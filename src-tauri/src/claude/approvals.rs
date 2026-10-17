//! Production queries wait here until the user clicks Run or Deny in the panel.

use super::events::{ChatEvent, ChatHub};
use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;

#[derive(Default)]
pub struct Approvals {
    /// request id -> (chat id, answer channel)
    pending: Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>,
}

impl Approvals {
    /// Shows the SQL in the chat and waits for Run / Deny. No answer within `timeout` = Deny.
    /// If the caller drops this future (Stop), the request is removed and shown as denied.
    pub async fn ask(&self, hub: &ChatHub, chat_id: &str, connection_id: &str, connection_name: &str, sql: &str, timeout: Duration) -> bool {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        if let Ok(mut p) = self.pending.lock() {
            p.insert(request_id.clone(), (chat_id.to_string(), tx));
        }
        let mut guard = AskGuard { approvals: self, hub, chat_id, request_id: request_id.clone(), finished: false };
        hub.push(chat_id, ChatEvent::Approval { request_id: request_id.clone(), connection: connection_id.into(), connection_name: connection_name.into(), sql: sql.into() });
        let allowed = matches!(tokio::time::timeout(timeout, rx).await, Ok(Ok(true)));
        guard.finished = true;
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&request_id);
        }
        hub.push(chat_id, ChatEvent::ApprovalAnswered { request_id, allowed });
        allowed
    }

    pub fn answer(&self, request_id: &str, allow: bool) -> AppResult<()> {
        let entry = self.pending.lock().ok().and_then(|mut p| p.remove(request_id));
        match entry {
            Some((_, tx)) => {
                let _ = tx.send(allow);
                Ok(())
            }
            None => Err(AppError::msg("This request is no longer waiting for an answer.")),
        }
    }

    pub fn deny_all(&self, chat_id: &str) {
        let senders: Vec<oneshot::Sender<bool>> = match self.pending.lock() {
            Ok(mut p) => {
                let ids: Vec<String> = p.iter().filter(|(_, (c, _))| c == chat_id).map(|(id, _)| id.clone()).collect();
                ids.into_iter().filter_map(|id| p.remove(&id)).map(|(_, tx)| tx).collect()
            }
            Err(_) => Vec::new(),
        };
        for tx in senders {
            let _ = tx.send(false);
        }
    }
}

/// Cleans up a request whose `ask` future was dropped before it finished.
struct AskGuard<'a> {
    approvals: &'a Approvals,
    hub: &'a ChatHub,
    chat_id: &'a str,
    request_id: String,
    finished: bool,
}

impl Drop for AskGuard<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(mut p) = self.approvals.pending.lock() {
            p.remove(&self.request_id);
        }
        self.hub.push(self.chat_id, ChatEvent::ApprovalAnswered { request_id: std::mem::take(&mut self.request_id), allowed: false });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::events::{ChatEvent, ChatHub};
    use std::sync::Arc;
    use std::time::Duration;

    async fn first_request_id(hub: &ChatHub) -> String {
        loop {
            for e in hub.wait_after("c1", 0, Duration::from_secs(1)).await.unwrap() {
                if let ChatEvent::Approval { request_id, .. } = e.event {
                    return request_id;
                }
            }
        }
    }

    #[tokio::test]
    async fn allow_deny_and_timeout() {
        let hub = Arc::new(ChatHub::default());
        hub.create("c1");
        let approvals = Arc::new(Approvals::default());

        let (h, a) = (hub.clone(), approvals.clone());
        let asked = tokio::spawn(async move { a.ask(&h, "c1", "conn", "Prod DB", "SELECT 1", Duration::from_secs(5)).await });
        let id = first_request_id(&hub).await;
        approvals.answer(&id, true).unwrap();
        assert!(asked.await.unwrap());

        assert!(!approvals.ask(&hub, "c1", "conn", "Prod DB", "SELECT 2", Duration::from_millis(30)).await, "timeout means deny");
        assert!(approvals.answer("unknown", true).is_err());
    }

    #[tokio::test]
    async fn stop_denies_open_requests() {
        let hub = Arc::new(ChatHub::default());
        hub.create("c1");
        let approvals = Arc::new(Approvals::default());
        let (h, a) = (hub.clone(), approvals.clone());
        let asked = tokio::spawn(async move { a.ask(&h, "c1", "conn", "Prod DB", "SELECT 1", Duration::from_secs(5)).await });
        first_request_id(&hub).await;
        approvals.deny_all("c1");
        assert!(!asked.await.unwrap());
    }

    #[tokio::test]
    async fn dropped_request_is_answered_as_denied() {
        let hub = Arc::new(ChatHub::default());
        hub.create("c1");
        let approvals = Arc::new(Approvals::default());
        let (h, a) = (hub.clone(), approvals.clone());
        let asked = tokio::spawn(async move { a.ask(&h, "c1", "conn", "Prod DB", "SELECT 1", Duration::from_secs(5)).await });
        let id = first_request_id(&hub).await;
        asked.abort();
        let _ = asked.await;
        assert!(approvals.pending.lock().unwrap().is_empty(), "the request is removed");
        assert!(approvals.answer(&id, true).is_err());
        let events = hub.wait_after("c1", 0, Duration::from_millis(10)).await.unwrap();
        assert!(events.iter().any(|e| e.event == ChatEvent::ApprovalAnswered { request_id: id.clone(), allowed: false }), "{events:?}");
    }
}
