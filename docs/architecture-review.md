# Rowline — architecture review (security first, speed second)

Date: 2026-11-21 · Branch reviewed: `feat/ui-polish` (b5597f0) · Read-only review, no code changed.

---

## 1. Summary verdict

Rowline is in better shape than most young database clients. The code is small (≈7.8k lines of Rust, ≈13k lines of TS), it has one clear entry point (`commands::dispatch`), and the authors clearly think about security: values in change sets are bound parameters, identifiers are quoted, the AI path has a real **two-layer** read-only guard (SQL lexer check + `START TRANSACTION READ ONLY` / SQLite `SQLITE_OPEN_READ_ONLY`), the MCP server is bound to `127.0.0.1` with a 256-bit token and rejects any `Origin` header, the Claude process runs with `--strict-mcp-config`, `--setting-sources ""` and a minimal tool list, and the CSP and Tauri capabilities are tight. Tests cover many of the tricky cases (MySQL `/*! */` comments, `--1`, backslash escapes).

The main problem is **where the safety rules live**. Today they live in three different places with three different strengths:

| Path | Read-only check | Respects `claudeAccess` | Production approval |
|---|---|---|---|
| Claude panel (MCP) | strong (`readonly::check` + RO transaction) | yes | yes, per query |
| `rowline` CLI (socket) | strong | **no** | **no** |
| Editor / grid / restore (IPC) | weak, frontend only (`is_read_only_statement`, first keyword) | n/a | **frontend only**, easy to miss |

So: the AI-in-the-app path is well protected, but the **CLI that AI agents use daily skips the access policy and prod approval**, and the **production write guard for humans is a UI hint, not a rule**. The second theme is **credentials**: passwords sit in a plaintext JSON file, and the default MySQL TLS mode is `Off` (and `Required` does not stop a man-in-the-middle).

For speed, the design is fine for small and medium tables but has three real costs on big production tables: a `COUNT(*)` on **every page change**, MySQL results that are **read to the end even after the row limit**, and **`OFFSET` paging**. All three are cheap to fix.

**Verdict:** good foundation, not yet "safe to point at production by default". Move every policy decision into one Rust module (a "policy layer"), make the CLI use it, and fix the credential storage. That is about two weeks of focused work.

---

## 2. Findings

Severity: **critical** = can change or leak production data with little effort; **high** = real risk in normal use; **medium** = risk needs an extra condition; **low** = hygiene.

### 2.1 Security

| # | Area | Finding | Evidence | Risk / impact | Severity |
|---|---|---|---|---|---|
| S1 | CLI socket | `rowline` CLI ignores `claudeAccess` (Off / Schema / Data) and the production approval. Any open connection, including prod marked "schema only" or "off", can be queried for up to 1000 rows. The MCP path enforces both. | `src-tauri/src/cli/server.rs:117-124` (lists all open), `:173-222` (no access/env check) vs `src-tauri/src/claude/mcp.rs:205-214` | An AI agent (or any script you run) reads production row data that the app UI says Claude cannot see. Prompt-injected agents can exfiltrate. | **critical** |
| S2 | Prod guard | Production write confirmation exists only in the React editor and uses `is_read_only_statement`, which looks at the **first keyword only**. `WITH x AS (…) DELETE …`, `WITH … UPDATE …`, `SELECT … INTO OUTFILE`, `SELECT … FOR UPDATE`, `SELECT GET_LOCK(…)` all pass as "read only" and run on prod without a prompt. | `src-tauri/src/sqlgen.rs:323-334`, `src-tauri/src/commands/queries.rs:43-46`, `src/components/QueryTabView.tsx:101` | Accidental data change on prod with no warning. | **high** |
| S3 | Prod guard | `split_statements` does not follow the MySQL lexer: it treats `--` as a comment even without a following space. `SELECT 1--1; DELETE FROM t` is one "SELECT" statement for the splitter (so no prod prompt), but MySQL runs `SELECT 1-(-1)` **and** `DELETE` because `mysql_async` enables multi-statements. `readonly.rs` already handles this correctly; `sqlgen` does not. | `src-tauri/src/sqlgen.rs:276-280` vs `src-tauri/src/readonly.rs:162-165` | Hidden second statement on prod. | **high** |
| S4 | Backend trust | The backend never checks `environment` for `execute_sql`, `apply_changes`, `restore_start`. All prod protection is in the webview. One generic Tauri command (`call`) exposes every command, including `write_text_file`/`read_text_file` on **any path**. | `src-tauri/src/commands/data.rs:104-136`, `src-tauri/src/commands/jobs.rs:27-45`, `src-tauri/src/commands/files.rs:42-49`, `src-tauri/src/lib.rs:19-26` | If the webview is ever compromised (bad dependency, rendering bug), it can write any file in `$HOME` and run any SQL on prod. CSP makes XSS unlikely, but defence in depth is missing. | **high** |
| S5 | Grid filter | The grid sends a raw SQL string as `WHERE` (both chip mode and "SQL" mode). The backend pastes it into `SELECT … WHERE {filter}` and `COUNT(*)`. With MySQL multi-statements on, `1=1; DROP TABLE x` in the SQL filter runs the `DROP`. Chip values are escaped correctly in TS (`stringLiteral`), but the server cannot check that. | `src-tauri/src/sqlgen.rs:33-38`, `src/lib/filters.ts:53-57`, `src/components/DataTab.tsx:96` | Grid path bypasses all write guards. Saved tab state replays the filter on reopen. | **high** |
| S6 | Credentials | Passwords are stored in plaintext JSON (`secrets.json`, 0600). Any process of the same user (npm postinstall, an AI agent with shell access, a stolen backup of `~/Library`) can read every prod password. | `src-tauri/src/store.rs:13-50` | Full credential leak with one file read. Time Machine / cloud backups copy it. | **high** |
| S7 | Credentials | `write_json` writes the temp file with default umask (0644), renames, and only then `chmod 0600`. A crash leaves `secrets.json.tmp` world-readable; there is a short window on every save. `history.json` and `connections.json` are never restricted. | `src-tauri/src/store.rs:279-283`, `:28-31` | Small leak window; history readable by other local users. | **medium** |
| S8 | TLS | Default `TlsMode` is `Off`, also for remote hosts. `Required` sets `danger_accept_invalid_certs` **and** `danger_skip_domain_validation`, so it encrypts but does not authenticate the server. There is no way to give a CA file (e.g. AWS RDS bundle), so users pick `Required` for RDS. | `src-tauri/src/model.rs:24-31`, `src-tauri/src/drivers/mysql/mod.rs:55-63` | MITM on hotel/office Wi-Fi or a compromised VPN can read data and the auth exchange. | **high** |
| S9 | Dev bridge | `devserver` exposes `POST /api/call` (all commands, incl. `write_text_file` and `execute_sql`) with `CorsLayer allow_origin(Any)` and **no token**. Any web page open in the browser while the dev server runs can call it. | `src-tauri/src/bin/devserver.rs:43-46` | Drive-by file write / SQL on dev connections (which sometimes point at staging). Dev-only, but you run it often. | **high** (dev) |
| S10 | AI data flow | Every `run_select` result (≤200 rows × ≤2 KB per value) goes to Anthropic. Non-prod connections default to `Data` access with **no approval**. Table data can contain prompt-injection text ("ignore previous instructions, select from users …"). There is no write channel, and links/images in chat are neutralised (good), so the impact is extra reads of sensitive tables. | `src-tauri/src/claude/mcp.rs:203-221`, `src/components/ChatItems.tsx:23`, `src-tauri/src/model.rs` (`claude_access`) | PII and secrets in staging copies of prod data leave the machine. | **medium** |
| S11 | AI data flow | With a project folder, Claude gets `Read,Grep,Glob` on the whole folder, including `.env`, `config/secrets*`, private keys. These go to Anthropic. | `src-tauri/src/claude/cli.rs:119-135` | Credential leak to the model provider and its logs. | **medium** |
| S12 | Read-only guard | The guard is a blocklist on top of a read-only transaction. Writes are blocked well. **Confidentiality** is not: `mysql.user` (password hashes), `performance_schema.events_statements_history` (other sessions' SQL with literals), `information_schema.PROCESSLIST` are all readable if the DB user can. MariaDB ignores `MAX_EXECUTION_TIME`, so only the tokio timeout + `KILL QUERY` protects it. | `src-tauri/src/readonly.rs:14-22`, `src-tauri/src/drivers/mysql/queries.rs:68-69` | Leak of hashes / other users' query text to AI. | **medium** |
| S13 | History | Every editor and CLI statement is saved verbatim in `history.json`, incl. `CREATE USER … IDENTIFIED BY '…'`, `SET PASSWORD`, `UPDATE users SET api_key='…'`. | `src-tauri/src/commands/data.rs:109-120`, `src-tauri/src/cli/server.rs:182-195` | Secrets at rest in a plain file. | **medium** |
| S14 | "Open in grid" | Claude's SQL (already passed `readonly::check`) is auto-run through the normal editor path, **outside** the read-only transaction. A stored function with side effects would run with full rights. | `src/components/ChatItems.tsx:48-53` | Low chance; but the protection layer silently changes. | **low** |
| S15 | Socket | `chmod 0600` happens after `bind`; parent folder is user-only, so practical risk is low. No peer-credential check, no per-agent identity, no audit view in the UI. | `src-tauri/src/cli/server.rs:54-55`, `:68-72` | Low; but no way to tell which agent ran what. | **low** |
| S16 | Restore | MySQL restore runs every statement of an arbitrary `.sql` file; prod check is only a dialog text. | `src-tauri/src/commands/jobs.rs:27-45`, `src/components/BackupMenu.tsx:53-55` | Wrong file restored on prod = data loss. | **medium** |

**What is designed well (keep it):**
- Change sets: identifiers quoted, values bound, `$expr` restricted to a 4-word allowlist (`sqlgen.rs:103-118`).
- `readonly::check` masks strings/comments with the right MySQL vs SQLite lexer rules, keeps `/*! */`, blocks `INTO`, lock/sleep functions, `LOAD_FILE`, `FOR SHARE`, multi-statements; then a **database-level** read-only layer catches what the parser misses (`readonly.rs`, `mysql/queries.rs:62-90`, `sqlite.rs:249-280`). This is the right pattern.
- MCP server: random port on `127.0.0.1`, 256-bit token, constant-time compare, `Origin` rejected, token in a 0600 file in a 0700 folder, not in argv (`mcp.rs:26-78`, `claude/cli.rs:96-107`).
- Claude process: `--strict-mcp-config`, `--setting-sources ""`, tools limited to `mcp__rowline` (+ Read/Grep/Glob only in a validated project folder), project folder can't be `/`, `$HOME`, or the config folder (`claude/cli.rs:109-145`, `commands/connections.rs:88-106`).
- Chat rendering: Markdown links and images turned into plain text, so no exfiltration by image URL (`ChatItems.tsx:23`). CSP `img-src 'self' data: blob:` backs it up.
- Tauri: capabilities are minimal (`core:default`, drag, dialog), CSP has no `unsafe-eval`, `connect-src` only IPC.
- App quits when the window closes, so no hidden prod connection or socket stays open (`lib.rs:63-73`).

### 2.2 Speed

| # | Area | Finding | Evidence | Impact | Severity |
|---|---|---|---|---|---|
| P1 | Grid count | `count_rows` runs on **every** `load()`, and `load` depends on `offset` and `sort`. Clicking "next page" or sorting re-runs `COUNT(*)` (full index scan on InnoDB). With a filter on, a second unfiltered `COUNT(*)` runs once per table. Old counts are not cancelled when a new load starts; they keep a pool connection busy. | `src/components/DataTab.tsx:98-129` (113, 120) | On a 50M-row table every page click costs seconds of server CPU on prod. | **high** |
| P2 | MySQL result limit | `run_query` keeps reading all rows after `max_rows` (it only stops storing them). `SELECT * FROM big` in the editor with limit 5000 still streams the whole table over the network. Same for AI `run_select` (200 rows) until the 30 s timeout. SQLite does `break` correctly. | `src-tauri/src/drivers/mysql/queries.rs:155-162` vs `src-tauri/src/drivers/sqlite.rs:376-378` | Long waits, network and server load, can't stop without Cancel. | **high** |
| P3 | Paging | `LIMIT n+1 OFFSET k`: deep pages scan and throw away `k` rows. | `src-tauri/src/sqlgen.rs:60-61` | Page 1000 of a big table is slow. | **medium** |
| P4 | Cancel | `cancel()` sends `KILL QUERY` to **every** tracked query of the session (all tabs, counts, suggestions), not just the tab's one. | `src-tauri/src/drivers/mysql/queries.rs:107-118` | Cancel in one tab kills work in others; users avoid Cancel. | **medium** |
| P5 | No timeouts | Editor and grid queries have no statement timeout (only AI/CLI do). Pool has no explicit `PoolConstraints` / inactive TTL; `wait_timeout` is 8 h. | `src-tauri/src/drivers/mysql/mod.rs:47-63` | A forgotten query holds locks on prod. Up to the default pool max per connection. | **medium** |
| P6 | IPC payload | Results are `Vec<Vec<serde_json::Value>>` serialised to JSON over IPC. Editor "no limit" = 10,000,000 rows into one JSON string, parsed on the main JS thread. | `src/components/QueryTabView.tsx:33,108`, `src-tauri/src/model.rs` (`QueryResult`) | UI freezes, memory spikes ×3–5 (Rust Value + JSON string + JS objects). | **medium** |
| P7 | SQLite concurrency | One `Mutex<Connection>` per SQLite session: a slow query blocks paging, counts, schema, suggestions. | `src-tauri/src/drivers/sqlite.rs:12-16,41-52` | Grid "hangs" during a long editor query. | **medium** |
| P8 | Store I/O | `history.json` (500 entries) is read, parsed and fully rewritten synchronously on every query, on the async runtime. `connections.json` is read from disk on every `store.connection()` (each MCP tool call, each CLI call). | `src-tauri/src/store.rs:96-105`, `:261-267` | Small now; grows with history size; blocks tokio worker. | **low** |
| P9 | Pooled session state | Each editor run takes a random pooled connection. `BEGIN` in one run and `COMMIT` in the next go to different connections; temp tables and `SET @v` disappear. | `src-tauri/src/drivers/mysql/queries.rs:47-59` | Correctness more than speed; users can't do manual transactions on prod safely. | **medium** |
| P10 | Bundle | Main JS chunk 1.7 MB; `elk.bundled` (1.4 MB) **and** `elk-worker` (1.6 MB) both shipped; no `React.lazy` for diagram, CodeMirror or sql-formatter. Unused deps in `package.json`: `marked`, `react-responsive-carousel`, `lodash` (not imported in `src`). | `dist/assets/*`, `package.json`, `src/lib/diagram.ts:137` | Slower cold start of the webview; bigger app. | **low** |

Not measured: grid re-render cost in `DataTab.tsx` (723 lines, many `useState`) — I did not profile it. Glide Data Grid is canvas-based, so per-cell cost is low; the risk is whole-tab re-renders on every keystroke in the filter bar. Worth one React Profiler session.

---

## 3. Recommended target architecture

```
┌──────────────────────────── Webview (React) ─────────────────────────────┐
│  UI only. Sends *intents*, never raw policy decisions.                    │
│  grid: {table, filter AST | raw, sort, cursor}  editor: {sql, tabSession} │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ typed Tauri commands (one per domain, generated TS types)
┌───────────────▼──────────────────────────────────────────────────────────┐
│ Rust core                                                                 │
│                                                                           │
│  ┌──────────────┐   every request carries a Caller:                       │
│  │  Policy      │   Human(tab) | Claude(chat) | Cli(agent) | Restore      │
│  │  (one module)│ ← decides: allowed? needs approval? read-only tx?       │
│  └──────┬───────┘   inputs: environment, claudeAccess, cliAccess,         │
│         │           statement class (from ONE lexer: readonly::classify)  │
│  ┌──────▼───────┐                                                         │
│  │ Approvals    │ ← one queue for chat + CLI + prod writes (UI prompt)    │
│  └──────┬───────┘                                                         │
│  ┌──────▼──────────────┐   ┌───────────────┐   ┌──────────────────────┐   │
│  │ Executor            │   │ Secrets       │   │ Audit log            │   │
│  │ - timeouts per class│   │ Keychain/age  │   │ who/what/where, no   │   │
│  │ - early stop/KILL   │   │ zeroize       │   │ literals for secrets │   │
│  │ - per-query cancel  │   └───────────────┘   └──────────────────────┘   │
│  │ - sticky conn / tab │                                                  │
│  └──────┬──────────────┘                                                  │
│  ┌──────▼──────┐  ┌──────────┐                                            │
│  │ MySQL pool  │  │ SQLite   │  (+ optional read-only DB user per conn,   │
│  │ (+SSH)      │  │ RW + RO  │   used by Claude / CLI automatically)      │
│  └─────────────┘  └──────────┘                                            │
└───────────────────────────────────────────────────────────────────────────┘
        ▲                         ▲
        │ MCP (HTTP 127.0.0.1,    │ Unix socket (0600), per-agent token
        │ token, no Origin)       │ optional, same Policy + Approvals
     Claude Code               rowline CLI / other agents
```

### Key design decisions

1. **One policy module, enforced in Rust, for every caller.** `Policy::check(caller, connection, statement) -> Allow | AllowReadOnly | NeedsApproval(reason) | Deny(reason)`. The MCP server, the CLI, `execute_sql`, `apply_changes`, `select_page`, restore all call it. The frontend only shows the result. This removes S1, S2, S4, S16 in one design.
2. **One SQL lexer.** Replace `sqlgen::split_statements` + `is_read_only_statement` with the masking lexer from `readonly.rs` (it already follows MySQL/SQLite rules). Output a `StatementClass` (Read, Write, Ddl, Admin, Unknown) per statement. Unknown = treated as Write. Same function for prod prompts, AI and CLI.
3. **Defence in depth for automation: separate DB credentials.** Let each connection have an optional "read-only user" (MySQL user with `SELECT` only, no access to `mysql.*`). Claude and the CLI always use it when it is set. The SQL parser then becomes a second line, not the only line. This is the only real fix for S12.
4. **Access level per caller, not one flag.** Split `claudeAccess` into `ai: {panel, cli} × {off, schema, data}` plus `requireApproval: bool`. Default for prod: CLI = schema, panel = schema, approval on.
5. **Prod writes are a two-step backend protocol.** `execute_sql` on prod returns `NeedsConfirmation { token, statements }`; the UI shows them; the second call must pass the token. A compromised or buggy UI can't skip it.
6. **Grid sends a filter AST, not SQL.** `{column, op, values[]}` → Rust builds the `WHERE` with bound params. Raw SQL filter stays as a power feature, but goes through `Policy` (must classify as a read expression: wrap as `SELECT 1 FROM t WHERE (<raw>)` and run `readonly::check`) and runs with multi-statements off.
7. **Secrets in the macOS Keychain, done right.** Sign the app with a stable identity (Developer ID or at least a stable self-signed cert), then one Keychain item per connection or one Keychain-held key that encrypts `secrets.json`. Keep secrets in `secrecy::SecretString` / `zeroize`.
8. **Executor owns query lifecycle.** Each query gets a `QueryId`, its own timeout, a cancel handle that kills only that thread id, early stop after `max_rows` (drop + `KILL QUERY`), and optional sticky connection per editor tab (for manual transactions).
9. **Typed, narrow IPC.** Split the generic `call` into Tauri commands per domain with generated TS types (`specta`/`tauri-specta`), and remove free-path file commands: file writes go only through the dialog plugin's chosen path (or a short-lived path token returned by the save dialog).

---

## 4. Refactor plan (ordered, each step shippable)

| # | Step | What ships | Effort |
|---|---|---|---|
| 1 | **CLI respects access policy.** In `cli/server.rs`, filter `connections` by `claude_access() != Off`; `tables`/`describe` need ≥ Schema; `query` needs Data; prod returns `blocked` unless a new setting "Allow CLI on production" is on. Add tests next to the existing ones. | S1 closed | S |
| 2 | **Prod gate uses the strong check.** Replace `is_read_only` command body with `readonly::check`-based classification per statement (and make `split_statements` follow the MySQL `-- ` rule). Add tests for `WITH … DELETE`, `SELECT 1--1; DELETE`, `INTO OUTFILE`. | S2, S3 closed | S |
| 3 | **Backend prod confirmation token.** `execute_sql`, `apply_changes`, `restore_start` on prod require `confirm: <token>` from a first "plan" call. UI flow stays the same. | S4 (SQL part), S16 | M |
| 4 | **Early stop for MySQL results.** In `run_query`, after `max_rows`, stop reading: drop the stream and `KILL QUERY` the thread on a second connection (or wrap SELECTs in a sub-query `LIMIT max_rows+1` where possible). | P2 | S |
| 5 | **Count once per (table, filter).** Remove `offset`/`sort` from the count key; reuse total across pages; cancel the old count when the filter changes; show `information_schema.TABLES.TABLE_ROWS` estimate instantly and make exact count opt-in on tables > 1M rows. | P1 | S |
| 6 | **Per-query cancel.** Track `QueryId → thread id`; `cancel_query` takes the query id from the tab. | P4 | S |
| 7 | **Grid filter AST.** Move `ruleCondition` to Rust with bound params; raw mode goes through the policy check and multi-statements off (`OptsBuilder::client_found_rows`/disable `CLIENT_MULTI_STATEMENTS` on the grid pool, or a separate pool). | S5 | M |
| 8 | **Secrets: Keychain.** Stable code signing, Keychain items via `security-framework`; one-time migration from `secrets.json`, then delete it. `secrecy` + `zeroize` in memory. | S6, S7 | M |
| 9 | **TLS done right.** Add `VerifyCa { ca_file }` mode (RDS bundle), default `Verify` for non-localhost hosts, warning badge on `Off`/`Required` for prod. | S8 | S |
| 10 | **Policy module + single lexer.** Extract `policy.rs` and `lexer.rs`; MCP, CLI, IPC call it. Remove duplicate logic. | foundation for 3, 7, 11 | M |
| 11 | **Read-only DB user per connection.** Optional second user/password; Claude and CLI use it. | S12 | M |
| 12 | **Typed IPC, no free-path file commands.** `tauri-specta`; `write_text_file` only to a path returned by the save dialog in the same session. | S4 (file part) | M |
| 13 | **Executor: timeouts, sticky tab connection, keyset paging.** Default statement timeout per environment (e.g. prod 60 s, configurable), "session" mode for editor tabs, `WHERE pk > last ORDER BY pk` paging when the sort is by primary key. | P3, P5, P9 | L |
| 14 | **Streaming / binary results.** Send rows in chunks (Tauri `Channel`) as columnar arrays; grid fetches windows on scroll. | P6 | L |
| 15 | **SQLite: separate read connection pool (WAL).** One writer + N readers. | P7 | M |

---

## 5. Missing features that matter for security and speed

| Priority | Feature | Why |
|---|---|---|
| P0 | **Production safe mode** per connection: read-only by default; "unlock writes for 10 minutes" button; red frame; enforced in Rust. | Today prod writes depend on UI dialogs (S2–S5). |
| P0 | **Keychain storage** for passwords. | S6. |
| P0 | **Per-caller AI/CLI access** (panel vs CLI, approval on/off), plus an **audit view** ("Agent activity": time, caller, connection, SQL, rows). History already has `source: "cli"`; add a filter and make it visible. | S1, S10, S15. |
| P1 | **Query timeouts** for editor and grid, per environment. | P5; protects prod from forgotten queries. |
| P1 | **SSH tunnel** (and later AWS IAM / RDS proxy auth). | Most prod MySQL is not on a public port; today users open tunnels by hand or expose ports. |
| P1 | **TLS with custom CA** (`VerifyCa`). | S8. |
| P1 | **Read-only DB user for automation.** | S12. |
| P1 | **Sensitive column masking** for AI/CLI (rules like `*password*`, `*token*`, `email` → hashed or `***`), configurable per connection. | S10: less PII to the model provider. |
| P1 | **Deny rules for project folder** (`.env*`, `*.pem`, `*secret*`, `config/credentials*`) passed as `--disallowedTools Read(...)`. | S11. |
| P2 | **Streaming results + virtual paging** in the editor. | P6. |
| P2 | **Keyset paging** and **estimated counts**. | P1, P3. |
| P2 | **Sticky session per editor tab** (manual transactions, temp tables). | P9. |
| P2 | **History redaction** (detect `IDENTIFIED BY`, `PASSWORD(`, long hex/base64 literals) and an option to not store history for prod. | S13. |
| P3 | **Signed + notarized builds, auto-update with signature check.** | Needed for Keychain and for trust in the binary that holds prod creds. |

---

## 6. Quick wins (under a day each)

1. **CLI: enforce `claudeAccess` and block prod data without approval** (`cli/server.rs`, ~40 lines + tests). Biggest risk reduction per hour.
2. **`is_read_only` → use `readonly::check` logic per statement** and fix `--` in `split_statements` (`sqlgen.rs:276`). Add the 4 bypass cases as tests.
3. **MySQL early stop after `max_rows`** in `run_query` (`mysql/queries.rs:155-162`).
4. **Count only when table/filter changes**, not on page/sort change (`DataTab.tsx:98-129`); cancel stale counts.
5. **Write secrets with `OpenOptions::mode(0o600)`** before writing content; same for `history.json`; clean up `*.json.tmp` on start (`store.rs:279-283`).
6. **Dev bridge:** remove `CorsLayer allow_origin(Any)`, reject requests with an `Origin` other than `http://localhost:1420`, add a random token printed at start (`devserver.rs:43-46`).
7. **TLS warning:** show a badge "not verified" for `Off`/`Required` on non-localhost hosts; default new remote connections to `Verify`.
8. **Project folder deny list** for Claude: add `Read(.env*)`, `Read(**/*.pem)` etc. to `--disallowedTools` (`claude/cli.rs:109-145`).
9. **Per-query cancel id** so Cancel in one tab doesn't kill other tabs (`mysql/queries.rs:107-118`).
10. **Remove unused deps** (`marked`, `react-responsive-carousel`, `lodash`) and `React.lazy` the diagram tab (elk + xyflow) — smaller first load.
11. **Block `mysql.*`, `performance_schema.events_statements_*` and `information_schema.PROCESSLIST`** in `readonly::check` for AI/CLI (simple word check on masked text) until the read-only DB user exists.

---

*Method:* read `src-tauri/src` (drivers, manager, sqlgen, readonly, commands, cli, claude, store, backup), `tauri.conf.json`, capabilities, and the main React files (`DataTab.tsx`, `QueryTabView.tsx`, `filters.ts`, `ChatItems.tsx`, stores), plus `dist/assets` sizes. No tests were run, no database was touched, no secrets were read.
