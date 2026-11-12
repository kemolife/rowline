//! Browsing and editing data: databases, tables, pages, SQL, pending changes.

use super::{AppState, ok, parse};
use crate::error::AppResult;
use serde::Deserialize;
use serde_json::Value;
use super::IdArgs;
use crate::manager::Session;
use crate::model::*;
use crate::sqlgen;

const DEFAULT_MAX_ROWS: usize = 5_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObjectsArgs {
    id: String,
    database: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableArgs {
    id: String,
    database: Option<String>,
    table: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValuesArgs {
    id: String,
    database: Option<String>,
    table: String,
    column: String,
}

/// suggestions are a help, not worth waiting for
const SUGGEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const SUGGEST_LIMIT: usize = 50;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageArgs {
    id: String,
    request: PageRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteArgs {
    id: String,
    database: Option<String>,
    sql: String,
    max_rows: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesArgs {
    id: String,
    database: Option<String>,
    table: String,
    changes: ChangeSet,
}

pub(super) const COMMANDS: &[&str] = &["list_databases", "list_objects", "schema_columns", "table_structure", "select_page", "count_rows", "execute_sql", "preview_changes", "apply_changes", "cancel_query", "common_values"];

pub(super) async fn run(state: &AppState, command: &str, args: Value) -> AppResult<Value> {
    match command {
        "list_databases" => {
            let a: IdArgs = parse(args)?;
            ok(state.manager.get(&a.id).await?.databases().await?)
        }
        "list_objects" => {
            let a: ObjectsArgs = parse(args)?;
            ok(state.manager.get(&a.id).await?.objects(a.database.as_deref()).await?)
        }
        "schema_columns" => {
            let a: ObjectsArgs = parse(args)?;
            let cols = state.manager.get(&a.id).await?.schema_columns(a.database.as_deref()).await?;
            ok(cols.into_iter().collect::<std::collections::BTreeMap<_, _>>())
        }
        "table_structure" => {
            let a: TableArgs = parse(args)?;
            ok(state.manager.get(&a.id).await?.structure(a.database.as_deref(), &a.table).await?)
        }
        "select_page" => {
            let a: PageArgs = parse(args)?;
            ok(state.manager.get(&a.id).await?.select_page(a.request).await?)
        }
        "common_values" => {
            let a: ValuesArgs = parse(args)?;
            let session = state.manager.get(&a.id).await?;
            let values = tokio::time::timeout(SUGGEST_TIMEOUT, session.common_values(a.database.as_deref(), &a.table, &a.column, SUGGEST_LIMIT))
                .await
                .unwrap_or(Ok(Vec::new()))?;
            ok(values)
        }
        "count_rows" => {
            let a: PageArgs = parse(args)?;
            ok(state.manager.get(&a.id).await?.count(a.request).await?)
        }
        "execute_sql" => {
            let a: ExecuteArgs = parse(args)?;
            let session = state.manager.get(&a.id).await?;
            let started = std::time::Instant::now();
            let res = session.execute(a.database.as_deref(), &a.sql, a.max_rows.unwrap_or(DEFAULT_MAX_ROWS)).await;
            let _ = state.store.add_history(HistoryEntry {
                id: uuid::Uuid::new_v4().to_string(),
                connection_id: a.id.clone(),
                database: a.database.clone(),
                sql: a.sql.clone(),
                executed_at: chrono::Utc::now(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                ok: res.is_ok(),
                source: None,
                error: None,
                rows: None,
            });
            ok(res?)
        }
        "preview_changes" => {
            let a: ChangesArgs = parse(args)?;
            let session = state.manager.get(&a.id).await?;
            let db = match &*session {
                Session::Mysql(_) => a.database.as_deref(),
                Session::Sqlite(_) => None,
            };
            let statements = sqlgen::change_set_statements(session.dialect(), db, &a.table, &a.changes)?;
            ok(statements.iter().map(sqlgen::preview_sql).collect::<Vec<_>>())
        }
        "apply_changes" => {
            let a: ChangesArgs = parse(args)?;
            ok(state.manager.get(&a.id).await?.apply_changes(a.database.as_deref(), &a.table, a.changes).await?)
        }
        "cancel_query" => {
            let a: IdArgs = parse(args)?;
            state.manager.get(&a.id).await?.cancel().await?;
            ok(true)
        }
        other => Err(super::unknown(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;

    #[tokio::test]
    async fn sqlite_flow_through_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("app.sqlite");
        rusqlite::Connection::open(&db_path)
            .unwrap()
            .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a'), ('b');")
            .unwrap();
        let state = AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap());

        let saved = dispatch(&state, "save_connection", json!({
            "id": "", "name": "Local file", "engine": "sqlite", "filePath": db_path.to_str().unwrap()
        })).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let info = dispatch(&state, "connect", json!({ "id": id })).await.unwrap();
        assert!(info["version"].as_str().unwrap().starts_with("SQLite"));

        let objs = dispatch(&state, "list_objects", json!({ "id": id })).await.unwrap();
        assert_eq!(objs[0]["name"], "t");

        let page = dispatch(&state, "select_page", json!({ "id": id, "request": { "table": "t", "limit": 50, "offset": 0 } })).await.unwrap();
        assert_eq!(page["rows"].as_array().unwrap().len(), 2);

        let preview = dispatch(&state, "preview_changes", json!({
            "id": id, "table": "t", "changes": { "updates": [{ "key": {"id": 1}, "values": {"name": "z"} }] }
        })).await.unwrap();
        assert_eq!(preview[0], "UPDATE \"t\" SET \"name\" = 'z' WHERE \"id\" = 1");

        let res = dispatch(&state, "execute_sql", json!({ "id": id, "sql": "select count(*) n from t; delete from t where id = 2" })).await.unwrap();
        assert_eq!(res[0]["rows"][0][0], 2);
        assert_eq!(res[1]["affectedRows"], 1);
        let hist = dispatch(&state, "list_history", json!({ "connectionId": id })).await.unwrap();
        assert_eq!(hist.as_array().unwrap().len(), 1);

        assert_eq!(dispatch(&state, "is_read_only", json!({ "sql": "select 1; show tables" })).await.unwrap(), json!(true));
        assert_eq!(dispatch(&state, "is_read_only", json!({ "sql": "select 1; delete from t" })).await.unwrap(), json!(false));

        dispatch(&state, "disconnect", json!({ "id": id })).await.unwrap();
        let err = dispatch(&state, "list_objects", json!({ "id": id })).await.unwrap_err();
        assert!(err.to_string().contains("not found or closed"));
        assert!(dispatch(&state, "nope", json!({})).await.is_err());
    }

    #[tokio::test]
    async fn common_values_are_most_frequent_first() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        dispatch(&state, "execute_sql", json!({ "id": id, "sql": "create table s (id integer primary key, status text); insert into s (status) values ('Online'), ('Offline'), ('Online'), (null), ('Away'), ('Online'), ('Away')" }))
            .await
            .unwrap();
        let v = dispatch(&state, "common_values", json!({ "id": id, "table": "s", "column": "status" })).await.unwrap();
        assert_eq!(v, json!(["Online", "Away", "Offline"]));
    }
}
