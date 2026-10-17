//! Helpers shared by the command tests.

pub(crate) use super::{AppState, dispatch};
pub(crate) use crate::claude::events::ChatEvent;
pub(crate) use crate::store::{SecretStore, Store};
pub(crate) use serde_json::json;

pub(crate) fn fake_claude() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-claude.sh").canonicalize().unwrap()
}

pub(crate) async fn sqlite_state(dir: &std::path::Path) -> (std::sync::Arc<AppState>, String) {
    let db = dir.join("c.sqlite");
    rusqlite::Connection::open(&db).unwrap().execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);").unwrap();
    let state = std::sync::Arc::new(AppState::new(Store::new(dir.join("cfg"), SecretStore::file(dir.join("s.json"))).unwrap()));
    let saved = dispatch(&state, "save_connection", json!({ "id": "", "name": "c", "engine": "sqlite", "filePath": db.to_str().unwrap() })).await.unwrap();
    let id = saved["id"].as_str().unwrap().to_string();
    dispatch(&state, "connect", json!({ "id": id })).await.unwrap();
    crate::claude::mcp::start(state.clone()).await.unwrap();
    (state, id)
}

pub(crate) async fn events_until_done(state: &AppState, chat: &str) -> Vec<ChatEvent> {
    let mut all = Vec::new();
    let mut after = 0;
    for _ in 0..50 {
        let batch: Vec<crate::claude::events::NumberedEvent> =
            serde_json::from_value(dispatch(state, "chat_events", json!({ "chatId": chat, "after": after })).await.unwrap()).unwrap_or_default();
        for e in batch {
            after = e.seq;
            let done = matches!(e.event, ChatEvent::Done { .. } | ChatEvent::Error { .. });
            all.push(e.event);
            if done {
                return all;
            }
        }
    }
    panic!("no Done event: {all:?}");
}

pub(crate) fn pid_claude(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let pid_file = dir.join("claude.pid");
    let script = dir.join("pid-claude.sh");
    std::fs::write(&script, format!("#!/bin/sh\nROWLINE_FAKE_CLAUDE_PIDFILE='{}' exec '{}' \"$@\"\n", pid_file.display(), fake_claude().display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, pid_file)
}

pub(crate) async fn read_pid(file: &std::path::Path) -> u32 {
    for _ in 0..100 {
        if let Some(pid) = std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse().ok()) {
            return pid;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("fake Claude Code did not write its pid");
}

pub(crate) fn alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

pub(crate) async fn gone_within(pid: u32, limit: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + limit;
    while std::time::Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}

/// A Claude stand-in that leaves a marker file when it starts, then runs the fake script.
pub(crate) fn marking_claude(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let marker = dir.join("started");
    let script = dir.join("marking-claude.sh");
    std::fs::write(&script, format!("#!/bin/sh\ntouch '{}'\nexec '{}' \"$@\"\n", marker.display(), fake_claude().display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, marker)
}
