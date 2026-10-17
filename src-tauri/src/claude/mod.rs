//! Claude panel backend: chat events, Production approvals, the MCP server and the Claude Code runner.

pub mod approvals;
pub mod cli;
pub mod events;
pub mod mcp;
pub mod runner;

use crate::error::{AppError, AppResult};
use approvals::Approvals;
use events::ChatHub;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

/// Where Claude Code reaches Rowline's MCP server
#[derive(Debug, Clone)]
pub struct McpEndpoint {
    pub port: u16,
    pub token: String,
}

impl McpEndpoint {
    pub fn url(&self, chat_id: &str) -> String {
        format!("http://127.0.0.1:{}/mcp/{chat_id}", self.port)
    }
}

/// A connection a chat may use, with the database selected in Rowline (MySQL)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConnection {
    pub id: String,
    #[serde(default)]
    pub database: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ChatConfig {
    /// The first one is the chat's own connection
    pub connection_ids: Vec<String>,
    pub databases: HashMap<String, Option<String>>,
}

impl ChatConfig {
    fn from_connections(list: Vec<ChatConnection>) -> Self {
        let mut c = ChatConfig::default();
        for item in list {
            if !c.connection_ids.contains(&item.id) {
                c.connection_ids.push(item.id.clone());
            }
            c.databases.insert(item.id, item.database);
        }
        c
    }

    pub fn database_for(&self, id: &str) -> Option<String> {
        self.databases.get(id).cloned().flatten()
    }
}

pub struct ClaudeState {
    pub hub: Arc<ChatHub>,
    pub approvals: Arc<Approvals>,
    pub endpoint: OnceLock<McpEndpoint>,
    /// Working folder for chats without a project folder (empty, inside the app's data folder)
    pub work_dir: PathBuf,
    /// Folder of client-errors.log
    pub log_dir: PathBuf,
    /// Tests point this at scripts/fake-claude.sh
    pub bin_override: Mutex<Option<PathBuf>>,
    /// One Claude Code process per chat
    pub runners: tokio::sync::Mutex<HashMap<String, runner::ChatRunner>>,
    /// Tests: makes the binary lookup slow, to open the Stop/Close race window
    #[cfg(test)]
    pub locate_delay: Mutex<Option<std::time::Duration>>,
    chats: Mutex<HashMap<String, ChatConfig>>,
    stop_signals: Mutex<HashMap<String, Arc<Notify>>>,
}

impl ClaudeState {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            hub: Arc::default(),
            approvals: Arc::default(),
            endpoint: OnceLock::new(),
            work_dir: data_dir.join("claude-workdir"),
            log_dir: data_dir.to_path_buf(),
            bin_override: Mutex::new(None),
            runners: tokio::sync::Mutex::new(HashMap::new()),
            #[cfg(test)]
            locate_delay: Mutex::new(None),
            chats: Mutex::new(HashMap::new()),
            stop_signals: Mutex::new(HashMap::new()),
        }
    }

    pub fn open_chat(&self, connections: Vec<ChatConnection>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        if let Ok(mut chats) = self.chats.lock() {
            chats.insert(id.clone(), ChatConfig::from_connections(connections));
        }
        self.hub.create(&id);
        id
    }

    pub fn set_connections(&self, chat_id: &str, connections: Vec<ChatConnection>) -> AppResult<()> {
        let mut chats = self.chats.lock().map_err(|_| AppError::msg("chat lock poisoned"))?;
        let chat = chats.get_mut(chat_id).ok_or_else(|| AppError::msg(format!("Unknown chat: {chat_id}")))?;
        *chat = ChatConfig::from_connections(connections);
        Ok(())
    }

    pub fn chat(&self, chat_id: &str) -> AppResult<ChatConfig> {
        self.chats
            .lock()
            .ok()
            .and_then(|c| c.get(chat_id).cloned())
            .ok_or_else(|| AppError::msg(format!("Unknown chat: {chat_id}")))
    }

    pub fn chat_ids(&self) -> Vec<String> {
        self.chats.lock().map(|c| c.keys().cloned().collect()).unwrap_or_default()
    }

    pub fn remove_chat(&self, chat_id: &str) {
        if let Ok(mut c) = self.chats.lock() {
            c.remove(chat_id);
        }
        if let Ok(mut s) = self.stop_signals.lock() {
            s.remove(chat_id);
        }
        self.hub.remove(chat_id);
    }

    /// Notified when the user presses Stop; running tools give up.
    pub fn stop_signal(&self, chat_id: &str) -> Arc<Notify> {
        self.stop_signals.lock().map(|mut s| s.entry(chat_id.to_string()).or_default().clone()).unwrap_or_default()
    }
}
