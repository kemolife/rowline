//! Rowline's MCP server: read-only database tools for the Claude panel.
//! Minimal MCP (JSON-RPC 2.0) over streamable HTTP: every POST gets one JSON response, no server-sent events.

use super::events::ChatEvent;
use super::{ChatConfig, McpEndpoint};
use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::manager::Session;
use crate::model::{ClaudeAccess, ConnectionConfig, Engine, Environment};
use crate::readonly;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

/// Starts the server on a random local port with a new secret token.
pub async fn start(state: Arc<AppState>) -> AppResult<McpEndpoint> {
    if state.claude.endpoint.get().is_some() {
        return Err(AppError::msg("The Claude tools server is already running."));
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let endpoint = McpEndpoint { port, token };
    state.claude.endpoint.set(endpoint.clone()).map_err(|_| AppError::msg("The Claude tools server is already running."))?;
    let app = Router::new()
        .route("/mcp/{chat_id}", post(handle).get(|| async { StatusCode::METHOD_NOT_ALLOWED }).delete(|| async { StatusCode::OK }))
        .with_state(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(endpoint)
}

async fn handle(State(state): State<Arc<AppState>>, Path(chat_id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(endpoint) = state.claude.endpoint.get() else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    // Web pages always send an Origin header; Claude Code does not. Refusing it blocks DNS-rebinding and
    // cross-site requests even before the token check (MCP transport rule: validate Origin).
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let expected = format!("Bearer {}", endpoint.token);
    let given = headers.get(header::AUTHORIZATION).map(|v| v.as_bytes()).unwrap_or_default();
    if !same_secret(given, expected.as_bytes()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return Json(rpc_error(Value::Null, -32700, "Parse error")).into_response();
    };
    // notifications (no id) get 202 and no body
    let Some(id) = msg.get("id").cloned() else { return StatusCode::ACCEPTED.into_response() };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let reply = match msg.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => rpc_result(id, initialize(&params)),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => match tool_list(&state, &chat_id) {
            Ok(tools) => rpc_result(id, tools),
            Err(e) => rpc_error(id, -32602, &e.to_string()),
        },
        "tools/call" => rpc_result(id, call_tool(&state, &chat_id, &params).await),
        _ => rpc_error(id, -32601, "Method not found"),
    };
    Json(reply).into_response()
}

/// Compares two byte strings in time that depends only on their lengths, not on where they differ.
fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "rowline", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Read-only access to the user's open database connections in Rowline. Call list_connections first."
    })
}

/// Connections of a chat that Claude may see (access is not Off).
fn visible(state: &AppState, chat: &ChatConfig) -> Vec<ConnectionConfig> {
    chat.connection_ids
        .iter()
        .filter_map(|id| state.store.connection(id).ok())
        .filter(|c| c.claude_access() != ClaudeAccess::Off)
        .collect()
}

fn tool_list(state: &AppState, chat_id: &str) -> AppResult<Value> {
    let chat = state.claude.chat(chat_id)?;
    let any_data = visible(state, &chat).iter().any(|c| c.claude_access() == ClaudeAccess::Data);
    let conn = || json!({ "type": "string", "description": "Connection id from list_connections" });
    let db = || json!({ "type": "string", "description": "MySQL database (schema). Default: the database selected in Rowline" });
    let mut tools = vec![
        json!({ "name": "list_connections", "description": "Database connections you may use in this chat: id, name, engine (mysql or sqlite), environment, selected database and access level.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "list_tables", "description": "Tables and views of a connection, with estimated row counts.", "inputSchema": { "type": "object", "properties": { "connection": conn(), "database": db() }, "required": ["connection"] } }),
        json!({ "name": "describe_table", "description": "Columns (type, nullable, default, primary key), indexes and foreign keys of one table.", "inputSchema": { "type": "object", "properties": { "connection": conn(), "database": db(), "table": { "type": "string" } }, "required": ["connection", "table"] } }),
    ];
    if any_data {
        tools.push(json!({ "name": "run_select", "description": "Run ONE read-only statement (SELECT, SHOW, EXPLAIN, WITH … SELECT). Returns at most 200 rows; long values are cut to 2 KB. On Production connections the user must approve each query.", "inputSchema": { "type": "object", "properties": { "connection": conn(), "database": db(), "sql": { "type": "string" } }, "required": ["connection", "sql"] } }));
    }
    Ok(json!({ "tools": tools }))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ToolArgs {
    connection: Option<String>,
    database: Option<String>,
    table: Option<String>,
    sql: Option<String>,
}

struct ToolOutput {
    text: String,
    rows: Option<usize>,
    truncated: bool,
}

/// Runs a tool and reports it to the chat as a card (ToolCall, then ToolResult).
async fn call_tool(state: &AppState, chat_id: &str, params: &Value) -> Value {
    // a closed or unknown chat: answer without touching chat state (no card, no stop signal entry)
    if let Err(e) = state.claude.chat(chat_id) {
        return json!({ "content": [{ "type": "text", "text": e.to_string() }], "isError": true });
    }
    let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let args: ToolArgs = serde_json::from_value(params.get("arguments").cloned().unwrap_or_else(|| json!({}))).unwrap_or_default();
    let call_id = uuid::Uuid::new_v4().to_string();
    let hub = &state.claude.hub;
    let db = tool_database(state, chat_id, &args);
    hub.push(chat_id, ChatEvent::ToolCall { call_id: call_id.clone(), tool: name.clone(), connection: args.connection.clone(), database: db, sql: args.sql.clone() });
    let started = std::time::Instant::now();
    let stop = state.claude.stop_signal(chat_id);
    let res = tokio::select! {
        biased;
        r = run_tool(state, chat_id, &name, &args) => r,
        _ = stop.notified() => Err(AppError::msg("Stopped by the user.")),
    };
    let elapsed_ms = Some(started.elapsed().as_millis() as u64);
    match res {
        Ok(out) => {
            hub.push(chat_id, ChatEvent::ToolResult { call_id, rows: out.rows, truncated: out.truncated, elapsed_ms, error: None });
            json!({ "content": [{ "type": "text", "text": out.text }] })
        }
        Err(e) => {
            let message = e.to_string();
            hub.push(chat_id, ChatEvent::ToolResult { call_id, rows: None, truncated: false, elapsed_ms, error: Some(message.clone()) });
            json!({ "content": [{ "type": "text", "text": message }], "isError": true })
        }
    }
}

fn text_output<T: serde::Serialize>(value: &T, rows: Option<usize>) -> AppResult<ToolOutput> {
    Ok(ToolOutput { text: serde_json::to_string(value)?, rows, truncated: false })
}

async fn run_tool(state: &AppState, chat_id: &str, name: &str, a: &ToolArgs) -> AppResult<ToolOutput> {
    let chat = state.claude.chat(chat_id)?;
    match name {
        "list_connections" => {
            let list: Vec<Value> = visible(state, &chat)
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id, "name": c.name, "engine": c.engine, "environment": c.environment,
                        "database": chat.database_for(&c.id).or_else(|| c.database.clone()),
                        "access": c.claude_access(),
                    })
                })
                .collect();
            text_output(&list, Some(list.len()))
        }
        "list_tables" => {
            let (c, s) = resolve(state, &chat, a).await?;
            let objects = s.objects(database(&chat, &c, a).as_deref()).await?;
            text_output(&objects, Some(objects.len()))
        }
        "describe_table" => {
            let (c, s) = resolve(state, &chat, a).await?;
            let table = a.table.as_deref().ok_or_else(|| AppError::msg("table is required"))?;
            let structure = s.structure(database(&chat, &c, a).as_deref(), table).await?;
            text_output(&structure, None)
        }
        "run_select" => {
            let (c, s) = resolve(state, &chat, a).await?;
            if c.claude_access() != ClaudeAccess::Data {
                return Err(AppError::msg(format!("Connection \"{}\" allows schema only. Use list_tables and describe_table.", c.name)));
            }
            let sql = a.sql.as_deref().ok_or_else(|| AppError::msg("sql is required"))?;
            readonly::check(sql, s.dialect())?; // refuse writes before bothering the user
            if c.environment == Environment::Prod
                && !state.claude.approvals.ask(&state.claude.hub, chat_id, &c.id, &c.name, sql, APPROVAL_TIMEOUT).await
            {
                return Err(AppError::msg("The user did not allow this query."));
            }
            let res = readonly::run_select(&s, database(&chat, &c, a).as_deref(), sql).await?;
            let body = json!({
                "columns": res.columns.iter().map(|col| col.name.as_str()).collect::<Vec<_>>(),
                "rows": res.rows, "truncated": res.truncated, "elapsedMs": res.elapsed_ms,
            });
            Ok(ToolOutput { text: body.to_string(), rows: Some(res.rows.len()), truncated: res.truncated })
        }
        other => Err(AppError::msg(format!("Unknown tool: {other}"))),
    }
}

/// The connection named in the arguments, if this chat may use it and it is open.
async fn resolve(state: &AppState, chat: &ChatConfig, a: &ToolArgs) -> AppResult<(ConnectionConfig, Arc<Session>)> {
    let id = a.connection.as_deref().ok_or_else(|| AppError::msg("connection is required. Call list_connections first."))?;
    let not_available = || AppError::msg(format!("Connection {id} is not available in this chat."));
    if !chat.connection_ids.iter().any(|c| c == id) {
        return Err(not_available());
    }
    let config = state.store.connection(id).map_err(|_| not_available())?;
    if config.claude_access() == ClaudeAccess::Off {
        return Err(not_available());
    }
    let session = state.manager.get(id).await.map_err(|_| AppError::msg(format!("Connection \"{}\" is not open in Rowline.", config.name)))?;
    Ok((config, session))
}

/// MySQL: the argument, else the database selected in Rowline, else the saved default. SQLite: none.
fn database(chat: &ChatConfig, c: &ConnectionConfig, a: &ToolArgs) -> Option<String> {
    match c.engine {
        Engine::Mysql => a.database.clone().or_else(|| chat.database_for(&c.id)).or_else(|| c.database.clone()),
        Engine::Sqlite => None,
    }
}

/// The database a tool call will use, for the card's "Open in grid" (None when the connection is not in the chat).
fn tool_database(state: &AppState, chat_id: &str, a: &ToolArgs) -> Option<String> {
    let chat = state.claude.chat(chat_id).ok()?;
    let id = a.connection.as_deref()?;
    if !chat.connection_ids.iter().any(|c| c == id) {
        return None;
    }
    let config = state.store.connection(id).ok()?;
    database(&chat, &config, a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::ChatConnection;
    use crate::claude::events::ChatEvent;
    use crate::commands::dispatch;
    use crate::store::{SecretStore, Store};
    use serde_json::json;

    struct Fixture {
        _dir: tempfile::TempDir,
        state: Arc<AppState>,
        endpoint: crate::claude::McpEndpoint,
        conn_id: String,
    }

    async fn fixture(environment: &str, access: Option<&str>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("m.sqlite");
        rusqlite::Connection::open(&db).unwrap().execute_batch("CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL); INSERT INTO orders (total) VALUES (10), (20);").unwrap();
        let state = Arc::new(AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap()));
        let mut conn = json!({ "id": "", "name": "Shop", "engine": "sqlite", "environment": environment, "filePath": db.to_str().unwrap() });
        if let Some(a) = access {
            conn["claudeAccess"] = json!(a);
        }
        let saved = dispatch(&state, "save_connection", conn).await.unwrap();
        let conn_id = saved["id"].as_str().unwrap().to_string();
        dispatch(&state, "connect", json!({ "id": conn_id })).await.unwrap();
        let endpoint = start(state.clone()).await.unwrap();
        Fixture { _dir: dir, state, endpoint, conn_id }
    }

    async fn rpc(f: &Fixture, chat: &str, token: &str, body: Value) -> reqwest::Response {
        reqwest::Client::new()
            .post(f.endpoint.url(chat))
            .header("Authorization", format!("Bearer {token}"))
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    async fn call(f: &Fixture, chat: &str, tool: &str, args: Value) -> Value {
        let res = rpc(f, chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } })).await;
        res.json::<Value>().await.unwrap()["result"].clone()
    }

    fn chat_for(f: &Fixture) -> String {
        f.state.claude.open_chat(vec![ChatConnection { id: f.conn_id.clone(), database: None }])
    }

    #[tokio::test]
    async fn rejects_wrong_token_and_answers_initialize() {
        let f = fixture("dev", None).await;
        let chat = chat_for(&f);
        assert_eq!(rpc(&f, &chat, "wrong", json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await.status(), 401);
        let init: Value = rpc(&f, &chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "rowline");
        let note = rpc(&f, &chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        assert_eq!(note.status(), 202);
    }

    #[tokio::test]
    async fn rejects_missing_token_and_browser_requests() {
        let f = fixture("dev", None).await;
        let chat = chat_for(&f);
        let client = reqwest::Client::new();
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        let no_token = client.post(f.endpoint.url(&chat)).json(&ping).send().await.unwrap();
        assert_eq!(no_token.status(), 401);
        let short = client.post(f.endpoint.url(&chat)).header("Authorization", "Bearer ").json(&ping).send().await.unwrap();
        assert_eq!(short.status(), 401);
        // a web page that somehow knows the token is still refused: browsers always send Origin
        let browser = client
            .post(f.endpoint.url(&chat))
            .header("Authorization", format!("Bearer {}", f.endpoint.token))
            .header("Origin", "http://evil.example")
            .json(&ping)
            .send()
            .await
            .unwrap();
        assert_eq!(browser.status(), 403);
    }

    #[tokio::test]
    async fn unknown_chat_and_second_start_are_refused() {
        let f = fixture("dev", None).await;
        assert!(start(f.state.clone()).await.is_err(), "a second server on the same state must fail");
        let r = call(&f, "no-such-chat", "list_connections", json!({})).await;
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("Unknown chat"));
    }

    #[test]
    fn secret_compare() {
        assert!(same_secret(b"Bearer abc", b"Bearer abc"));
        assert!(!same_secret(b"Bearer abd", b"Bearer abc"));
        assert!(!same_secret(b"Bearer ab", b"Bearer abc"));
        assert!(!same_secret(b"", b"Bearer abc"));
    }

    #[tokio::test]
    async fn lists_tools_by_access_level() {
        let f = fixture("dev", None).await;
        let chat = chat_for(&f);
        let tools: Value = rpc(&f, &chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.json().await.unwrap();
        let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_connections", "list_tables", "describe_table", "run_select"]);

        let f = fixture("dev", Some("schema")).await;
        let chat = chat_for(&f);
        let tools: Value = rpc(&f, &chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.json().await.unwrap();
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 3);
        let r = call(&f, &chat, "run_select", json!({ "connection": f.conn_id, "sql": "SELECT 1" })).await;
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("schema only"));
    }

    #[tokio::test]
    async fn runs_reads_and_reports_cards() {
        let f = fixture("dev", None).await;
        let chat = chat_for(&f);
        let tables = call(&f, &chat, "list_tables", json!({ "connection": f.conn_id })).await;
        assert!(tables["content"][0]["text"].as_str().unwrap().contains("orders"));
        let r = call(&f, &chat, "run_select", json!({ "connection": f.conn_id, "sql": "SELECT sum(total) AS s FROM orders" })).await;
        let body: Value = serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["rows"][0][0], 30.0);
        let w = call(&f, &chat, "run_select", json!({ "connection": f.conn_id, "sql": "DELETE FROM orders" })).await;
        assert_eq!(w["isError"], true);

        let events = f.state.claude.hub.wait_after(&chat, 0, std::time::Duration::from_millis(10)).await.unwrap();
        let calls = events.iter().filter(|e| matches!(e.event, ChatEvent::ToolCall { .. })).count();
        let results = events.iter().filter(|e| matches!(e.event, ChatEvent::ToolResult { .. })).count();
        assert_eq!((calls, results), (3, 3));
    }

    #[tokio::test]
    async fn connection_outside_the_chat_is_rejected() {
        let f = fixture("dev", None).await;
        let other_chat = f.state.claude.open_chat(vec![ChatConnection { id: "someone-else".into(), database: None }]);
        let r = call(&f, &other_chat, "run_select", json!({ "connection": f.conn_id, "sql": "SELECT 1" })).await;
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("not available in this chat"));
    }

    #[tokio::test]
    async fn production_waits_for_approval() {
        let f = fixture("prod", Some("data")).await;
        let chat = chat_for(&f);
        let state = f.state.clone();
        let chat2 = chat.clone();
        tokio::spawn(async move {
            loop {
                for e in state.claude.hub.wait_after(&chat2, 0, std::time::Duration::from_secs(1)).await.unwrap() {
                    if let ChatEvent::Approval { request_id, .. } = e.event {
                        state.claude.approvals.answer(&request_id, false).unwrap();
                        return;
                    }
                }
            }
        });
        let r = call(&f, &chat, "run_select", json!({ "connection": f.conn_id, "sql": "SELECT 1" })).await;
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("did not allow"));
    }

    #[tokio::test]
    async fn mcp_uses_explicit_database() {
        // SQLite has one database; the explicit value must be accepted and ignored, not fail
        let f = fixture("dev", None).await;
        let chat = chat_for(&f);
        let r = call(&f, &chat, "list_tables", json!({ "connection": f.conn_id, "database": "main" })).await;
        assert!(r.get("isError").is_none(), "{r}");
        // MySQL: covered by `mysql_database_argument_wins` below when ROWLINE_TEST_MYSQL is set
    }

    #[tokio::test]
    async fn tool_call_reports_the_database_it_uses() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap()));
        let saved = dispatch(&state, "save_connection", json!({ "id": "", "name": "My", "engine": "mysql", "host": "127.0.0.1", "database": "saved_db" })).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        let chat = state.claude.open_chat(vec![ChatConnection { id: id.clone(), database: Some("selected_db".into()) }]);
        let args = |db: Option<&str>| ToolArgs { connection: Some(id.clone()), database: db.map(String::from), ..Default::default() };
        assert_eq!(tool_database(&state, &chat, &args(Some("asked_db"))).as_deref(), Some("asked_db"));
        assert_eq!(tool_database(&state, &chat, &args(None)).as_deref(), Some("selected_db"));
        let other = state.claude.open_chat(vec![]);
        assert_eq!(tool_database(&state, &other, &args(Some("asked_db"))), None, "not in this chat");
        // the event carries it to the frontend
        let f = fixture("dev", None).await;
        let c = chat_for(&f);
        call(&f, &c, "list_tables", json!({ "connection": f.conn_id, "database": "main" })).await;
        let events = f.state.claude.hub.wait_after(&c, 0, std::time::Duration::from_millis(10)).await.unwrap();
        assert!(matches!(&events[0].event, ChatEvent::ToolCall { database: None, .. }), "SQLite has no database: {events:?}");
    }

    #[tokio::test]
    async fn mysql_database_argument_wins() {
        let Ok(v) = std::env::var("ROWLINE_TEST_MYSQL") else { return };
        let p: Vec<&str> = v.splitn(5, ':').collect();
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap()));
        let saved = dispatch(&state, "save_connection", json!({
            "id": "", "name": "My", "engine": "mysql", "host": p[0], "port": p[1].parse::<u16>().unwrap(), "user": p[2], "password": p[3], "database": p[4]
        })).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        dispatch(&state, "connect", json!({ "id": id })).await.unwrap();
        start(state.clone()).await.unwrap();
        // the chat says "selected database = information_schema"; the argument asks for the test database
        let chat = state.claude.open_chat(vec![ChatConnection { id: id.clone(), database: Some("information_schema".into()) }]);
        let out = run_tool(&state, &chat, "run_select", &ToolArgs { connection: Some(id.clone()), database: Some(p[4].into()), sql: Some("SELECT DATABASE()".into()), ..Default::default() }).await.unwrap();
        assert!(out.text.contains(p[4]), "{}", out.text);
        let out = run_tool(&state, &chat, "run_select", &ToolArgs { connection: Some(id), sql: Some("SELECT DATABASE()".into()), ..Default::default() }).await.unwrap();
        assert!(out.text.contains("information_schema"), "{}", out.text);
    }
}
