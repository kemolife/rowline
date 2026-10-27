pub mod claude;
pub mod backup;
pub mod cli;
pub mod commands;
pub mod drivers;
pub mod error;
pub mod manager;
pub mod model;
pub mod readonly;
pub mod sqlgen;
pub mod store;

use commands::AppState;
use std::sync::Arc;
use store::{SecretStore, Store};
use tauri::Manager as _;

/// Single entry point for all backend commands (see commands::dispatch).
#[tauri::command]
async fn call(
    state: tauri::State<'_, Arc<AppState>>,
    command: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, error::AppError> {
    commands::dispatch(&state, &command, args.unwrap_or(serde_json::Value::Null)).await
}

/// The app was called Tabula. Moves a folder written under the old name to the new one, once,
/// so saved connections, passwords and UI state are kept. Never overwrites an existing folder.
pub fn move_old_folder(old: &std::path::Path, new: &std::path::Path) {
    if old.is_dir() && !new.exists() {
        if let Some(parent) = new.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(old, new);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // before the window exists: config folder (connections, passwords) and WebKit storage (theme, open tabs)
    if let (Some(config), Some(home)) = (dirs::config_dir(), dirs::home_dir()) {
        move_old_folder(&config.join("app.tabula.desktop"), &config.join("app.rowline.desktop"));
        move_old_folder(&home.join("Library/WebKit/app.tabula.desktop"), &home.join("Library/WebKit/app.rowline.desktop"));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let store = Store::new(dir.clone(), SecretStore::file(dir.join("secrets.json")))?;
            let state = Arc::new(AppState::new(store));
            tauri::async_runtime::block_on(claude::mcp::start(state.clone()))?;
            // the `rowline` command; without it the app still works (e.g. a second Rowline is running)
            if let Err(e) = tauri::async_runtime::block_on(cli::server::start(state.clone(), cli::socket_path())) {
                eprintln!("rowline command unavailable: {e}");
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![call])
        .build(tauri::generate_context!())
        .expect("error while building Rowline")
        .run(|app, event| match event {
            // Rowline has one window: closing it quits, so nothing keeps running unseen in the background
            // (an open prod connection, the `rowline` command socket).
            tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Destroyed, .. } if app.webview_windows().is_empty() => app.exit(0),
            // Quitting must not leave Claude Code processes behind.
            tauri::RunEvent::Exit => {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    tauri::async_runtime::block_on(claude::runner::kill_all(&state));
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::move_old_folder;

    #[test]
    fn moves_the_old_folder_once_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let (old, new) = (dir.path().join("old"), dir.path().join("new"));
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("connections.json"), "[]").unwrap();
        move_old_folder(&old, &new);
        assert!(!old.exists());
        assert_eq!(std::fs::read_to_string(new.join("connections.json")).unwrap(), "[]");

        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("connections.json"), "old").unwrap();
        move_old_folder(&old, &new);
        assert_eq!(std::fs::read_to_string(new.join("connections.json")).unwrap(), "[]", "an existing folder is kept");
        assert!(old.exists());
    }
}
