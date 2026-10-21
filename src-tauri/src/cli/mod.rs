//! `rowline` on the command line: runs read-only queries through the open Rowline app,
//! so agents (Claude Code and others) can check data without ever seeing a password.
//! The same binary is the app; `main` sends it here when the first argument is a CLI command.

pub mod server;

use serde_json::{Value, json};
use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;

/// Exit codes
pub const EXIT_ERROR: i32 = 1;
/// the query is not read-only
pub const EXIT_BLOCKED: i32 = 2;
/// Rowline is not running
pub const EXIT_NO_APP: i32 = 3;

const COMMANDS: &[&str] = &["connections", "tables", "describe", "query", "help", "--help", "-h", "--version", "-V", "install"];

const HELP: &str = "rowline — read-only database access through the Rowline app

Usage:
  rowline connections                      Open connections: name, environment, engine, database
  rowline tables   [--conn NAME] [--db DB] Tables and views, with estimated row counts
  rowline describe TABLE [--conn NAME] [--db DB]
                                           Columns, indexes and foreign keys of a table
  rowline query    [--conn NAME] [--db DB] [--limit N] [--format json|table|csv] \"SQL\"
                                           Run one read-only statement (SQL can also come on stdin)

Options:
  -c, --conn NAME    Connection by name (any case; a unique part of the name is enough).
                     Not needed when only one connection is open.
  -d, --db DB        MySQL database. Default: the one selected in Rowline.
  -n, --limit N      Most rows to return (default 200, at most 1000).
  -f, --format F     json (default, compact), table or csv.

Rules:
  - Only connections that are open in the Rowline app can be used. Rowline must be running.
  - Read-only: one SELECT, SHOW, DESCRIBE, EXPLAIN or WITH … SELECT statement. Writes, several
    statements, INTO OUTFILE, FOR UPDATE, LOAD_FILE and similar are refused before they reach
    the database, and the query runs in a read-only transaction with a 30 s time limit.
  - Text values longer than 2,048 characters are cut. Every query is logged in Rowline's History.

Exit codes: 0 ok, 1 error, 2 refused (not read-only), 3 Rowline is not running.

Example:
  rowline query --conn \"prod replica\" \"SELECT id, status FROM orders WHERE id = 42\"
";

/// True when the arguments ask for the command line, not the app window.
/// `argv0` is how the program was started: a bare name or ~/.local/bin means a shell started it.
pub fn is_cli(argv0: &str, args: &[String]) -> bool {
    match args.first() {
        Some(a) => COMMANDS.contains(&a.as_str()),
        None => !argv0.contains('/') || argv0.contains("/.local/bin/"),
    }
}

/// Where the app listens. ROWLINE_SOCKET overrides it (tests, dev bridge).
pub fn socket_path() -> PathBuf {
    if let Some(p) = std::env::var_os("ROWLINE_SOCKET") {
        return PathBuf::from(p);
    }
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("app.rowline.desktop").join("rowline.sock")
}

#[derive(Debug, PartialEq, Default)]
pub struct Parsed {
    pub cmd: String,
    pub conn: Option<String>,
    pub db: Option<String>,
    pub limit: Option<usize>,
    pub format: Format,
    /// SQL for query, table name for describe
    pub arg: Option<String>,
}

#[derive(Debug, PartialEq, Clone, Copy, Default)]
pub enum Format {
    #[default]
    Json,
    Table,
    Csv,
}

pub fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut p = Parsed { cmd: args.first().cloned().unwrap_or_else(|| "help".into()), ..Default::default() };
    let mut rest = Vec::new();
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (a.as_str(), None),
        };
        let mut value = |name: &str| inline.clone().or_else(|| it.next().cloned()).ok_or_else(|| format!("{name} needs a value"));
        match flag {
            "-c" | "--conn" | "--connection" => p.conn = Some(value("--conn")?),
            "-d" | "--db" | "--database" => p.db = Some(value("--db")?),
            "-n" | "--limit" => {
                let v = value("--limit")?;
                p.limit = Some(v.parse().map_err(|_| format!("--limit must be a number, got \"{v}\""))?);
            }
            "-f" | "--format" => {
                p.format = match value("--format")?.as_str() {
                    "json" => Format::Json,
                    "table" => Format::Table,
                    "csv" => Format::Csv,
                    other => return Err(format!("Unknown format \"{other}\": use json, table or csv")),
                }
            }
            "--" => rest.extend(it.by_ref().cloned()),
            f if f.starts_with('-') && f.len() > 1 => return Err(format!("Unknown option {f}. See rowline help.")),
            _ => rest.push(a.clone()),
        }
    }
    if !rest.is_empty() {
        p.arg = Some(rest.join(" "));
    }
    Ok(p)
}

/// Sends one request to the app and reads the answer.
fn ask(request: &Value) -> Result<Value, (i32, String)> {
    let path = socket_path();
    let mut stream = std::os::unix::net::UnixStream::connect(&path)
        .map_err(|_| (EXIT_NO_APP, "Rowline is not running. Open the Rowline app and connect to a database.".to_string()))?;
    let io = |e: std::io::Error| (EXIT_ERROR, format!("Talking to Rowline failed: {e}"));
    stream.write_all(format!("{request}\n").as_bytes()).map_err(io)?;
    let mut out = String::new();
    stream.read_to_string(&mut out).map_err(io)?;
    let answer: Value = serde_json::from_str(&out).map_err(|e| (EXIT_ERROR, format!("Rowline sent a bad answer: {e}")))?;
    if answer["ok"] == true {
        Ok(answer["data"].clone())
    } else {
        let code = if answer["blocked"] == true { EXIT_BLOCKED } else { EXIT_ERROR };
        Err((code, answer["error"].as_str().unwrap_or("Unknown error").to_string()))
    }
}

/// Runs the command line and returns the exit code.
pub fn main(args: Vec<String>) -> i32 {
    match run(&args) {
        Ok(text) => {
            print!("{text}");
            0
        }
        Err((code, msg)) => {
            eprintln!("rowline: {msg}");
            code
        }
    }
}

fn run(args: &[String]) -> Result<String, (i32, String)> {
    let p = parse(args).map_err(|e| (EXIT_ERROR, e))?;
    let request = match p.cmd.as_str() {
        "help" | "--help" | "-h" => return Ok(HELP.to_string()),
        "--version" | "-V" => return Ok(format!("rowline {}\n", env!("CARGO_PKG_VERSION"))),
        "install" => return install().map_err(|e| (EXIT_ERROR, e)),
        "connections" => json!({ "cmd": "connections" }),
        "tables" => json!({ "cmd": "tables", "conn": p.conn, "db": p.db }),
        "describe" => {
            let table = p.arg.clone().ok_or((EXIT_ERROR, "Name the table: rowline describe TABLE".to_string()))?;
            json!({ "cmd": "describe", "conn": p.conn, "db": p.db, "table": table })
        }
        "query" => {
            let sql = match p.arg.as_deref() {
                Some("-") | None => read_stdin().map_err(|e| (EXIT_ERROR, e))?,
                Some(s) => s.to_string(),
            };
            json!({ "cmd": "query", "conn": p.conn, "db": p.db, "sql": sql, "limit": p.limit })
        }
        other => return Err((EXIT_ERROR, format!("Unknown command \"{other}\". See rowline help."))),
    };
    let data = ask(&request)?;
    Ok(render(&p.cmd, &data, p.format))
}

fn read_stdin() -> Result<String, String> {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err("Give the SQL as an argument: rowline query \"SELECT …\"".into());
    }
    let mut sql = String::new();
    stdin.lock().read_to_string(&mut sql).map_err(|e| e.to_string())?;
    Ok(sql)
}

/// Links ~/.local/bin/rowline to this program (the app binary), so shells and agents find it.
fn install() -> Result<String, String> {
    let report = install_link(&std::env::current_exe().map_err(|e| e.to_string())?)?;
    Ok(format!("{report}\n"))
}

/// The link target must be the Rowline app binary; a file (not a link) already there is left alone.
pub fn install_link(exe: &std::path::Path) -> Result<String, String> {
    if exe.file_name().and_then(|n| n.to_str()) != Some("rowline") {
        return Err("Install the command from the Rowline app (this program is not the app).".into());
    }
    let bin = dirs::home_dir().ok_or("No home folder")?.join(".local/bin");
    install_link_in(exe, &bin)
}

pub fn install_link_in(exe: &std::path::Path, bin: &std::path::Path) -> Result<String, String> {
    std::fs::create_dir_all(bin).map_err(|e| e.to_string())?;
    let link = bin.join("rowline");
    match std::fs::symlink_metadata(&link) {
        Ok(m) if m.file_type().is_symlink() => std::fs::remove_file(&link).map_err(|e| e.to_string())?,
        Ok(_) => return Err(format!("{} exists and is not a link; remove it first.", link.display())),
        Err(_) => {}
    }
    std::os::unix::fs::symlink(exe, &link).map_err(|e| e.to_string())?;
    let on_path = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d == bin));
    let mut msg = format!("Installed {} → {}", link.display(), exe.display());
    if !on_path {
        msg.push_str(&format!("\n{} is not on your PATH. Add this line to ~/.zshrc:\n  export PATH=\"$HOME/.local/bin:$PATH\"", bin.display()));
    }
    Ok(msg)
}

fn render(cmd: &str, data: &Value, format: Format) -> String {
    match (cmd, format) {
        ("query", Format::Table) => table(&strings(&data["columns"]), &rows(&data["rows"])) + &footer(data),
        ("query", Format::Csv) => csv(&strings(&data["columns"]), &rows(&data["rows"])),
        ("connections", Format::Table) => {
            let list = data.as_array().cloned().unwrap_or_default();
            let cols = ["name", "environment", "engine", "database"].map(String::from).to_vec();
            let body: Vec<Vec<String>> = list.iter().map(|c| cols.iter().map(|k| cell(&c[k.as_str()])).collect()).collect();
            table(&cols, &body)
        }
        _ => format!("{data}\n"),
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default()
}

fn rows(v: &Value) -> Vec<Vec<String>> {
    v.as_array().map(|rows| rows.iter().map(|r| r.as_array().map(|c| c.iter().map(cell).collect()).unwrap_or_default()).collect()).unwrap_or_default()
}

fn cell(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn footer(data: &Value) -> String {
    let n = data["rowCount"].as_u64().unwrap_or(0);
    let more = if data["truncated"] == true { " (more rows exist; use --limit or a narrower WHERE)" } else { "" };
    format!("{n} row{}{more}\n", if n == 1 { "" } else { "s" })
}

/// Plain text columns, padded; newlines in values become spaces
pub fn table(cols: &[String], rows: &[Vec<String>]) -> String {
    let clean = |s: &str| s.replace(['\n', '\r', '\t'], " ");
    let mut width: Vec<usize> = cols.iter().map(|c| c.chars().count()).collect();
    for r in rows {
        for (i, v) in r.iter().enumerate() {
            if i < width.len() {
                width[i] = width[i].max(clean(v).chars().count().min(60));
            }
        }
    }
    let line = |cells: Vec<String>| {
        let parts: Vec<String> = cells
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let v: String = clean(v).chars().take(60).collect();
                format!("{v:<w$}", w = width.get(i).copied().unwrap_or(0))
            })
            .collect();
        parts.join("  ").trim_end().to_string() + "\n"
    };
    let mut out = line(cols.to_vec());
    out += &line(width.iter().map(|w| "-".repeat(*w)).collect());
    for r in rows {
        out += &line(r.clone());
    }
    out
}

pub fn csv(cols: &[String], rows: &[Vec<String>]) -> String {
    let field = |s: &str| if s.contains([',', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() };
    let line = |r: &[String]| r.iter().map(|s| field(s)).collect::<Vec<_>>().join(",") + "\n";
    let mut out = line(cols);
    for r in rows {
        out += &line(r);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn knows_when_it_is_the_command_line() {
        assert!(is_cli("/Applications/Rowline.app/Contents/MacOS/rowline", &args(&["query", "SELECT 1"])));
        assert!(!is_cli("/Applications/Rowline.app/Contents/MacOS/rowline", &[]), "Finder starts the app");
        assert!(!is_cli("/x/target/debug/rowline", &[]), "tauri dev starts the app");
        assert!(is_cli("rowline", &[]), "typed in a shell: help");
        assert!(is_cli("/Users/me/.local/bin/rowline", &[]));
        assert!(!is_cli("/Applications/Rowline.app/Contents/MacOS/rowline", &args(&["-psn_0_123"])));
    }

    #[test]
    fn parses_options() {
        let p = parse(&args(&["query", "--conn", "prod replica", "-n", "50", "--format=table", "SELECT", "1"])).unwrap();
        assert_eq!(p.conn.as_deref(), Some("prod replica"));
        assert_eq!(p.limit, Some(50));
        assert_eq!(p.format, Format::Table);
        assert_eq!(p.arg.as_deref(), Some("SELECT 1"));
        let p = parse(&args(&["query", "-c", "x", "--", "-1 AS n"])).unwrap();
        assert_eq!(p.arg.as_deref(), Some("-1 AS n"));
        assert!(parse(&args(&["query", "--limit", "many"])).unwrap_err().contains("number"));
        assert!(parse(&args(&["query", "--conn"])).unwrap_err().contains("needs a value"));
        assert!(parse(&args(&["query", "--wat"])).unwrap_err().contains("Unknown option"));
        assert!(parse(&args(&["query", "-f", "xml"])).unwrap_err().contains("Unknown format"));
    }

    #[test]
    fn renders_table_and_csv() {
        let cols = args(&["id", "note"]);
        let rows = vec![args(&["1", "a,b"]), args(&["22", "line\nbreak \"q\""])];
        assert_eq!(table(&cols, &rows), "id  note\n--  --------------\n1   a,b\n22  line break \"q\"\n");
        assert_eq!(csv(&cols, &rows), "id,note\n1,\"a,b\"\n22,\"line\nbreak \"\"q\"\"\"\n");
        let data = json!({ "columns": ["n"], "rows": [[null], [2]], "rowCount": 2, "truncated": true });
        let out = render("query", &data, Format::Table);
        assert!(out.contains("NULL") && out.ends_with("2 rows (more rows exist; use --limit or a narrower WHERE)\n"), "{out}");
        assert_eq!(render("query", &data, Format::Json), format!("{data}\n"));
    }

    #[test]
    fn install_links_and_never_overwrites_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("rowline");
        std::fs::write(&exe, "").unwrap();
        let bin = dir.path().join("bin");
        install_link_in(&exe, &bin).unwrap();
        assert_eq!(std::fs::read_link(bin.join("rowline")).unwrap(), exe);
        install_link_in(&exe, &bin).unwrap(); // again: the old link is replaced
        std::fs::remove_file(bin.join("rowline")).unwrap();
        std::fs::write(bin.join("rowline"), "mine").unwrap();
        assert!(install_link_in(&exe, &bin).unwrap_err().contains("not a link"));
        assert!(install_link(&dir.path().join("devserver")).unwrap_err().contains("not the app"));
    }

    #[test]
    fn says_when_the_app_is_not_running() {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: tests in this module do not read ROWLINE_SOCKET concurrently except this one
        unsafe { std::env::set_var("ROWLINE_SOCKET", dir.path().join("none.sock")) };
        let err = run(&args(&["connections"])).unwrap_err();
        unsafe { std::env::remove_var("ROWLINE_SOCKET") };
        assert_eq!(err.0, EXIT_NO_APP);
        assert!(err.1.contains("not running"));
    }
}
