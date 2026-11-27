//! Postgres through the app commands (need ROWLINE_TEST_POSTGRES, else they return early).

use super::test_support::*;
use crate::drivers::postgres::UNLOCK_MESSAGE;
use serde_json::Value;

fn names(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn the_form_lists_postgres_databases_without_templates() {
    let Some(p) = pg_env() else { return };
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap());
    let form = json!({ "id": "", "name": "t", "engine": "postgres", "host": p[0], "port": p[1].parse::<u16>().unwrap(), "user": p[2], "password": p[3], "database": "half_typed_nam" });
    let list = names(&dispatch(&state, "list_databases_for", form).await.unwrap());
    assert!(list.contains(&p[4]), "{list:?}");
    assert!(!list.iter().any(|n| n.starts_with("template")), "{list:?}");
}

#[tokio::test]
async fn schemas_objects_and_pages_follow_the_schema_argument() {
    let dir = tempfile::tempdir().unwrap();
    let Some((state, id)) = postgres_state(dir.path(), "dev", None).await else { return };
    let schemas = names(&dispatch(&state, "list_schemas", json!({ "id": id })).await.unwrap());
    assert_eq!(schemas[0], "public", "{schemas:?}");
    assert!(schemas.contains(&"billing".to_string()), "{schemas:?}");
    assert!(!schemas.iter().any(|s| s.starts_with("pg_") || s == "information_schema"), "{schemas:?}");

    let objs = dispatch(&state, "list_objects", json!({ "id": id, "schema": "billing" })).await.unwrap();
    assert_eq!(objs.as_array().unwrap().iter().map(|o| o["name"].as_str().unwrap()).collect::<Vec<_>>(), ["invoices"]);
    let public = dispatch(&state, "list_objects", json!({ "id": id })).await.unwrap();
    assert!(public.to_string().contains("\"Orders\""), "no schema = public: {public}");

    let st = dispatch(&state, "table_structure", json!({ "id": id, "schema": "billing", "table": "invoices" })).await.unwrap();
    assert!(st.to_string().contains("due"), "{st}");
    let page = dispatch(&state, "select_page", json!({ "id": id, "request": { "schema": "billing", "table": "invoices", "limit": 5, "offset": 0 } })).await.unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 5);
    let n = dispatch(&state, "count_rows", json!({ "id": id, "request": { "schema": "billing", "table": "invoices", "limit": 5, "offset": 0 } })).await.unwrap();
    assert_eq!(n, 20);
    let values = dispatch(&state, "common_values", json!({ "id": id, "schema": "billing", "table": "invoices", "column": "id" })).await.unwrap();
    assert!(!values.as_array().unwrap().is_empty());
    let graph = dispatch(&state, "schema_graph", json!({ "id": id, "schema": "billing" })).await.unwrap();
    assert_eq!(graph.as_array().unwrap().len(), 1, "{graph}");
    // the SQL editor: search_path = "<schema>", public
    let res = dispatch(&state, "execute_sql", json!({ "id": id, "schema": "billing", "sql": "select count(*) from invoices" })).await.unwrap();
    assert_eq!(res[0]["rows"][0][0], 20);
    let preview = dispatch(&state, "preview_changes", json!({
        "id": id, "schema": "billing", "table": "invoices", "changes": { "updates": [{ "key": {"id": 1}, "values": {"due": "2030-01-01"} }] }
    })).await.unwrap();
    assert_eq!(preview[0], "UPDATE \"billing\".\"invoices\" SET \"due\" = '2030-01-01' WHERE \"id\" = 1");
}

#[tokio::test]
async fn the_active_schema_is_kept_per_connection() {
    let dir = tempfile::tempdir().unwrap();
    let Some((state, id)) = postgres_state(dir.path(), "dev", None).await else { return };
    assert_eq!(state.manager.schema(&id), None);
    dispatch(&state, "set_active_schema", json!({ "id": id, "schema": "billing" })).await.unwrap();
    assert_eq!(state.manager.schema(&id).as_deref(), Some("billing"));
    dispatch(&state, "set_active_schema", json!({ "id": id })).await.unwrap();
    assert_eq!(state.manager.schema(&id), None);
    dispatch(&state, "set_active_schema", json!({ "id": id, "schema": "billing" })).await.unwrap();
    dispatch(&state, "disconnect", json!({ "id": id })).await.unwrap();
    assert_eq!(state.manager.schema(&id), None, "closing forgets it");
}

#[tokio::test]
async fn prod_is_read_only_until_the_tab_unlocks() {
    let dir = tempfile::tempdir().unwrap();
    let Some((state, id)) = postgres_state(dir.path(), "prod", None).await else { return };
    let sql = "create temp table rowline_t5 (id int)";
    let err = dispatch(&state, "execute_sql", json!({ "id": id, "sql": sql })).await.unwrap_err().to_string();
    assert_eq!(err, UNLOCK_MESSAGE);
    let err = dispatch(&state, "execute_sql", json!({ "id": id, "sql": sql, "unlocked": false })).await.unwrap_err().to_string();
    assert_eq!(err, UNLOCK_MESSAGE);
    // temp table: gone with the session reset after the call
    dispatch(&state, "execute_sql", json!({ "id": id, "sql": sql, "unlocked": true })).await.unwrap();
    let changes = json!({ "updates": [{ "key": {"id": 1}, "values": {"name": "x"} }] });
    let err = dispatch(&state, "apply_changes", json!({ "id": id, "table": "customers", "changes": changes })).await.unwrap_err().to_string();
    assert_eq!(err, UNLOCK_MESSAGE);
    // reads work while locked
    let page = dispatch(&state, "select_page", json!({ "id": id, "request": { "table": "customers", "limit": 1, "offset": 0 } })).await.unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn postgres_backup_is_not_offered() {
    let dir = tempfile::tempdir().unwrap();
    let Some((state, id)) = postgres_state(dir.path(), "dev", None).await else { return };
    for cmd in ["backup_start", "restore_start"] {
        let err = dispatch(&state, cmd, json!({ "id": id, "path": dir.path().join("x.sql") })).await.unwrap_err().to_string();
        assert_eq!(err, "Backup is not available for PostgreSQL yet.");
    }
}
