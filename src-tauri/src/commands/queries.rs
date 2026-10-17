//! SQL helpers, saved queries and query history.

use super::{AppState, ok, parse};
use crate::error::{AppError, AppResult};
use serde::Deserialize;
use serde_json::Value;
use super::IdArgs;
use crate::model::*;
use crate::sqlgen;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlArgs {
    sql: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveQueryArgs {
    #[serde(default)]
    id: String,
    connection_id: String,
    name: String,
    sql: String,
    #[serde(default)]
    database: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryArgs {
    connection_id: Option<String>,
}

pub(super) const COMMANDS: &[&str] = &["split_statements", "is_read_only", "list_saved_queries", "save_query", "delete_saved_query", "list_history"];

pub(super) async fn run(state: &AppState, command: &str, args: Value) -> AppResult<Value> {
    match command {
        "split_statements" => {
            let a: SqlArgs = parse(args)?;
            ok(sqlgen::split_statements(&a.sql))
        }
        "is_read_only" => {
            let a: SqlArgs = parse(args)?;
            ok(sqlgen::split_statements(&a.sql).iter().all(|s| sqlgen::is_read_only_statement(&s.text)))
        }
        "list_saved_queries" => {
            let a: HistoryArgs = parse(args)?;
            let id = a.connection_id.ok_or_else(|| AppError::msg("connectionId is required"))?;
            ok(state.store.saved_queries(&id)?)
        }
        "save_query" => {
            let a: SaveQueryArgs = parse(args)?;
            ok(state.store.save_query(SavedQuery {
                id: a.id,
                connection_id: a.connection_id,
                name: a.name,
                sql: a.sql,
                database: a.database,
                updated_at: chrono::Utc::now(),
            })?)
        }
        "delete_saved_query" => {
            let a: IdArgs = parse(args)?;
            state.store.delete_query(&a.id)?;
            ok(true)
        }
        "list_history" => {
            let a: HistoryArgs = parse(args)?;
            ok(state.store.history(a.connection_id.as_deref())?.into_iter().take(200).collect::<Vec<_>>())
        }
        other => Err(super::unknown(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;

    #[tokio::test]
    async fn saved_queries_through_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap());
        let saved = dispatch(&state, "save_query", json!({ "connectionId": "c1", "name": "Top customers", "sql": "SELECT 1", "database": "shop" })).await.unwrap();
        assert_eq!(saved["name"], "Top customers");
        assert_eq!(saved["database"], "shop");
        let id = saved["id"].as_str().unwrap().to_string();
        dispatch(&state, "save_query", json!({ "id": id, "connectionId": "c1", "name": "Renamed", "sql": "SELECT 2" })).await.unwrap();
        let list = dispatch(&state, "list_saved_queries", json!({ "connectionId": "c1" })).await.unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "Renamed");
        assert_eq!(list[0]["sql"], "SELECT 2");
        dispatch(&state, "delete_saved_query", json!({ "id": id })).await.unwrap();
        assert_eq!(dispatch(&state, "list_saved_queries", json!({ "connectionId": "c1" })).await.unwrap(), json!([]));
    }
}
