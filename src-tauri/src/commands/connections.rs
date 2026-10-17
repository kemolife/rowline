//! Saved connections: list, save, delete, test, open and close.

use super::{AppState, ok, parse};
use crate::error::{AppError, AppResult};
use serde_json::Value;
use super::IdArgs;
use crate::manager::Session;
use crate::model::*;



pub(super) const COMMANDS: &[&str] = &["list_connections", "save_connection", "delete_connection", "test_connection", "connect", "disconnect"];

pub(super) async fn run(state: &AppState, command: &str, args: Value) -> AppResult<Value> {
    match command {
        "list_connections" => ok(state.store.connections()?),
        "save_connection" => ok(save_connection(state, parse(args)?)?),
        "delete_connection" => {
            let a: IdArgs = parse(args)?;
            state.manager.remove(&a.id).await;
            state.store.delete_connection(&a.id)?;
            ok(true)
        }
        "test_connection" => {
            let input: ConnectionInput = parse(args)?;
            let password = resolve_password(state, &input)?;
            let session = Session::open(&input.config, password.as_deref()).await?;
            ok(session.server_info().await?)
        }
        "connect" => {
            let a: IdArgs = parse(args)?;
            let config = state.store.connection(&a.id)?;
            let password = state.store.secrets.get(&a.id)?;
            let session = Session::open(&config, password.as_deref()).await?;
            let info = session.server_info().await?;
            state.manager.insert(&a.id, session).await;
            ok(info)
        }
        "disconnect" => {
            let a: IdArgs = parse(args)?;
            state.manager.remove(&a.id).await;
            ok(true)
        }
        other => Err(super::unknown(other)),
    }
}

fn save_connection(state: &AppState, input: ConnectionInput) -> AppResult<ConnectionConfig> {
    let mut config = input.config;
    if config.name.trim().is_empty() {
        return Err(AppError::msg("Name is required"));
    }
    config.project_folder = match config.project_folder.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(folder) => Some(project_folder(state.store.dir(), folder)?),
        None => None,
    };
    if config.id.is_empty() {
        config.id = uuid::Uuid::new_v4().to_string();
    }
    if let Some(pw) = input.password {
        if pw.is_empty() {
            state.store.secrets.delete(&config.id)?;
        } else {
            state.store.secrets.set(&config.id, &pw)?;
        }
    }
    state.store.save_connection(config.clone())?;
    Ok(config)
}

/// The canonical project folder path. Refuses folders that would show Claude too much:
/// the disk root, the home folder or any folder above it, Rowline's config folder (passwords live there),
/// anything inside it, and any folder above it (e.g. ~/Library).
/// The runner checks again before every start, so older saved paths are covered too.
pub(crate) fn project_folder(config_dir: &std::path::Path, folder: &str) -> AppResult<String> {
    let path = std::path::Path::new(folder);
    if !path.is_dir() {
        return Err(AppError::msg(format!("Project folder not found: {folder}")));
    }
    let canonical = std::fs::canonicalize(path)?;
    if canonical.parent().is_none() {
        return Err(AppError::msg("The project folder can't be the disk root. Choose your app's folder."));
    }
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).and_then(|h| std::fs::canonicalize(h).ok());
    if home.as_deref().is_some_and(|h| h.starts_with(&canonical)) {
        return Err(AppError::msg("The project folder can't be your home folder or a folder above it. Choose your app's folder."));
    }
    let config_dir = std::fs::canonicalize(config_dir).unwrap_or_else(|_| config_dir.to_path_buf());
    if canonical.starts_with(&config_dir) || config_dir.starts_with(&canonical) {
        return Err(AppError::msg("The project folder can't contain or be inside Rowline's settings folder. Choose your app's folder."));
    }
    canonical.to_str().map(str::to_string).ok_or_else(|| AppError::msg(format!("Project folder path is not valid text: {folder}")))
}

/// Password from the form, or the stored one when the form left it unchanged.
fn resolve_password(state: &AppState, input: &ConnectionInput) -> AppResult<Option<String>> {
    match &input.password {
        Some(p) => Ok(Some(p.clone())),
        None if !input.config.id.is_empty() => state.store.secrets.get(&input.config.id),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;

    #[tokio::test]
    async fn claude_settings_default_by_environment_and_validate_folder() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap());
        let base = json!({ "id": "", "name": "p", "engine": "sqlite", "filePath": "/tmp/x.sqlite" });

        let mut prod = base.clone();
        prod["environment"] = json!("prod");
        let saved: ConnectionConfig = serde_json::from_value(dispatch(&state, "save_connection", prod).await.unwrap()).unwrap();
        assert_eq!(saved.claude_access(), ClaudeAccess::Schema);

        let saved: ConnectionConfig = serde_json::from_value(dispatch(&state, "save_connection", base.clone()).await.unwrap()).unwrap();
        assert_eq!(saved.claude_access(), ClaudeAccess::Data);

        let mut off = base.clone();
        off["claudeAccess"] = json!("off");
        let saved: ConnectionConfig = serde_json::from_value(dispatch(&state, "save_connection", off).await.unwrap()).unwrap();
        assert_eq!(saved.claude_access(), ClaudeAccess::Off);

        let mut bad = base.clone();
        bad["projectFolder"] = json!("/definitely/not/here");
        let err = dispatch(&state, "save_connection", bad).await.unwrap_err();
        assert!(err.to_string().contains("Project folder not found"));

        let mut good = base;
        let project = dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        good["projectFolder"] = json!(project.to_str().unwrap());
        assert!(dispatch(&state, "save_connection", good).await.is_ok());
    }

    #[tokio::test]
    async fn project_folder_is_canonical_and_not_too_wide() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap());
        let app = dir.path().join("app");
        std::fs::create_dir_all(app.join("src")).unwrap();
        let save = |folder: String| dispatch(&state, "save_connection", json!({ "id": "", "name": "p", "engine": "sqlite", "filePath": "/tmp/x.sqlite", "projectFolder": folder }));

        // stored as the real path: no `..`, no trailing slash, symlinks resolved (/var -> /private/var on macOS)
        let saved = save(format!("{}/src/../", app.display())).await.unwrap();
        let canonical = std::fs::canonicalize(&app).unwrap();
        assert_eq!(saved["projectFolder"], canonical.to_str().unwrap());

        let err = |r: AppResult<Value>| r.unwrap_err().to_string();
        assert!(err(save("/".into()).await).contains("disk root"));
        let home = std::env::var("HOME").unwrap();
        assert!(err(save(home.clone()).await).contains("home folder"));
        assert!(err(save(format!("{home}/")).await).contains("home folder"));
        // folders above home or above the settings folder would show Claude everything below them
        let above_home = std::path::Path::new(&home).parent().unwrap().to_str().unwrap().to_string();
        assert!(err(save(above_home).await).contains("home folder"));
        assert!(err(save(dir.path().to_str().unwrap().into()).await).contains("settings folder"));
        let cfg = state.store.dir().to_path_buf();
        std::fs::create_dir_all(cfg.join("claude-workdir")).unwrap();
        assert!(err(save(cfg.to_str().unwrap().into()).await).contains("settings folder"));
        assert!(err(save(cfg.join("claude-workdir").to_str().unwrap().into()).await).contains("settings folder"));
    }
}
