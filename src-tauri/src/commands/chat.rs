//! The Claude panel: Claude Code status, chats, approvals.

use super::{AppState, ok, parse};
use crate::error::AppResult;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStartArgs {
    connections: Vec<crate::claude::ChatConnection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatConnectionsArgs {
    chat_id: String,
    connections: Vec<crate::claude::ChatConnection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatIdArgs {
    chat_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSendArgs {
    chat_id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatEventsArgs {
    chat_id: String,
    after: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalArgs {
    request_id: String,
    allow: bool,
}

pub(super) const COMMANDS: &[&str] = &["claude_status", "chat_start", "chat_set_connections", "chat_send", "chat_events", "chat_stop", "chat_close", "chat_close_all", "answer_approval"];

pub(super) async fn run(state: &AppState, command: &str, args: Value) -> AppResult<Value> {
    match command {
        "claude_status" => {
            let path = crate::claude::runner::locate_bin(state).await;
            let version = match path.clone() {
                Some(p) => tokio::task::spawn_blocking(move || crate::claude::cli::version(&p)).await.ok().flatten(),
                None => None,
            };
            ok(json!({ "found": path.is_some(), "path": path, "version": version }))
        }
        "chat_start" => {
            let a: ChatStartArgs = parse(args)?;
            ok(json!({ "chatId": state.claude.open_chat(a.connections) }))
        }
        "chat_set_connections" => {
            let a: ChatConnectionsArgs = parse(args)?;
            state.claude.set_connections(&a.chat_id, a.connections)?;
            ok(true)
        }
        "chat_send" => {
            let a: ChatSendArgs = parse(args)?;
            crate::claude::runner::send(state, &a.chat_id, &a.text).await?;
            ok(true)
        }
        "chat_events" => {
            let a: ChatEventsArgs = parse(args)?;
            ok(state.claude.hub.wait_after(&a.chat_id, a.after, std::time::Duration::from_secs(25)).await?)
        }
        "chat_stop" => {
            let a: ChatIdArgs = parse(args)?;
            crate::claude::runner::stop(state, &a.chat_id).await?;
            ok(true)
        }
        "chat_close" => {
            let a: ChatIdArgs = parse(args)?;
            crate::claude::runner::close(state, &a.chat_id).await?;
            ok(true)
        }
        "chat_close_all" => {
            crate::claude::runner::close_all(state).await?;
            ok(true)
        }
        "answer_approval" => {
            let a: ApprovalArgs = parse(args)?;
            state.claude.approvals.answer(&a.request_id, a.allow)?;
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
    async fn chat_round_trip_with_fake_claude() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        *state.claude.bin_override.lock().unwrap() = Some(fake_claude());
        let status = dispatch(&state, "claude_status", json!({})).await.unwrap();
        assert_eq!(status["found"], true);
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })).await.unwrap();
        let events = events_until_done(&state, &chat).await;
        assert!(matches!(events[0], ChatEvent::User { .. }));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::TextDelta { .. } | ChatEvent::Text { .. })));
        assert!(matches!(events.last(), Some(ChatEvent::Done { .. })));
    }

    #[tokio::test]
    async fn missing_claude_shows_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        *state.claude.bin_override.lock().unwrap() = Some(dir.path().join("no-such-claude"));
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })).await.unwrap();
        let events = events_until_done(&state, &chat).await;
        assert!(matches!(events.last(), Some(ChatEvent::Error { error_kind, .. }) if error_kind == "not_installed"), "{events:?}");
    }

    #[tokio::test]
    async fn too_wide_saved_folder_is_refused_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        *state.claude.bin_override.lock().unwrap() = Some(fake_claude());
        // a path saved before the folder check existed: it contains Rowline's settings folder
        let mut config = state.store.connection(&id).unwrap();
        config.project_folder = Some(dir.path().to_str().unwrap().into());
        state.store.save_connection(config).unwrap();
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })).await.unwrap();
        let events = events_until_done(&state, &chat).await;
        assert!(matches!(events.last(), Some(ChatEvent::Error { error_kind, .. }) if error_kind == "folder"), "{events:?}");
        assert!(state.claude.runners.lock().await.get(&chat).is_none_or(|r| !r.has_child()), "no Claude Code process may start");
    }

    #[tokio::test]
    async fn mcp_config_file_lives_only_while_the_chat_is_open() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        *state.claude.bin_override.lock().unwrap() = Some(fake_claude());
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })).await.unwrap();
        events_until_done(&state, &chat).await;
        let file = state.store.dir().join("claude-mcp").join(format!("{chat}.json"));
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(std::fs::read_to_string(&file).unwrap().contains(&state.claude.endpoint.get().unwrap().token));
        dispatch(&state, "chat_close", json!({ "chatId": chat })).await.unwrap();
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn closing_a_chat_kills_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        let (script, pid_file) = pid_claude(dir.path());
        *state.claude.bin_override.lock().unwrap() = Some(script);
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })).await.unwrap();
        let pid = read_pid(&pid_file).await;
        assert!(alive(pid), "Claude Code runs before Close");
        dispatch(&state, "chat_close", json!({ "chatId": chat })).await.unwrap();
        assert!(dispatch(&state, "chat_events", json!({ "chatId": chat, "after": 0 })).await.is_err());
        assert!(state.claude.runners.lock().await.get(&chat).is_none());
        assert!(gone_within(pid, std::time::Duration::from_secs(2)).await, "process {pid} still runs after Close");
    }

    #[tokio::test]
    async fn chat_close_all_closes_every_chat_and_kills_its_process() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        let (script, pid_file) = pid_claude(dir.path());
        *state.claude.bin_override.lock().unwrap() = Some(script);
        let running = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        let idle = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        dispatch(&state, "chat_send", json!({ "chatId": running, "text": "hi" })).await.unwrap();
        let pid = read_pid(&pid_file).await;
        dispatch(&state, "chat_close_all", json!({})).await.unwrap();
        for chat in [&running, &idle] {
            assert!(dispatch(&state, "chat_events", json!({ "chatId": chat, "after": 0 })).await.is_err(), "chat {chat} is closed");
        }
        assert!(state.claude.runners.lock().await.is_empty());
        assert!(gone_within(pid, std::time::Duration::from_secs(2)).await, "process {pid} still runs after chat_close_all");
        // nothing open: still fine
        dispatch(&state, "chat_close_all", json!({})).await.unwrap();
    }

    #[tokio::test]
    async fn app_exit_kills_running_processes() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        let (script, pid_file) = pid_claude(dir.path());
        *state.claude.bin_override.lock().unwrap() = Some(script);
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })).await.unwrap();
        let pid = read_pid(&pid_file).await;
        crate::claude::runner::kill_all(&state).await;
        assert!(gone_within(pid, std::time::Duration::from_secs(2)).await, "process {pid} still runs after exit");
    }

    #[tokio::test]
    async fn close_during_binary_lookup_starts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        let (script, marker) = marking_claude(dir.path());
        *state.claude.bin_override.lock().unwrap() = Some(script);
        *state.claude.locate_delay.lock().unwrap() = Some(std::time::Duration::from_millis(500));
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        let (sent, closed) = tokio::join!(dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })), async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            dispatch(&state, "chat_close", json!({ "chatId": chat })).await
        });
        sent.unwrap();
        closed.unwrap();
        assert!(state.claude.runners.lock().await.get(&chat).is_none());
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(!marker.exists(), "Claude Code was started for a closed chat");
    }

    #[tokio::test]
    async fn stop_during_binary_lookup_cancels_the_send() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        let (script, marker) = marking_claude(dir.path());
        *state.claude.bin_override.lock().unwrap() = Some(script);
        *state.claude.locate_delay.lock().unwrap() = Some(std::time::Duration::from_millis(500));
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        let (sent, stopped) = tokio::join!(dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })), async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            dispatch(&state, "chat_stop", json!({ "chatId": chat })).await
        });
        sent.unwrap();
        stopped.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(!marker.exists(), "Claude Code was started after Stop");
        // the next message works as usual
        *state.claude.locate_delay.lock().unwrap() = None;
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "again" })).await.unwrap();
        let events = events_until_done(&state, &chat).await;
        assert!(matches!(events.last(), Some(ChatEvent::Done { .. })), "{events:?}");
        assert!(marker.exists());
    }

    #[tokio::test]
    async fn stop_marks_the_chat_and_the_next_message_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        *state.claude.bin_override.lock().unwrap() = Some(fake_claude());
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })).await.unwrap();
        events_until_done(&state, &chat).await;
        dispatch(&state, "chat_stop", json!({ "chatId": chat })).await.unwrap();
        let all: Vec<crate::claude::events::NumberedEvent> =
            serde_json::from_value(dispatch(&state, "chat_events", json!({ "chatId": chat, "after": 0 })).await.unwrap()).unwrap();
        assert!(all.iter().any(|e| e.event == ChatEvent::Stopped));
        // a stopped chat starts a new process on the next message (no "exited" error from the killed one)
        let after = all.last().unwrap().seq;
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "again" })).await.unwrap();
        let next: Vec<crate::claude::events::NumberedEvent> =
            serde_json::from_value(dispatch(&state, "chat_events", json!({ "chatId": chat, "after": after })).await.unwrap()).unwrap();
        assert!(!next.iter().any(|e| matches!(&e.event, ChatEvent::Error { error_kind, .. } if error_kind == "exited")), "{next:?}");
    }
}
