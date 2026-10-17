//! Local files: cell values from a file, exports, the client error log.

use super::{AppState, ok, parse};
use crate::error::{AppError, AppResult};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileArgs {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct PathArgs {
    path: String,
}

/// Largest file a cell can be filled from
const MAX_CELL_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// A UTF-8 text file for a cell value ("Load from file…").
fn read_text_file(path: &str) -> AppResult<String> {
    let size = std::fs::metadata(path)?.len();
    if size > MAX_CELL_FILE_BYTES {
        return Err(AppError::msg(format!("The file is too big for a cell ({} MB; the limit is 10 MB).", size / 1024 / 1024)));
    }
    let bytes = std::fs::read(path)?;
    String::from_utf8(bytes).map_err(|_| AppError::msg("Only text files can be loaded into a cell."))
}

#[derive(Deserialize)]
struct LogArgs {
    message: String,
}

pub(super) const COMMANDS: &[&str] = &["read_text_file", "write_text_file", "log_client_error"];

pub(super) async fn run(state: &AppState, command: &str, args: Value) -> AppResult<Value> {
    match command {
        "read_text_file" => {
            let a: PathArgs = parse(args)?;
            ok(read_text_file(&a.path)?)
        }
        "write_text_file" => {
            let a: WriteFileArgs = parse(args)?;
            std::fs::write(&a.path, a.content)?;
            ok(true)
        }
        "log_client_error" => {
            let a: LogArgs = parse(args)?;
            state.store.log_client_error(&a.message)?;
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
    async fn reads_text_files_for_cells() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap());
        let text = dir.path().join("a.json");
        std::fs::write(&text, "{\"a\": 1}").unwrap();
        assert_eq!(dispatch(&state, "read_text_file", json!({ "path": text })).await.unwrap(), json!("{\"a\": 1}"));
        let bin = dir.path().join("b.bin");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        assert!(dispatch(&state, "read_text_file", json!({ "path": bin })).await.unwrap_err().to_string().contains("text files"));
        let big = dir.path().join("big.txt");
        std::fs::write(&big, vec![b'x'; 10 * 1024 * 1024 + 1]).unwrap();
        assert!(dispatch(&state, "read_text_file", json!({ "path": big })).await.unwrap_err().to_string().contains("too big"));
    }
}
