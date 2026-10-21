//! The app side of the `rowline` command: a Unix socket that only this user can open.
//! One JSON request per connection, one JSON answer, then the connection closes.
//! Queries are read-only (readonly::check and a read-only transaction) and go into History as "cli".

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::manager::Session;
use crate::model::{ConnectionConfig, Engine, HistoryEntry};
use crate::readonly;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

pub const DEFAULT_LIMIT: usize = 200;
pub const MAX_LIMIT: usize = 1000;
/// a request bigger than this is refused (a query, not a data dump)
const MAX_REQUEST: u64 = 1024 * 1024;

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct Request {
    pub cmd: String,
    pub conn: Option<String>,
    pub db: Option<String>,
    pub table: Option<String>,
    pub sql: Option<String>,
    pub limit: Option<usize>,
}

/// Errors that mean "not allowed" rather than "went wrong": the CLI exits with code 2 for these.
fn blocked(e: AppError) -> Value {
    json!({ "ok": false, "blocked": true, "error": e.to_string() })
}

fn failed(e: AppError) -> Value {
    json!({ "ok": false, "error": e.to_string() })
}

/// Listens on `path`. Refuses to start when another Rowline already answers there;
/// a socket file left by a crashed app is replaced.
pub async fn start(state: Arc<AppState>, path: PathBuf) -> AppResult<()> {
    if path.exists() {
        if UnixStream::connect(&path).await.is_ok() {
            return Err(AppError::msg(format!("Another Rowline already listens on {}", path.display())));
        }
        std::fs::remove_file(&path)?;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let listener = UnixListener::bind(&path)?;
    restrict(&path)?;
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let state = state.clone();
            tokio::spawn(async move {
                let _ = serve(&state, stream).await;
            });
        }
    });
    Ok(())
}

/// Only this user may connect (other users on the Mac cannot read or write the socket).
fn restrict(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

async fn serve(state: &AppState, stream: UnixStream) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    BufReader::new(read.take(MAX_REQUEST)).read_line(&mut line).await?;
    let answer = match serde_json::from_str::<Request>(&line) {
        Ok(req) => handle(state, req).await,
        Err(e) => failed(AppError::msg(format!("Bad request: {e}"))),
    };
    write.write_all(format!("{answer}\n").as_bytes()).await?;
    write.shutdown().await
}

/// Answers one request: `{ "ok": true, "data": … }` or `{ "ok": false, "error": "…" }`.
pub async fn handle(state: &AppState, req: Request) -> Value {
    let res = match req.cmd.as_str() {
        "connections" => connections(state).await,
        "tables" => tables(state, &req).await,
        "describe" => describe(state, &req).await,
        "query" => return query(state, &req).await,
        other => Err(AppError::msg(format!("Unknown command: {other}"))),
    };
    match res {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(e) => failed(e),
    }
}

/// Open connections, in the order of their names
async fn open_connections(state: &AppState) -> Vec<ConnectionConfig> {
    let ids = state.manager.open_ids().await;
    let mut list: Vec<ConnectionConfig> = ids.iter().filter_map(|id| state.store.connection(id).ok()).collect();
    list.sort_by_key(|c| c.name.to_lowercase());
    list
}

/// MySQL: --db, else the database selected in the app, else the saved default. SQLite: none.
fn database(state: &AppState, c: &ConnectionConfig, asked: Option<&str>) -> Option<String> {
    match c.engine {
        Engine::Mysql => asked.map(str::to_string).or_else(|| state.manager.database(&c.id)).or_else(|| c.database.clone()),
        Engine::Sqlite => None,
    }
}

async fn connections(state: &AppState) -> AppResult<Value> {
    let list: Vec<Value> = open_connections(state)
        .await
        .iter()
        .map(|c| json!({ "name": c.name, "environment": c.environment, "engine": c.engine, "database": database(state, c, None) }))
        .collect();
    Ok(Value::Array(list))
}

/// The open connection a name points to: the same name (any case), the id, or the only name that contains it.
pub fn pick<'a>(open: &'a [ConnectionConfig], wanted: &str) -> AppResult<&'a ConnectionConfig> {
    let names = || open.iter().map(|c| format!("\"{}\"", c.name)).collect::<Vec<_>>().join(", ");
    if open.is_empty() {
        return Err(AppError::msg("No connection is open in Rowline. Open one in the app first."));
    }
    let w = wanted.trim().to_lowercase();
    if let Some(c) = open.iter().find(|c| c.name.to_lowercase() == w || c.id == wanted) {
        return Ok(c);
    }
    let partial: Vec<&ConnectionConfig> = open.iter().filter(|c| c.name.to_lowercase().contains(&w)).collect();
    match partial.as_slice() {
        [one] => Ok(one),
        [] => Err(AppError::msg(format!("No open connection matches \"{wanted}\". Open: {}.", names()))),
        many => Err(AppError::msg(format!(
            "\"{wanted}\" matches {} connections: {}. Use the full name.",
            many.len(),
            many.iter().map(|c| format!("\"{}\"", c.name)).collect::<Vec<_>>().join(", ")
        ))),
    }
}

async fn resolve(state: &AppState, req: &Request) -> AppResult<(ConnectionConfig, Arc<Session>)> {
    let open = open_connections(state).await;
    let wanted = match req.conn.as_deref() {
        Some(w) => w,
        // one open connection: no need to name it
        None if open.len() == 1 => open[0].name.as_str(),
        None if open.is_empty() => "",
        None => return Err(AppError::msg("Choose a connection with --conn. `rowline connections` lists them.")),
    };
    let c = pick(&open, wanted)?.clone();
    let session = state.manager.get(&c.id).await.map_err(|_| AppError::msg(format!("Connection \"{}\" is not open in Rowline.", c.name)))?;
    Ok((c, session))
}

async fn tables(state: &AppState, req: &Request) -> AppResult<Value> {
    let (c, s) = resolve(state, req).await?;
    Ok(serde_json::to_value(s.objects(database(state, &c, req.db.as_deref()).as_deref()).await?)?)
}

async fn describe(state: &AppState, req: &Request) -> AppResult<Value> {
    let (c, s) = resolve(state, req).await?;
    let table = req.table.as_deref().filter(|t| !t.is_empty()).ok_or_else(|| AppError::msg("Name the table: rowline describe <table>"))?;
    Ok(serde_json::to_value(s.structure(database(state, &c, req.db.as_deref()).as_deref(), table).await?)?)
}

async fn query(state: &AppState, req: &Request) -> Value {
    let (c, s) = match resolve(state, req).await {
        Ok(v) => v,
        Err(e) => return failed(e),
    };
    let db = database(state, &c, req.db.as_deref());
    let sql = req.sql.as_deref().unwrap_or("").to_string();
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let started = std::time::Instant::now();
    let log = |ok: bool, error: Option<String>, rows: Option<usize>| {
        let _ = state.store.add_history(HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: c.id.clone(),
            database: db.clone(),
            sql: sql.clone(),
            executed_at: chrono::Utc::now(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            ok,
            source: Some("cli".into()),
            error,
            rows,
        });
    };
    // the rule check comes first: a write never reaches the database
    let statement = match readonly::check(&sql, s.dialect()) {
        Ok(st) => st,
        Err(e) => {
            log(false, Some(format!("Blocked: {e}")), None);
            return blocked(e);
        }
    };
    match s.select_read_only(db.as_deref(), &statement, limit).await {
        Ok(mut res) => {
            readonly::limit_values(&mut res);
            log(true, None, Some(res.rows.len()));
            json!({ "ok": true, "data": {
                "connection": c.name, "database": db,
                "columns": res.columns.iter().map(|col| col.name.as_str()).collect::<Vec<_>>(),
                "rows": res.rows, "rowCount": res.rows.len(), "truncated": res.truncated, "elapsedMs": res.elapsed_ms,
            } })
        }
        Err(e) => {
            // the database refused a write the check let through: still "not allowed"
            let msg = e.to_string();
            let refused = msg.contains("READ ONLY") || msg.contains("1792") || msg.to_lowercase().contains("readonly");
            log(false, Some(msg), None);
            if refused { blocked(e) } else { failed(e) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::dispatch;
    use crate::store::{SecretStore, Store};

    struct Fixture {
        dir: tempfile::TempDir,
        state: Arc<AppState>,
        id: String,
    }

    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("shop.sqlite");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 300) INSERT INTO orders (total) SELECT i FROM n;")
            .unwrap();
        let state = Arc::new(AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap()));
        let saved = dispatch(&state, "save_connection", json!({ "id": "", "name": "Shop prod", "engine": "sqlite", "environment": "prod", "filePath": db.to_str().unwrap() })).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        Fixture { dir, state, id }
    }

    fn req(cmd: &str) -> Request {
        Request { cmd: cmd.into(), ..Default::default() }
    }

    #[tokio::test]
    async fn sees_only_open_connections() {
        let f = fixture().await;
        let r = handle(&f.state, req("connections")).await;
        assert_eq!(r["data"], json!([]), "saved but not open");
        let q = handle(&f.state, Request { sql: Some("SELECT 1".into()), ..req("query") }).await;
        assert!(q["error"].as_str().unwrap().contains("No connection is open"), "{q}");
        dispatch(&f.state, "connect", json!({ "id": f.id })).await.unwrap();
        let r = handle(&f.state, req("connections")).await;
        assert_eq!(r["data"][0]["name"], "Shop prod");
        assert_eq!(r["data"][0]["environment"], "prod");
        dispatch(&f.state, "disconnect", json!({ "id": f.id })).await.unwrap();
        assert_eq!(handle(&f.state, req("connections")).await["data"], json!([]));
    }

    #[tokio::test]
    async fn runs_reads_with_a_limit_and_logs_them() {
        let f = fixture().await;
        dispatch(&f.state, "connect", json!({ "id": f.id })).await.unwrap();
        let r = handle(&f.state, Request { conn: Some("shop".into()), sql: Some("SELECT id, total FROM orders ORDER BY id".into()), ..req("query") }).await;
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["data"]["rowCount"], DEFAULT_LIMIT);
        assert_eq!(r["data"]["truncated"], true);
        assert_eq!(r["data"]["columns"], json!(["id", "total"]));
        let small = handle(&f.state, Request { sql: Some("SELECT id FROM orders".into()), limit: Some(5), ..req("query") }).await;
        assert_eq!(small["data"]["rowCount"], 5, "one open connection needs no --conn");
        let huge = handle(&f.state, Request { sql: Some("SELECT id FROM orders".into()), limit: Some(1_000_000), ..req("query") }).await;
        assert_eq!(huge["data"]["rowCount"], 300, "capped at MAX_LIMIT, here all 300 rows");

        let history = f.state.store.history(Some(&f.id)).unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[0].source.as_deref(), Some("cli"));
        assert_eq!(history[2].rows, Some(DEFAULT_LIMIT));
    }

    #[tokio::test]
    async fn blocks_writes_and_logs_the_attempt() {
        let f = fixture().await;
        dispatch(&f.state, "connect", json!({ "id": f.id })).await.unwrap();
        for sql in ["DELETE FROM orders", "SELECT 1; DROP TABLE orders", "UPDATE orders SET total = 0", "WITH x AS (SELECT 1) DELETE FROM orders"] {
            let r = handle(&f.state, Request { sql: Some(sql.into()), ..req("query") }).await;
            assert_eq!(r["blocked"], true, "{sql}: {r}");
        }
        let count = handle(&f.state, Request { sql: Some("SELECT count(*) AS n FROM orders".into()), ..req("query") }).await;
        assert_eq!(count["data"]["rows"][0][0], 300, "nothing changed");
        let history = f.state.store.history(Some(&f.id)).unwrap();
        assert!(history[1].error.as_deref().unwrap().starts_with("Blocked:"), "{:?}", history[1]);
        assert!(!history[1].ok);
    }

    #[tokio::test]
    async fn schema_commands() {
        let f = fixture().await;
        dispatch(&f.state, "connect", json!({ "id": f.id })).await.unwrap();
        let t = handle(&f.state, req("tables")).await;
        assert!(t["data"].to_string().contains("orders"), "{t}");
        let d = handle(&f.state, Request { table: Some("orders".into()), ..req("describe") }).await;
        assert!(d["data"].to_string().contains("total"), "{d}");
        let no_table = handle(&f.state, req("describe")).await;
        assert!(no_table["error"].as_str().unwrap().contains("Name the table"));
    }

    fn config(name: &str) -> ConnectionConfig {
        serde_json::from_value(json!({ "id": format!("id-{name}"), "name": name, "engine": "sqlite" })).unwrap()
    }

    #[test]
    fn picks_connections_by_name() {
        let open = vec![config("Prod sollit core"), config("Prod sollit services"), config("dev sollit db")];
        assert_eq!(pick(&open, "prod sollit core").unwrap().name, "Prod sollit core");
        assert_eq!(pick(&open, "dev").unwrap().name, "dev sollit db");
        assert_eq!(pick(&open, "id-dev sollit db").unwrap().name, "dev sollit db");
        let many = pick(&open, "prod").unwrap_err().to_string();
        assert!(many.contains("matches 2 connections"), "{many}");
        let none = pick(&open, "staging").unwrap_err().to_string();
        assert!(none.contains("Open: \"Prod sollit core\""), "{none}");
    }

    #[tokio::test]
    async fn answers_over_the_socket_and_only_to_this_user() {
        let f = fixture().await;
        dispatch(&f.state, "connect", json!({ "id": f.id })).await.unwrap();
        let path = f.dir.path().join("r.sock");
        start(f.state.clone(), path.clone()).await.unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(start(f.state.clone(), path.clone()).await.is_err(), "a second app must not take over the socket");

        let mut s = UnixStream::connect(&path).await.unwrap();
        s.write_all(b"{\"cmd\":\"query\",\"sql\":\"SELECT 2 AS n\"}\n").await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["data"]["rows"][0][0], 2);

        let mut s = UnixStream::connect(&path).await.unwrap();
        s.write_all(b"not json\n").await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.contains("Bad request"));
    }

    #[tokio::test]
    async fn replaces_a_stale_socket_file() {
        let f = fixture().await;
        let path = f.dir.path().join("stale.sock");
        drop(std::os::unix::net::UnixListener::bind(&path).unwrap()); // file stays, nobody listens
        start(f.state.clone(), path.clone()).await.unwrap();
        assert!(UnixStream::connect(&path).await.is_ok());
    }

    #[tokio::test]
    async fn mysql_uses_the_selected_database_and_stays_read_only() {
        let Ok(v) = std::env::var("ROWLINE_TEST_MYSQL") else { return };
        let p: Vec<&str> = v.splitn(5, ':').collect();
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap()));
        let saved = dispatch(&state, "save_connection", json!({
            "id": "", "name": "My prod", "engine": "mysql", "environment": "prod", "host": p[0], "port": p[1].parse::<u16>().unwrap(), "user": p[2], "password": p[3]
        })).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        dispatch(&state, "connect", json!({ "id": id })).await.unwrap();
        dispatch(&state, "set_active_database", json!({ "id": id, "database": p[4] })).await.unwrap();
        let r = handle(&state, Request { sql: Some("SELECT DATABASE() AS db".into()), ..req("query") }).await;
        assert_eq!(r["data"]["rows"][0][0], p[4], "{r}");
        let r = handle(&state, Request { sql: Some("SELECT DATABASE() AS db".into()), db: Some("information_schema".into()), ..req("query") }).await;
        assert_eq!(r["data"]["rows"][0][0], "information_schema", "--db wins");
        let w = handle(&state, Request { sql: Some("CREATE TABLE rowline_cli_nope (id INT)".into()), ..req("query") }).await;
        assert_eq!(w["blocked"], true, "{w}");
        let gone = handle(&state, Request { sql: Some("SHOW TABLES LIKE 'rowline_cli_nope'".into()), ..req("query") }).await;
        assert_eq!(gone["data"]["rowCount"], 0);
    }
}
