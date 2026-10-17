//! Chat events: what the panel shows, numbered so the frontend can poll for "everything after N".

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    User { text: String },
    TextDelta { text: String },
    Text { text: String },
    Activity { label: String },
    /// `database`: the MySQL database the tool uses (None for SQLite or an unknown connection)
    ToolCall { call_id: String, tool: String, connection: Option<String>, database: Option<String>, sql: Option<String> },
    ToolResult { call_id: String, rows: Option<usize>, truncated: bool, elapsed_ms: Option<u64>, error: Option<String> },
    Approval { request_id: String, connection: String, connection_name: String, sql: String },
    ApprovalAnswered { request_id: String, allowed: bool },
    Done { duration_ms: Option<u64>, cost_usd: Option<f64> },
    Stopped,
    Error { error_kind: String, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NumberedEvent {
    pub seq: u64,
    #[serde(flatten)]
    pub event: ChatEvent,
}

#[derive(Default)]
struct ChatLog {
    events: Mutex<Vec<NumberedEvent>>,
    notify: Notify,
}

#[derive(Default)]
pub struct ChatHub {
    chats: Mutex<HashMap<String, Arc<ChatLog>>>,
}

impl ChatHub {
    fn get(&self, chat_id: &str) -> Option<Arc<ChatLog>> {
        self.chats.lock().ok()?.get(chat_id).cloned()
    }

    pub fn create(&self, chat_id: &str) {
        if let Ok(mut chats) = self.chats.lock() {
            chats.entry(chat_id.to_string()).or_default();
        }
    }

    pub fn exists(&self, chat_id: &str) -> bool {
        self.get(chat_id).is_some()
    }

    pub fn remove(&self, chat_id: &str) {
        let log = self.chats.lock().ok().and_then(|mut c| c.remove(chat_id));
        if let Some(log) = log {
            log.notify.notify_waiters();
        }
    }

    /// Adds an event; unknown chats are ignored (the chat was closed meanwhile).
    pub fn push(&self, chat_id: &str, event: ChatEvent) {
        let Some(log) = self.get(chat_id) else { return };
        if let Ok(mut ev) = log.events.lock() {
            let seq = ev.last().map(|e| e.seq).unwrap_or(0) + 1;
            ev.push(NumberedEvent { seq, event });
        }
        log.notify.notify_waiters();
    }

    /// Events with seq > `after`; waits up to `wait` for the first one.
    pub async fn wait_after(&self, chat_id: &str, after: u64, wait: Duration) -> AppResult<Vec<NumberedEvent>> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let log = self.get(chat_id).ok_or_else(|| AppError::msg(format!("Unknown chat: {chat_id}")))?;
            let notified = log.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let new: Vec<NumberedEvent> = log.events.lock().map(|ev| ev.iter().filter(|e| e.seq > after).cloned().collect()).unwrap_or_default();
            if !new.is_empty() {
                return Ok(new);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Ok(Vec::new());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn wait_returns_new_events_and_times_out_empty() {
        let hub = ChatHub::default();
        hub.create("c1");
        hub.push("c1", ChatEvent::User { text: "hi".into() });
        let got = hub.wait_after("c1", 0, Duration::from_millis(50)).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].seq, 1);
        assert!(hub.wait_after("c1", 1, Duration::from_millis(50)).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn wait_wakes_up_on_push() {
        let hub = std::sync::Arc::new(ChatHub::default());
        hub.create("c1");
        let h = hub.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            h.push("c1", ChatEvent::TextDelta { text: "x".into() });
        });
        let got = hub.wait_after("c1", 0, Duration::from_secs(5)).await.unwrap();
        assert_eq!(got[0].event, ChatEvent::TextDelta { text: "x".into() });
    }

    #[tokio::test]
    async fn chats_have_separate_logs() {
        let hub = ChatHub::default();
        hub.create("a");
        hub.create("b");
        hub.push("a", ChatEvent::User { text: "for a".into() });
        assert!(hub.wait_after("b", 0, Duration::from_millis(20)).await.unwrap().is_empty());
        assert!(hub.wait_after("missing", 0, Duration::from_millis(20)).await.is_err());
    }

    #[test]
    fn serializes_for_the_frontend() {
        let e = NumberedEvent { seq: 3, event: ChatEvent::ToolResult { call_id: "x".into(), rows: Some(2), truncated: false, elapsed_ms: Some(5), error: None } };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["seq"], 3);
        assert_eq!(v["kind"], "tool_result");
        assert_eq!(v["callId"], "x");
        assert_eq!(v["elapsedMs"], 5);
        let err = serde_json::to_value(ChatEvent::Error { error_kind: "login".into(), message: "m".into() }).unwrap();
        assert_eq!(err["kind"], "error");
        assert_eq!(err["errorKind"], "login");
    }
}
