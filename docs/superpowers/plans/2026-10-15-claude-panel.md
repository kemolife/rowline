# Multiple connections and Claude panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Tabula keep several connections open with a connection rail, and add a Claude panel that answers questions about the data through read-only tools, using the user's installed Claude Code.

**Architecture:** The frontend store changes from one session to a map of workspaces (one per open connection), rendered side by side and hidden when inactive. The Rust backend gets a read-only query path, a small hand-written MCP server (JSON-RPC over HTTP on 127.0.0.1 with a secret token), and an agent runner that spawns `claude -p` with stream-json input/output per chat. The panel talks to the backend only through `commands::dispatch` and a long-poll command for chat events, so everything also works through the browser dev bridge.

**Tech Stack:** Tauri 2, Rust 2024 (tokio, axum 0.8, mysql_async 0.37, rusqlite 0.40), React 18.3, TypeScript, Zustand 5, Tailwind 4, Vitest (jsdom), react-markdown 9.

**Spec:** `docs/superpowers/specs/2026-10-15-claude-panel-design.md`

## Global Constraints

- **No git commits.** The user commits only after testing. Each task ends with a checkpoint (all tests green), not a commit.
- Work in `~/Documents/projects/tabula` on the current branch.
- Node: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 24.21.0` before any npm / vitest / tsc / tauri command.
- npm installs need `--legacy-peer-deps` (already in `.npmrc`). React must stay on 18 (Glide Data Grid needs React ≤ 18).
- Rust tests: `./scripts/test-rust.sh` (MySQL tests run against the local Docker DB when its env file exists).
- Frontend tests: `./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/vitest.json` then read `numPassedTests` / `numFailedTests` from the JSON (the rtk wrapper output can be stale). Type check: `./node_modules/.bin/tsc --noEmit -p .`
- Every backend command goes through `commands::dispatch(state, name, args)`; argument structs use `#[serde(rename_all = "camelCase")]`.
- Passwords stay in `secrets.json` (0600) via `store::SecretStore`; never the Keychain. The dev bridge never touches the app's config folder.
- Claude limits (exact values from the spec): at most **200 rows** per query, text values cut to **2 KB** (2048 chars), query timeout **30 s**, Production approval timeout **5 minutes**, long poll waits up to **25 s**.
- `claudeAccess` default: Production → `schema`, every other environment → `data`.
- UI copy: short, sentence case, plain words, no "please", no "successfully".
- Shell quirks on this Mac: use `/bin/ps`, `/usr/bin/grep`, `/bin/kill`; `cat` may be wrapped, use `/bin/cat` when output looks odd.

## Review Focus

1. **Claude asks about a MySQL database other than the one selected in the sidebar** → `list_tables` / `run_select` with an explicit `database` must use that database, not the selected one. Test in Task 8 (`mcp_uses_explicit_database`).
2. **The user disconnects a connection while Claude is answering** → the chat is closed, the Claude Code process is killed, and polling the closed chat returns an error instead of hanging or panicking. Test in Task 10 (`closing_a_chat_kills_the_process`).
3. **Huge values (long JSON text, BLOBs)** → each value is cut to 2048 chars plus `…`, so one row can't flood Claude. Test in Task 3 (`long_values_are_cut`).
4. **Claude Code not installed, or not logged in** → the chat shows a clear notice with the fix instead of a silent failure. Tests in Task 9 (`classifies_login_and_limit_errors`) and Task 10 (`missing_claude_shows_not_installed`).
5. **Two chats on two connections at the same time** → events never mix, and chat A can't use chat B's connection. Tests in Task 7 (`chats_have_separate_logs`) and Task 8 (`connection_outside_the_chat_is_rejected`).

---

## File structure

Backend (`src-tauri/src/`):

| File | Responsibility |
|---|---|
| `readonly.rs` (new) | SQL check for Claude queries, limits, `run_select` |
| `drivers/mysql.rs`, `drivers/sqlite.rs`, `manager.rs` | new `select_read_only` per engine |
| `model.rs` | `ClaudeAccess`, new `ConnectionConfig` fields |
| `claude/mod.rs` (new) | `ClaudeState`, `ChatConfig`, `McpEndpoint` |
| `claude/events.rs` (new) | `ChatEvent`, `ChatHub` (event log + long poll) |
| `claude/approvals.rs` (new) | Production approval requests |
| `claude/mcp.rs` (new) | MCP server and the four tools |
| `claude/cli.rs` (new) | find `claude`, build its arguments, parse its stream-json output |
| `claude/runner.rs` (new) | one Claude Code process per chat: send, stop, close |
| `commands.rs` | new chat commands; `AppState` gets `claude` |
| `store.rs` | `Store::dir()`, shared `append_log` |
| `lib.rs`, `bin/devserver.rs` | `Arc<AppState>`, start the MCP server |

Frontend (`src/`):

| File | Responsibility |
|---|---|
| `store/app.ts` | workspaces map, open order, active connection, launcher, Claude panel toggle |
| `store/workspace.tsx` (new) | `ConnectionScope`, `useConnectionId`, `useWs`, `useWsActions` |
| `components/ConnectionRail.tsx` (new) | left rail with open connections |
| `App.tsx`, `Workspace.tsx`, `Header.tsx`, `Sidebar.tsx`, `TabBar.tsx`, `DataTab.tsx`, `QueryTabView.tsx`, `CommandPalette.tsx` | read the scoped workspace |
| `lib/chat.ts` (new) | chat item model and the pure `applyEvents` reducer |
| `store/chat.ts` (new) | chat per connection, polling, send / stop / new chat / answer |
| `components/ClaudePanel.tsx`, `components/ChatItems.tsx`, `components/ConnectionChips.tsx` (new) | the panel UI |
| `components/ConnectionForm.tsx` | Claude section (access level, project folder) |
| `lib/types.ts`, `lib/api.ts` | new types and commands |

Other: `scripts/fake-claude.sh` (test stand-in), `src-tauri/tests/fixtures/claude/*.jsonl` (recorded output).

---

### Task 1: Probe the installed Claude Code and record samples

The runner depends on four CLI behaviours. Check them on the installed version (2.1.296) before writing code. **This sends a few tiny prompts with the user's Claude login — ask the user in chat first and wait for a yes.**

**Files:**
- Create: `src-tauri/tests/fixtures/claude/hello.jsonl`
- Create: `src-tauri/tests/fixtures/claude/probe-notes.md`

**Interfaces:**
- Produces: `hello.jsonl` — real stream-json output for one short answer (used by Task 9 and Task 10 tests and by `scripts/fake-claude.sh`). `probe-notes.md` — the result of each check below.

- [ ] **Step 1: Ask the user for permission**

Say: "Task 1 runs `claude -p` four times with tiny prompts (a few cents of your plan). OK to run?" Continue only after a yes.

- [ ] **Step 2: Record a stream-json answer with stdin input**

```bash
mkdir -p ~/Documents/projects/tabula/src-tauri/tests/fixtures/claude
cd "$(mktemp -d)"
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: Hello from Claude"}]}}' \
 | claude -p --verbose --input-format stream-json --output-format stream-json --include-partial-messages \
     --strict-mcp-config --setting-sources "" --tools "" \
 > ~/Documents/projects/tabula/src-tauri/tests/fixtures/claude/hello.jsonl
/usr/bin/grep -o '"type":"[a-z_]*"' ~/Documents/projects/tabula/src-tauri/tests/fixtures/claude/hello.jsonl | sort | uniq -c
```

Expected: the process ends after one answer (stdin closed), the file has a `"type":"system"` line with `"subtype":"init"` and `"session_id"`, several `"type":"stream_event"` lines, one `"type":"assistant"` line, and a `"type":"result"` line. If `--setting-sources ""` is rejected, run `claude --help | /usr/bin/grep -A3 setting-sources`, try `--setting-sources local` from the empty temp folder, and write which one worked into `probe-notes.md`; Task 9 uses that value.

- [ ] **Step 3: Check that a folder-scoped read can't leave the folder**

```bash
P="$(mktemp -d)"; echo "inside" > "$P/in.txt"; echo "outside" > "$(dirname "$P")/tabula-outside.txt"
cd "$P"
printf '%s\n' "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Read $P/in.txt and then $(dirname "$P")/tabula-outside.txt and print both contents.\"}]}}" \
 | claude -p --verbose --input-format stream-json --output-format stream-json \
     --strict-mcp-config --setting-sources "" --tools Read,Grep,Glob --allowedTools "Read(/$P/**)" \
 | /usr/bin/grep -o '"is_error":[a-z]*\|inside\|outside\|permission[^"]*' | head -20
```

Expected: `inside` appears; the outside read is refused (a permission message, no `outside` content). Write the result to `probe-notes.md`. If the outside file *was* read, stop and tell the user: the project-folder feature must stay disabled until fixed.

- [ ] **Step 4: Check that two messages work in one process**

```bash
cd "$(mktemp -d)"
( printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Remember the number 42. Reply OK."}]}}'; sleep 20;
  printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Which number did I ask you to remember?"}]}}'; sleep 20 ) \
 | claude -p --verbose --input-format stream-json --output-format stream-json --strict-mcp-config --setting-sources "" --tools "" \
 | /usr/bin/grep -c '"type":"result"'
```

Expected: `2` (two results from one process). Write it to `probe-notes.md`.

- [ ] **Step 5: Check the MCP allow-rule format**

```bash
claude --help | /usr/bin/grep -i -A2 "allowedTools"
```

Write into `probe-notes.md` whether `mcp__tabula` (whole server) is the documented form. Task 9 uses `mcp__tabula`; Task 13 confirms it in the live run.

- [ ] **Step 6: Checkpoint**

`hello.jsonl` exists and is non-empty; `probe-notes.md` lists the four results. No commit.

---

### Task 2: Read-only SQL check

**Files:**
- Create: `src-tauri/src/readonly.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod readonly;`)

**Interfaces:**
- Consumes: `sqlgen::split_statements(&str) -> Vec<StatementRange>`, `sqlgen::is_read_only_statement(&str) -> bool`, `sqlgen::Dialect`.
- Produces:
  - `pub const MAX_ROWS: usize = 200;` `pub const MAX_VALUE_CHARS: usize = 2048;` `pub const TIMEOUT: Duration = 30 s;`
  - `pub fn check(sql: &str, dialect: Dialect) -> AppResult<String>` — returns the single statement text (no trailing `;`) or an error.
  - `pub fn limit_values(result: &mut QueryResult)` — cuts long string values (Task 3 uses it).

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/readonly.rs` with only the test module first:

```rust
//! Guards for queries that Claude runs: one read-only statement, small results.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlgen::Dialect::{Mysql, Sqlite};

    #[test]
    fn accepts_plain_reads() {
        assert_eq!(check("SELECT * FROM t WHERE a = 1;", Mysql).unwrap(), "SELECT * FROM t WHERE a = 1");
        assert!(check("  -- note\nshow tables", Mysql).is_ok());
        assert!(check("EXPLAIN SELECT 1", Mysql).is_ok());
        assert!(check("WITH x AS (SELECT 1 AS n) SELECT n FROM x", Sqlite).is_ok());
        assert!(check("select `update`, \"delete\" from t where note = 'drop table x'", Mysql).is_ok());
        assert!(check("SELECT updated_at FROM t", Mysql).is_ok());
        assert!(check("PRAGMA table_info(t)", Sqlite).is_ok());
    }

    #[test]
    fn rejects_writes_and_tricks() {
        for sql in [
            "DELETE FROM t",
            "SELECT 1; DELETE FROM t",
            "SELECT * FROM t INTO OUTFILE '/tmp/x'",
            "SELECT * INTO @a FROM t",
            "SELECT * FROM t FOR UPDATE",
            "SELECT * FROM t LOCK IN SHARE MODE",
            "SELECT * FROM t FOR SHARE",
            "WITH x AS (SELECT 1) DELETE FROM t",
            "WITH x AS (SELECT 1) UPDATE t SET a = 1",
            "SELECT 1 /*!50000 , (DELETE FROM t) */",
            "PRAGMA journal_mode = WAL",
            "",
            "   ;  ",
        ] {
            assert!(check(sql, Mysql).is_err() || check(sql, Sqlite).is_err(), "should reject: {sql}");
        }
        assert!(check("PRAGMA journal_mode = WAL", Sqlite).is_err());
        assert!(check("PRAGMA table_info(t)", Mysql).is_err(), "PRAGMA is SQLite only");
    }

    #[test]
    fn error_messages_explain_the_rule() {
        assert!(check("SELECT 1; SELECT 2", Mysql).unwrap_err().to_string().contains("one statement"));
        assert!(check("DELETE FROM t", Mysql).unwrap_err().to_string().contains("read-only"));
    }
}
```

Add `pub mod readonly;` to `src-tauri/src/lib.rs` after `pub mod model;`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `./scripts/test-rust.sh readonly`
Expected: compile error `cannot find function check`.

- [ ] **Step 3: Write the implementation**

Put this above the test module in `readonly.rs`:

```rust
use crate::error::{AppError, AppResult};
use crate::model::QueryResult;
use crate::sqlgen::{self, Dialect};
use serde_json::Value;
use std::time::Duration;

pub const MAX_ROWS: usize = 200;
pub const MAX_VALUE_CHARS: usize = 2048;
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// Words that never appear in a read-only statement outside quotes and comments.
const WRITE_WORDS: &[&str] = &[
    "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME",
    "GRANT", "REVOKE", "CALL", "LOAD", "HANDLER", "LOCK", "UNLOCK", "INTO", "ATTACH", "DETACH", "VACUUM", "REINDEX",
];

fn not_read_only() -> AppError {
    AppError::msg("Only read-only queries are allowed (SELECT, SHOW, EXPLAIN, WITH … SELECT).")
}

/// Returns the one statement in `sql` if it only reads data.
pub fn check(sql: &str, dialect: Dialect) -> AppResult<String> {
    let statements = sqlgen::split_statements(sql);
    let text = match statements.as_slice() {
        [] => return Err(AppError::msg("The query is empty.")),
        [one] => one.text.trim().trim_end_matches(';').trim().to_string(),
        _ => return Err(AppError::msg("Send one statement at a time.")),
    };
    let masked = mask(&text);
    let words: Vec<String> = masked
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(|w| w.to_ascii_uppercase())
        .collect();
    let first = words.first().map(String::as_str).unwrap_or("");
    let pragma_read = dialect == Dialect::Sqlite && first == "PRAGMA" && !masked.contains('=');
    if !(sqlgen::is_read_only_statement(&text) || pragma_read) {
        return Err(not_read_only());
    }
    if words.iter().any(|w| WRITE_WORDS.contains(&w.as_str())) || words.join(" ").contains("FOR SHARE") {
        return Err(not_read_only());
    }
    Ok(text)
}

/// Blanks out string literals, quoted identifiers and comments, so keywords inside them don't count.
/// MySQL `/*! … */` comments are executed by the server, so their content is kept.
fn mask(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '\'' || c == '"' || c == '`' {
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' && c == '\'' {
                    i += 2;
                    continue;
                }
                if chars[i] == c {
                    if chars.get(i + 1) == Some(&c) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            out.push(' ');
            i += 1;
        } else if (c == '-' && next == Some('-')) || c == '#' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            out.push(' ');
        } else if c == '/' && next == Some('*') && chars.get(i + 2) != Some(&'!') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            out.push(' ');
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Cuts text values longer than MAX_VALUE_CHARS, so one row can't flood the chat.
pub fn limit_values(result: &mut QueryResult) {
    for row in &mut result.rows {
        for v in row.iter_mut() {
            if let Value::String(s) = v {
                if s.chars().count() > MAX_VALUE_CHARS {
                    let cut: String = s.chars().take(MAX_VALUE_CHARS).collect();
                    *s = format!("{cut}…");
                }
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `./scripts/test-rust.sh readonly`
Expected: 3 tests pass.

- [ ] **Step 5: Checkpoint**

Run: `./scripts/test-rust.sh` — all tests pass. No commit.

---

### Task 3: Read-only execution in the drivers

**Files:**
- Modify: `src-tauri/src/drivers/sqlite.rs` (new method + tests)
- Modify: `src-tauri/src/drivers/mysql.rs` (new method + tests)
- Modify: `src-tauri/src/manager.rs` (dispatch method)
- Modify: `src-tauri/src/readonly.rs` (`run_select` + tests)

**Interfaces:**
- Consumes: `readonly::{check, limit_values, MAX_ROWS, TIMEOUT}` (Task 2); existing private `run_query` (SQLite) and `run_tracked`, `conn`, `db` (MySQL).
- Produces:
  - `SqliteSession::select_read_only(&self, sql: String, max_rows: usize) -> AppResult<QueryResult>`
  - `MysqlSession::select_read_only(&self, database: Option<&str>, sql: &str, max_rows: usize) -> AppResult<QueryResult>`
  - `Session::select_read_only(&self, database: Option<&str>, sql: &str, max_rows: usize) -> AppResult<QueryResult>`
  - `pub async fn readonly::run_select(session: &Session, database: Option<&str>, sql: &str) -> AppResult<QueryResult>` — check + execute + limits. Task 8 uses it.

- [ ] **Step 1: Write the failing SQLite tests**

Add to the `tests` module in `src-tauri/src/readonly.rs`:

```rust
    use crate::manager::Session;

    async fn sqlite_session(dir: &std::path::Path) -> Session {
        let path = dir.join("ro.sqlite");
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT);").unwrap();
        let tx = c.unchecked_transaction().unwrap();
        for i in 0..250 {
            tx.execute("INSERT INTO t (body) VALUES (?1)", [format!("row {i}")]).unwrap();
        }
        tx.execute("INSERT INTO t (body) VALUES (?1)", ["x".repeat(5000)]).unwrap();
        tx.commit().unwrap();
        let config: crate::model::ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "c1", "name": "ro", "engine": "sqlite", "filePath": path.to_str().unwrap()
        })).unwrap();
        Session::open(&config, None).await.unwrap()
    }

    #[tokio::test]
    async fn run_select_limits_rows() {
        let dir = tempfile::tempdir().unwrap();
        let s = sqlite_session(dir.path()).await;
        let res = run_select(&s, None, "SELECT id, body FROM t").await.unwrap();
        assert_eq!(res.rows.len(), MAX_ROWS);
        assert!(res.truncated);
    }

    #[tokio::test]
    async fn long_values_are_cut() {
        let dir = tempfile::tempdir().unwrap();
        let s = sqlite_session(dir.path()).await;
        let res = run_select(&s, None, "SELECT body FROM t ORDER BY length(body) DESC LIMIT 1").await.unwrap();
        let body = res.rows[0][0].as_str().unwrap();
        assert_eq!(body.chars().count(), MAX_VALUE_CHARS + 1);
        assert!(body.ends_with('…'));
    }

    #[tokio::test]
    async fn sqlite_database_layer_blocks_writes() {
        let dir = tempfile::tempdir().unwrap();
        let s = sqlite_session(dir.path()).await;
        // skip the SQL check on purpose: the read-only connection itself must refuse
        let err = s.select_read_only(None, "DELETE FROM t", 10).await.unwrap_err().to_string();
        assert!(err.to_lowercase().contains("readonly") || err.to_lowercase().contains("read-only"), "{err}");
        let n = s.execute(None, "SELECT count(*) FROM t", 10).await.unwrap();
        assert_eq!(n[0].rows[0][0], 251);
        assert!(run_select(&s, None, "DELETE FROM t").await.unwrap_err().to_string().contains("read-only"));
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `./scripts/test-rust.sh readonly`
Expected: compile errors (`run_select`, `select_read_only` not found).

- [ ] **Step 3: Implement SQLite `select_read_only`**

In `src-tauri/src/drivers/sqlite.rs`, add inside `impl SqliteSession` (after `execute`):

```rust
    /// Runs one statement on a separate read-only connection, stopped after readonly::TIMEOUT.
    pub async fn select_read_only(&self, sql: String, max_rows: usize) -> AppResult<QueryResult> {
        if self.path == ":memory:" {
            return Err(AppError::msg("Claude can't query an in-memory database."));
        }
        let path = self.path.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<InterruptHandle>();
        let task = tokio::task::spawn_blocking(move || -> AppResult<QueryResult> {
            let c = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            c.busy_timeout(std::time::Duration::from_secs(5))?;
            c.execute_batch("PRAGMA query_only = ON")?;
            let _ = tx.send(c.get_interrupt_handle());
            run_query(&c, &sql, &[], max_rows)
        });
        let watchdog = tokio::spawn(async move {
            if let Ok(handle) = rx.await {
                tokio::time::sleep(crate::readonly::TIMEOUT).await;
                handle.interrupt();
            }
        });
        let res = task.await.map_err(|e| AppError::msg(e.to_string()))?;
        watchdog.abort();
        res.map_err(|e| {
            if e.to_string().contains("interrupt") {
                AppError::Timeout(format!("the query ran longer than {} s", crate::readonly::TIMEOUT.as_secs()))
            } else {
                e
            }
        })
    }
```

In `src-tauri/src/manager.rs`, add to `impl Session` (after `execute`):

```rust
    /// One read-only statement for Claude (the caller has already run readonly::check).
    pub async fn select_read_only(&self, database: Option<&str>, sql: &str, max_rows: usize) -> AppResult<QueryResult> {
        match self {
            Session::Mysql(s) => s.select_read_only(database, sql, max_rows).await,
            Session::Sqlite(s) => s.select_read_only(sql.to_string(), max_rows).await,
        }
    }
```

In `src-tauri/src/readonly.rs`, add below `limit_values`:

```rust
/// Checks, runs and trims one query for Claude.
pub async fn run_select(session: &crate::manager::Session, database: Option<&str>, sql: &str) -> AppResult<QueryResult> {
    let statement = check(sql, session.dialect())?;
    let mut result = session.select_read_only(database, &statement, MAX_ROWS).await?;
    limit_values(&mut result);
    result.statement = Some(statement);
    Ok(result)
}
```

- [ ] **Step 4: Implement MySQL `select_read_only`**

In `src-tauri/src/drivers/mysql.rs`, add inside `impl MysqlSession` (after `execute`):

```rust
    /// Runs one statement inside a READ ONLY transaction, limited to readonly::TIMEOUT.
    pub async fn select_read_only(&self, database: Option<&str>, sql: &str, max_rows: usize) -> AppResult<QueryResult> {
        let timeout = crate::readonly::TIMEOUT;
        let mut c = self.conn().await?;
        if let Some(db) = self.db(database) {
            c.query_drop(format!("USE {}", Dialect::Mysql.quote_ident(db))).await?;
        }
        // MySQL only; MariaDB ignores it (the tokio timeout below still applies)
        let _ = c.query_drop(format!("SET SESSION MAX_EXECUTION_TIME = {}", timeout.as_millis())).await;
        c.query_drop("START TRANSACTION READ ONLY").await?;
        let thread_id = c.id();
        let res = match tokio::time::timeout(timeout + std::time::Duration::from_secs(2), self.run_tracked(&mut c, sql, max_rows)).await {
            Ok(r) => r,
            Err(_) => {
                if let Ok(mut killer) = self.conn().await {
                    let _ = killer.query_drop(format!("KILL QUERY {thread_id}")).await;
                }
                Err(AppError::Timeout(format!("the query ran longer than {} s", timeout.as_secs())))
            }
        };
        let _ = c.query_drop("ROLLBACK").await;
        let _ = c.query_drop("SET SESSION MAX_EXECUTION_TIME = 0").await;
        res
    }
```

- [ ] **Step 5: Add the MySQL test**

Add to the `tests` module in `src-tauri/src/drivers/mysql.rs`:

```rust
    #[tokio::test]
    async fn read_only_transaction_blocks_writes() {
        let Some((s, db)) = session().await else { return };
        s.execute(Some(&db), "DROP TABLE IF EXISTS tabula_ro_test; CREATE TABLE tabula_ro_test (id INT PRIMARY KEY); INSERT INTO tabula_ro_test VALUES (1)", 10)
            .await
            .unwrap();
        // skip the SQL check on purpose: the transaction itself must refuse
        let err = s.select_read_only(Some(&db), "DELETE FROM tabula_ro_test", 10).await.unwrap_err().to_string();
        assert!(err.contains("READ ONLY") || err.contains("1792"), "{err}");
        let rows = s.select_read_only(Some(&db), "SELECT id FROM tabula_ro_test", 10).await.unwrap();
        assert_eq!(rows.rows.len(), 1);
        s.execute(Some(&db), "DROP TABLE tabula_ro_test", 10).await.unwrap();
    }
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `./scripts/test-rust.sh readonly read_only_transaction`
Expected: the 3 new SQLite tests and the MySQL test pass (the MySQL test returns early when Docker is not running — start it with `docker compose -f ~/Documents/projects/tableplus-refs/docker/docker-compose.yml up -d` if needed).

- [ ] **Step 7: Checkpoint**

Run: `./scripts/test-rust.sh` — all pass. No commit.

---

### Task 4: Connection settings — Claude access and project folder

**Files:**
- Modify: `src-tauri/src/model.rs` (enum + fields + method)
- Modify: `src-tauri/src/store.rs` (test helper literal)
- Modify: `src-tauri/src/commands.rs` (`save_connection` validation + test)
- Modify: `src/lib/types.ts`, `src/lib/api.ts` (`pickFolder`), `src/components/ConnectionForm.tsx`

**Interfaces:**
- Produces (Rust): `pub enum ClaudeAccess { Data, Schema, Off }` (serde lowercase); `ConnectionConfig.claude_access: Option<ClaudeAccess>`, `ConnectionConfig.project_folder: Option<String>`; `impl ConnectionConfig { pub fn claude_access(&self) -> ClaudeAccess }`.
- Produces (TS): `type ClaudeAccess = 'data' | 'schema' | 'off'`; `ConnectionConfig.claudeAccess?: ClaudeAccess | null`; `ConnectionConfig.projectFolder?: string | null`; `export function effectiveClaudeAccess(c: Pick<ConnectionConfig, 'claudeAccess' | 'environment'>): ClaudeAccess` in `lib/types.ts`; `pickFolder(): Promise<string | null>` in `lib/api.ts`.

- [ ] **Step 1: Write the failing Rust test**

Add to `src-tauri/src/commands.rs` `tests` module:

```rust
    #[tokio::test]
    async fn claude_settings_default_by_environment_and_validate_folder() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap());
        let base = json!({ "id": "", "name": "p", "engine": "sqlite", "filePath": "/tmp/x.sqlite" });

        let mut prod = base.clone();
        prod["environment"] = json!("prod");
        let saved: ConnectionConfig = serde_json::from_value(dispatch(&state, "save_connection", prod).await.unwrap()).unwrap();
        assert_eq!(saved.claude_access(), ClaudeAccess::Schema);

        let saved: ConnectionConfig = serde_json::from_value(dispatch(&state, "save_connection", base.clone()).await.unwrap()).unwrap();
        assert_eq!(saved.claude_access(), ClaudeAccess::Data);

        let mut off = base.clone();
        off["claudeAccess"] = json!("off");
        let saved: ConnectionConfig = serde_json::from_value(dispatch(&state, "save_connection", off).await.unwrap()).unwrap();
        assert_eq!(saved.claude_access(), ClaudeAccess::Off);

        let mut bad = base.clone();
        bad["projectFolder"] = json!("/definitely/not/here");
        let err = dispatch(&state, "save_connection", bad).await.unwrap_err();
        assert!(err.to_string().contains("Project folder not found"));

        let mut good = base;
        good["projectFolder"] = json!(dir.path().to_str().unwrap());
        assert!(dispatch(&state, "save_connection", good).await.is_ok());
    }
```

- [ ] **Step 2: Run it to see it fail**

Run: `./scripts/test-rust.sh claude_settings`
Expected: compile error (`ClaudeAccess` not found).

- [ ] **Step 3: Implement the model change**

In `src-tauri/src/model.rs`, add after `TlsMode`:

```rust
/// What Claude may see on a connection
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeAccess {
    /// Tables, columns and rows (SELECT)
    Data,
    /// Tables and columns only
    Schema,
    /// Nothing
    Off,
}
```

Add two fields at the end of `ConnectionConfig`:

```rust
    // Claude
    /// None = default for the environment (see `claude_access()`)
    #[serde(default)]
    pub claude_access: Option<ClaudeAccess>,
    /// Folder Claude may read (Read, Grep, Glob only)
    #[serde(default)]
    pub project_folder: Option<String>,
```

Add below the struct:

```rust
impl ConnectionConfig {
    /// Production defaults to schema only, every other environment to data.
    pub fn claude_access(&self) -> ClaudeAccess {
        self.claude_access.unwrap_or(if self.environment == Environment::Prod { ClaudeAccess::Schema } else { ClaudeAccess::Data })
    }
}
```

In `src-tauri/src/store.rs` test helper `config()`, add `claude_access: None, project_folder: None,` to the struct literal.

In `src-tauri/src/commands.rs` `save_connection`, after the name check add:

```rust
    if let Some(folder) = config.project_folder.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        if !std::path::Path::new(folder).is_dir() {
            return Err(AppError::msg(format!("Project folder not found: {folder}")));
        }
        config.project_folder = Some(folder.to_string());
    } else {
        config.project_folder = None;
    }
```

Add `use crate::model::ClaudeAccess;` is not needed in non-test code (glob import `crate::model::*` already covers it).

- [ ] **Step 4: Run the Rust test to see it pass**

Run: `./scripts/test-rust.sh claude_settings`
Expected: PASS.

- [ ] **Step 5: Frontend types and folder picker**

In `src/lib/types.ts`, add after `TlsMode`:

```ts
export type ClaudeAccess = 'data' | 'schema' | 'off';
```

Add to `ConnectionConfig`:

```ts
  /** null/undefined = default for the environment */
  claudeAccess?: ClaudeAccess | null;
  /** folder Claude may read */
  projectFolder?: string | null;
```

Add at the end of the file:

```ts
/** Production defaults to schema only, every other environment to data (mirrors ConnectionConfig::claude_access). */
export function effectiveClaudeAccess(c: Pick<ConnectionConfig, 'claudeAccess' | 'environment'>): ClaudeAccess {
  return c.claudeAccess ?? (c.environment === 'prod' ? 'schema' : 'data');
}
```

In `src/lib/api.ts`, add after `pickSqliteFile`:

```ts
export async function pickFolder(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({ directory: true, multiple: false });
    return typeof res === 'string' ? res : null;
  }
  return window.prompt('Project folder path');
}
```

- [ ] **Step 6: Claude section in the connection form**

In `src/components/ConnectionForm.tsx`:

1. Change imports:

```ts
import { CheckCircle2, FolderOpen, Loader2, X, XCircle } from 'lucide-react';
import { api, pickFolder, pickSqliteFile } from '../lib/api';
import { effectiveClaudeAccess, type ClaudeAccess, type ConnectionInput, type Engine, type Environment, type TlsMode } from '../lib/types';
```

2. Add after `TLS_MODES`:

```ts
const CLAUDE_ACCESS: { value: ClaudeAccess; label: string; hint: string }[] = [
  { value: 'data', label: 'Schema + data', hint: 'Claude sees tables and can run read-only SELECT queries.' },
  { value: 'schema', label: 'Schema only', hint: 'Claude sees tables and columns, but no rows.' },
  { value: 'off', label: 'Off', hint: 'Claude can’t see this connection.' },
];
```

3. In `payload()`, add `projectFolder: form.projectFolder?.trim() || null,` to the returned object.

4. Insert this block right before `{result && (`:

```tsx
          <div className="space-y-1.5 border-t border-line pt-4">
            <span className="label">Claude access</span>
            <div className="flex rounded-lg bg-surface-2 p-0.5">
              {CLAUDE_ACCESS.map((a) => (
                <button
                  type="button"
                  key={a.value}
                  onClick={() => set({ claudeAccess: a.value })}
                  className={cx('h-7 flex-1 rounded-md text-[12px] font-medium', effectiveClaudeAccess(form) === a.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
                  data-testid={`claude-access-${a.value}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <p className="text-[11.5px] text-ink-3">{CLAUDE_ACCESS.find((a) => a.value === effectiveClaudeAccess(form))?.hint}</p>
          </div>
          {effectiveClaudeAccess(form) !== 'off' && (
            <label className="block space-y-1.5">
              <span className="label">Project folder <span className="font-normal text-ink-3">(optional)</span></span>
              <div className="flex gap-2">
                <input className="field field-mono" value={form.projectFolder ?? ''} placeholder="/path/to/your/app" onChange={(e) => set({ projectFolder: e.target.value })} />
                <button
                  type="button"
                  className="btn h-8 shrink-0"
                  onClick={async () => {
                    const folder = await pickFolder();
                    if (folder) set({ projectFolder: folder });
                  }}
                >
                  <FolderOpen size={14} /> Choose
                </button>
              </div>
              <p className="text-[11.5px] text-ink-3">Claude can read files in this folder. It can’t change them.</p>
            </label>
          )}
```

- [ ] **Step 7: Type check and checkpoint**

Run: `./node_modules/.bin/tsc --noEmit -p .` → no errors. `./scripts/test-rust.sh` → all pass. Vitest → all pass. No commit.

---

### Task 5: Workspace store — several open connections

**Files:**
- Modify: `src/store/app.ts` (full rewrite below)
- Create: `src/store/app.test.ts`

**Interfaces:**
- Produces (exported from `src/store/app.ts`):
  - types `ThemeMode`, `TableTab`, `QueryTab` (now with `autoRun?: boolean`), `Tab`, `Session`, `Toast`, `Workspace { session; tabs; activeTabId; dirtyTabs }`, `AppState`
  - state: `workspaces: Record<string, Workspace>`, `openOrder: string[]`, `activeConnectionId: string | null`, `launcherOpen: boolean`, `claudeOpen: boolean` (plus the old global fields: theme, connections, connecting, sidebarOpen, rowPanelOpen, editing, paletteOpen, toasts)
  - actions (connection id first): `connect(id)`, `switchTo(id)`, `showLauncher(open)`, `disconnect(id)`, `selectDatabase(cid, db)`, `refreshObjects(cid)`, `openTable(cid, name, kind?, view?)`, `openQuery(cid, sql?, opts?: { autoRun?: boolean })`, `updateTab(cid, tabId, patch)`, `closeTab(cid, tabId)`, `setActiveTab(cid, tabId)`, `setDirty(cid, tabId, count)`, `toggleClaude()`, and the unchanged global ones.
  - selectors: `activeWorkspace(s): Workspace | null`, `wsActiveTab(w: Workspace): Tab | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/store/app.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmAnswer = { value: true };
vi.mock('../lib/api', () => ({
  api: {
    listConnections: vi.fn(async () => []),
    connect: vi.fn(async () => ({ version: 'v', currentDatabase: 'shop' })),
    disconnect: vi.fn(async () => true),
    listDatabases: vi.fn(async () => ['shop']),
    listObjects: vi.fn(async () => [{ name: 'orders', kind: 'table', rowEstimate: 1 }]),
  },
  confirmDialog: vi.fn(async () => confirmAnswer.value),
}));

import { api } from '../lib/api';
import { activeWorkspace, useApp } from './app';

const conn = (id: string, engine: 'mysql' | 'sqlite' = 'mysql') => ({ id, name: id, engine, environment: 'dev' as const });

describe('workspaces', () => {
  beforeEach(() => {
    confirmAnswer.value = true;
    vi.mocked(api.connect).mockClear();
    useApp.setState({ connections: [conn('a'), conn('b', 'sqlite')], workspaces: {}, openOrder: [], activeConnectionId: null, launcherOpen: false });
  });

  it('opens several connections and switches between them', async () => {
    await useApp.getState().connect('a');
    await useApp.getState().connect('b');
    let s = useApp.getState();
    expect(s.openOrder).toEqual(['a', 'b']);
    expect(s.activeConnectionId).toBe('b');
    await s.connect('a'); // already open: only switches
    s = useApp.getState();
    expect(s.activeConnectionId).toBe('a');
    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(activeWorkspace(s)?.session.database).toBe('shop');
  });

  it('keeps tabs per connection', async () => {
    await useApp.getState().connect('a');
    await useApp.getState().connect('b');
    useApp.getState().openTable('a', 'orders');
    useApp.getState().openQuery('b', 'select 1', { autoRun: true });
    const s = useApp.getState();
    expect(s.workspaces.a.tabs.map((t) => t.kind)).toEqual(['table']);
    expect(s.workspaces.b.tabs).toMatchObject([{ kind: 'query', sql: 'select 1', autoRun: true }]);
    expect(s.workspaces.b.activeTabId).toBe(s.workspaces.b.tabs[0].id);
  });

  it('disconnecting the active connection activates a neighbour', async () => {
    await useApp.getState().connect('a');
    await useApp.getState().connect('b');
    await useApp.getState().disconnect('b');
    const s = useApp.getState();
    expect(s.openOrder).toEqual(['a']);
    expect(s.activeConnectionId).toBe('a');
    expect(s.workspaces.b).toBeUndefined();
  });

  it('asks before disconnecting with unsaved edits', async () => {
    await useApp.getState().connect('a');
    useApp.getState().openTable('a', 'orders');
    const tabId = useApp.getState().workspaces.a.tabs[0].id;
    useApp.getState().setDirty('a', tabId, 2);
    confirmAnswer.value = false;
    await useApp.getState().disconnect('a');
    expect(useApp.getState().openOrder).toEqual(['a']);
  });

  it('the launcher shows the connection list without closing connections', async () => {
    await useApp.getState().connect('a');
    useApp.getState().showLauncher(true);
    expect(useApp.getState().launcherOpen).toBe(true);
    await useApp.getState().connect('a');
    expect(useApp.getState().launcherOpen).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `./node_modules/.bin/vitest run src/store/app.test.ts`
Expected: FAIL (`openOrder` undefined / `activeWorkspace` not exported).

- [ ] **Step 3: Rewrite `src/store/app.ts`**

Replace the whole file with:

```ts
import { create } from 'zustand';
import { api, confirmDialog } from '../lib/api';
import type { ConnectionConfig, ConnectionInput, DbObject, ObjectKind, ServerInfo } from '../lib/types';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface TableTab {
  id: string;
  kind: 'table';
  table: string;
  objectKind: ObjectKind;
  view: 'data' | 'structure';
  /** database the tab belongs to (MySQL) */
  database: string | null;
}

export interface QueryTab {
  id: string;
  kind: 'query';
  title: string;
  sql: string;
  database: string | null;
  /** run all statements once when the tab opens (Claude "Open in grid") */
  autoRun?: boolean;
}

export type Tab = TableTab | QueryTab;

export interface Session {
  connectionId: string;
  config: ConnectionConfig;
  info: ServerInfo;
  databases: string[];
  database: string | null;
  objects: DbObject[];
  loadingObjects: boolean;
}

/** Everything that belongs to one open connection */
export interface Workspace {
  session: Session;
  tabs: Tab[];
  activeTabId: string | null;
  /** pending change counts of table tabs, for close confirmation */
  dirtyTabs: Record<string, number>;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface AppState {
  theme: ThemeMode;
  connections: ConnectionConfig[];
  connecting: string | null;
  workspaces: Record<string, Workspace>;
  /** open connections in rail order */
  openOrder: string[];
  activeConnectionId: string | null;
  /** connection list shown in the main area while connections stay open */
  launcherOpen: boolean;
  sidebarOpen: boolean;
  rowPanelOpen: boolean;
  claudeOpen: boolean;
  editing: ConnectionInput | null;
  paletteOpen: boolean;
  toasts: Toast[];

  setTheme: (t: ThemeMode) => void;
  loadConnections: () => Promise<void>;
  connect: (id: string) => Promise<void>;
  switchTo: (id: string) => void;
  showLauncher: (open: boolean) => void;
  disconnect: (id: string) => Promise<void>;
  selectDatabase: (cid: string, db: string) => Promise<void>;
  refreshObjects: (cid: string) => Promise<void>;
  openTable: (cid: string, name: string, kind?: ObjectKind, view?: 'data' | 'structure') => void;
  openQuery: (cid: string, sql?: string, opts?: { autoRun?: boolean }) => void;
  updateTab: (cid: string, tabId: string, patch: Partial<TableTab> | Partial<QueryTab>) => void;
  closeTab: (cid: string, tabId: string) => Promise<void>;
  setActiveTab: (cid: string, tabId: string) => void;
  setDirty: (cid: string, tabId: string, count: number) => void;
  toggleSidebar: () => void;
  toggleRowPanel: () => void;
  toggleClaude: () => void;
  setEditing: (c: ConnectionInput | null) => void;
  setPaletteOpen: (open: boolean) => void;
  toast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;
let tabId = 0;
const newTabId = () => `tab-${++tabId}`;

const readTheme = (): ThemeMode => {
  try {
    return (localStorage.getItem('tabula.theme') as ThemeMode) || 'dark';
  } catch {
    return 'dark';
  }
};

const readFlag = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};

export const useApp = create<AppState>((set, get) => {
  /** Updates one workspace; does nothing when the connection was closed meanwhile. */
  const patchWs = (cid: string, fn: (w: Workspace) => Partial<Workspace>) => {
    const w = get().workspaces[cid];
    if (!w) return;
    set({ workspaces: { ...get().workspaces, [cid]: { ...w, ...fn(w) } } });
  };
  const patchSession = (cid: string, fn: (s: Session) => Partial<Session>) => patchWs(cid, (w) => ({ session: { ...w.session, ...fn(w.session) } }));

  return {
    theme: readTheme(),
    connections: [],
    connecting: null,
    workspaces: {},
    openOrder: [],
    activeConnectionId: null,
    launcherOpen: false,
    sidebarOpen: true,
    rowPanelOpen: true,
    claudeOpen: readFlag('tabula.claudeOpen', false),
    editing: null,
    paletteOpen: false,
    toasts: [],

    setTheme: (theme) => {
      try {
        localStorage.setItem('tabula.theme', theme);
      } catch {
        /* storage not available */
      }
      set({ theme });
    },

    loadConnections: async () => {
      try {
        set({ connections: await api.listConnections() });
      } catch (e) {
        get().toast(`Could not load connections: ${(e as Error).message}`, 'error');
      }
    },

    connect: async (id) => {
      if (get().workspaces[id]) {
        get().switchTo(id);
        return;
      }
      const config = get().connections.find((c) => c.id === id);
      if (!config) return;
      set({ connecting: id });
      try {
        const info = await api.connect(id);
        const databases = config.engine === 'mysql' ? await api.listDatabases(id) : ['main'];
        const database = config.engine === 'mysql' ? config.database || info.currentDatabase || null : null;
        const restored = loadSavedTabs(id);
        set({
          workspaces: {
            ...get().workspaces,
            [id]: {
              session: { connectionId: id, config, info, databases, database, objects: [], loadingObjects: false },
              tabs: restored.tabs,
              activeTabId: restored.activeTabId,
              dirtyTabs: {},
            },
          },
          openOrder: [...get().openOrder.filter((o) => o !== id), id],
          activeConnectionId: id,
          launcherOpen: false,
        });
        if (config.engine === 'sqlite' || database) await get().refreshObjects(id);
      } catch (e) {
        get().toast((e as Error).message, 'error');
      } finally {
        set({ connecting: null });
      }
    },

    switchTo: (id) => {
      if (!get().workspaces[id]) return;
      set({ activeConnectionId: id, launcherOpen: false });
    },

    showLauncher: (launcherOpen) => set({ launcherOpen: launcherOpen && get().openOrder.length > 0 }),

    disconnect: async (id) => {
      const w = get().workspaces[id];
      if (!w) return;
      const dirty = Object.values(w.dirtyTabs).some((n) => n > 0);
      if (dirty && !(await confirmDialog(`"${w.session.config.name}" has unsaved changes. Disconnect anyway?`))) return;
      try {
        await api.disconnect(id);
      } catch {
        /* already closed */
      }
      const { [id]: _closed, ...workspaces } = get().workspaces;
      const order = get().openOrder;
      const idx = order.indexOf(id);
      const openOrder = order.filter((o) => o !== id);
      let activeConnectionId = get().activeConnectionId;
      if (activeConnectionId === id) activeConnectionId = openOrder[Math.min(idx, openOrder.length - 1)] ?? null;
      set({ workspaces, openOrder, activeConnectionId, launcherOpen: get().launcherOpen && openOrder.length > 0 });
    },

    selectDatabase: async (cid, db) => {
      const w = get().workspaces[cid];
      if (!w || w.session.database === db) return;
      patchSession(cid, () => ({ database: db, objects: [] }));
      await get().refreshObjects(cid);
    },

    refreshObjects: async (cid) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const database = w.session.database;
      patchSession(cid, () => ({ loadingObjects: true }));
      try {
        const objects = await api.listObjects(cid, database);
        patchSession(cid, (s) => (s.database === database ? { objects, loadingObjects: false } : {}));
      } catch (e) {
        patchSession(cid, () => ({ loadingObjects: false }));
        get().toast((e as Error).message, 'error');
      }
    },

    openTable: (cid, name, kind = 'table', view = 'data') => {
      const w = get().workspaces[cid];
      if (!w) return;
      const existing = w.tabs.find((t) => t.kind === 'table' && t.table === name && t.database === w.session.database);
      if (existing) {
        patchWs(cid, () => ({ activeTabId: existing.id }));
        if (existing.kind === 'table' && existing.view !== view) get().updateTab(cid, existing.id, { view });
        return;
      }
      const tab: TableTab = { id: newTabId(), kind: 'table', table: name, objectKind: kind, view, database: w.session.database };
      patchWs(cid, (ws) => ({ tabs: [...ws.tabs, tab], activeTabId: tab.id }));
    },

    openQuery: (cid, sql = '', opts = {}) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const n = w.tabs.filter((t) => t.kind === 'query').length + 1;
      const tab: QueryTab = { id: newTabId(), kind: 'query', title: `Query ${n}`, sql, database: w.session.database, ...(opts.autoRun ? { autoRun: true } : {}) };
      patchWs(cid, (ws) => ({ tabs: [...ws.tabs, tab], activeTabId: tab.id }));
    },

    updateTab: (cid, id, patch) => patchWs(cid, (w) => ({ tabs: w.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) })),

    closeTab: async (cid, id) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const dirty = w.dirtyTabs[id] ?? 0;
      if (dirty > 0 && !(await confirmDialog(`Discard ${dirty} unsaved change${dirty > 1 ? 's' : ''}?`))) return;
      patchWs(cid, (ws) => {
        const idx = ws.tabs.findIndex((t) => t.id === id);
        const rest = ws.tabs.filter((t) => t.id !== id);
        const { [id]: _gone, ...dirtyTabs } = ws.dirtyTabs;
        const activeTabId = ws.activeTabId === id ? rest[Math.min(idx, rest.length - 1)]?.id ?? null : ws.activeTabId;
        return { tabs: rest, activeTabId, dirtyTabs };
      });
    },

    setActiveTab: (cid, id) => patchWs(cid, () => ({ activeTabId: id })),
    setDirty: (cid, id, count) => {
      const w = get().workspaces[cid];
      if (!w || (w.dirtyTabs[id] ?? 0) === count) return;
      patchWs(cid, (ws) => ({ dirtyTabs: { ...ws.dirtyTabs, [id]: count } }));
    },
    toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
    toggleRowPanel: () => set({ rowPanelOpen: !get().rowPanelOpen }),
    toggleClaude: () => {
      const claudeOpen = !get().claudeOpen;
      try {
        localStorage.setItem('tabula.claudeOpen', claudeOpen ? '1' : '0');
      } catch {
        /* storage not available */
      }
      set({ claudeOpen });
    },
    setEditing: (editing) => set({ editing }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

    toast: (message, kind = 'info') => {
      const id = ++toastId;
      set({ toasts: [...get().toasts, { id, kind, message }] });
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500);
    },
    dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  };
});

export const activeWorkspace = (s: AppState): Workspace | null => (s.activeConnectionId ? s.workspaces[s.activeConnectionId] ?? null : null);
export const wsActiveTab = (w: Workspace): Tab | null => w.tabs.find((t) => t.id === w.activeTabId) ?? null;

// Open tabs (and query text) are remembered per connection and restored on the next connect.
const TABS_KEY = (connectionId: string) => `tabula.tabs.${connectionId}`;

function loadSavedTabs(connectionId: string): { tabs: Tab[]; activeTabId: string | null } {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY(connectionId)) ?? 'null') as { tabs: Omit<Tab, 'id'>[]; active: number } | null;
    if (!saved?.tabs?.length) return { tabs: [], activeTabId: null };
    const tabs = saved.tabs.map((t) => ({ ...t, id: newTabId(), autoRun: undefined }) as Tab);
    return { tabs, activeTabId: tabs[Math.min(Math.max(saved.active, 0), tabs.length - 1)]?.id ?? null };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
useApp.subscribe((state, prev) => {
  if (state.workspaces === prev.workspaces) return;
  for (const [cid, w] of Object.entries(state.workspaces)) {
    const old = prev.workspaces[cid];
    if (old && old.tabs === w.tabs && old.activeTabId === w.activeTabId) continue;
    const tabs = w.tabs;
    const active = tabs.findIndex((t) => t.id === w.activeTabId);
    clearTimeout(saveTimers[cid]);
    saveTimers[cid] = setTimeout(() => {
      try {
        localStorage.setItem(TABS_KEY(cid), JSON.stringify({ tabs: tabs.map(({ id: _id, ...rest }) => ({ ...rest, autoRun: undefined })), active }));
      } catch {
        /* storage not available */
      }
    }, 300);
  }
});
```

- [ ] **Step 4: Run the store tests to see them pass**

Run: `./node_modules/.bin/vitest run src/store/app.test.ts`
Expected: 5 tests pass. (`tsc` will fail now because components still use the old store; Task 6 fixes that. Do not run the app between Task 5 and Task 6.)

- [ ] **Step 5: Checkpoint**

Store tests green. No commit. Continue directly with Task 6.

---

### Task 6: Workspace UI — scoped components and the connection rail

**Files:**
- Create: `src/store/workspace.tsx`
- Create: `src/components/ConnectionRail.tsx`
- Modify: `src/App.tsx`, `src/components/Workspace.tsx`, `src/components/Header.tsx`, `src/components/Sidebar.tsx`, `src/components/TabBar.tsx`, `src/components/DataTab.tsx`, `src/components/QueryTabView.tsx`, `src/components/CommandPalette.tsx`, `src/components/StartScreen.tsx`

**Interfaces:**
- Consumes: Task 5 store.
- Produces:
  - `ConnectionScope({ id, children })`, `useConnectionId(): string`, `useWs<T>(select: (w: Workspace) => T): T`, `useWsActions(): { openTable(name, kind?, view?); openQuery(sql?, opts?); updateTab(tabId, patch); closeTab(tabId); setActiveTab(tabId); setDirty(tabId, count); selectDatabase(db); refreshObjects(); disconnect() }` — the same actions as the store, with the connection id already filled in.
  - `Workspace` takes `active: boolean`. `ConnectionRail` has no props.
  - Keyboard: ⌘1…⌘9 switch connections, ⌘L toggles Claude (used by Task 12), Esc closes the launcher.

- [ ] **Step 1: Create the scope hooks**

Create `src/store/workspace.tsx`:

```tsx
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useApp, type QueryTab, type TableTab, type Workspace } from './app';
import type { ObjectKind } from '../lib/types';

const ConnectionContext = createContext<string | null>(null);

/** Everything rendered inside belongs to one open connection. */
export function ConnectionScope({ id, children }: { id: string; children: ReactNode }) {
  return <ConnectionContext.Provider value={id}>{children}</ConnectionContext.Provider>;
}

export function useConnectionId(): string {
  const id = useContext(ConnectionContext);
  if (!id) throw new Error('useConnectionId must be used inside <ConnectionScope>');
  return id;
}

/**
 * Reads from this scope's workspace. While a connection closes, components may render once more
 * after their workspace is gone; they then keep the last value instead of crashing.
 */
export function useWs<T>(select: (w: Workspace) => T): T {
  const id = useConnectionId();
  const last = useRef<T>(undefined as T);
  return useApp((s) => {
    const w = s.workspaces[id];
    if (w) last.current = select(w);
    return last.current;
  });
}

/** Store actions with this scope's connection id filled in. */
export function useWsActions() {
  const id = useConnectionId();
  return useMemo(() => {
    const s = () => useApp.getState();
    return {
      openTable: (name: string, kind?: ObjectKind, view?: 'data' | 'structure') => s().openTable(id, name, kind, view),
      openQuery: (sql?: string, opts?: { autoRun?: boolean }) => s().openQuery(id, sql, opts),
      updateTab: (tabId: string, patch: Partial<TableTab> | Partial<QueryTab>) => s().updateTab(id, tabId, patch),
      closeTab: (tabId: string) => s().closeTab(id, tabId),
      setActiveTab: (tabId: string) => s().setActiveTab(id, tabId),
      setDirty: (tabId: string, count: number) => s().setDirty(id, tabId, count),
      selectDatabase: (db: string) => s().selectDatabase(id, db),
      refreshObjects: () => s().refreshObjects(id),
      disconnect: () => s().disconnect(id),
    };
  }, [id]);
}
```

- [ ] **Step 2: Move the components to scoped reads**

Apply these exact replacements (each file keeps its other code):

`src/components/Header.tsx`:
```ts
import { LogOut, PanelLeft, Plus, Search, Sparkles } from 'lucide-react';
import { ENV_LABEL, MOD, cx, envColor } from '../lib/ui';
import { useApp, wsActiveTab } from '../store/app';
import { useWs, useWsActions } from '../store/workspace';
```
and inside the component replace the first lines with:
```ts
  const session = useWs((w) => w.session);
  const tab = useWs(wsActiveTab);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const toggleClaude = useApp((s) => s.toggleClaude);
  const claudeOpen = useApp((s) => s.claudeOpen);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const { openQuery, disconnect } = useWsActions();
```
Add a Claude button before the "New query" button:
```tsx
      <button className={cx('icon-btn no-drag', claudeOpen && 'text-accent')} onClick={toggleClaude} title={`Claude (${MOD}L)`} aria-label="Toggle Claude panel" data-testid="toggle-claude">
        <Sparkles size={15} />
      </button>
```
Change the header's left padding to `style={{ paddingLeft: trafficLightSpace ? 32 : 8 }}` (the rail now sits under the traffic lights).

`src/components/Sidebar.tsx`:
```ts
import { useWs, useWsActions } from '../store/workspace';
import { wsActiveTab } from '../store/app';
```
(remove the old `import { activeTab, useApp } from '../store/app';`) and replace the first lines of the component with:
```ts
  const session = useWs((w) => w.session);
  const tab = useWs(wsActiveTab);
  const { selectDatabase, refreshObjects, openTable, openQuery } = useWsActions();
```

`src/components/TabBar.tsx`: replace the store reads with:
```ts
  const tabs = useWs((w) => w.tabs);
  const activeTabId = useWs((w) => w.activeTabId);
  const dirty = useWs((w) => w.dirtyTabs);
  const { setActiveTab, closeTab, openQuery } = useWsActions();
```
and the import with `import { useWs, useWsActions } from '../store/workspace';`.

`src/components/DataTab.tsx`: replace
```ts
  const session = useApp((s) => s.session)!;
  const setDirty = useApp((s) => s.setDirty);
  const updateTab = useApp((s) => s.updateTab);
```
with
```ts
  const session = useWs((w) => w.session);
  const { setDirty, updateTab } = useWsActions();
```
and add `import { useWs, useWsActions } from '../store/workspace';`. Keep `useApp` for global fields it still reads (row panel, toasts).

`src/components/QueryTabView.tsx`: replace
```ts
  const session = useApp((s) => s.session)!;
  const updateTab = useApp((s) => s.updateTab);
```
with
```ts
  const session = useWs((w) => w.session);
  const { updateTab } = useWsActions();
```
add the import, and add this effect right after the `run` callback and `runRef` are defined (it runs "Open in grid" tabs once):
```ts
  useEffect(() => {
    if (!tab.autoRun) return;
    updateTab(tab.id, { autoRun: false });
    setTimeout(() => runRef.current('all'), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

`src/components/CommandPalette.tsx`: replace `const session = s.session!;` with
```ts
  const cid = s.activeConnectionId!;
  const session = s.workspaces[cid].session;
```
change `s.openTable(o.name, o.kind)` → `s.openTable(cid, o.name, o.kind)`, `s.openTable(o.name, o.kind, 'structure')` → `s.openTable(cid, o.name, o.kind, 'structure')`, `s.openQuery()` → `s.openQuery(cid)`, any `s.selectDatabase(d)` → `s.selectDatabase(cid, d)`, any `s.disconnect()` → `s.disconnect(cid)`. Add open connections as the first items of the action list:
```ts
      ...s.openOrder
        .filter((id) => id !== cid)
        .map((id, i) => ({
          id: `c:${id}`,
          label: `Switch to ${s.workspaces[id].session.config.name}`,
          hint: s.openOrder.indexOf(id) < 9 ? `${MOD}${s.openOrder.indexOf(id) + 1}` : undefined,
          icon: <Database size={14} />,
          run: () => s.switchTo(id),
        })),
```
(import `Database` from `lucide-react`; `i` is unused — drop it if the linter complains.)

`src/components/Workspace.tsx`: make it take `{ active }`, read tabs through `useWs`, guard the key handler, and render the Claude panel slot. Replace the component and `cycleTab` with:
```tsx
export default function Workspace({ active }: { active: boolean }) {
  const cid = useConnectionId();
  const tabs = useWs((w) => w.tabs);
  const activeTabId = useWs((w) => w.activeTabId);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      const s = useApp.getState();
      const w = s.workspaces[cid];
      if (!w) return;
      if (matchKey(e, 'mod+k') || matchKey(e, 'mod+p')) {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (matchKey(e, 'mod+t')) {
        e.preventDefault();
        s.openQuery(cid);
      } else if (matchKey(e, 'mod+w')) {
        e.preventDefault();
        if (w.activeTabId) s.closeTab(cid, w.activeTabId);
      } else if (matchKey(e, 'mod+b')) {
        e.preventDefault();
        s.toggleSidebar();
      } else if (matchKey(e, 'mod+l')) {
        e.preventDefault();
        s.toggleClaude();
      } else if (matchKey(e, 'mod+shift+]') || (e.ctrlKey && e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        cycleTab(cid, 1);
      } else if (matchKey(e, 'mod+shift+[') || (e.ctrlKey && e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        cycleTab(cid, -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cid]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <Header trafficLightSpace={isTauri && isMac} />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col bg-surface">
          <TabBar />
          <div className="relative min-h-0 flex-1">
            {tabs.length === 0 && <EmptyWorkspace />}
            {/* tabs stay mounted so their state (pages, edits, editor) survives switching */}
            {tabs.map((t) => (
              <div key={t.id} className="absolute inset-0" style={{ display: t.id === activeTabId ? 'flex' : 'none' }}>
                {t.kind === 'table' ? <DataTab tab={t} active={active && t.id === activeTabId} /> : <QueryTabView tab={t} active={active && t.id === activeTabId} />}
              </div>
            ))}
          </div>
        </main>
        {/* Task 12 renders <ClaudePanel /> here */}
      </div>
    </div>
  );
}

function cycleTab(cid: string, dir: number) {
  const s = useApp.getState();
  const w = s.workspaces[cid];
  if (!w?.tabs.length) return;
  const idx = w.tabs.findIndex((t) => t.id === w.activeTabId);
  s.setActiveTab(cid, w.tabs[(idx + dir + w.tabs.length) % w.tabs.length].id);
}
```
Update its imports: `import { useEffect, useRef } from 'react';`, `import { useConnectionId, useWs, useWsActions } from '../store/workspace';`, remove the `CommandPalette` import (the palette moves to `App`). In `EmptyWorkspace` replace `const openQuery = useApp((s) => s.openQuery);` with `const { openQuery } = useWsActions();`.

`src/components/StartScreen.tsx`: add an optional `embedded` prop (`export default function StartScreen({ embedded = false }: { embedded?: boolean })`). When `embedded` is true, render a "Back" button in its top bar that calls `useApp.getState().showLauncher(false)`, and skip the left padding reserved for traffic lights (the rail is there). No other change.

- [ ] **Step 3: Create the connection rail**

Create `src/components/ConnectionRail.tsx`:

```tsx
import { Plus } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { isTauri } from '../lib/api';
import { ENV_LABEL, MOD, cx, envColor, isMac } from '../lib/ui';
import { useDismiss } from '../lib/useDismiss';
import { useApp } from '../store/app';

export function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export default function ConnectionRail() {
  const openOrder = useApp((s) => s.openOrder);
  const workspaces = useApp((s) => s.workspaces);
  const activeId = useApp((s) => s.activeConnectionId);
  const launcherOpen = useApp((s) => s.launcherOpen);
  const connecting = useApp((s) => s.connecting);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menuRef, closeMenu, !!menu);

  return (
    <nav className="drag flex w-[52px] shrink-0 flex-col items-center gap-2 border-r border-line bg-bg pb-3" style={{ paddingTop: isTauri && isMac ? 44 : 10 }} data-tauri-drag-region data-testid="connection-rail">
      {openOrder.map((id, i) => {
        const w = workspaces[id];
        if (!w) return null;
        const c = w.session.config;
        const color = envColor(c.environment);
        const active = id === activeId && !launcherOpen;
        return (
          <button
            key={id}
            className={cx('no-drag relative flex h-9 w-9 items-center justify-center rounded-[10px] text-[12px] font-semibold transition-shadow', active && 'shadow-[0_0_0_2px_var(--accent)]')}
            style={{ background: `color-mix(in srgb, ${color} ${active ? 22 : 14}%, transparent)`, color }}
            onClick={() => useApp.getState().switchTo(id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, id });
            }}
            title={`${c.name} · ${ENV_LABEL[c.environment]}${i < 9 ? ` (${MOD}${i + 1})` : ''}`}
            aria-label={`Switch to ${c.name}`}
            aria-current={active}
            data-testid="rail-item"
          >
            {initials(c.name)}
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg" style={{ background: color }} />
          </button>
        );
      })}
      <button
        className={cx('no-drag flex h-9 w-9 items-center justify-center rounded-[10px] border border-dashed border-line-strong text-ink-3 hover:text-ink', launcherOpen && 'border-accent text-accent')}
        onClick={() => useApp.getState().showLauncher(!launcherOpen)}
        title="Open another connection"
        aria-label="Open another connection"
        data-testid="rail-add"
      >
        {connecting ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Plus size={16} />}
      </button>

      {menu && (
        <div ref={menuRef} className="fade-in fixed z-50 w-44 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]" style={{ left: menu.x, top: menu.y }}>
          <button
            className="flex w-full rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3"
            onClick={() => {
              setMenu(null);
              useApp.getState().disconnect(menu.id);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </nav>
  );
}
```

- [ ] **Step 4: Rewrite `App.tsx`**

Replace `src/App.tsx` with:

```tsx
import { useEffect } from 'react';
import { useApp } from './store/app';
import { ConnectionScope } from './store/workspace';
import CommandPalette from './components/CommandPalette';
import ConnectionForm from './components/ConnectionForm';
import ConnectionRail from './components/ConnectionRail';
import StartScreen from './components/StartScreen';
import Toasts from './components/Toasts';
import Workspace from './components/Workspace';

export default function App() {
  const theme = useApp((s) => s.theme);
  const openOrder = useApp((s) => s.openOrder);
  const activeId = useApp((s) => s.activeConnectionId);
  const launcherOpen = useApp((s) => s.launcherOpen);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const editing = useApp((s) => s.editing);
  const loadConnections = useApp((s) => s.loadConnections);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  // ⌘1…⌘9 switch connections; Esc closes the connection list
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const id = s.openOrder[Number(e.key) - 1];
        if (id) {
          e.preventDefault();
          s.switchTo(id);
        }
      } else if (e.key === 'Escape' && s.launcherOpen && !s.editing) {
        s.showLauncher(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (openOrder.length === 0) {
    return (
      <>
        <StartScreen />
        {editing && <ConnectionForm />}
        <Toasts />
      </>
    );
  }

  return (
    <>
      <div className="flex h-full">
        <ConnectionRail />
        <div className="relative flex min-w-0 flex-1">
          {/* every open connection stays mounted, so its tabs, filters and scroll survive a switch */}
          {openOrder.map((id) => {
            const visible = id === activeId && !launcherOpen;
            return (
              <div key={id} className="absolute inset-0 flex" style={{ display: visible ? 'flex' : 'none' }}>
                <ConnectionScope id={id}>
                  <Workspace active={visible} />
                </ConnectionScope>
              </div>
            );
          })}
          {launcherOpen && (
            <div className="absolute inset-0 flex">
              <StartScreen embedded />
            </div>
          )}
        </div>
      </div>
      {paletteOpen && activeId && (
        <ConnectionScope id={activeId}>
          <CommandPalette />
        </ConnectionScope>
      )}
      {editing && <ConnectionForm />}
      <Toasts />
    </>
  );
}
```

- [ ] **Step 5: Find leftovers**

Run:
```bash
/usr/bin/grep -rn "s\.session\b\|s\.tabs\b\|s\.activeTabId\|s\.dirtyTabs\|activeTab(" src/components src/App.tsx | /usr/bin/grep -v "w\.\|test"
```
Expected: no output. Fix any line it prints with `useWs` / `useWsActions`.

- [ ] **Step 6: Add a rail test and run all checks**

Add to `src/store/app.test.ts`:
```ts
import { initials } from '../components/ConnectionRail';

describe('rail initials', () => {
  it('uses two letters', () => {
    expect(initials('development-core-cluster')).toBe('DC');
    expect(initials('shop')).toBe('SH');
    expect(initials('   ')).toBe('?');
  });
});
```
Run: `./node_modules/.bin/tsc --noEmit -p .` → no errors; vitest → all pass.

- [ ] **Step 7: Check in the browser**

Start the dev bridge and Vite (see README "Develop"). With two saved dev connections (a SQLite file and the Docker MySQL), check by hand:
1. Open connection 1, then click **+** in the rail and open connection 2 → two rail squares, the second active.
2. Open a table in each, type a filter in connection 1, switch with ⌘1 / ⌘2 → the filter text is still there.
3. Right-click a square → Disconnect → the other connection becomes active.
4. Disconnect the last one → the start screen shows.

- [ ] **Step 8: Checkpoint**

All tests and `tsc` green, browser check done. No commit.

---

### Task 7: Chat events, approvals and `ClaudeState`

**Files:**
- Create: `src-tauri/src/claude/mod.rs`, `src-tauri/src/claude/events.rs`, `src-tauri/src/claude/approvals.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod claude;`), `src-tauri/src/commands.rs` (`AppState.claude`), `src-tauri/src/store.rs` (`Store::dir`, `append_log`)

**Interfaces:**
- Produces:
  - `ChatEvent` (serde Serialize + Deserialize: `#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]`) with variants `User { text }`, `TextDelta { text }`, `Text { text }`, `Activity { label }`, `ToolCall { call_id, tool, connection: Option<String>, sql: Option<String> }`, `ToolResult { call_id, rows: Option<usize>, truncated: bool, elapsed_ms: Option<u64>, error: Option<String> }`, `Approval { request_id, connection, connection_name, sql }`, `ApprovalAnswered { request_id, allowed: bool }`, `Done { duration_ms: Option<u64>, cost_usd: Option<f64> }`, `Stopped`, `Error { error_kind: String, message: String }`.
  - `NumberedEvent { seq: u64, #[serde(flatten)] event: ChatEvent }`.
  - `ChatHub`: `create(&self, chat_id)`, `remove(&self, chat_id)`, `exists(&self, chat_id) -> bool`, `push(&self, chat_id, ChatEvent)`, `async wait_after(&self, chat_id, after: u64, wait: Duration) -> AppResult<Vec<NumberedEvent>>`.
  - `Approvals`: `async ask(&self, hub: &ChatHub, chat_id, connection_id, connection_name, sql, timeout: Duration) -> bool`, `answer(&self, request_id, allow) -> AppResult<()>`, `deny_all(&self, chat_id)`.
  - `ClaudeState { hub: Arc<ChatHub>, approvals: Arc<Approvals>, endpoint: OnceLock<McpEndpoint>, work_dir: PathBuf, bin_override: Mutex<Option<PathBuf>>, log_dir: PathBuf, .. }` with `new(data_dir: &Path)`, `open_chat(connections: Vec<ChatConnection>) -> String`, `set_connections(chat_id, Vec<ChatConnection>) -> AppResult<()>`, `chat(chat_id) -> AppResult<ChatConfig>`, `remove_chat(chat_id)`, `stop_signal(chat_id) -> Arc<tokio::sync::Notify>`.
  - `ChatConnection { id: String, database: Option<String> }` (serde camelCase, Deserialize), `ChatConfig { connection_ids: Vec<String>, databases: HashMap<String, Option<String>> }` with `database_for(&self, id) -> Option<String>`.
  - `McpEndpoint { port: u16, token: String }` with `url(&self, chat_id) -> String`.
  - `Store::dir(&self) -> &Path`; `pub fn append_log(dir: &Path, message: &str) -> AppResult<()>` in `store.rs` (used by `Store::log_client_error` and the runner).

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/claude/events.rs` with only tests first:

```rust
//! Chat events: what the panel shows, numbered so the frontend can poll for "everything after N".

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
```

Create `src-tauri/src/claude/approvals.rs` with only tests first:

```rust
//! Production queries wait here until the user clicks Run or Deny in the panel.

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
}
```

Create `src-tauri/src/claude/mod.rs`:

```rust
//! Claude panel backend: chat events, Production approvals, the MCP server and the Claude Code runner.

pub mod approvals;
pub mod events;
```

Add `pub mod claude;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run them to see them fail**

Run: `./scripts/test-rust.sh claude::`
Expected: compile errors (types not defined).

- [ ] **Step 3: Implement `events.rs`**

Put above the tests:

```rust
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
    ToolCall { call_id: String, tool: String, connection: Option<String>, sql: Option<String> },
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
```

- [ ] **Step 4: Implement `approvals.rs`**

Put above the tests:

```rust
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
    pub async fn ask(&self, hub: &ChatHub, chat_id: &str, connection_id: &str, connection_name: &str, sql: &str, timeout: Duration) -> bool {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        if let Ok(mut p) = self.pending.lock() {
            p.insert(request_id.clone(), (chat_id.to_string(), tx));
        }
        hub.push(chat_id, ChatEvent::Approval { request_id: request_id.clone(), connection: connection_id.into(), connection_name: connection_name.into(), sql: sql.into() });
        let allowed = matches!(tokio::time::timeout(timeout, rx).await, Ok(Ok(true)));
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
```

- [ ] **Step 5: Implement `ClaudeState` in `claude/mod.rs`**

Replace `src-tauri/src/claude/mod.rs` with:

```rust
//! Claude panel backend: chat events, Production approvals, the MCP server and the Claude Code runner.

pub mod approvals;
pub mod events;

use crate::error::{AppError, AppResult};
use approvals::Approvals;
use events::ChatHub;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

/// Where Claude Code reaches Tabula's MCP server
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

/// A connection a chat may use, with the database selected in Tabula (MySQL)
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
```

- [ ] **Step 6: Wire `ClaudeState` into `AppState` and the store**

In `src-tauri/src/store.rs`:
1. Add a public function above `impl Store` (move the body of `log_client_error` here):

```rust
/// Appends a message (with time) to client-errors.log in `dir`; keeps the file below ~1 MB.
pub fn append_log(dir: &Path, message: &str) -> AppResult<()> {
    use std::io::Write;
    let path = dir.join("client-errors.log");
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        std::fs::rename(&path, dir.join("client-errors.old.log"))?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "--- {}\n{}\n", chrono::Utc::now().to_rfc3339(), message)?;
    Ok(())
}
```

2. Replace the body of `Store::log_client_error` with `append_log(&self.dir, message)`.
3. Add to `impl Store`:

```rust
    pub fn dir(&self) -> &Path {
        &self.dir
    }
```

In `src-tauri/src/commands.rs`, change `AppState`:

```rust
pub struct AppState {
    pub store: Store,
    pub manager: Manager,
    pub claude: crate::claude::ClaudeState,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        let claude = crate::claude::ClaudeState::new(store.dir());
        Self { store, manager: Manager::default(), claude }
    }
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `./scripts/test-rust.sh claude::`
Expected: 6 tests pass.

- [ ] **Step 8: Checkpoint**

`./scripts/test-rust.sh` — all pass. No commit.

---

### Task 8: MCP server with the four tools

**Files:**
- Create: `src-tauri/src/claude/mcp.rs`
- Modify: `src-tauri/src/claude/mod.rs` (`pub mod mcp;`)
- Modify: `src-tauri/Cargo.toml` (axum non-optional; reqwest dev-dependency)

**Interfaces:**
- Consumes: `AppState { store, manager, claude }`, `readonly::{check, run_select}`, `ConnectionConfig::claude_access()`, `ChatHub::push`, `Approvals::ask`, `ClaudeState::{chat, stop_signal, endpoint}`.
- Produces: `pub async fn start(state: Arc<AppState>) -> AppResult<McpEndpoint>` — binds `127.0.0.1:0`, sets `state.claude.endpoint`, serves `POST /mcp/{chat_id}`. Tool names: `list_connections`, `list_tables`, `describe_table`, `run_select`. Claude Code sees them as `mcp__tabula__<name>`.

- [ ] **Step 1: Dependencies**

In `src-tauri/Cargo.toml`:
- change `axum = { version = "0.8", optional = true }` to `axum = "0.8"`
- change the feature line to `devserver = ["dep:tower-http"]`
- add under `[dev-dependencies]`: `reqwest = { version = "0.12", default-features = false, features = ["json"] }`

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/claude/mcp.rs` with only tests first:

```rust
//! Tabula's MCP server: read-only database tools for the Claude panel.
//! Minimal MCP (JSON-RPC 2.0) over streamable HTTP: every POST gets one JSON response, no server-sent events.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::ChatConnection;
    use crate::claude::events::ChatEvent;
    use crate::commands::dispatch;
    use crate::store::{SecretStore, Store};
    use serde_json::json;

    struct Fixture {
        _dir: tempfile::TempDir,
        state: Arc<AppState>,
        endpoint: crate::claude::McpEndpoint,
        conn_id: String,
    }

    async fn fixture(environment: &str, access: Option<&str>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("m.sqlite");
        rusqlite::Connection::open(&db).unwrap().execute_batch("CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL); INSERT INTO orders (total) VALUES (10), (20);").unwrap();
        let state = Arc::new(AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap()));
        let mut conn = json!({ "id": "", "name": "Shop", "engine": "sqlite", "environment": environment, "filePath": db.to_str().unwrap() });
        if let Some(a) = access {
            conn["claudeAccess"] = json!(a);
        }
        let saved = dispatch(&state, "save_connection", conn).await.unwrap();
        let conn_id = saved["id"].as_str().unwrap().to_string();
        dispatch(&state, "connect", json!({ "id": conn_id })).await.unwrap();
        let endpoint = start(state.clone()).await.unwrap();
        Fixture { _dir: dir, state, endpoint, conn_id }
    }

    async fn rpc(f: &Fixture, chat: &str, token: &str, body: Value) -> reqwest::Response {
        reqwest::Client::new()
            .post(f.endpoint.url(chat))
            .header("Authorization", format!("Bearer {token}"))
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    async fn call(f: &Fixture, chat: &str, tool: &str, args: Value) -> Value {
        let res = rpc(f, chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } })).await;
        res.json::<Value>().await.unwrap()["result"].clone()
    }

    fn chat_for(f: &Fixture) -> String {
        f.state.claude.open_chat(vec![ChatConnection { id: f.conn_id.clone(), database: None }])
    }

    #[tokio::test]
    async fn rejects_wrong_token_and_answers_initialize() {
        let f = fixture("dev", None).await;
        let chat = chat_for(&f);
        assert_eq!(rpc(&f, &chat, "wrong", json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await.status(), 401);
        let init: Value = rpc(&f, &chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "tabula");
        let note = rpc(&f, &chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        assert_eq!(note.status(), 202);
    }

    #[tokio::test]
    async fn lists_tools_by_access_level() {
        let f = fixture("dev", None).await;
        let chat = chat_for(&f);
        let tools: Value = rpc(&f, &chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.json().await.unwrap();
        let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_connections", "list_tables", "describe_table", "run_select"]);

        let f = fixture("dev", Some("schema")).await;
        let chat = chat_for(&f);
        let tools: Value = rpc(&f, &chat, &f.endpoint.token, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.json().await.unwrap();
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 3);
        let r = call(&f, &chat, "run_select", json!({ "connection": f.conn_id, "sql": "SELECT 1" })).await;
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("schema only"));
    }

    #[tokio::test]
    async fn runs_reads_and_reports_cards() {
        let f = fixture("dev", None).await;
        let chat = chat_for(&f);
        let tables = call(&f, &chat, "list_tables", json!({ "connection": f.conn_id })).await;
        assert!(tables["content"][0]["text"].as_str().unwrap().contains("orders"));
        let r = call(&f, &chat, "run_select", json!({ "connection": f.conn_id, "sql": "SELECT sum(total) AS s FROM orders" })).await;
        let body: Value = serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["rows"][0][0], 30.0);
        let w = call(&f, &chat, "run_select", json!({ "connection": f.conn_id, "sql": "DELETE FROM orders" })).await;
        assert_eq!(w["isError"], true);

        let events = f.state.claude.hub.wait_after(&chat, 0, std::time::Duration::from_millis(10)).await.unwrap();
        let calls = events.iter().filter(|e| matches!(e.event, ChatEvent::ToolCall { .. })).count();
        let results = events.iter().filter(|e| matches!(e.event, ChatEvent::ToolResult { .. })).count();
        assert_eq!((calls, results), (3, 3));
    }

    #[tokio::test]
    async fn connection_outside_the_chat_is_rejected() {
        let f = fixture("dev", None).await;
        let other_chat = f.state.claude.open_chat(vec![ChatConnection { id: "someone-else".into(), database: None }]);
        let r = call(&f, &other_chat, "run_select", json!({ "connection": f.conn_id, "sql": "SELECT 1" })).await;
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("not available in this chat"));
    }

    #[tokio::test]
    async fn production_waits_for_approval() {
        let f = fixture("prod", Some("data")).await;
        let chat = chat_for(&f);
        let state = f.state.clone();
        let chat2 = chat.clone();
        tokio::spawn(async move {
            loop {
                for e in state.claude.hub.wait_after(&chat2, 0, std::time::Duration::from_secs(1)).await.unwrap() {
                    if let ChatEvent::Approval { request_id, .. } = e.event {
                        state.claude.approvals.answer(&request_id, false).unwrap();
                        return;
                    }
                }
            }
        });
        let r = call(&f, &chat, "run_select", json!({ "connection": f.conn_id, "sql": "SELECT 1" })).await;
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("did not allow"));
    }

    #[tokio::test]
    async fn mcp_uses_explicit_database() {
        // SQLite has one database; the explicit value must be accepted and ignored, not fail
        let f = fixture("dev", None).await;
        let chat = chat_for(&f);
        let r = call(&f, &chat, "list_tables", json!({ "connection": f.conn_id, "database": "main" })).await;
        assert!(r.get("isError").is_none(), "{r}");
        // MySQL: covered by `mysql_database_argument_wins` below when TABULA_TEST_MYSQL is set
    }
}
```

Add `pub mod mcp;` to `src-tauri/src/claude/mod.rs`.

- [ ] **Step 3: Run them to see them fail**

Run: `./scripts/test-rust.sh claude::mcp`
Expected: compile error (`start` not found).

- [ ] **Step 4: Implement the server**

Put above the tests in `mcp.rs`:

```rust
use super::events::ChatEvent;
use super::{ChatConfig, McpEndpoint};
use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::manager::Session;
use crate::model::{ClaudeAccess, ConnectionConfig, Engine, Environment};
use crate::readonly;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

/// Starts the server on a random local port with a new secret token.
pub async fn start(state: Arc<AppState>) -> AppResult<McpEndpoint> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let endpoint = McpEndpoint { port, token };
    let _ = state.claude.endpoint.set(endpoint.clone());
    let app = Router::new()
        .route("/mcp/{chat_id}", post(handle).get(|| async { StatusCode::METHOD_NOT_ALLOWED }).delete(|| async { StatusCode::OK }))
        .with_state(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(endpoint)
}

async fn handle(State(state): State<Arc<AppState>>, Path(chat_id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(endpoint) = state.claude.endpoint.get() else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    let expected = format!("Bearer {}", endpoint.token);
    if headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) != Some(expected.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return Json(rpc_error(Value::Null, -32700, "Parse error")).into_response();
    };
    // notifications (no id) get 202 and no body
    let Some(id) = msg.get("id").cloned() else { return StatusCode::ACCEPTED.into_response() };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let reply = match msg.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => rpc_result(id, initialize(&params)),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => match tool_list(&state, &chat_id) {
            Ok(tools) => rpc_result(id, tools),
            Err(e) => rpc_error(id, -32602, &e.to_string()),
        },
        "tools/call" => rpc_result(id, call_tool(&state, &chat_id, &params).await),
        _ => rpc_error(id, -32601, "Method not found"),
    };
    Json(reply).into_response()
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "tabula", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Read-only access to the user's open database connections in Tabula. Call list_connections first."
    })
}

/// Connections of a chat that Claude may see (access is not Off).
fn visible(state: &AppState, chat: &ChatConfig) -> Vec<ConnectionConfig> {
    chat.connection_ids
        .iter()
        .filter_map(|id| state.store.connection(id).ok())
        .filter(|c| c.claude_access() != ClaudeAccess::Off)
        .collect()
}

fn tool_list(state: &AppState, chat_id: &str) -> AppResult<Value> {
    let chat = state.claude.chat(chat_id)?;
    let any_data = visible(state, &chat).iter().any(|c| c.claude_access() == ClaudeAccess::Data);
    let conn = || json!({ "type": "string", "description": "Connection id from list_connections" });
    let db = || json!({ "type": "string", "description": "MySQL database (schema). Default: the database selected in Tabula" });
    let mut tools = vec![
        json!({ "name": "list_connections", "description": "Database connections you may use in this chat: id, name, engine (mysql or sqlite), environment, selected database and access level.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "list_tables", "description": "Tables and views of a connection, with estimated row counts.", "inputSchema": { "type": "object", "properties": { "connection": conn(), "database": db() }, "required": ["connection"] } }),
        json!({ "name": "describe_table", "description": "Columns (type, nullable, default, primary key), indexes and foreign keys of one table.", "inputSchema": { "type": "object", "properties": { "connection": conn(), "database": db(), "table": { "type": "string" } }, "required": ["connection", "table"] } }),
    ];
    if any_data {
        tools.push(json!({ "name": "run_select", "description": "Run ONE read-only statement (SELECT, SHOW, EXPLAIN, WITH … SELECT). Returns at most 200 rows; long values are cut to 2 KB. On Production connections the user must approve each query.", "inputSchema": { "type": "object", "properties": { "connection": conn(), "database": db(), "sql": { "type": "string" } }, "required": ["connection", "sql"] } }));
    }
    Ok(json!({ "tools": tools }))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ToolArgs {
    connection: Option<String>,
    database: Option<String>,
    table: Option<String>,
    sql: Option<String>,
}

struct ToolOutput {
    text: String,
    rows: Option<usize>,
    truncated: bool,
}

/// Runs a tool and reports it to the chat as a card (ToolCall, then ToolResult).
async fn call_tool(state: &AppState, chat_id: &str, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let args: ToolArgs = serde_json::from_value(params.get("arguments").cloned().unwrap_or_else(|| json!({}))).unwrap_or_default();
    let call_id = uuid::Uuid::new_v4().to_string();
    let hub = &state.claude.hub;
    hub.push(chat_id, ChatEvent::ToolCall { call_id: call_id.clone(), tool: name.clone(), connection: args.connection.clone(), sql: args.sql.clone() });
    let started = std::time::Instant::now();
    let stop = state.claude.stop_signal(chat_id);
    let res = tokio::select! {
        r = run_tool(state, chat_id, &name, &args) => r,
        _ = stop.notified() => Err(AppError::msg("Stopped by the user.")),
    };
    let elapsed_ms = Some(started.elapsed().as_millis() as u64);
    match res {
        Ok(out) => {
            hub.push(chat_id, ChatEvent::ToolResult { call_id, rows: out.rows, truncated: out.truncated, elapsed_ms, error: None });
            json!({ "content": [{ "type": "text", "text": out.text }] })
        }
        Err(e) => {
            let message = e.to_string();
            hub.push(chat_id, ChatEvent::ToolResult { call_id, rows: None, truncated: false, elapsed_ms, error: Some(message.clone()) });
            json!({ "content": [{ "type": "text", "text": message }], "isError": true })
        }
    }
}

fn text_output<T: serde::Serialize>(value: &T, rows: Option<usize>) -> AppResult<ToolOutput> {
    Ok(ToolOutput { text: serde_json::to_string(value)?, rows, truncated: false })
}

async fn run_tool(state: &AppState, chat_id: &str, name: &str, a: &ToolArgs) -> AppResult<ToolOutput> {
    let chat = state.claude.chat(chat_id)?;
    match name {
        "list_connections" => {
            let list: Vec<Value> = visible(state, &chat)
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id, "name": c.name, "engine": c.engine, "environment": c.environment,
                        "database": chat.database_for(&c.id).or_else(|| c.database.clone()),
                        "access": c.claude_access(),
                    })
                })
                .collect();
            text_output(&list, Some(list.len()))
        }
        "list_tables" => {
            let (c, s) = resolve(state, &chat, a).await?;
            let objects = s.objects(database(&chat, &c, a).as_deref()).await?;
            text_output(&objects, Some(objects.len()))
        }
        "describe_table" => {
            let (c, s) = resolve(state, &chat, a).await?;
            let table = a.table.as_deref().ok_or_else(|| AppError::msg("table is required"))?;
            let structure = s.structure(database(&chat, &c, a).as_deref(), table).await?;
            text_output(&structure, None)
        }
        "run_select" => {
            let (c, s) = resolve(state, &chat, a).await?;
            if c.claude_access() != ClaudeAccess::Data {
                return Err(AppError::msg(format!("Connection \"{}\" allows schema only. Use list_tables and describe_table.", c.name)));
            }
            let sql = a.sql.as_deref().ok_or_else(|| AppError::msg("sql is required"))?;
            readonly::check(sql, s.dialect())?; // refuse writes before bothering the user
            if c.environment == Environment::Prod
                && !state.claude.approvals.ask(&state.claude.hub, chat_id, &c.id, &c.name, sql, APPROVAL_TIMEOUT).await
            {
                return Err(AppError::msg("The user did not allow this query."));
            }
            let res = readonly::run_select(&s, database(&chat, &c, a).as_deref(), sql).await?;
            let body = json!({
                "columns": res.columns.iter().map(|col| col.name.as_str()).collect::<Vec<_>>(),
                "rows": res.rows, "truncated": res.truncated, "elapsedMs": res.elapsed_ms,
            });
            Ok(ToolOutput { text: body.to_string(), rows: Some(res.rows.len()), truncated: res.truncated })
        }
        other => Err(AppError::msg(format!("Unknown tool: {other}"))),
    }
}

/// The connection named in the arguments, if this chat may use it and it is open.
async fn resolve(state: &AppState, chat: &ChatConfig, a: &ToolArgs) -> AppResult<(ConnectionConfig, Arc<Session>)> {
    let id = a.connection.as_deref().ok_or_else(|| AppError::msg("connection is required. Call list_connections first."))?;
    let not_available = || AppError::msg(format!("Connection {id} is not available in this chat."));
    if !chat.connection_ids.iter().any(|c| c == id) {
        return Err(not_available());
    }
    let config = state.store.connection(id).map_err(|_| not_available())?;
    if config.claude_access() == ClaudeAccess::Off {
        return Err(not_available());
    }
    let session = state.manager.get(id).await.map_err(|_| AppError::msg(format!("Connection \"{}\" is not open in Tabula.", config.name)))?;
    Ok((config, session))
}

/// MySQL: the argument, else the database selected in Tabula, else the saved default. SQLite: none.
fn database(chat: &ChatConfig, c: &ConnectionConfig, a: &ToolArgs) -> Option<String> {
    match c.engine {
        Engine::Mysql => a.database.clone().or_else(|| chat.database_for(&c.id)).or_else(|| c.database.clone()),
        Engine::Sqlite => None,
    }
}
```

- [ ] **Step 5: Add the MySQL database-argument test**

Append inside the `tests` module of `mcp.rs`:

```rust
    #[tokio::test]
    async fn mysql_database_argument_wins() {
        let Ok(v) = std::env::var("TABULA_TEST_MYSQL") else { return };
        let p: Vec<&str> = v.splitn(5, ':').collect();
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(Store::new(dir.path().join("cfg"), SecretStore::file(dir.path().join("s.json"))).unwrap()));
        let saved = dispatch(&state, "save_connection", json!({
            "id": "", "name": "My", "engine": "mysql", "host": p[0], "port": p[1].parse::<u16>().unwrap(), "user": p[2], "password": p[3], "database": p[4]
        })).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        dispatch(&state, "connect", json!({ "id": id })).await.unwrap();
        start(state.clone()).await.unwrap();
        // the chat says "selected database = information_schema"; the argument asks for the test database
        let chat = state.claude.open_chat(vec![ChatConnection { id: id.clone(), database: Some("information_schema".into()) }]);
        let out = run_tool(&state, &chat, "run_select", &ToolArgs { connection: Some(id.clone()), database: Some(p[4].into()), sql: Some("SELECT DATABASE()".into()), ..Default::default() }).await.unwrap();
        assert!(out.text.contains(p[4]), "{}", out.text);
        let out = run_tool(&state, &chat, "run_select", &ToolArgs { connection: Some(id), sql: Some("SELECT DATABASE()".into()), ..Default::default() }).await.unwrap();
        assert!(out.text.contains("information_schema"), "{}", out.text);
    }
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `./scripts/test-rust.sh claude::mcp`
Expected: 7 tests pass (the MySQL one returns early without Docker).

- [ ] **Step 7: Checkpoint**

`./scripts/test-rust.sh` — all pass; `cargo build --manifest-path src-tauri/Cargo.toml --features devserver --bin devserver` builds. No commit.

---

### Task 9: Claude Code CLI helpers — find it, build arguments, parse output

**Files:**
- Create: `src-tauri/src/claude/cli.rs`
- Modify: `src-tauri/src/claude/mod.rs` (`pub mod cli;`)

**Interfaces:**
- Consumes: `src-tauri/tests/fixtures/claude/hello.jsonl` and `probe-notes.md` (Task 1). If the probe found that `--setting-sources ""` is rejected, use the value from `probe-notes.md` in `SETTING_SOURCES` below.
- Produces:
  - `pub fn locate(override_path: Option<&Path>) -> Option<PathBuf>`
  - `pub fn version(bin: &Path) -> Option<String>`
  - `pub struct RunOptions { mcp_url: String, token: String, project_folder: Option<String>, resume: Option<String>, system_prompt: String }`
  - `pub fn build_args(o: &RunOptions) -> Vec<String>`
  - `pub fn system_prompt(has_project_folder: bool) -> String`
  - `pub enum StreamItem { SessionId(String), TextDelta(String), Text(String), Activity(String), Done { duration_ms: Option<u64>, cost_usd: Option<f64>, error: Option<String> }, Ignored, Unknown(String) }`
  - `pub fn parse_line(line: &str) -> Vec<StreamItem>`
  - `pub fn classify_error(message: &str) -> &'static str` — `"login"`, `"limit"` or `"claude"`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/claude/cli.rs` with only tests first:

```rust
//! Finding and talking to the installed Claude Code CLI (`claude -p` with stream-json input and output).

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(folder: Option<&str>) -> RunOptions {
        RunOptions { mcp_url: "http://127.0.0.1:9/mcp/c".into(), token: "t".into(), project_folder: folder.map(Into::into), resume: None, system_prompt: "p".into() }
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> &'a str {
        let i = args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("missing {flag}"));
        &args[i + 1]
    }

    #[test]
    fn args_without_project_folder_disable_all_builtin_tools() {
        let args = build_args(&opts(None));
        assert_eq!(value_after(&args, "--tools"), "");
        assert_eq!(value_after(&args, "--allowedTools"), "mcp__tabula");
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        let mcp: serde_json::Value = serde_json::from_str(value_after(&args, "--mcp-config")).unwrap();
        assert_eq!(mcp["mcpServers"]["tabula"]["type"], "http");
        assert_eq!(mcp["mcpServers"]["tabula"]["headers"]["Authorization"], "Bearer t");
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn args_with_project_folder_allow_reading_only_there() {
        let mut o = opts(Some("/Users/me/app"));
        o.resume = Some("s1".into());
        let args = build_args(&o);
        assert_eq!(value_after(&args, "--tools"), "Read,Grep,Glob");
        let i = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(&args[i + 1..i + 3], ["mcp__tabula", "Read(//Users/me/app/**)"]);
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
            parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","name":"Read","input":{"file_path":"/a/b/models/user.ts"}},{"type":"tool_use","name":"mcp__tabula__run_select","input":{}}]}}"#),
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
```

Add `pub mod cli;` to `src-tauri/src/claude/mod.rs`.

- [ ] **Step 2: Run them to see them fail**

Run: `./scripts/test-rust.sh claude::cli`
Expected: compile errors.

- [ ] **Step 3: Implement**

Put above the tests:

```rust
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// Settings Claude Code loads: none of the user's or project's (no hooks, no extra permissions).
/// Changed after the Task 1 probe if `""` is not accepted.
const SETTING_SOURCES: &str = "";

/// Finds the `claude` binary. A GUI app has a short PATH, so common install places are checked first.
pub fn locate(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = override_path {
        return p.is_file().then(|| p.to_path_buf());
    }
    if let Ok(p) = std::env::var("TABULA_CLAUDE_BIN") {
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
    let out = std::process::Command::new(shell).args(["-lc", "command -v claude"]).output().ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty() && Path::new(&path).is_file()).then(|| PathBuf::from(path))
}

pub fn version(bin: &Path) -> Option<String> {
    let out = std::process::Command::new(bin).arg("--version").output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub struct RunOptions {
    pub mcp_url: String,
    pub token: String,
    pub project_folder: Option<String>,
    pub resume: Option<String>,
    pub system_prompt: String,
}

pub fn build_args(o: &RunOptions) -> Vec<String> {
    let mcp = json!({ "mcpServers": { "tabula": { "type": "http", "url": o.mcp_url, "headers": { "Authorization": format!("Bearer {}", o.token) } } } });
    let mut args: Vec<String> = [
        "-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages",
        "--strict-mcp-config", "--setting-sources", SETTING_SOURCES,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push("--mcp-config".into());
    args.push(mcp.to_string());
    args.push("--tools".into());
    let mut allowed = vec!["mcp__tabula".to_string()];
    match &o.project_folder {
        Some(folder) => {
            args.push("Read,Grep,Glob".into());
            // `//` = absolute path in Claude Code permission rules; Grep and Glob follow Read rules
            allowed.push(format!("Read(/{}/**)", folder.trim_end_matches('/')));
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
        "You are the assistant inside Tabula, a desktop database client. Answer the user's questions about their databases.\n\
         Use the tabula tools: list_connections first, then list_tables and describe_table, then run_select.\n\
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
        "result" => {
            let failed = v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().is_some_and(|s| s != "success");
            let error = failed.then(|| text(&v["result"]).unwrap_or_else(|| v["subtype"].as_str().unwrap_or("error").to_string()));
            vec![StreamItem::Done { duration_ms: v["duration_ms"].as_u64(), cost_usd: v["total_cost_usd"].as_f64(), error }]
        }
        other => vec![StreamItem::Unknown(other.to_string())],
    }
}

/// A status line for built-in tools; Tabula's own tools show as cards instead.
fn activity(block: &Value) -> Option<StreamItem> {
    let name = block["name"].as_str()?;
    let input = &block["input"];
    let label = match name {
        n if n.starts_with("mcp__tabula__") => return None,
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
    } else if m.contains("limit") || m.contains("usage") {
        "limit"
    } else {
        "claude"
    }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `./scripts/test-rust.sh claude::cli`
Expected: 6 tests pass. If `parses_the_recorded_answer` lists unknown types (for example `rate_limit_event`), add them to `parse_line` as `"rate_limit_event" => vec![StreamItem::Ignored],` and run again.

- [ ] **Step 5: Checkpoint**

`./scripts/test-rust.sh` — all pass. No commit.

---

### Task 10: Agent runner, chat commands and app wiring

**Files:**
- Create: `src-tauri/src/claude/runner.rs`, `scripts/fake-claude.sh`
- Modify: `src-tauri/src/claude/mod.rs` (`pub mod runner;`, `runners` field), `src-tauri/src/commands.rs` (commands + tests), `src-tauri/src/lib.rs` (`Arc<AppState>`, start MCP), `src-tauri/src/bin/devserver.rs` (start MCP)

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces:
  - `runner::send(state: &AppState, chat_id: &str, text: &str) -> AppResult<()>` — errors that the user should see become `ChatEvent::Error` in the chat; the command still returns `Ok`.
  - `runner::stop(state, chat_id)`, `runner::close(state, chat_id)` ("New chat" in the panel = close + start a new chat) (all `async -> AppResult<()>`).
  - Commands: `claude_status` → `{ found: bool, path: string | null, version: string | null }`; `chat_start { connections: ChatConnection[] }` → `{ chatId }`; `chat_set_connections { chatId, connections }`; `chat_send { chatId, text }`; `chat_events { chatId, after }` → `NumberedEvent[]` (waits up to 25 s); `chat_stop { chatId }`; `chat_close { chatId }`; `answer_approval { requestId, allow }`.
  - Env var `TABULA_CLAUDE_BIN` (dev bridge / tests) points at another binary; `TABULA_FAKE_CLAUDE_FIXTURE` picks the reply file of `scripts/fake-claude.sh`.

- [ ] **Step 1: Create the fake Claude script**

Create `scripts/fake-claude.sh` and make it executable (`chmod +x scripts/fake-claude.sh`):

```sh
#!/bin/sh
# Test stand-in for `claude -p --input-format stream-json`: answers every input line with a recorded reply.
case "$1" in --version) echo "0.0.0 (fake Claude Code)"; exit 0 ;; esac
FIXTURE="${TABULA_FAKE_CLAUDE_FIXTURE:-$(cd "$(dirname "$0")" && pwd)/../src-tauri/tests/fixtures/claude/hello.jsonl}"
while IFS= read -r _line; do
  cat "$FIXTURE"
done
```

- [ ] **Step 2: Write the failing tests**

Add to the `tests` module of `src-tauri/src/commands.rs`:

```rust
    use crate::claude::events::ChatEvent;

    fn fake_claude() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-claude.sh").canonicalize().unwrap()
    }

    async fn sqlite_state(dir: &std::path::Path) -> (std::sync::Arc<AppState>, String) {
        let db = dir.join("c.sqlite");
        rusqlite::Connection::open(&db).unwrap().execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);").unwrap();
        let state = std::sync::Arc::new(AppState::new(Store::new(dir.join("cfg"), SecretStore::file(dir.join("s.json"))).unwrap()));
        let saved = dispatch(&state, "save_connection", json!({ "id": "", "name": "c", "engine": "sqlite", "filePath": db.to_str().unwrap() })).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        dispatch(&state, "connect", json!({ "id": id })).await.unwrap();
        crate::claude::mcp::start(state.clone()).await.unwrap();
        (state, id)
    }

    async fn events_until_done(state: &AppState, chat: &str) -> Vec<ChatEvent> {
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
    async fn closing_a_chat_kills_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        *state.claude.bin_override.lock().unwrap() = Some(fake_claude());
        let chat = dispatch(&state, "chat_start", json!({ "connections": [{ "id": id }] })).await.unwrap()["chatId"].as_str().unwrap().to_string();
        dispatch(&state, "chat_send", json!({ "chatId": chat, "text": "hi" })).await.unwrap();
        dispatch(&state, "chat_close", json!({ "chatId": chat })).await.unwrap();
        assert!(dispatch(&state, "chat_events", json!({ "chatId": chat, "after": 0 })).await.is_err());
        assert!(state.claude.runners.lock().await.get(&chat).is_none());
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
```

- [ ] **Step 3: Run them to see them fail**

Run: `./scripts/test-rust.sh chat_ missing_claude closing_a_chat`
Expected: compile errors (`runners` field / commands missing).

- [ ] **Step 4: Implement the runner**

Add to `ClaudeState` in `src-tauri/src/claude/mod.rs`: field `pub runners: tokio::sync::Mutex<HashMap<String, runner::ChatRunner>>,`, initialise it with `runners: tokio::sync::Mutex::new(HashMap::new()),` in `new`, and add `pub mod runner;` next to the other modules.

Create `src-tauri/src/claude/runner.rs`:

```rust
//! One Claude Code process per chat: messages go to its stdin, its stdout becomes chat events.

use super::cli::{self, RunOptions, StreamItem};
use super::events::{ChatEvent, ChatHub};
use super::ChatConfig;
use crate::commands::AppState;
use crate::error::AppResult;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
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
}

fn error(kind: &str, message: impl Into<String>) -> ChatEvent {
    ChatEvent::Error { error_kind: kind.into(), message: message.into() }
}

/// Sends a user message, starting Claude Code when needed.
pub async fn send(state: &AppState, chat_id: &str, text: &str) -> AppResult<()> {
    let chat = state.claude.chat(chat_id)?;
    let hub = state.claude.hub.clone();
    hub.push(chat_id, ChatEvent::User { text: text.to_string() });
    let mut runners = state.claude.runners.lock().await;
    let runner = runners.entry(chat_id.to_string()).or_default();
    if runner.stdin.is_none() || !runner.alive.load(Ordering::SeqCst) {
        if let Err(event) = spawn(state, chat_id, &chat, runner) {
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
        hub.push(chat_id, error("exited", format!("Could not send the message to Claude Code: {e}")));
    }
    Ok(())
}

fn spawn(state: &AppState, chat_id: &str, chat: &ChatConfig, runner: &mut ChatRunner) -> Result<(), ChatEvent> {
    let endpoint = state.claude.endpoint.get().ok_or_else(|| error("internal", "Claude tools are not ready yet. Try again in a moment."))?;
    let override_path = state.claude.bin_override.lock().ok().and_then(|p| p.clone());
    let bin = cli::locate(override_path.as_deref())
        .ok_or_else(|| error("not_installed", "Claude Code is not installed. Install it, run `claude` once in Terminal and log in, then try again."))?;
    let primary = chat.connection_ids.first().and_then(|id| state.store.connection(id).ok());
    let project_folder = primary.and_then(|c| c.project_folder).filter(|f| Path::new(f).is_dir());
    let cwd: PathBuf = project_folder.clone().map(PathBuf::from).unwrap_or_else(|| state.claude.work_dir.clone());
    let _ = std::fs::create_dir_all(&cwd);
    let options = RunOptions {
        mcp_url: endpoint.url(chat_id),
        token: endpoint.token.clone(),
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
        r.stopping.store(true, Ordering::SeqCst);
        r.alive.store(false, Ordering::SeqCst);
        r.stdin = None;
        if let Some(mut child) = r.child.take() {
            let _ = child.start_kill();
        }
    }
    state.claude.approvals.deny_all(chat_id);
    state.claude.stop_signal(chat_id).notify_waiters();
    state.claude.hub.push(chat_id, ChatEvent::Stopped);
    Ok(())
}

/// Connection closed: stop everything and remove the chat.
pub async fn close(state: &AppState, chat_id: &str) -> AppResult<()> {
    stop(state, chat_id).await?;
    state.claude.runners.lock().await.remove(chat_id);
    state.claude.remove_chat(chat_id);
    Ok(())
}
```

- [ ] **Step 5: Add the commands**

In `src-tauri/src/commands.rs` add argument structs:

```rust
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
```

Add these arms to `dispatch` before `"ping"`:

```rust
        "claude_status" => {
            let override_path = state.claude.bin_override.lock().ok().and_then(|p| p.clone());
            let path = crate::claude::cli::locate(override_path.as_deref());
            let version = path.as_deref().and_then(crate::claude::cli::version);
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
        "answer_approval" => {
            let a: ApprovalArgs = parse(args)?;
            state.claude.approvals.answer(&a.request_id, a.allow)?;
            ok(true)
        }
```

- [ ] **Step 6: Share `AppState` and start the MCP server in the app and the dev bridge**

Replace `run()` and `call` in `src-tauri/src/lib.rs`:

```rust
use std::sync::Arc;

/// Single entry point for all backend commands (see commands::dispatch).
#[tauri::command]
async fn call(
    state: tauri::State<'_, Arc<AppState>>,
    command: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, error::AppError> {
    commands::dispatch(&state, &command, args.unwrap_or(serde_json::Value::Null)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let store = Store::new(dir.clone(), SecretStore::file(dir.join("secrets.json")))?;
            let state = Arc::new(AppState::new(store));
            tauri::async_runtime::block_on(claude::mcp::start(state.clone()))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![call])
        .run(tauri::generate_context!())
        .expect("error while running Tabula");
}
```

(`AppError` must implement `std::error::Error` for `?` inside `setup`; it does through `thiserror`.)

In `src-tauri/src/bin/devserver.rs`, after `let state = Arc::new(AppState::new(store));` add:

```rust
    let mcp = tabula_lib::claude::mcp::start(state.clone()).await.expect("mcp server");
    println!("Claude tools (MCP) on 127.0.0.1:{}", mcp.port);
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `./scripts/test-rust.sh`
Expected: all tests pass, including the 4 new chat tests.

- [ ] **Step 8: Checkpoint**

`npm run tauri build -- --bundles app` builds (run with nvm Node). No commit.

---

### Task 11: Frontend chat model, API and store

**Files:**
- Modify: `src/lib/types.ts` (chat types), `src/lib/api.ts` (chat commands)
- Create: `src/lib/chat.ts`, `src/lib/chat.test.ts`, `src/store/chat.ts`

**Interfaces:**
- Consumes: backend commands from Task 10; `useApp` workspaces (Task 5).
- Produces:
  - Types: `ChatEvent` (mirror of the Rust enum, plus `seq`), `ClaudeStatus { found: boolean; path: string | null; version: string | null }`, `ChatConnection { id: string; database: string | null }`.
  - `lib/chat.ts`: `ChatItem` union (`user`, `assistant`, `tool`, `approval`, `notice`), `ChatView { items; busy; activity; lastSeq }`, `emptyChat`, `applyEvents(view, events): ChatView`, `noticeText(kind, message): string`, `TOOL_LABEL`.
  - `store/chat.ts`: `useChat` with `chats: Record<connectionId, { chatId: string | null; view: ChatView; extra: string[] }>`, `status`, `noticeSeen`, and actions `checkStatus()`, `send(cid, text)`, `stop(cid)`, `newChat(cid)`, `answer(cid, requestId, allow)`, `setExtra(cid, ids)`, `dismissNotice()`.

- [ ] **Step 1: Add the types and API calls**

Append to `src/lib/types.ts`:

```ts
export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
}

export interface ChatConnection {
  id: string;
  database: string | null;
}

/** Mirrors claude::events::NumberedEvent */
export type ChatEvent = { seq: number } & (
  | { kind: 'user'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'activity'; label: string }
  | { kind: 'tool_call'; callId: string; tool: string; connection: string | null; sql: string | null }
  | { kind: 'tool_result'; callId: string; rows: number | null; truncated: boolean; elapsedMs: number | null; error: string | null }
  | { kind: 'approval'; requestId: string; connection: string; connectionName: string; sql: string }
  | { kind: 'approval_answered'; requestId: string; allowed: boolean }
  | { kind: 'done'; durationMs: number | null; costUsd: number | null }
  | { kind: 'stopped' }
  | { kind: 'error'; errorKind: string; message: string }
);
```

In `src/lib/api.ts`, extend the type import with `ChatConnection, ChatEvent, ClaudeStatus` and add to the `api` object:

```ts
  claudeStatus: () => call<ClaudeStatus>('claude_status'),
  chatStart: (connections: ChatConnection[]) => call<{ chatId: string }>('chat_start', { connections }),
  chatSetConnections: (chatId: string, connections: ChatConnection[]) => call<boolean>('chat_set_connections', { chatId, connections }),
  chatSend: (chatId: string, text: string) => call<boolean>('chat_send', { chatId, text }),
  chatEvents: (chatId: string, after: number) => call<ChatEvent[]>('chat_events', { chatId, after }),
  chatStop: (chatId: string) => call<boolean>('chat_stop', { chatId }),
  chatClose: (chatId: string) => call<boolean>('chat_close', { chatId }),
  answerApproval: (requestId: string, allow: boolean) => call<boolean>('answer_approval', { requestId, allow }),
```

- [ ] **Step 2: Write the failing reducer tests**

Create `src/lib/chat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyEvents, emptyChat } from './chat';
import type { ChatEvent } from './types';

let seq = 0;
const ev = (e: Omit<ChatEvent, 'seq'>) => ({ ...e, seq: ++seq }) as ChatEvent;

describe('applyEvents', () => {
  it('streams text, then replaces it with the final text', () => {
    let v = applyEvents(emptyChat, [ev({ kind: 'user', text: 'hi' }), ev({ kind: 'text_delta', text: 'Hel' }), ev({ kind: 'text_delta', text: 'lo' })]);
    expect(v.busy).toBe(true);
    expect(v.items[1]).toMatchObject({ type: 'assistant', text: 'Hello', streaming: true });
    v = applyEvents(v, [ev({ kind: 'text', text: 'Hello!' }), ev({ kind: 'done', durationMs: 5, costUsd: null })]);
    expect(v.items[1]).toMatchObject({ type: 'assistant', text: 'Hello!', streaming: false });
    expect(v.busy).toBe(false);
  });

  it('turns tool calls into cards and updates them', () => {
    let v = applyEvents(emptyChat, [ev({ kind: 'tool_call', callId: 'c1', tool: 'run_select', connection: 'x', sql: 'SELECT 1' })]);
    expect(v.items[0]).toMatchObject({ type: 'tool', status: 'running' });
    expect(v.activity).toBe('Running query');
    v = applyEvents(v, [ev({ kind: 'tool_result', callId: 'c1', rows: 3, truncated: false, elapsedMs: 4, error: null })]);
    expect(v.items[0]).toMatchObject({ status: 'done', rows: 3 });
    v = applyEvents(v, [ev({ kind: 'tool_call', callId: 'c2', tool: 'run_select', connection: 'x', sql: 'DELETE' }), ev({ kind: 'tool_result', callId: 'c2', rows: null, truncated: false, elapsedMs: 1, error: 'Only read-only' })]);
    expect(v.items[1]).toMatchObject({ status: 'error', error: 'Only read-only' });
  });

  it('tracks approvals', () => {
    let v = applyEvents(emptyChat, [ev({ kind: 'approval', requestId: 'r1', connection: 'p', connectionName: 'Prod', sql: 'SELECT 1' })]);
    expect(v.items[0]).toMatchObject({ type: 'approval', answer: 'pending' });
    v = applyEvents(v, [ev({ kind: 'approval_answered', requestId: 'r1', allowed: false })]);
    expect(v.items[0]).toMatchObject({ answer: 'denied' });
  });

  it('shows errors with the fix and ignores repeated events', () => {
    const e = ev({ kind: 'error', errorKind: 'login', message: 'Invalid API key' });
    let v = applyEvents(emptyChat, [e]);
    v = applyEvents(v, [e]);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ type: 'notice', tone: 'error' });
    expect((v.items[0] as { text: string }).text).toContain('/login');
  });

  it('notes a stop only while Claude was working', () => {
    expect(applyEvents(emptyChat, [ev({ kind: 'stopped' })]).items).toHaveLength(0);
    const v = applyEvents(emptyChat, [ev({ kind: 'user', text: 'x' }), ev({ kind: 'stopped' })]);
    expect(v.items[1]).toMatchObject({ type: 'notice', text: 'Stopped.' });
    expect(v.busy).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `./node_modules/.bin/vitest run src/lib/chat.test.ts`
Expected: FAIL (module `./chat` not found).

- [ ] **Step 4: Implement `src/lib/chat.ts`**

```ts
import type { ChatEvent } from './types';

export interface AssistantItem {
  type: 'assistant';
  id: string;
  text: string;
  streaming: boolean;
}

export interface ToolItem {
  type: 'tool';
  id: string;
  callId: string;
  tool: string;
  connection: string | null;
  sql: string | null;
  status: 'running' | 'done' | 'error';
  rows: number | null;
  truncated: boolean;
  elapsedMs: number | null;
  error: string | null;
}

export interface ApprovalItem {
  type: 'approval';
  id: string;
  requestId: string;
  connection: string;
  connectionName: string;
  sql: string;
  answer: 'pending' | 'allowed' | 'denied';
}

export type ChatItem =
  | { type: 'user'; id: string; text: string }
  | AssistantItem
  | ToolItem
  | ApprovalItem
  | { type: 'notice'; id: string; tone: 'error' | 'info'; text: string; errorKind?: string };

export interface ChatView {
  items: ChatItem[];
  /** Claude is working on an answer */
  busy: boolean;
  /** short status line ("Reading models/user.ts") */
  activity: string | null;
  lastSeq: number;
}

export const emptyChat: ChatView = { items: [], busy: false, activity: null, lastSeq: 0 };

export const TOOL_LABEL: Record<string, string> = {
  run_select: 'Running query',
  list_tables: 'Listing tables',
  describe_table: 'Reading table structure',
  list_connections: 'Checking connections',
};

export function noticeText(kind: string, message: string): string {
  if (kind === 'login') return 'Claude Code is not logged in. Run `claude` in Terminal, then `/login`, and try again.';
  if (kind === 'limit') return `Your Claude plan limit is reached. ${message}`;
  return message;
}

/** Folds new backend events into the chat view (pure; events with seq ≤ lastSeq are ignored). */
export function applyEvents(view: ChatView, events: ChatEvent[]): ChatView {
  let items = [...view.items];
  let { busy, activity, lastSeq } = view;
  const streamingIndex = () => {
    const last = items[items.length - 1];
    return last?.type === 'assistant' && last.streaming ? items.length - 1 : -1;
  };
  const finishStreaming = () => {
    items = items.map((it) => (it.type === 'assistant' && it.streaming ? { ...it, streaming: false } : it));
  };

  for (const e of events) {
    if (e.seq <= lastSeq) continue;
    lastSeq = e.seq;
    const id = `e${e.seq}`;
    switch (e.kind) {
      case 'user':
        items.push({ type: 'user', id, text: e.text });
        busy = true;
        activity = null;
        break;
      case 'text_delta': {
        const i = streamingIndex();
        if (i >= 0) items[i] = { ...(items[i] as AssistantItem), text: (items[i] as AssistantItem).text + e.text };
        else items.push({ type: 'assistant', id, text: e.text, streaming: true });
        activity = null;
        break;
      }
      case 'text': {
        const i = streamingIndex();
        if (i >= 0) items[i] = { ...(items[i] as AssistantItem), text: e.text, streaming: false };
        else items.push({ type: 'assistant', id, text: e.text, streaming: false });
        break;
      }
      case 'activity':
        activity = e.label;
        break;
      case 'tool_call':
        finishStreaming();
        items.push({ type: 'tool', id, callId: e.callId, tool: e.tool, connection: e.connection, sql: e.sql, status: 'running', rows: null, truncated: false, elapsedMs: null, error: null });
        activity = TOOL_LABEL[e.tool] ?? `Using ${e.tool}`;
        break;
      case 'tool_result':
        items = items.map((it) =>
          it.type === 'tool' && it.callId === e.callId ? { ...it, status: e.error ? 'error' : 'done', rows: e.rows, truncated: e.truncated, elapsedMs: e.elapsedMs, error: e.error } : it,
        );
        activity = null;
        break;
      case 'approval':
        items.push({ type: 'approval', id, requestId: e.requestId, connection: e.connection, connectionName: e.connectionName, sql: e.sql, answer: 'pending' });
        activity = 'Waiting for your approval';
        break;
      case 'approval_answered':
        items = items.map((it) => (it.type === 'approval' && it.requestId === e.requestId ? { ...it, answer: e.allowed ? 'allowed' : 'denied' } : it));
        activity = null;
        break;
      case 'done':
        finishStreaming();
        busy = false;
        activity = null;
        break;
      case 'stopped':
        finishStreaming();
        if (busy) items.push({ type: 'notice', id, tone: 'info', text: 'Stopped.' });
        busy = false;
        activity = null;
        break;
      case 'error':
        finishStreaming();
        items.push({ type: 'notice', id, tone: 'error', text: noticeText(e.errorKind, e.message), errorKind: e.errorKind });
        busy = false;
        activity = null;
        break;
    }
  }
  return { items, busy, activity, lastSeq };
}
```

- [ ] **Step 5: Run the reducer tests to see them pass**

Run: `./node_modules/.bin/vitest run src/lib/chat.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Implement the chat store**

Create `src/store/chat.ts`:

```ts
import { create } from 'zustand';
import { api } from '../lib/api';
import { applyEvents, emptyChat, type ChatView } from '../lib/chat';
import type { ChatConnection, ClaudeStatus } from '../lib/types';
import { useApp } from './app';

export interface ChatSlot {
  chatId: string | null;
  view: ChatView;
  /** other open connections added with the chip */
  extra: string[];
}

interface ChatState {
  chats: Record<string, ChatSlot>;
  status: ClaudeStatus | null;
  noticeSeen: boolean;
  checkStatus: () => Promise<void>;
  send: (cid: string, text: string) => Promise<void>;
  stop: (cid: string) => Promise<void>;
  newChat: (cid: string) => Promise<void>;
  answer: (cid: string, requestId: string, allow: boolean) => Promise<void>;
  setExtra: (cid: string, ids: string[]) => void;
  dismissNotice: () => void;
}

const NOTICE_KEY = 'tabula.claude.noticeSeen';
const readNotice = () => {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
};

const blank = (): ChatSlot => ({ chatId: null, view: emptyChat, extra: [] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The chat's own connection first, then the extra ones that are still open. */
function connectionsFor(cid: string, extra: string[]): ChatConnection[] {
  const ws = useApp.getState().workspaces;
  return [cid, ...extra.filter((id) => id !== cid && ws[id])].map((id) => ({ id, database: ws[id]?.session.database ?? null }));
}

export const useChat = create<ChatState>((set, get) => {
  const slot = (cid: string) => get().chats[cid] ?? blank();
  const patch = (cid: string, p: Partial<ChatSlot>) => set({ chats: { ...get().chats, [cid]: { ...slot(cid), ...p } } });

  /** Long-polls the backend until the chat is closed or replaced. */
  const poll = async (cid: string, chatId: string) => {
    for (;;) {
      const cur = get().chats[cid];
      if (!cur || cur.chatId !== chatId) return;
      try {
        const events = await api.chatEvents(chatId, cur.view.lastSeq);
        const now = get().chats[cid];
        if (!now || now.chatId !== chatId) return;
        if (events.length) patch(cid, { view: applyEvents(now.view, events) });
      } catch (e) {
        if (String((e as Error).message).includes('Unknown chat')) {
          if (get().chats[cid]?.chatId === chatId) patch(cid, { chatId: null });
          return;
        }
        await sleep(1000);
      }
    }
  };

  const ensureChat = async (cid: string): Promise<string> => {
    const s = slot(cid);
    if (s.chatId) return s.chatId;
    const { chatId } = await api.chatStart(connectionsFor(cid, s.extra));
    patch(cid, { chatId, view: { ...emptyChat } });
    void poll(cid, chatId);
    return chatId;
  };

  return {
    chats: {},
    status: null,
    noticeSeen: readNotice(),

    checkStatus: async () => {
      try {
        set({ status: await api.claudeStatus() });
      } catch {
        set({ status: { found: false, path: null, version: null } });
      }
    },

    send: async (cid, text) => {
      try {
        const chatId = await ensureChat(cid);
        await api.chatSetConnections(chatId, connectionsFor(cid, slot(cid).extra));
        await api.chatSend(chatId, text);
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    },

    stop: async (cid) => {
      const chatId = slot(cid).chatId;
      if (chatId) await api.chatStop(chatId).catch(() => undefined);
    },

    newChat: async (cid) => {
      const chatId = slot(cid).chatId;
      patch(cid, { chatId: null, view: emptyChat });
      if (chatId) await api.chatClose(chatId).catch(() => undefined);
    },

    answer: async (_cid, requestId, allow) => {
      try {
        await api.answerApproval(requestId, allow);
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    },

    setExtra: (cid, extra) => {
      patch(cid, { extra });
      const chatId = slot(cid).chatId;
      if (chatId) api.chatSetConnections(chatId, connectionsFor(cid, extra)).catch(() => undefined);
    },

    dismissNotice: () => {
      try {
        localStorage.setItem(NOTICE_KEY, '1');
      } catch {
        /* storage not available */
      }
      set({ noticeSeen: true });
    },
  };
});

// A closed connection closes its chat (the backend kills its Claude Code process).
useApp.subscribe((state, prev) => {
  if (state.workspaces === prev.workspaces) return;
  for (const cid of Object.keys(prev.workspaces)) {
    if (state.workspaces[cid]) continue;
    const s = useChat.getState().chats[cid];
    if (!s) continue;
    const { [cid]: _closed, ...rest } = useChat.getState().chats;
    useChat.setState({ chats: rest });
    if (s.chatId) api.chatClose(s.chatId).catch(() => undefined);
  }
});
```

- [ ] **Step 7: Checkpoint**

`tsc` → no errors; vitest → all pass. No commit.

---

### Task 12: Claude panel UI

**Files:**
- Create: `src/components/ClaudePanel.tsx`, `src/components/ChatItems.tsx`, `src/components/ConnectionChips.tsx`
- Modify: `src/components/Workspace.tsx` (mount the panel), `src/styles.css` (chat Markdown styles), `package.json` (react-markdown)

**Interfaces:**
- Consumes: `useChat` (Task 11), `useConnectionId`, `useWs` (Task 6), `useApp.openQuery/switchTo/toggleClaude` (Task 5).
- Produces: `<ClaudePanel />` (no props, scoped by `ConnectionScope`), shown when `claudeOpen` is true; ⌘L already toggles it (Task 6).

- [ ] **Step 1: Install react-markdown**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 24.21.0 >/dev/null && npm install react-markdown@9.1.0
```

(react-markdown does not render raw HTML from Claude's text, so a reply can't inject markup into the app.)

- [ ] **Step 2: Chat items**

Create `src/components/ChatItems.tsx`:

```tsx
import { AlertCircle, Check, Database, ExternalLink, Loader2, ShieldAlert, X } from 'lucide-react';
import Markdown from 'react-markdown';
import { TOOL_LABEL, type ApprovalItem, type ChatItem, type ToolItem } from '../lib/chat';
import { cx } from '../lib/ui';
import { useApp } from '../store/app';

const TOOL_TITLE: Record<string, string> = { run_select: 'Query', list_tables: 'List tables', describe_table: 'Describe table', list_connections: 'Connections' };

export default function ChatItems({ items, onAnswer }: { items: ChatItem[]; onAnswer: (requestId: string, allow: boolean) => void }) {
  return (
    <>
      {items.map((it) => {
        switch (it.type) {
          case 'user':
            return (
              <div key={it.id} className="selectable ml-8 self-end whitespace-pre-wrap rounded-xl bg-surface-2 px-3 py-2 text-[13px]">
                {it.text}
              </div>
            );
          case 'assistant':
            return (
              <div key={it.id} className="chat-md selectable text-[13px] leading-relaxed">
                <Markdown components={{ a: ({ children }) => <span className="underline decoration-dotted">{children}</span> }}>{it.text}</Markdown>
                {it.streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" />}
              </div>
            );
          case 'tool':
            return <ToolCard key={it.id} item={it} />;
          case 'approval':
            return <ApprovalCard key={it.id} item={it} onAnswer={onAnswer} />;
          case 'notice':
            return (
              <div key={it.id} className={cx('selectable flex gap-2 rounded-lg px-3 py-2 text-[12.5px]', it.tone === 'error' ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-ink-2')}>
                {it.tone === 'error' && <AlertCircle size={14} className="mt-0.5 shrink-0" />}
                <span>{it.text}</span>
              </div>
            );
        }
      })}
    </>
  );
}

function ToolCard({ item }: { item: ToolItem }) {
  const connections = useApp((s) => s.connections);
  const name = connections.find((c) => c.id === item.connection)?.name ?? item.connection;
  const canOpen = item.tool === 'run_select' && item.sql && item.connection && item.status === 'done';
  const openInGrid = () => {
    const s = useApp.getState();
    if (!item.connection || !item.sql || !s.workspaces[item.connection]) return;
    s.switchTo(item.connection);
    s.openQuery(item.connection, item.sql, { autoRun: true });
  };
  return (
    <div className="overflow-hidden rounded-lg border border-line text-[12px]" data-testid="tool-card">
      <div className="flex items-center gap-1.5 border-b border-line bg-surface-2/60 px-2.5 py-1.5 text-ink-3">
        {item.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : item.status === 'error' ? <X size={12} className="text-danger" /> : <Database size={12} />}
        <span className="font-medium text-ink-2">{TOOL_TITLE[item.tool] ?? item.tool}</span>
        {name && <span className="truncate">· {name}</span>}
        <span className="ml-auto shrink-0 tabular-nums">
          {item.status === 'running' ? TOOL_LABEL[item.tool] ?? '' : item.rows != null ? `${item.rows}${item.truncated ? '+' : ''} rows` : ''}
          {item.elapsedMs != null && item.status !== 'running' ? ` · ${item.elapsedMs} ms` : ''}
        </span>
      </div>
      {item.sql && <pre className="selectable mono max-h-40 overflow-auto whitespace-pre-wrap px-2.5 py-2 text-[11.5px] text-ink-2">{item.sql}</pre>}
      {item.error && <div className="selectable border-t border-line px-2.5 py-1.5 text-danger">{item.error}</div>}
      {canOpen && (
        <button className="flex w-full items-center gap-1.5 border-t border-line px-2.5 py-1.5 text-left text-accent hover:bg-surface-2" onClick={openInGrid}>
          <ExternalLink size={12} /> Open in grid
        </button>
      )}
    </div>
  );
}

function ApprovalCard({ item, onAnswer }: { item: ApprovalItem; onAnswer: (requestId: string, allow: boolean) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--env-prod)_45%,var(--border))] text-[12px]" data-testid="approval-card">
      <div className="flex items-center gap-1.5 bg-[color-mix(in_srgb,var(--env-prod)_10%,transparent)] px-2.5 py-1.5 font-medium text-[var(--env-prod)]">
        <ShieldAlert size={13} /> Production · {item.connectionName}
      </div>
      <pre className="selectable mono max-h-48 overflow-auto whitespace-pre-wrap px-2.5 py-2 text-[11.5px]">{item.sql}</pre>
      <div className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
        {item.answer === 'pending' ? (
          <>
            <span className="text-ink-3">Run this read-only query?</span>
            <button className="btn ml-auto h-7" onClick={() => onAnswer(item.requestId, false)}>
              Deny
            </button>
            <button className="btn btn-primary h-7" onClick={() => onAnswer(item.requestId, true)} data-testid="approve-query">
              Run
            </button>
          </>
        ) : (
          <span className={cx('flex items-center gap-1.5', item.answer === 'allowed' ? 'text-success' : 'text-ink-3')}>
            {item.answer === 'allowed' ? <Check size={13} /> : <X size={13} />} {item.answer === 'allowed' ? 'You allowed this query' : 'You denied this query'}
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Connection chips**

Create `src/components/ConnectionChips.tsx`:

```tsx
import { Plus, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { effectiveClaudeAccess } from '../lib/types';
import { useDismiss } from '../lib/useDismiss';
import { envColor } from '../lib/ui';
import { useApp } from '../store/app';
import { useChat } from '../store/chat';

/** one shared empty list, so the store selector returns a stable value */
const NO_EXTRA: string[] = [];

function Chip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const w = useApp((s) => s.workspaces[id]);
  if (!w) return null;
  const c = w.session.config;
  const db = c.engine === 'mysql' ? w.session.database : null;
  return (
    <span className="flex h-6 max-w-[220px] items-center gap-1 rounded-full px-2 text-[11.5px]" style={{ background: `color-mix(in srgb, ${envColor(c.environment)} 14%, transparent)`, color: envColor(c.environment) }}>
      <span className="truncate">@ {c.name}{db ? ` · ${db}` : ''}</span>
      {onRemove && (
        <button onClick={onRemove} aria-label={`Remove ${c.name}`} className="shrink-0 opacity-70 hover:opacity-100">
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export default function ConnectionChips({ cid }: { cid: string }) {
  const extra = useChat((s) => s.chats[cid]?.extra ?? NO_EXTRA);
  const setExtra = useChat((s) => s.setExtra);
  const openOrder = useApp((s) => s.openOrder);
  const workspaces = useApp((s) => s.workspaces);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, close, open);
  const candidates = openOrder.filter((id) => id !== cid && !extra.includes(id) && effectiveClaudeAccess(workspaces[id].session.config) !== 'off');

  return (
    <div className="relative flex flex-wrap items-center gap-1" data-testid="connection-chips">
      <Chip id={cid} />
      {extra.filter((id) => workspaces[id]).map((id) => (
        <Chip key={id} id={id} onRemove={() => setExtra(cid, extra.filter((e) => e !== id))} />
      ))}
      {candidates.length > 0 && (
        <button className="flex h-6 items-center gap-0.5 rounded-full border border-line px-2 text-[11.5px] text-ink-3 hover:text-ink" onClick={() => setOpen(!open)} aria-label="Add connection">
          <Plus size={11} /> connection
        </button>
      )}
      {open && (
        <div ref={ref} className="fade-in absolute bottom-8 left-0 z-50 w-56 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]">
          {candidates.map((id) => (
            <button
              key={id}
              className="flex w-full rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3"
              onClick={() => {
                setExtra(cid, [...extra, id]);
                setOpen(false);
              }}
            >
              {workspaces[id].session.config.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: The panel**

Create `src/components/ClaudePanel.tsx`:

```tsx
import { ArrowUp, RotateCcw, Sparkles, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { emptyChat } from '../lib/chat';
import { effectiveClaudeAccess } from '../lib/types';
import { MOD } from '../lib/ui';
import { useApp } from '../store/app';
import { useChat } from '../store/chat';
import { useConnectionId, useWs } from '../store/workspace';
import ChatItems from './ChatItems';
import ConnectionChips from './ConnectionChips';

const WIDTH_KEY = 'tabula.claudeWidth';
const readWidth = () => {
  try {
    return Math.min(720, Math.max(300, Number(localStorage.getItem(WIDTH_KEY)) || 380));
  } catch {
    return 380;
  }
};

export default function ClaudePanel() {
  const cid = useConnectionId();
  const session = useWs((w) => w.session);
  const view = useChat((s) => s.chats[cid]?.view ?? emptyChat);
  const status = useChat((s) => s.status);
  const noticeSeen = useChat((s) => s.noticeSeen);
  const toggleClaude = useApp((s) => s.toggleClaude);
  const [text, setText] = useState('');
  const [width, setWidth] = useState(readWidth);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const access = effectiveClaudeAccess(session.config);

  useEffect(() => {
    if (!status) useChat.getState().checkStatus();
    inputRef.current?.focus();
  }, [status]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.items]);

  const submit = (value = text) => {
    const t = value.trim();
    if (!t || view.busy) return;
    setText('');
    useChat.getState().send(cid, t);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: MouseEvent) => {
      w = Math.min(720, Math.max(300, startW + (startX - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      try {
        localStorage.setItem(WIDTH_KEY, String(w));
      } catch {
        /* storage not available */
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const tables = session.objects.filter((o) => o.kind === 'table').slice(0, 2).map((o) => o.name);
  const examples = tables.length
    ? [`What is stored in ${tables[0]}? Show 5 example rows.`, `How many rows does ${tables[0]} have, grouped by a useful column?`, tables[1] ? `How are ${tables[0]} and ${tables[1]} related?` : `Which tables reference ${tables[0]}?`]
    : ['Which tables are in this database?'];

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-line bg-bg" style={{ width }} data-testid="claude-panel">
      <div className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" onMouseDown={startResize} />
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Sparkles size={14} className="text-accent" />
        <span className="text-[13px] font-medium">Claude</span>
        <span className="kbd ml-1">{MOD} L</span>
        <button className="icon-btn ml-auto h-7 w-7" onClick={() => useChat.getState().newChat(cid)} title="New chat" aria-label="New chat">
          <RotateCcw size={13} />
        </button>
        <button className="icon-btn h-7 w-7" onClick={toggleClaude} title={`Close (${MOD}L)`} aria-label="Close Claude panel">
          <X size={14} />
        </button>
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {!noticeSeen && (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-ink-2">
            Claude sees the tables, rows and files it reads here. They are sent to Anthropic. Change this per connection in its settings.{' '}
            <button className="font-medium text-accent" onClick={() => useChat.getState().dismissNotice()}>
              Got it
            </button>
          </div>
        )}
        {status && !status.found ? (
          <div className="rounded-lg border border-line px-3 py-3 text-[12.5px] text-ink-2" data-testid="claude-missing">
            <div className="mb-1 font-medium text-ink">Claude Code is not installed</div>
            Install Claude Code, run <code className="mono">claude</code> once in Terminal and log in. Then open this panel again.
          </div>
        ) : access === 'off' ? (
          <div className="text-[12.5px] text-ink-3">Claude is off for this connection. Change it in the connection settings.</div>
        ) : view.items.length === 0 ? (
          <div className="mt-6 space-y-2 text-[12.5px]">
            <div className="text-ink-2">Ask about the data in {session.config.name}.{access === 'schema' ? ' Claude sees tables and columns only.' : ''}</div>
            {examples.map((q) => (
              <button key={q} className="block w-full rounded-lg border border-line px-3 py-2 text-left text-ink-2 hover:bg-surface-2 hover:text-ink" onClick={() => submit(q)}>
                {q}
              </button>
            ))}
          </div>
        ) : (
          <ChatItems items={view.items} onAnswer={(requestId, allow) => useChat.getState().answer(cid, requestId, allow)} />
        )}
      </div>

      {view.busy && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-3 text-[12px] text-ink-3">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          <span className="truncate">{view.activity ?? 'Thinking…'}</span>
          <button className="btn ml-auto h-6 px-2" onClick={() => useChat.getState().stop(cid)} data-testid="stop-claude">
            <Square size={10} className="fill-current" /> Stop
          </button>
        </div>
      )}

      {access !== 'off' && status?.found !== false && (
        <div className="shrink-0 border-t border-line p-2.5">
          <div className="rounded-xl border border-line-strong bg-surface p-2 focus-within:border-accent">
            <ConnectionChips cid={cid} />
            <div className="mt-1.5 flex items-end gap-2">
              <textarea
                ref={inputRef}
                className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-ink-3"
                rows={1}
                placeholder="Ask about your data…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                data-testid="claude-input"
              />
              <button className="btn btn-primary h-8 w-8 shrink-0 justify-center p-0" onClick={() => submit()} disabled={view.busy || !text.trim()} aria-label="Send">
                <ArrowUp size={15} />
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 5: Mount the panel and add Markdown styles**

In `src/components/Workspace.tsx`: add `const claudeOpen = useApp((s) => s.claudeOpen);` in the component, import `ClaudePanel from './ClaudePanel'`, and replace the line `{/* Task 12 renders <ClaudePanel /> here */}` with `{claudeOpen && <ClaudePanel />}`.

Append to `src/styles.css`:

```css
/* Claude answers (Markdown) */
.chat-md > * + * {
  margin-top: 0.6em;
}
.chat-md code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0.1em 0.35em;
  border-radius: 5px;
  background: var(--surface-2);
}
.chat-md pre {
  overflow-x: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-2);
}
.chat-md pre code {
  padding: 0;
  background: none;
}
.chat-md ul,
.chat-md ol {
  padding-left: 1.3em;
  list-style: disc;
}
.chat-md ol {
  list-style: decimal;
}
.chat-md table {
  border-collapse: collapse;
  font-size: 12px;
}
.chat-md th,
.chat-md td {
  border: 1px solid var(--border);
  padding: 3px 8px;
  text-align: left;
}
```

- [ ] **Step 6: Type check and unit tests**

Run: `./node_modules/.bin/tsc --noEmit -p .` → no errors. Vitest → all pass.

- [ ] **Step 7: Browser check with the fake Claude**

```bash
cd ~/Documents/projects/tabula
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 24.21.0 >/dev/null
TABULA_CLAUDE_BIN="$PWD/scripts/fake-claude.sh" npm run devserver   # terminal 1
npm run dev                                                         # terminal 2
```

In the browser (http://127.0.0.1:1420), open a SQLite dev connection and check:
1. ⌘L (or the sparkle button) opens the panel; the first-time notice shows; "Got it" hides it for good.
2. Click an example question → the user bubble appears, the recorded answer streams in, the status line disappears when done.
3. "New chat" empties the chat; the next message works.
4. The chip shows `@ <connection>`; with a second open connection, "+ connection" adds it and its × removes it.
5. Switch connection with ⌘2 → a different (empty) chat; switch back → the first chat is still there.
6. Right-click the rail square → Disconnect → no errors in the console.

Then restart the bridge without `TABULA_CLAUDE_BIN` and with `PATH=/usr/bin:/bin` plus `HOME=$(mktemp -d)` (so no Claude is found) and check that the panel shows "Claude Code is not installed".

- [ ] **Step 8: Checkpoint**

All checks above pass. No commit.

---

### Task 13: Docs, app build and one live run

**Files:**
- Modify: `README.md`, `docs/design.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Update the docs**

In `README.md` "Features", add:

```markdown
- Several connections open at once: connection rail on the left, `⌘1`…`⌘9` to switch; each keeps its own tabs and chat.
- Claude panel (`⌘L`): ask questions about your data in plain language. Uses your installed Claude Code and its login
  (no API key). Claude only reads: read-only tools, max 200 rows per query, Production queries need your approval.
  Per connection you choose what Claude may see (schema + data, schema only, off) and an optional project folder it
  may read.
```

In "Develop", add:

```markdown
Test the Claude panel without using your plan: `TABULA_CLAUDE_BIN="$PWD/scripts/fake-claude.sh" npm run devserver`
replays a recorded answer.
```

In `docs/design.md`, add a "Claude panel" section with the diagram and the three read-only layers from the spec
(link the spec file) and add the connection rail to the layout section.

- [ ] **Step 2: Build the app**

```bash
cd ~/Documents/projects/tabula && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 24.21.0 >/dev/null
./node_modules/.bin/tauri build --bundles app
```

Expected: `src-tauri/target/release/bundle/macos/Tabula.app` builds. Quit the running Tabula and open the new build.

- [ ] **Step 3: Ask before the live run**

Say to the user: "Everything is built. One live test uses your real Claude Code (a few short questions, small cost on your plan). OK to run it?" Continue only after a yes.

- [ ] **Step 4: Live run (in the real app, on the local Docker MySQL or a SQLite file — never a Production connection)**

1. Open the connection, ⌘L, ask: "Which 3 tables have the most rows?" → tool cards for `list_tables` (and maybe `run_select`), a short answer.
2. Ask: "Delete all rows from <table>." → Claude explains it can only read; no write reaches the database (check the row count in the grid).
3. Click **Open in grid** on a query card → a query tab opens and runs.
4. Set the connection's environment to Production (Claude access: Schema + data), ask a data question → the approval card appears; Deny → Claude reports it was not allowed; ask again, Run → the result arrives. Set the environment back.
5. Set a project folder, ask "What does the `status` column in <table> mean? Check the code." → status line shows "Reading …", and the answer refers to the code.
6. Press **Stop** during an answer → "Stopped."; the next question works.

If the MCP tools do not appear (Claude says it has no database tools), check `probe-notes.md` from Task 1 for the `--allowedTools` form and the stderr in `client-errors.log`.

- [ ] **Step 5: Final checkpoint**

`./scripts/test-rust.sh`, vitest and `tsc` all green; live run done. Report to the user what was tested and what was not. Do not commit — the user commits after their own test.
