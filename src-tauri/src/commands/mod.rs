//! All backend commands behind one entry point: `dispatch(state, name, args)`.
//! The app exposes it as the Tauri command `call`, the dev bridge as `POST /api/call`.

use crate::error::{AppError, AppResult};
use crate::manager::Manager;
use crate::store::Store;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

mod chat;
mod connections;
mod data;
mod files;
mod jobs;
mod queries;
mod schema;
#[cfg(test)]
mod test_support;

pub(crate) use connections::project_folder;

pub struct AppState {
    pub store: Store,
    pub manager: Manager,
    pub jobs: crate::backup::Jobs,
    pub claude: crate::claude::ClaudeState,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        let claude = crate::claude::ClaudeState::new(store.dir());
        Self { store, manager: Manager::default(), jobs: Default::default(), claude }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IdArgs {
    pub(super) id: String,
}

pub(super) fn parse<T: DeserializeOwned>(args: Value) -> AppResult<T> {
    serde_json::from_value(args).map_err(|e| AppError::msg(format!("Invalid arguments: {e}")))
}

pub(super) fn ok<T: serde::Serialize>(v: T) -> AppResult<Value> {
    Ok(serde_json::to_value(v)?)
}

pub(super) fn unknown(command: &str) -> AppError {
    AppError::msg(format!("Unknown command: {command}"))
}

/// Sends a command to the module of its domain.
pub async fn dispatch(state: &AppState, command: &str, args: Value) -> AppResult<Value> {
    if connections::COMMANDS.contains(&command) {
        connections::run(state, command, args).await
    } else if data::COMMANDS.contains(&command) {
        data::run(state, command, args).await
    } else if queries::COMMANDS.contains(&command) {
        queries::run(state, command, args).await
    } else if jobs::COMMANDS.contains(&command) {
        jobs::run(state, command, args).await
    } else if files::COMMANDS.contains(&command) {
        files::run(state, command, args).await
    } else if chat::COMMANDS.contains(&command) {
        chat::run(state, command, args).await
    } else if schema::COMMANDS.contains(&command) {
        schema::run(state, command, args).await
    } else if command == "ping" {
        ok(json!({ "ok": true }))
    } else {
        Err(unknown(command))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every command a domain lists is really handled there (no "Unknown command"), and no name is in two domains.
    #[tokio::test]
    async fn every_listed_command_is_routed() {
        let all: Vec<&str> = [connections::COMMANDS, data::COMMANDS, queries::COMMANDS, jobs::COMMANDS, files::COMMANDS, chat::COMMANDS, schema::COMMANDS].concat();
        let mut sorted = all.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), all.len(), "a command is listed twice");
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(crate::store::Store::new(dir.path().join("cfg"), crate::store::SecretStore::file(dir.path().join("s.json"))).unwrap());
        for command in all {
            if let Err(e) = dispatch(&state, command, Value::Null).await {
                assert!(!e.to_string().starts_with("Unknown command"), "{command} is not handled");
            }
        }
        assert!(dispatch(&state, "nope", Value::Null).await.unwrap_err().to_string().starts_with("Unknown command"));
    }
}
