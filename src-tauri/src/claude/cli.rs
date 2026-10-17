//! Finding and talking to the installed Claude Code CLI (`claude -p` with stream-json input and output).

use serde_json::{Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs a command with no stdin and no stderr; returns stdout if it exits successfully within `timeout`.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // A background process that inherited stdout can keep the pipe open: do not wait for EOF forever
                let out = rx.recv_timeout(Duration::from_secs(1)).ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Login files may print banners, so the path is the last non-empty line.
fn last_line_path(output: &str) -> Option<PathBuf> {
    let line = output.lines().map(str::trim).filter(|l| !l.is_empty()).last()?;
    let p = PathBuf::from(line);
    p.is_file().then_some(p)
}

/// Settings Claude Code loads: none of the user's or project's (no hooks, no extra permissions).
/// The Task 1 probe confirmed that `""` is accepted.
const SETTING_SOURCES: &str = "";

/// Finds the `claude` binary. A GUI app has a short PATH, so common install places are checked first.
pub fn locate(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = override_path {
        return p.is_file().then(|| p.to_path_buf());
    }
    if let Ok(p) = std::env::var("ROWLINE_CLAUDE_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join(".claude/local/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    if let Some(p) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(p);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = Command::new(shell);
    cmd.args(["-lc", "command -v claude"]);
    last_line_path(&run_with_timeout(cmd, PROBE_TIMEOUT)?)
}

pub fn version(bin: &Path) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.arg("--version");
    run_with_timeout(cmd, PROBE_TIMEOUT).map(|o| o.trim().to_string())
}

pub struct RunOptions {
    /// File written by `write_mcp_config` (the token is not passed in argv, where `ps` shows it)
    pub mcp_config_path: String,
    pub project_folder: Option<String>,
    pub resume: Option<String>,
    pub system_prompt: String,
}

/// MCP config for one chat: only Rowline's server, with its secret token.
pub fn mcp_config(url: &str, token: &str) -> String {
    json!({ "mcpServers": { "rowline": { "type": "http", "url": url, "headers": { "Authorization": format!("Bearer {token}") } } } }).to_string()
}

/// Writes the MCP config to `<dir>/<chat_id>.json`, readable only by the current user (folder 0700, file 0600).
pub fn write_mcp_config(dir: &Path, chat_id: &str, url: &str, token: &str) -> std::io::Result<PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let path = dir.join(format!("{chat_id}.json"));
    let _ = std::fs::remove_file(&path);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
    f.write_all(mcp_config(url, token).as_bytes())?;
    Ok(path)
}

pub fn build_args(o: &RunOptions) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages",
        "--strict-mcp-config", "--setting-sources", SETTING_SOURCES,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push("--mcp-config".into());
    args.push(o.mcp_config_path.clone());
    args.push("--tools".into());
    let mut allowed = vec!["mcp__rowline".to_string()];
    // A relative folder or "/" would give a wrong or far too wide rule: treat both as no folder.
    let folder = o.project_folder.as_deref().filter(|f| f.starts_with('/') && !f.trim_end_matches('/').is_empty());
    match folder {
        Some(folder) => {
            args.push("Read,Grep,Glob".into());
            // Characters like spaces or brackets have special meaning in permission rules, so no rule is
            // written for such paths; the runner sets the working folder, which Claude Code can read anyway.
            let plain = folder.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c));
            if plain {
                // `//` = absolute path in Claude Code permission rules; Grep and Glob follow Read rules
                allowed.push(format!("Read(/{}/**)", folder.trim_end_matches('/')));
            }
        }
        None => args.push(String::new()),
    }
    args.push("--allowedTools".into());
    args.extend(allowed);
    args.push("--append-system-prompt".into());
    args.push(o.system_prompt.clone());
    if let Some(id) = &o.resume {
        args.push("--resume".into());
        args.push(id.clone());
    }
    args
}

pub fn system_prompt(has_project_folder: bool) -> String {
    let mut p = String::from(
        "You are the assistant inside Rowline, a desktop database client. Answer the user's questions about their databases.\n\
         Use the rowline tools: list_connections first, then list_tables and describe_table, then run_select.\n\
         You can only read data. Never say or imply that you changed data.\n\
         Write SQL for the connection's engine (MySQL or SQLite). Select only the columns you need and use LIMIT.\n\
         When an answer is based on a query, mention the query briefly. Answer briefly, in the user's language.",
    );
    if has_project_folder {
        p.push_str("\nThe user's application code is in the current folder. Read it (Read, Grep, Glob) when the meaning of a table, column or value is unclear.");
    }
    p
}

#[derive(Debug, Clone, PartialEq)]
pub enum StreamItem {
    SessionId(String),
    TextDelta(String),
    Text(String),
    Activity(String),
    Done { duration_ms: Option<u64>, cost_usd: Option<f64>, error: Option<String> },
    Ignored,
    Unknown(String),
}

pub fn parse_line(line: &str) -> Vec<StreamItem> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![StreamItem::Unknown(line.chars().take(200).collect())];
    };
    let text = |v: &Value| v.as_str().map(str::to_string);
    match v["type"].as_str().unwrap_or("") {
        "system" => match (v["subtype"].as_str(), text(&v["session_id"])) {
            (Some("init"), Some(id)) => vec![StreamItem::SessionId(id)],
            _ => vec![StreamItem::Ignored],
        },
        "stream_event" => {
            let e = &v["event"];
            if e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta" {
                text(&e["delta"]["text"]).map(|t| vec![StreamItem::TextDelta(t)]).unwrap_or_default()
            } else {
                vec![StreamItem::Ignored]
            }
        }
        "assistant" => v["message"]["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| match b["type"].as_str()? {
                        "text" => text(&b["text"]).map(StreamItem::Text),
                        "tool_use" => activity(b),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        "user" => vec![StreamItem::Ignored],
        "rate_limit_event" => vec![StreamItem::Ignored],
        "result" => {
            let failed = v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().is_some_and(|s| s != "success");
            let error = failed.then(|| {
                text(&v["result"]).filter(|r| !r.trim().is_empty()).unwrap_or_else(|| v["subtype"].as_str().unwrap_or("error").to_string())
            });
            vec![StreamItem::Done { duration_ms: v["duration_ms"].as_u64(), cost_usd: v["total_cost_usd"].as_f64(), error }]
        }
        other => vec![StreamItem::Unknown(other.to_string())],
    }
}

/// A status line for built-in tools; Rowline's own tools show as cards instead.
fn activity(block: &Value) -> Option<StreamItem> {
    let name = block["name"].as_str()?;
    let input = &block["input"];
    let label = match name {
        n if n.starts_with("mcp__rowline__") => return None,
        "Read" => format!("Reading {}", short_path(input["file_path"].as_str().unwrap_or("a file"))),
        "Grep" => format!("Searching for \"{}\"", input["pattern"].as_str().unwrap_or("")),
        "Glob" => format!("Looking for files {}", input["pattern"].as_str().unwrap_or("")),
        other => format!("Using {other}"),
    };
    Some(StreamItem::Activity(label))
}

/// Last two path parts: /a/b/models/user.ts -> models/user.ts
fn short_path(p: &str) -> String {
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    parts[parts.len().saturating_sub(2)..].join("/")
}

pub fn classify_error(message: &str) -> &'static str {
    let m = message.to_lowercase();
    if ["login", "log in", "logged in", "authenticat", "api key", "oauth"].iter().any(|k| m.contains(k)) {
        "login"
    } else if ["usage limit", "rate limit", "limit reached", "limit will reset", "out of credits", "credit balance"].iter().any(|k| m.contains(k)) {
        "limit"
    } else {
        "claude"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(folder: Option<&str>) -> RunOptions {
        RunOptions { mcp_config_path: "/tmp/rowline-mcp/c.json".into(), project_folder: folder.map(Into::into), resume: None, system_prompt: "p".into() }
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> &'a str {
        let i = args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("missing {flag}"));
        &args[i + 1]
    }

    #[test]
    fn args_without_project_folder_disable_all_builtin_tools() {
        let args = build_args(&opts(None));
        assert_eq!(value_after(&args, "--tools"), "");
        assert_eq!(value_after(&args, "--allowedTools"), "mcp__rowline");
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert_eq!(value_after(&args, "--mcp-config"), "/tmp/rowline-mcp/c.json");
        assert!(!args.iter().any(|a| a.contains("Bearer")), "the token must not be in argv");
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn mcp_config_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mcp_dir = dir.path().join("claude-mcp");
        let path = write_mcp_config(&mcp_dir, "c1", "http://127.0.0.1:9/mcp/c1", "secret").unwrap();
        let mcp: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(mcp["mcpServers"]["rowline"]["type"], "http");
        assert_eq!(mcp["mcpServers"]["rowline"]["url"], "http://127.0.0.1:9/mcp/c1");
        assert_eq!(mcp["mcpServers"]["rowline"]["headers"]["Authorization"], "Bearer secret");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&mcp_dir).unwrap().permissions().mode() & 0o777, 0o700);
        // writing again (respawn after Stop) replaces the file
        write_mcp_config(&mcp_dir, "c1", "http://127.0.0.1:9/mcp/c1", "other").unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("Bearer other"));
    }

    #[test]
    fn args_with_project_folder_allow_reading_only_there() {
        let mut o = opts(Some("/Users/me/app"));
        o.resume = Some("s1".into());
        let args = build_args(&o);
        assert_eq!(value_after(&args, "--tools"), "Read,Grep,Glob");
        let i = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(&args[i + 1..i + 3], ["mcp__rowline", "Read(//Users/me/app/**)"]);
        assert_eq!(value_after(&args, "--resume"), "s1");
    }

    #[test]
    fn parses_hand_written_lines() {
        assert_eq!(parse_line(r#"{"type":"system","subtype":"init","session_id":"abc"}"#), vec![StreamItem::SessionId("abc".into())]);
        assert_eq!(
            parse_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"#),
            vec![StreamItem::TextDelta("Hi".into())]
        );
        assert_eq!(
            parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","name":"Read","input":{"file_path":"/a/b/models/user.ts"}},{"type":"tool_use","name":"mcp__rowline__run_select","input":{}}]}}"#),
            vec![StreamItem::Text("Hello".into()), StreamItem::Activity("Reading models/user.ts".into())]
        );
        assert_eq!(
            parse_line(r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"total_cost_usd":0.01,"result":"Hello"}"#),
            vec![StreamItem::Done { duration_ms: Some(1200), cost_usd: Some(0.01), error: None }]
        );
        assert_eq!(
            parse_line(r#"{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"#),
            vec![StreamItem::Done { duration_ms: None, cost_usd: None, error: Some("Invalid API key · Please run /login".into()) }]
        );
        assert_eq!(
            parse_line(r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}"#),
            vec![StreamItem::Done { duration_ms: None, cost_usd: None, error: Some("error_max_turns".into()) }]
        );
        assert_eq!(parse_line(r#"{"type":"user","message":{}}"#), vec![StreamItem::Ignored]);
        assert!(matches!(parse_line(r#"{"type":"brand_new"}"#)[0], StreamItem::Unknown(_)));
        assert!(matches!(parse_line("not json")[0], StreamItem::Unknown(_)));
    }

    #[test]
    fn parses_the_recorded_answer() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude/hello.jsonl")).unwrap();
        let items: Vec<StreamItem> = text.lines().flat_map(parse_line).collect();
        assert!(items.iter().any(|i| matches!(i, StreamItem::SessionId(_))));
        assert!(items.iter().any(|i| matches!(i, StreamItem::TextDelta(_) | StreamItem::Text(_))));
        assert!(items.iter().any(|i| matches!(i, StreamItem::Done { error: None, .. })));
        let unknown: Vec<_> = items.iter().filter(|i| matches!(i, StreamItem::Unknown(_))).collect();
        assert!(unknown.is_empty(), "add these types to parse_line as Ignored if harmless: {unknown:?}");
    }

    #[test]
    fn classifies_login_and_limit_errors() {
        assert_eq!(classify_error("Invalid API key · Please run /login"), "login");
        assert_eq!(classify_error("Not logged in"), "login");
        assert_eq!(classify_error("Claude AI usage limit reached|1760000000"), "limit");
        assert_eq!(classify_error("Something else"), "claude");
        // a context or token limit is not the plan's usage limit
        assert_eq!(classify_error("Prompt is too long: context limit exceeded"), "claude");
        assert_eq!(classify_error("You've hit your usage limit"), "limit");
    }

    #[test]
    fn odd_project_folders() {
        let args = build_args(&opts(Some("/Users/me/app/")));
        assert_eq!(&args[args.iter().position(|a| a == "--allowedTools").unwrap() + 2], "Read(//Users/me/app/**)");
        for f in ["/", "relative/dir"] {
            let args = build_args(&opts(Some(f)));
            assert_eq!(value_after(&args, "--tools"), "", "{f}");
            assert_eq!(value_after(&args, "--allowedTools"), "mcp__rowline");
        }
        let args = build_args(&opts(Some("/Users/me/My App")));
        assert_eq!(value_after(&args, "--tools"), "Read,Grep,Glob");
        assert_eq!(value_after(&args, "--allowedTools"), "mcp__rowline");
        assert!(!args.iter().any(|a| a.starts_with("Read(")));
    }

    #[test]
    fn last_line_path_skips_banners() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("claude");
        std::fs::write(&bin, "x").unwrap();
        let out = format!("Welcome!\n{}\n\n", bin.display());
        assert_eq!(last_line_path(&out), Some(bin));
        assert_eq!(last_line_path("banner only\n"), None);
        assert_eq!(last_line_path(""), None);
    }

    #[test]
    fn timeout_kills_slow_commands() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let slow = dir.path().join("slow.sh");
        std::fs::write(&slow, "#!/bin/sh\nsleep 10\n").unwrap();
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        let start = Instant::now();
        assert_eq!(run_with_timeout(Command::new(&slow), Duration::from_millis(200)), None);
        assert!(start.elapsed() < Duration::from_secs(5));
        let fast = dir.path().join("fast.sh");
        std::fs::write(&fast, "#!/bin/sh\necho hi\n").unwrap();
        std::fs::set_permissions(&fast, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(run_with_timeout(Command::new(&fast), Duration::from_secs(5)).as_deref(), Some("hi\n"));
    }

    #[test]
    fn background_process_holding_stdout_does_not_hang() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("bg.sh");
        std::fs::write(&script, "#!/bin/sh\n(sleep 10) &\necho /bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let start = Instant::now();
        let _ = run_with_timeout(Command::new(&script), Duration::from_secs(5));
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn locate_respects_override() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("claude");
        std::fs::write(&fake, "#!/bin/sh\n").unwrap();
        assert_eq!(locate(Some(&fake)), Some(fake.clone()));
        assert_eq!(locate(Some(&dir.path().join("missing"))), None);
    }
}
