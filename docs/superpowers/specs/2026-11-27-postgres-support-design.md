# PostgreSQL support — design

Status: draft for review · 2026-11-27

## Intent

uDB opens MySQL and SQLite today. The user and their team also work with **PostgreSQL**:
work **prod** databases and **local dev** databases, **mostly to read data**. Postgres
should feel the same as MySQL in uDB: browse tables, grid, filters, sort, count, ⌘K,
SQL editor, Claude panel, `udb` command, cancel. And it must be at least as safe.

## Goals

- Connect to Postgres (host, port 5432, user, password, database, TLS).
- Browse one database + one schema at a time (the TablePlus model, see below).
- Everything that works for a MySQL table works for a Postgres table: grid paging,
  filters, sort, count (with "Stop"), common values, structure, diagram, row editing,
  SQL editor (multi-statement, results, errors), ⌘K (tables, columns, saved queries).
- Claude panel and `udb` command work on Postgres with the same Claude access levels
  (Data / Schema / Off).
- Cancel a running query from the tab (button, Esc, ⌘.) — only that tab's query.

## Non-goals (v1)

- Backup / restore for Postgres. The backup menu hides these items for Postgres
  connections. Can come later as its own job.
- Several schemas side by side in the sidebar (PhpStorm-style tree).
- Postgres-only object types in the sidebar: functions, sequences, materialized views
  beyond listing them as views, extensions, roles.
- A `Driver` trait refactor (approach C below). Later, if a 4th engine comes.
- Other engines (MariaDB check, SQL Server, NoSQL).

## Anti-goals (failure even if it "works")

- Any path where Claude or the `udb` command can change data or read server files on
  Postgres. Postgres must not be the weak engine.
- MySQL or SQLite behaviour changes or gets slower because of this work.
- Loading every schema / every database on a big server at connect time (slow start).

## Constraints

- Stack stays: Tauri 2 / Rust (tokio), React + Zustand, Glide grid, CodeMirror.
- TLS uses the same `native-tls` stack as `mysql_async` (macOS Keychain trust).
- Tests: Postgres gets a container in `dev/docker/docker-compose.yml` next to MySQL
  (bound to 127.0.0.1, own port, e.g. 15432), env in `dev/docker/.env`, picked up by
  `scripts/test-rust.sh` as `ROWLINE_TEST_POSTGRES` (same `host:port:user:pass:db`
  form as `ROWLINE_TEST_MYSQL`). Tests skip when the variable is missing.
- Don't touch other Docker containers on the machine.
- Saved connections stay compatible: `engine: "postgres"` is a new enum value;
  old files load unchanged.

## Approaches

**A. `tokio-postgres` + a third `Session` arm — chosen.**
New `src-tauri/src/drivers/postgres/` (mod, schema, queries, values), built like
`drivers/mysql/`. `Session::Postgres(PostgresSession)` in `manager.rs`; each method's
`match` gets one more arm. `tokio-postgres` gives direct control of cancel
(`CancelToken`, no second login), row streaming (stop at the row limit), and
session settings (`default_transaction_read_only`, `search_path`, `statement_timeout`).
TLS via `postgres-native-tls`.

**B. `sqlx` for Postgres only.** One crate for all engines in theory, but we would
keep MySQL/SQLite as they are, so it only adds a big dependency tree; its cancel and
row-limit streaming are weaker. Compile-time checked queries don't help: our SQL is
dynamic. Rejected.

**C. `Driver` trait refactor first, then Postgres.** Cleaner for 4+ engines, but a
large refactor of working code before any feature, with awkward async `dyn` traits.
Rejected for now (YAGNI).

The user picked A.

## Decided with the user

### Navigation: the TablePlus way

- A connection shows **one database + one schema** at a time.
- **Database picker**: same control as for MySQL. For Postgres, choosing a database
  opens a new connection to it (Postgres can't switch database on a live connection).
  Tabs of the old database stay open as tabs but must reconnect/fail clearly — see
  "Left to the builder".
- **Schema dropdown** at the top of the sidebar, above the table filter.
  Default: `public` if it exists and has tables, else the first schema with tables.
  Hidden when the database has only one user schema. System schemas
  (`pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp*`) are never listed.
- The sidebar table list shows only the selected schema.
- **⌘K searches all user schemas** of the current database (tables and columns) and
  shows `schema.table` for non-`public` ones. Picking one switches the sidebar schema
  and opens the table.
- **Tab names**: `invoices` for `public`, `billing.invoices` otherwise (same idea as
  today's database prefix when it differs).
- **SQL editor**: `search_path` is set to `"<selected schema>", public` so plain table
  names work, as in PhpStorm.

### Scope of v1

Read/browse at full quality + row editing + SQL editor + Claude + `udb`. No backup.

### Safety

Two locks for every read-only path (Claude panel, MCP tools, `udb query`):

1. **`readonly.rs` checker with real Postgres rules** (new `Dialect::Postgres`):
   - Lexer: `"ident"` quoting, `'…'` with `''`, `E'…'` escapes, dollar quotes
     `$$…$$` / `$tag$…$tag$`, `--` and nested `/* */` comments, `::` casts.
   - Allowed statements: `SELECT`, `WITH … SELECT`, `VALUES`, `TABLE x`, `SHOW`,
     `EXPLAIN` (without `ANALYZE`, since `EXPLAIN ANALYZE` runs the statement).
   - Blocked functions: `pg_read_file`, `pg_read_binary_file`, `pg_ls_dir`, `pg_stat_file`,
     `lo_import`, `lo_export`, `lo_get`, `dblink*`, `pg_sleep*`, `pg_terminate_backend`,
     `pg_cancel_backend`, `pg_reload_conf`, `set_config`, `pg_advisory_*lock*`,
     `query_to_xml` and friends that run SQL from a string. (`current_setting` stays allowed.)
   - Blocked data: `pg_authid`, `pg_shadow`, `pg_user_mapping(s)`, `pg_hba_file_rules`,
     `pg_file_settings`, `pg_stat_activity` (other users' queries, like MySQL
     processlist).
   - Statements such as `COPY`, `DO`, `CALL`, `SET`, `LISTEN/NOTIFY`, `LOCK`,
     `PREPARE/EXECUTE` are not reads and are refused.
2. **Server-side read-only**: read-only paths run inside
   `BEGIN TRANSACTION READ ONLY; … ROLLBACK;` with a `statement_timeout`. Postgres
   itself then refuses writes, even if the checker misses something. (Note: a read-only
   transaction does not stop `pg_read_file` or `dblink` — that's why lock 1 blocks them.)

App UI rules stay exactly as for MySQL today:
- On **prod**, statements that change data ask for confirmation before they run
  (`QueryTabView`), and row edits go through the review dialog. They are not blocked.
- Claude access default: prod = Schema, others = Data.

TLS: same `TlsMode` as MySQL. Map: Off → `sslmode=disable`, Required → `require`
(no cert check), Verify → `verify-full`. Default Verify for remote hosts, Off for
localhost (`src/lib/tls.ts` already does this by host).

Cancel: the session keeps a `CancelToken` per running query, keyed by tab owner
(`crate::owner`), like MySQL's `tracked()` guard. `cancel(owner)` sends the cancel
request for that tab's queries only.

## Touch points found in the code (for the builder)

Rust:
- `model.rs` — `Engine::Postgres`.
- `manager.rs` — `Session::Postgres`, `open` (default host 127.0.0.1, port 5432,
  user `postgres`), every method, `dialect()`.
- `sqlgen.rs` — `Dialect::Postgres`: quoting `"…"`, `LIMIT/OFFSET`, placeholders,
  `split_statements` aware of dollar quotes, `is_read_only_statement`.
- `readonly.rs` — Postgres rules above, tests next to the MySQL ones.
- `commands/data.rs`, `commands/jobs.rs`, `cli/server.rs`, `claude/mcp.rs` — the
  engine `match`es: the "database" for Postgres is the connection's current database;
  the schema is passed as well (new optional `schema` argument where tables are named).
- `commands/connections.rs` — `list_databases_for` for Postgres (`pg_database`,
  without templates, only databases the user may connect to).
- New `list_schemas` command.
- `drivers/postgres/values.rs` — type mapping to grid values: ints, numeric (as
  string, no float loss), bool, text, json/jsonb (as JSON text), uuid, bytea (as hex,
  cut), timestamps/timestamptz/date/time, interval, arrays (as text), enums,
  `inet`/`cidr`, unknown types as text via `::text`.
- Row identity for edits: primary key; tables without PK are read-only in the grid
  (same rule as MySQL — builder to confirm the current MySQL rule and copy it).

Frontend (`engine === 'mysql'` checks found in 17 files):
- `ConnectionForm` — engine choice, port default 5432, TLS, database picker.
- `Sidebar` — schema dropdown; `Header`, `TabBar` — names with schema.
- `filters.ts`, `filterComplete.ts`, `FilterBar`, `FilterInput`, `fieldValues.ts` —
  Postgres quoting and operators (`ILIKE` for case-insensitive contains,
  `::text` casts for LIKE on non-text).
- `CommandPalette` — all-schema search.
- `BackupMenu` — hide backup/restore for Postgres.
- `DiagramPane`, `diagram.ts` — foreign keys inside the selected schema; cross-schema
  FKs shown with `schema.table` labels.
- `store/app.ts` — current schema per connection, remembered like the current database.
- SQL editor highlighting: CodeMirror `PostgreSQL` dialect.

## Left to the builder

- Module split inside `drivers/postgres/` and exact function names.
- Connection pooling (one client per database vs a small pool) — but count and page
  queries must be able to run while a long query runs, as on MySQL.
- How open tabs behave after a database switch (reconnect on focus or show an error
  and offer to reopen) — pick the simpler one that matches MySQL behaviour.
- Exact list order and wording of error messages (follow the MySQL style:
  `ERROR code (state): message`, using Postgres SQLSTATE).
- Estimated row counts in the sidebar (`~`) from `pg_class.reltuples`, like MySQL.
- Tests: driver tests against the container; readonly unit tests; frontend tests for
  quoting/filters and the schema dropdown.
