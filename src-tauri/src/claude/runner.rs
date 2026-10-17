//! One Claude Code process per chat: messages go to its stdin, its stdout becomes chat events.

use super::cli::{self, RunOptions, StreamItem};
use super::events::{ChatEvent, ChatHub};
use super::ChatConfig;
use crate::commands::AppState;
use crate::error::AppResult;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

#[derive(Default)]
pub struct ChatRunner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    alive: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    /// Claude Code session id, for --resume after Stop
    session_id: Arc<Mutex<Option<String>>>,
    /// Bumped by Stop; a `send` that started before a Stop does not spawn or write
    generation: u64,
}

impl ChatRunner {
    #[cfg(test)]
    pub fn has_child(&self) -> bool {
        self.child.is_some()
    }

    fn needs_spawn(&self) -> bool {
        self.stdin.is_none() || !self.alive.load(Ordering::SeqCst)
    }
}

fn error(kind: &str, message: impl Into<String>) -> ChatEvent {
    ChatEvent::Error { error_kind: kind.into(), message: message.into() }
}

/// Finds the Claude Code binary off the async executor (`cli::locate` may run a login shell for up to 5 s).
pub async fn locate_bin(state: &AppState) -> Option<PathBuf> {
    let override_path = state.claude.bin_override.lock().ok().and_then(|p| p.clone());
    #[cfg(test)]
    if let Some(delay) = state.claude.locate_delay.lock().ok().and_then(|d| *d) {
        tokio::time::sleep(delay).await;
    }
    tokio::task::spawn_blocking(move || cli::locate(override_path.as_deref())).await.ok().flatten()
}

/// Sends a user message, starting Claude Code when needed.
pub async fn send(state: &AppState, chat_id: &str, text: &str) -> AppResult<()> {
    let chat = state.claude.chat(chat_id)?;
    let hub = state.claude.hub.clone();
    hub.push(chat_id, ChatEvent::User { text: text.to_string() });
    // The binary is resolved without holding the runners lock; `None` = not looked up yet.
    let mut bin: Option<Option<PathBuf>> = None;
    // Generation seen when the message arrived; a Stop after that cancels this send.
    let mut generation: Option<u64> = None;
    loop {
        let needs_spawn = {
            let mut runners = state.claude.runners.lock().await;
            if state.claude.chat(chat_id).is_err() {
                return Ok(());
            }
            // The runner is created here only, while the chat still exists; Close removes it after removing the chat.
            let runner = runners.entry(chat_id.to_string()).or_default();
            generation.get_or_insert(runner.generation);
            runner.needs_spawn()
        };
        if needs_spawn && bin.is_none() {
            bin = Some(locate_bin(state).await);
        }
        let mut runners = state.claude.runners.lock().await;
        // Closed or stopped while the binary was looked up: do nothing (the User event is already in the chat).
        if state.claude.chat(chat_id).is_err() {
            return Ok(());
        }
        let Some(runner) = runners.get_mut(chat_id) else { return Ok(()) };
        if Some(runner.generation) != generation {
            return Ok(());
        }
        if runner.needs_spawn() {
            // The process died between the check and now: look the binary up first (without the lock)
            let Some(found) = bin.take() else { continue };
            if let Err(event) = spawn(state, chat_id, &chat, runner, found) {
                hub.push(chat_id, event);
                return Ok(());
            }
        }
        let line = serde_json::json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }).to_string() + "\n";
        let Some(stdin) = runner.stdin.as_mut() else { return Ok(()) };
        let written = async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await
        }
        .await;
        if let Err(e) = written {
            runner.alive.store(false, Ordering::SeqCst);
            // this error is the one the user sees; the stdout reader must not add a second "exited"
            runner.stopping.store(true, Ordering::SeqCst);
            hub.push(chat_id, error("exited", format!("Could not send the message to Claude Code: {e}")));
        }
        return Ok(());
    }
}

fn spawn(state: &AppState, chat_id: &str, chat: &ChatConfig, runner: &mut ChatRunner, bin: Option<PathBuf>) -> Result<(), ChatEvent> {
    let endpoint = state.claude.endpoint.get().ok_or_else(|| error("internal", "Claude tools are not ready yet. Try again in a moment."))?;
    let bin = bin.ok_or_else(|| error("not_installed", "Claude Code is not installed. Install it, run `claude` once in Terminal and log in, then try again."))?;
    let primary = chat.connection_ids.first().and_then(|id| state.store.connection(id).ok());
    // checked again at every start: the folder may have changed since it was saved, or was saved before the check existed
    let project_folder = match primary.and_then(|c| c.project_folder) {
        Some(folder) => Some(
            crate::commands::project_folder(state.store.dir(), &folder)
                .map_err(|e| error("folder", format!("{e} Edit the connection's project folder.")))?,
        ),
        None => None,
    };
    let cwd: PathBuf = project_folder.clone().map(PathBuf::from).unwrap_or_else(|| state.claude.work_dir.clone());
    let _ = std::fs::create_dir_all(&cwd);
    let mcp_config_path = cli::write_mcp_config(&mcp_config_dir(state), chat_id, &endpoint.url(chat_id), &endpoint.token)
        .map_err(|e| error("internal", format!("Could not write the Claude tools config: {e}")))?;
    let options = RunOptions {
        mcp_config_path: mcp_config_path.to_string_lossy().into_owned(),
        project_folder: project_folder.clone(),
        resume: runner.session_id.lock().ok().and_then(|s| s.clone()),
        system_prompt: cli::system_prompt(project_folder.is_some()),
    };
    let mut child = tokio::process::Command::new(&bin)
        .args(cli::build_args(&options))
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| error("not_installed", format!("Could not start Claude Code ({}): {e}", bin.display())))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(error("internal", "Claude Code started without output pipes."));
    };
    runner.stdin = child.stdin.take();
    // an old process being replaced (e.g. after a broken pipe) must not report "exited" into the chat
    runner.stopping.store(true, Ordering::SeqCst);
    if let Some(old) = runner.child.take() {
        kill(old);
    }
    runner.alive = Arc::new(AtomicBool::new(true));
    runner.stopping = Arc::new(AtomicBool::new(false));
    runner.child = Some(child);
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    tokio::spawn(read_stderr(stderr, tail.clone()));
    tokio::spawn(read_stdout(Reader {
        stdout,
        hub: state.claude.hub.clone(),
        chat_id: chat_id.to_string(),
        session_id: runner.session_id.clone(),
        alive: runner.alive.clone(),
        stopping: runner.stopping.clone(),
        tail,
        log_dir: state.claude.log_dir.clone(),
    }));
    Ok(())
}

struct Reader {
    stdout: ChildStdout,
    hub: Arc<ChatHub>,
    chat_id: String,
    session_id: Arc<Mutex<Option<String>>>,
    alive: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    tail: Arc<Mutex<VecDeque<String>>>,
    log_dir: PathBuf,
}

async fn read_stdout(r: Reader) {
    let mut lines = BufReader::new(r.stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        for item in cli::parse_line(&line) {
            let event = match item {
                StreamItem::SessionId(id) => {
                    if let Ok(mut s) = r.session_id.lock() {
                        *s = Some(id);
                    }
                    continue;
                }
                StreamItem::TextDelta(text) => ChatEvent::TextDelta { text },
                StreamItem::Text(text) => ChatEvent::Text { text },
                StreamItem::Activity(label) => ChatEvent::Activity { label },
                StreamItem::Done { duration_ms, cost_usd, error: None } => ChatEvent::Done { duration_ms, cost_usd },
                StreamItem::Done { error: Some(message), .. } => error(cli::classify_error(&message), message),
                StreamItem::Ignored => continue,
                StreamItem::Unknown(what) => {
                    let _ = crate::store::append_log(&r.log_dir, &format!("Unknown Claude Code output: {what}"));
                    continue;
                }
            };
            r.hub.push(&r.chat_id, event);
        }
    }
    r.alive.store(false, Ordering::SeqCst);
    if !r.stopping.load(Ordering::SeqCst) {
        let detail = r.tail.lock().map(|t| t.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default();
        let kind = match cli::classify_error(&detail) {
            "claude" => "exited",
            other => other,
        };
        let message = if detail.trim().is_empty() { "Claude Code stopped.".to_string() } else { format!("Claude Code stopped: {detail}") };
        r.hub.push(&r.chat_id, error(kind, message));
    }
}

async fn read_stderr(stderr: ChildStderr, tail: Arc<Mutex<VecDeque<String>>>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(mut t) = tail.lock() {
            t.push_back(line);
            while t.len() > 20 {
                t.pop_front();
            }
        }
    }
}

/// Stop button: kill the process, deny open approvals, stop running tools. The next message resumes the session.
pub async fn stop(state: &AppState, chat_id: &str) -> AppResult<()> {
    if let Some(r) = state.claude.runners.lock().await.get_mut(chat_id) {
        r.generation += 1;
        r.stopping.store(true, Ordering::SeqCst);
        r.alive.store(false, Ordering::SeqCst);
        r.stdin = None;
        if let Some(child) = r.child.take() {
            kill(child);
        }
    }
    state.claude.approvals.deny_all(chat_id);
    state.claude.stop_signal(chat_id).notify_waiters();
    state.claude.hub.push(chat_id, ChatEvent::Stopped);
    Ok(())
}

/// Kills the process and reaps it in the background (no zombie left behind).
fn kill(mut child: Child) {
    let _ = child.start_kill();
    if let Ok(rt) = tokio::runtime::Handle::try_current() {
        rt.spawn(async move {
            let _ = child.wait().await;
        });
    }
}

/// App exit: kill every Claude Code process. Waits at most 1 s for the runners lock (a `send` may hold it).
pub async fn kill_all(state: &AppState) {
    let runners = match state.claude.runners.try_lock() {
        Ok(r) => Some(r),
        Err(_) => tokio::time::timeout(std::time::Duration::from_secs(1), state.claude.runners.lock()).await.ok(),
    };
    if let Some(mut runners) = runners {
        for r in runners.values_mut() {
            r.stopping.store(true, Ordering::SeqCst);
            if let Some(mut child) = r.child.take() {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(std::time::Duration::from_millis(500), child.wait()).await;
            }
        }
    }
    let _ = std::fs::remove_dir_all(mcp_config_dir(state));
}

/// Frontend start (or reload): close every chat of the previous page, so no process is left without a panel.
pub async fn close_all(state: &AppState) -> AppResult<()> {
    let mut ids = state.claude.chat_ids();
    for id in state.claude.runners.lock().await.keys() {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    for id in ids {
        close(state, &id).await?;
    }
    Ok(())
}

/// Connection closed: stop everything and remove the chat.
pub async fn close(state: &AppState, chat_id: &str) -> AppResult<()> {
    stop(state, chat_id).await?;
    state.claude.remove_chat(chat_id);
    state.claude.runners.lock().await.remove(chat_id);
    let _ = std::fs::remove_file(mcp_config_dir(state).join(format!("{chat_id}.json")));
    Ok(())
}

/// Folder of the per-chat MCP config files (they hold the server token), next to the app's other data.
fn mcp_config_dir(state: &AppState) -> PathBuf {
    state.claude.log_dir.join("claude-mcp")
}
