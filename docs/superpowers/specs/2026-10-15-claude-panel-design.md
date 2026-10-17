# Tabula v2: multiple connections and a Claude panel

Date: 2026-10-15 · Status: design approved in chat, spec waiting for review

## 1. Goal

Ask Claude questions about your databases in plain language, inside Tabula, with Tabula's own look.
Work with several open connections at once and switch between them quickly.

Success looks like:

- With two connections open (for example a MySQL Dev server and a local SQLite file), you switch with ⌘1 / ⌘2
  and each one keeps its tabs, filters and chat.
- You ask "how many clients per view, top 5?" and Claude answers using a SELECT it ran itself.
  The panel shows that SQL, and **Open in grid** shows the full result in a normal Tabula tab.
- With a project folder set, Claude can answer "what does `status = 3` mean?" by reading the app code.
- Claude can never change data or files. On a Production connection every query waits for your approval.

Out of scope for this version:

- A built-in terminal (only a later "Open in Terminal" button, if wanted).
- Any write access for Claude (INSERT, UPDATE, DELETE, DDL, file edits, shell commands).
- A Claude API key mode. The panel uses the user's installed Claude Code and its login.
- Access from other Claude apps (Claude Desktop, Claude Code in a terminal). The MCP server is built so this can
  be added later with a small stdio shim.
- Saving chats across app restarts. A chat lives until the app quits or you start a new one.

## 2. Architecture

```
Claude panel (React)
   │  chat_send / chat_events (long poll) / chat_stop / answer_approval      ← commands::dispatch
   ▼
Agent runner (Rust)  ── spawns ──▶  claude -p (stream-json in/out), your login
                                       │  MCP over HTTP, 127.0.0.1 + secret token
                                       ▼
                               Tabula MCP server (Rust, inside the app)
                                       │  uses the already open sessions
                                       ▼
                               Manager (MySQL / SQLite sessions)
```

All new frontend ↔ backend calls go through the existing single entry `commands::dispatch`, so they work both in the
app (Tauri command `call`) and in the browser through the dev bridge. Streaming uses a long-poll command instead of
Tauri events, for the same reason.

### 2.1 Tabula MCP server

- Rust, a small hand-written MCP server (JSON-RPC 2.0 over the streamable HTTP transport, one JSON response per
  POST, no server-sent events) served by axum. Only `initialize`, `ping`, `tools/list` and `tools/call` are needed,
  so an SDK dependency (`rmcp`, whose API still changes often) is not worth it. axum becomes a normal
  (non-optional) dependency.
- Starts with the app on `127.0.0.1` and a random free port. Stops when the app quits.
- Every request must carry `Authorization: Bearer <token>` (compared in constant time). The token is random and
  made at each app start. Requests with an `Origin` header (web pages) are refused with 403.
- Each chat gets its own path: `/mcp/<chat-id>`. The server knows which connections that chat may use
  (its own connection, plus connections added through the chip). Any other connection id is an error.

Tools (`connection` is the connection id that `list_connections` returns):

| Tool | Input | Output |
|---|---|---|
| `list_connections` | none | id, name, engine, environment, current database, access level, for the chat's connections |
| `list_tables` | `connection`, `database?` | tables and views with kind and row estimate |
| `describe_table` | `connection`, `table`, `database?` | columns, indexes, foreign keys (reuses `table_structure`) |
| `run_select` | `connection`, `sql`, `database?` | columns, up to 200 rows, `truncated` flag, time taken |

`run_select` is not offered for connections with access **Schema only**. Connections with access **Off** are
never listed.

### 2.2 Read-only query path

`run_select` goes through three layers. Any one of them is enough to stop a write.

1. **SQL check:** exactly one statement (`sqlgen::split_statements`); it must pass `sqlgen::is_read_only_statement`
   (SELECT, SHOW, EXPLAIN, WITH, DESCRIBE; for SQLite also `PRAGMA name` or `PRAGMA name(arg)` without `=`). Also rejected: `INTO OUTFILE`,
   `INTO DUMPFILE`, `INTO @var`, `FOR UPDATE`, `LOCK IN SHARE MODE`, and a WITH whose main statement is not a SELECT.
2. **Database check:**
   - MySQL: a connection from the pool runs `START TRANSACTION READ ONLY`, the query, then `ROLLBACK`.
     `MAX_EXECUTION_TIME` hint / session variable limits it to 30 s.
   - SQLite: a separate connection opened with `SQLITE_OPEN_READ_ONLY` (plus `PRAGMA query_only = ON`),
     interrupted after 30 s.
3. **Limits:** at most 200 rows (the query is wrapped or `LIMIT 201` is added to detect `truncated`),
   text and binary values cut to 2 KB with a `…` mark, 30 s timeout.

### 2.3 Production approval

When `run_select` targets a connection with environment **Production**:

1. The MCP handler creates an approval request (id, chat id, connection, SQL) and adds an `approval` event to the
   chat's event list.
2. The panel shows the SQL with **Run** and **Deny**. The user's answer comes back through `answer_approval`.
3. The handler waits on a oneshot channel. No answer in 5 minutes, Deny, or Stop → the tool returns
   "The user did not allow this query." and nothing runs.

### 2.4 Agent runner

One Claude Code process per active chat, started on the first message:

```
claude -p --verbose
  --input-format stream-json --output-format stream-json --include-partial-messages
  --mcp-config <app data>/claude-mcp/<chat-id>.json   (file 0600, folder 0700; holds the URL and the Bearer token,
                                                     so the token is not visible in `ps`; deleted when the chat closes)
  --strict-mcp-config
  --setting-sources ""                         (verify: must load no user/project/local settings)
  --tools ""                                   (or "Read,Grep,Glob" when a project folder is set)
  --allowedTools mcp__tabula__* [Read(<folder>/**) Grep(<folder>/**) Glob(<folder>/**)]
  --append-system-prompt <Tabula prompt: engine/dialect, read-only rules, show SQL, be brief>
  [--resume <session-id>]                      (after Stop, so the chat continues)
cwd = project folder, or an empty folder inside the app's data folder
```

- User messages are written to stdin as stream-json lines. stdout lines are parsed into chat events
  (`text_delta`, `text`, `tool_use`, `tool_result`, `result`, `error`). Unknown event types are skipped and written to
  `client-errors.log`.
- **Stop** kills the process, denies open approvals and makes a running tool give up at once (a MySQL query still
  stops on its own within the 30 s limit; the user's own editor queries are not touched). The next message starts a
  new process with `--resume`.
- **Finding `claude`:** a GUI app has a short PATH. The runner checks, in order: `TABULA_CLAUDE_BIN` (dev/test),
  `~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, then
  `$SHELL -lc 'command -v claude'`. A path field in the settings is left out until a user needs it.
- Before a release, the flags marked "verify" are checked with a small probe against the installed version
  (2.1.296 today). The plan has this as its first task.

### 2.5 Chat events (backend → panel)

Each chat keeps an in-memory list of events with increasing numbers. `chat_events(chat_id, after)` returns new events
at once, or waits up to 25 s for one (long poll). Event kinds:
`user`, `text_delta`, `text`, `tool_call {tool, connection, sql?}`, `tool_result {rows, truncated, error?}`,
`approval {request_id, connection, sql}`, `approval_answered`, `done {cost?, duration}`, `error {kind, message}`.

New commands in `commands::dispatch`:
`chat_start(connections) → chat_id`, `chat_send(chat_id, text)`, `chat_events(chat_id, after)`,
`chat_stop(chat_id)`, `chat_close(chat_id)` (also used for **New chat**), `chat_set_connections(chat_id, connections)`,
`answer_approval(request_id, allow)`, `claude_status() → {found, path, version}`.
`connections` is a list of `{id, database}`: the chat's own connection first, then the ones added with the chip.

## 3. Multiple connections

### 3.1 UI

- **Connection rail** (left edge, ~44 px): one square per open connection, in opening order, with initials and the
  environment color. A dot shows the state: live, connecting (spinner), lost (red).
- Switch by click, ⌘1 … ⌘9, or ⌘K (open connections are listed first).
- **+** shows the connection list in the main area. Other connections stay open.
- Right-click a square → Disconnect. Unsaved edits in any of its tabs → confirmation, as today.
- Header shows the active connection, environment and database.

### 3.2 State

The store changes from one `session` + `tabs` to:

```ts
workspaces: Record<connectionId, {
  session: Session;          // as today
  tabs: Tab[]; activeTabId: string | null; dirtyTabs: Record<string, number>;
  chat: ChatState | null;
}>;
openOrder: string[];         // rail order
activeConnectionId: string | null;
```

- Components read the active workspace through selectors (`activeSession`, `activeTabs`), so their shape stays
  the same.
- Inactive workspaces stay mounted but hidden (`display: none`), so local state such as filter text, sort, page and
  scroll survives a switch. With at most ~9 open connections this is cheap.
- Tab restore per connection (`tabula.tabs.<id>` in localStorage) keeps working.
- The backend `Manager` already holds many sessions by id; no backend change is needed for this part.

## 4. Claude panel

- Right side, resizable, toggled with ⌘L. One chat per connection; switching connection switches the chat.
- **Chip row** above the input: `@ <connection> · <database>` (the chat's own connection) and **+** to add other open
  connections. **New chat** clears the chat and its Claude session.
- Messages: your text; Claude's text as Markdown (code blocks with SQL highlighting); a **tool card** per tool call
  (tool, connection, row count or error, the SQL, **Open in grid** → a new query tab with that SQL that runs at once);
  an **approval card** for Production; error notices.
- Footer while Claude works: a short status ("Reading table client_view…") and **Stop**.
- First open: a one-line notice: "Claude sees the tables, rows and files it reads here. They are sent to Anthropic.
  Change this per connection in its settings."
- Empty state: what Claude can do here, plus 3 example questions based on the connection's tables.

## 5. Connection settings

New fields on `ConnectionConfig` (saved in `connections.json`):

- `claudeAccess: "data" | "schema" | "off"`. Default: Production → `schema`, others → `data`.
- `projectFolder: string | null`. Picked with the folder dialog. Shown with a short note:
  "Claude can read files in this folder. It can't change them."

The connection form gets a small **Claude** section with these two fields.

## 6. Errors

| Case | Behaviour |
|---|---|
| `claude` not found | Panel shows "Claude Code is not installed" and how to fix it |
| Not logged in / plan limit reached | Panel shows Claude Code's own message; for login: "Run `claude` in Terminal, then `/login`" |
| Process exits unexpectedly | Error notice with the last stderr lines; the next message restarts with `--resume` |
| Connection lost / SQL error | Tool result carries the error text; Claude sees it and explains |
| Write attempt | Tool result: "Only read-only queries are allowed." Nothing reaches the database |
| Unknown stream event | Skipped and logged; chat continues |
| Approval timeout (5 min) | Treated as Deny |

## 7. Testing

- **Rust** (`./scripts/test-rust.sh`):
  - Read-only guard: writes rejected (two statements, `INTO OUTFILE`, `FOR UPDATE`, data-changing CTE), and the
    database layer blocks a write that skips the SQL check, on Docker MySQL and on SQLite.
  - Row limit, value truncation, timeout.
  - MCP server over real HTTP: wrong token → 401, connection not in the chat → error, schema-only hides
    `run_select`.
  - Production approval: allow, deny, timeout.
  - Stream-json parser against recorded sample files from the installed Claude Code.
  - Agent runner command line (flags, allowed tools with and without project folder).
- **Vitest:** workspace store (open, switch, close with unsaved edits, restore), chat event reducer.
- **Browser** through the dev bridge: rail, switching, panel with a fake agent (a test script that prints recorded
  stream-json), approval card.
- **One live run** with the user's real Claude Code, only after asking the user (it uses their plan).

## 8. Build order

1. Probe Claude Code flags (`--setting-sources ""`, scoped `Read(...)` rules, stream-json input) and record samples.
2. Multiple connections (store, rail, shortcuts).
3. Read-only query path + limits.
4. MCP server + Production approval.
5. Agent runner + chat events.
6. Claude panel UI.
7. Connection settings (access level, project folder).
8. Docs (README, design.md) and the live run.
