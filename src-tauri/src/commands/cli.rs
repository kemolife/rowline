//! The `rowline` command line tool: is it installed, and install it.

use super::{AppState, ok};
use crate::error::{AppError, AppResult};
use serde_json::{Value, json};

pub(super) const COMMANDS: &[&str] = &["cli_status", "install_cli"];

pub(super) async fn run(_state: &AppState, command: &str, _args: Value) -> AppResult<Value> {
    match command {
        "cli_status" => {
            let link = dirs::home_dir().map(|h| h.join(".local/bin/rowline"));
            let target = link.as_ref().and_then(|l| std::fs::read_link(l).ok());
            ok(json!({
                "installed": target.is_some(),
                "link": link.map(|l| l.display().to_string()),
                "target": target.map(|t| t.display().to_string()),
                "socket": crate::cli::socket_path().display().to_string(),
            }))
        }
        "install_cli" => {
            let exe = std::env::current_exe()?;
            ok(crate::cli::install_link(&exe).map_err(AppError::msg)?)
        }
        other => Err(super::unknown(other)),
    }
}
