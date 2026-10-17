//! Relation diagram: the schema of a database and snapshots of it (to show what changed since).

use super::{AppState, ok, parse};
use crate::error::{AppError, AppResult};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaArgs {
    id: String,
    #[serde(default)]
    database: Option<String>,
}

/// The diagram should never spin forever: a slow server ends with a message
const GRAPH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

async fn read_graph(session: &crate::manager::Session, database: Option<&str>) -> AppResult<Vec<crate::model::SchemaTable>> {
    tokio::time::timeout(GRAPH_TIMEOUT, session.schema_graph(database))
        .await
        .map_err(|_| AppError::Timeout(format!("reading the schema took longer than {} s", GRAPH_TIMEOUT.as_secs())))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeysArgs {
    connection_id: String,
    #[serde(default)]
    database: Option<String>,
}

pub(super) const COMMANDS: &[&str] = &["schema_graph", "schema_snapshots", "schema_snapshot_save", "list_virtual_keys", "save_virtual_key", "delete_virtual_key"];

pub(super) async fn run(state: &AppState, command: &str, args: Value) -> AppResult<Value> {
    match command {
        "schema_graph" => {
            let a: SchemaArgs = parse(args)?;
            let session = state.manager.get(&a.id).await?;
            ok(read_graph(&session, a.database.as_deref()).await?)
        }
        "schema_snapshots" => {
            let a: SchemaArgs = parse(args)?;
            ok(state.store.schema_snapshots(&a.id, a.database.as_deref())?)
        }
        // "mark as seen": the live schema becomes the new snapshot
        "schema_snapshot_save" => {
            let a: SchemaArgs = parse(args)?;
            let session = state.manager.get(&a.id).await?;
            let tables = read_graph(&session, a.database.as_deref()).await?;
            ok(state.store.add_schema_snapshot(&a.id, a.database.as_deref(), tables)?)
        }
        "list_virtual_keys" => {
            let a: KeysArgs = parse(args)?;
            ok(state.store.virtual_keys(&a.connection_id, a.database.as_deref())?)
        }
        "save_virtual_key" => {
            let key: crate::model::VirtualKey = parse(args)?;
            ok(state.store.save_virtual_key(key)?)
        }
        "delete_virtual_key" => {
            let a: super::IdArgs = parse(args)?;
            state.store.delete_virtual_key(&a.id)?;
            ok(serde_json::json!(null))
        }
        other => Err(super::unknown(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;

    #[tokio::test]
    async fn graph_and_snapshots_of_a_sqlite_database() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        dispatch(&state, "execute_sql", json!({ "id": id, "sql": "create table parent (id integer primary key, name text); create table child (id integer primary key, parent_id integer references parent(id))" }))
            .await
            .unwrap();
        let graph = dispatch(&state, "schema_graph", json!({ "id": id })).await.unwrap();
        let child = graph.as_array().unwrap().iter().find(|t| t["name"] == "child").unwrap();
        assert_eq!(child["foreignKeys"][0]["refTable"], "parent");
        assert_eq!(child["columns"][1]["name"], "parent_id");

        assert_eq!(dispatch(&state, "schema_snapshots", json!({ "id": id })).await.unwrap(), json!([]));
        let saved = dispatch(&state, "schema_snapshot_save", json!({ "id": id })).await.unwrap();
        assert_eq!(saved["tables"].as_array().unwrap().len(), graph.as_array().unwrap().len());
        let list = dispatch(&state, "schema_snapshots", json!({ "id": id })).await.unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
    }
}
