# Tabula — design

A fast, modern desktop database client for macOS. Version 1 supports **MySQL** and **SQLite** only.
Goal: the daily workflow of TablePlus (browse, edit, query) with a calmer, modern look
(neutral surfaces, one warm accent, generous spacing, monospace for data — in the spirit of Claude Code).

## Non-goals for v1
Other databases, ER diagrams, import wizards, charts, schema diff, user/permission management,
schema editing (structure is read-only in v1).

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Shell | Tauri 2 | Native WebView, small app, low RAM |
| Backend | Rust, tokio | Async, never blocks the UI |
| MySQL | `mysql_async` (text protocol) | Every value arrives as text/bytes → robust for any column type; `KILL QUERY` for cancel |
| SQLite | `rusqlite` (bundled) in `spawn_blocking` | Reference driver, all types accessible |
| Secrets | `secrets.json` in the app config folder, mode 0600 | No Keychain prompts for an unsigned app; readable only by the macOS user |
| App storage | JSON file in app config dir | Connections (without passwords), query history |
| Frontend | React 18 + TypeScript + Vite | |
| Grid | Glide Data Grid (canvas) | Smooth with large result sets |
| Editor | CodeMirror 6 (`@codemirror/lang-sql`) | Light, schema-aware autocomplete |
| State | Zustand | |
| Styling | Tailwind 4 + CSS variables | Light and dark theme from one token set |

## Architecture

```
React UI ──invoke()──> Tauri commands ──> core (Rust)
                                            ├─ ConnectionManager (pools/handles per connection id)
                                            ├─ drivers::{mysql, sqlite}  (trait Driver)
                                            ├─ sqlgen (quoting, SELECT/UPDATE/INSERT/DELETE builders)
                                            └─ store (connections.json, history.json, secrets.json)
```

* All commands are `async` and return `Result<T, AppError>` serialized to `{ message }`.
* **Dev bridge**: with the `devserver` cargo feature, the same command functions are exposed over
  HTTP (`POST /api/<command>`), so the UI can be tested in a normal browser against real databases.
  The frontend `api.ts` calls Tauri `invoke` inside the app and the HTTP bridge otherwise.

### Driver trait (core)
```rust
trait Driver {
  async fn test(&self) -> Result<ServerInfo>;
  async fn databases(&self) -> Result<Vec<String>>;              // MySQL only, SQLite returns ["main"]
  async fn objects(&self, db: &str) -> Result<Vec<DbObject>>;    // tables + views
  async fn structure(&self, db, table) -> Result<TableStructure>;// columns, PK, indexes, FKs
  async fn select_page(&self, req: PageRequest) -> Result<QueryResult>;
  async fn count(&self, req: CountRequest) -> Result<u64>;
  async fn execute(&self, sql: &str, max_rows: usize) -> Result<Vec<QueryResult>>; // SQL editor
  async fn apply_changes(&self, db, table, changes: ChangeSet) -> Result<u64>;     // one transaction
  async fn cancel(&self) -> Result<()>;
}
```

### Data model sent to the UI
* `QueryResult { columns: [{name, type_name, nullable?}], rows: [[Cell]], affected_rows, elapsed_ms, truncated }`
* `Cell` = JSON `null | string | number | bool`. Numbers that do not fit `f64` safely, decimals, dates
  and blobs are strings (blobs as `0x…` hex preview, max 256 bytes).

### Editing
* Grid edits go into a **pending change set** in the UI store (update/insert/delete), with undo/redo.
* Rows are identified by primary key (or all columns when no PK — editing disabled then, read-only badge).
* `⌘S` shows the generated SQL in a review dialog → `apply_changes` runs it in one transaction.
* SQL values are always bound parameters; identifiers are quoted by `sqlgen` (backticks / double quotes).

### Safety
* Connection has an **environment** tag: `local`, `dev`, `staging`, `prod` (color in header pill).
* `prod`: SQL editor asks for confirmation before statements that are not `SELECT/SHOW/EXPLAIN/DESCRIBE/WITH`.
* Connect timeout 10 s; every running query can be cancelled.

## UI

* **Connection rail** (far left): one icon per open connection, `⌘1`…`⌘9` to switch.
  Each connection keeps its own tabs, sidebar state and Claude chat.
* **Claude panel** (`⌘L`, right side): chat for the active connection. See "Claude panel" below.
* **Header**: window controls area, sidebar toggle, connection pill (env · server · database · object), ⌘K.
* **Sidebar**: database picker (MySQL), search, tables and views list.
* **Tabs**: data tab (Data | Structure toggle inside the tab, like TablePlus) and query tabs.
* **Data tab**: filter bar (raw `WHERE`), grid, bottom bar (row count, page, `+ Row`, pending changes,
  Save / Discard), right **row panel** (field, type, value, editable).
* **Query tab**: editor on top, results below (multiple result sets as sub-tabs), status (time, rows).
* **Start screen**: connection list (cards with engine badge + env color), new/edit connection form.
* **Command palette ⌘K / quick open ⌘P**: tables, actions.
* Keyboard: ⌘S save, ⌘Z/⌘⇧Z undo/redo, ⌘↵ run, ⌘. cancel, ⌘T new query, ⌘W close tab, ⌘R refresh.

### Visual language
* Surfaces: warm off-white / near-black, 1px hairline borders, 8px radius, no heavy shadows.
* One accent (warm coral) for primary actions and focus; env colors only in the connection pill.
* Inter/system UI font 13px for chrome; JetBrains Mono/SF Mono 12px for data and SQL.

## Claude panel

Full spec: [docs/superpowers/specs/2026-10-15-claude-panel-design.md](superpowers/specs/2026-10-15-claude-panel-design.md).

```
Chat UI ──> Tauri commands ──> chat manager ──spawns──> Claude Code (user's install and login)
                                    ▲                          │ MCP tools
                                    └──── tool bridge <────────┘ (list_connections, list_tables, describe_table, run_select)
                                              │
                                    read-only driver call on the chat's own connection
```

* Tabula starts Claude Code per chat. No API key. Binary lookup: `~/.local/bin`, `~/.claude/local`,
  `/opt/homebrew/bin`, `/usr/local/bin`, then the login shell (5 s limit). `TABULA_CLAUDE_BIN` overrides it.
* Database tools are the only way Claude reaches the data. A chat can only use its own connection.
* Per connection: Claude access = schema + data, schema only, or off (default: Production → schema only,
  other environments → schema + data).
* Production: each data query needs the user's approval (5 min timeout).
* Project folder (optional): Claude gets Read, Grep and Glob only, limited to that folder.
  The folder can't be the disk root, your home folder, a folder above them, or anything that contains or is
  inside Tabula's settings folder. It is checked on save and again each time Claude starts.
* The MCP server answers only `127.0.0.1`, needs the per-start token (kept in a 0600 file, not in the command
  line) and refuses browser requests (any `Origin` header).
* The app window has a strict Content Security Policy: nothing is loaded from the internet.
  Folders with special characters rely on the working directory for the limit.
* Answers are Markdown. Links and images render as plain text.

### Read-only, three layers
1. **SQL check** before running: a dialect-aware lexer allows only a single read statement
   (`SELECT`, `WITH`, `SHOW`, `EXPLAIN`, `DESCRIBE`, allowed `PRAGMA`s). The PRAGMA allowlist is strict
   and anything with `;` fails closed.
2. **Read-only session**: MySQL runs in a read-only transaction, SQLite uses a read-only connection.
3. **Limits**: 200 rows per query, text values cut to 2 KB, 30 s timeout.

Passwords stay in `secrets.json` (0600), never in the Keychain and never sent to Claude.

## Testing
* Rust: unit tests for `sqlgen` (quoting, builders) and value conversion; integration tests against
  SQLite (temp file) always, and MySQL when `TABULA_TEST_MYSQL` is set (`host:port:user:password:database`) (local Docker).
* Frontend: Vitest for the pending-changes store (apply, undo/redo, SQL preview inputs).
* End-to-end: run the UI in a browser through the dev bridge against Docker MySQL and a SQLite file.
