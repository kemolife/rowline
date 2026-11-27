# PostgreSQL Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** uDB opens PostgreSQL databases with the same features as MySQL and stricter safety on prod.

**Architecture:** New `src-tauri/src/drivers/postgres/` on `tokio-postgres`, a third `Session::Postgres` arm in `manager.rs`, `Dialect::Postgres` in `sqlgen.rs` and `readonly.rs`, an optional `schema` argument through commands, and frontend branches for a third engine (TablePlus-style schema dropdown).

**Tech Stack:** Rust (tokio, tokio-postgres, postgres-native-tls, native-tls), React + Zustand, CodeMirror `PostgreSQL` dialect, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-postgres-support-design.md` (read it first; its "Calls made after the builder check" section is binding).

## Global Constraints

- Engine value: `"postgres"` (Rust `Engine::Postgres`, TS `'postgres'`). Old saved connections load unchanged.
- Defaults: host `127.0.0.1`, port `5432`, user `postgres`.
- Postgres 12+. Test container image `postgres:16`, bound to `127.0.0.1:15432`, project `rowline-test-db` (same compose file as MySQL). Never touch other containers.
- TLS: `TlsMode::Off` → no TLS, `Required` → TLS without cert/host check, `Verify` → TLS with system trust + host check. Stack: `native-tls` (same as `mysql_async`).
- Session settings per query use `SET LOCAL` inside the query's transaction (PgBouncer-safe).
- Pool: 4 clients per database, created on first use; idle pools closed after 5 minutes.
- Read-only paths (Claude, MCP, `udb`, `select_read_only`) = `readonly::check` with `Dialect::Postgres` + `BEGIN READ ONLY` + `SET LOCAL statement_timeout` (same value MySQL uses for these paths) + `ROLLBACK`. They refuse to run when the login role is superuser: message `Claude and udb don't run as a Postgres superuser. Connect with a role that is not a superuser.`
- **Prod lock:** when `environment == prod`, every Postgres query (grid, editor, count, edits) runs in a READ ONLY transaction unless the call carries `unlocked: true`. Only the UI sends `unlocked`, per tab, after the "Unlock writes" confirm. Claude/MCP/`udb` never can.
- Error text: `ERROR <SQLSTATE>: <message>` (Postgres has no numeric code), plus `DETAIL`/`HINT` lines when present.
- Backup/restore: not for Postgres. Backend returns `Backup is not available for PostgreSQL yet.`; UI hides the items.
- No prettier. Keep edits local. Commit per task on branch `feat/postgres`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: `rtk proxy npx vitest run --reporter=dot`, `zsh scripts/test-rust.sh`, `rtk proxy npx tsc --noEmit -p .`. `grep` is aliased to rg; use `rtk proxy grep`.

## Review Focus

1. A Postgres identifier with upper case or a dot (`"Orders"`, `"a.b"`) — must be quoted everywhere (page, count, filter, edits, diagram, ⌘K). Test in Task 2 and Task 4.
2. A database with zero user schemas or only `public` empty — sidebar shows "No tables", dropdown hidden, no crash. Test in Task 4 (`schemas()` returns `[]` cleanly) and Task 7.
3. A prod connection with a tab unlocked, then a second tab — second tab stays locked; closing the unlocked tab re-locks. Test in Task 7 (store test).
4. `numeric`, `bigint` > 2^53, `uuid`, `jsonb`, `timestamptz`, `bytea`, arrays, `NULL` round-trip through grid display and edit. Test in Task 4.
5. Cancel of a long query in one tab while another tab pages the same table — the second query keeps running. Test in Task 4.

---

### Task 1: Engine value, dependencies, test container

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/model.rs` (`Engine`), `src/lib/types.ts` (`Engine`), `dev/docker/docker-compose.yml`, `dev/docker/.env` (add `PG_PORT` only if needed; reuse `DB_USER`/`DB_PASSWORD`), `scripts/test-rust.sh`
- Create: `dev/docker/init-postgres/01-shop.sql`

**Interfaces:**
- Produces: `Engine::Postgres` (serde `"postgres"`), TS `Engine = 'mysql' | 'sqlite' | 'postgres'`, env `ROWLINE_TEST_POSTGRES="127.0.0.1:15432:${DB_USER}:${DB_PASSWORD}:shop"`.

- [ ] Add deps: `tokio-postgres = { version = "0.7", features = ["with-chrono-0_4", "with-serde_json-1", "with-uuid-1"] }`, `postgres-native-tls = "0.5"`, `native-tls = "0.2"`, `rust_decimal` only if needed for numeric (prefer reading numeric as text via `::text` in SQL instead).
- [ ] `Engine::Postgres`. Every Rust `match` on `Engine`/`Session` that stops compiling gets a temporary arm returning `AppError::msg("PostgreSQL is not ready yet")` — later tasks replace them.
- [ ] Compose service `postgres` (`postgres:16`, `POSTGRES_USER=${DB_USER}`, `POSTGRES_PASSWORD=${DB_PASSWORD}`, `POSTGRES_DB=shop`, ports `127.0.0.1:15432:5432`, init folder `./init-postgres`). Init SQL: schemas `public` and `billing`; tables `public.customers(id serial pk, name text, email text unique, created_at timestamptz default now())`, `public."Orders"(id bigserial pk, customer_id int references customers, total numeric(12,2), meta jsonb, tags text[], token uuid, raw bytea)`, `billing.invoices(id int pk, order_id bigint references public."Orders", due date)`, a view `public.big_orders`, a table without PK `public.audit_log(at timestamptz, msg text)`, ~20 rows; a non-superuser role `reader` (password = `${DB_PASSWORD}` is not available in SQL — use a fixed test password `reader_pw`, test-only) with `SELECT` on all tables.
- [ ] `scripts/test-rust.sh` exports `ROWLINE_TEST_POSTGRES` next to `ROWLINE_TEST_MYSQL`.
- [ ] Start only that service: `docker compose -f dev/docker/docker-compose.yml up -d postgres`. Verify: `docker compose -f dev/docker/docker-compose.yml exec postgres psql -U "$DB_USER" -d shop -c '\dt *.*' | head`.
- [ ] Run all three test commands; all pass. Commit `postgres: engine value, deps, test container`.

### Task 2: `Dialect::Postgres` in sqlgen

**Files:** Modify `src-tauri/src/sqlgen.rs` (+ its tests), `src-tauri/src/model.rs` (`PageRequest.schema: Option<String>`, serde default).

**Interfaces:**
- Produces: `Dialect::Postgres`; `Dialect::qualified_in(self, database: Option<&str>, schema: Option<&str>, table: &str) -> String` (Postgres: `"schema"."table"` when schema given; database ignored; MySQL/SQLite: same as `qualified`). `select_page_sql`/`count_sql`/`common_values_sql` use `req.schema` for Postgres. `change_set_statements` emits `$1, $2…` with `::<type>` casts for Postgres — it takes a new arg `types: &HashMap<String, String>` (column → Postgres type name; empty map for other dialects). `split_statements` and `is_read_only_statement` understand dollar quotes and `E''` strings.

- [ ] Tests first: quoting `Orders` → `"Orders"`, `a"b` → `"a""b"`; `qualified_in(Postgres, Some("shop"), Some("billing"), "invoices")` = `"billing"."invoices"`; page SQL uses `LIMIT n OFFSET m`; update statement for Postgres = `UPDATE "public"."Orders" SET "total" = $1::numeric WHERE "id" = $2::int8`; `split_statements("select $$a;b$$; select 2")` → 2 statements; `split_statements("select E'it\\'s;'; select 1")` → 2; `is_read_only_statement("explain analyze delete from t")` = false, `("table customers")` = true.
- [ ] Run, see fail; implement; run, pass. All MySQL/SQLite sqlgen tests unchanged and passing.
- [ ] Commit `postgres: sql generation dialect`.

### Task 3: Postgres rules in `readonly.rs`

**Files:** Modify `src-tauri/src/readonly.rs` (+ tests).

**Interfaces:**
- Produces: `check(sql, Dialect::Postgres) -> AppResult<String>`; `blocked_schema(schema: Option<&str>) -> AppResult<()>` (refuses `pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp*`).

- [ ] Tests first (each a separate assertion, refused unless stated): allowed `select 1`, `with x as (select 1) select * from x`, `values (1)`, `table customers`, `show search_path`, `explain select 1`, `select current_setting('TimeZone')`, `select '$$pg_sleep$$'` (string, allowed), `select "pg_read_file" from t` (quoted column, allowed). Refused: `explain analyze select 1`, `select pg_read_file('/etc/passwd')`, `SELECT PG_SLEEP(10)`, `select pg_catalog.pg_sleep(1)`, `select * from dblink('…','…')`, `select lo_import('/x')`, `select nextval('s')`, `select setval('s',1)`, `select pg_notify('c','x')`, `select set_config('a','b',false)`, `select pg_terminate_backend(1)`, `select pg_advisory_lock(1)`, `select query_to_xml('delete from t', true, true, '')`, `select * from pg_authid`, `select * from pg_catalog.pg_shadow`, `select * from pg_stat_activity`, `select * from pg_hba_file_rules`, `select * from t for update`, `select * into t2 from t`, `copy t to program 'x'`, `do $$ begin end $$`, `call p()`, `set role postgres`, `lock t`, `listen c`, `prepare p as select 1`, `select 1; select 2` (one statement only), `select $q$ $q$; delete from t` (dollar-quote can't hide a second statement), `select /* */ pg_sleep(1)`, `select pg_sleep (1)` (space before paren). Error texts follow the MySQL style already in the file.
- [ ] Lexer for Postgres in `mask_with`: `"ident"`, `'…'` with `''`, `E'…'` with backslash escapes, `$tag$…$tag$`, `--`, nested `/* */`. Function detection must match `name(`, `name (`, `schema.name(`.
- [ ] Run, fail, implement, pass. MySQL/SQLite readonly tests unchanged.
- [ ] Commit `postgres: read-only checker rules`.

### Task 4: Postgres driver

**Files:** Create `src-tauri/src/drivers/postgres/{mod.rs,schema.rs,queries.rs,values.rs,test_support.rs}`; modify `src-tauri/src/drivers/mod.rs`, `src-tauri/src/error.rs` (Postgres error text).

**Interfaces:**
- Consumes: Task 2 sqlgen, Task 3 readonly (called by commands, not the driver).
- Produces `PostgresSession` with:
  - `connect(p: PostgresParams<'_>) -> AppResult<Self>` where `PostgresParams { host, port, user, password, database: Option<&str>, tls: TlsMode, prod_lock: bool }`; connects to `database` or `postgres`.
  - `server_info() -> ServerInfo` (`version` = `server_version`, `current_database`).
  - `is_superuser(database: Option<&str>) -> AppResult<bool>`.
  - `databases()` (non-template, `has_database_privilege(datname,'CONNECT')`, sorted), `schemas(database) -> Vec<String>` (user schemas that are not system schemas, sorted, `public` first).
  - `objects(database, schema)`, `structure(database, schema, table)`, `common_values(database, schema, table, column, limit)`, `schema_graph(database, schema)` (cross-schema FK target shown as `schema.table`), `schema_columns(database) -> Vec<(String, Vec<String>)>` (keys `table` for public, `schema.table` otherwise; all user schemas).
  - `select_page(req, unlocked: bool)`, `count(req, unlocked)`, `execute(database, schema, sql, max_rows, unlocked) -> Vec<QueryResult>` (keeps results before a failing statement, like MySQL `QueryResult::failed`), `select_read_only(database, schema, sql, max_rows)`, `apply_changes(database, schema, table, changes, unlocked) -> u64` (in one transaction; needs column types from `structure`).
  - `cancel(owner: Option<&str>)` — `running: Mutex<Vec<(u64 /*query id*/, Option<String>, CancelToken)>>` with a Drop guard; cancel sends `cancel_query(tls)` for matching owners.
  - Every query: `BEGIN` (`BEGIN READ ONLY` when `prod_lock && !unlocked`, always for `select_read_only`), `SET LOCAL search_path = "<schema>", public` when schema given, `SET LOCAL TimeZone = '<local zone>'`, then the work, then `COMMIT` (`ROLLBACK` for read-only paths). `execute` with a user `BEGIN`/`COMMIT` inside the text is allowed only when unlocked; on a locked connection writes fail with Postgres's own `25006` error — show it as `This prod connection is read-only. Use "Unlock writes" on this tab to change data.`
  - Row-limit streaming: `query_raw` and stop reading at `max_rows`, set `truncated`.
  - Reconnect after sleep: a client whose `is_closed()` is true is dropped and replaced on checkout.
- `values.rs`: map to JSON — int2/4 numbers; int8 and numeric as strings when beyond ±2^53 (numeric always as string via `::text`); bool; text/varchar/char/name/citext text; json/jsonb as JSON text string; uuid string; date/time/timestamp/timestamptz/interval as text; bytea `\x…` cut to the same length limit MySQL uses for blobs; arrays, enums, inet/cidr, unknown types as text. Rule: all queries (page and free SQL) read results in **text format** (every value arrives as the server's text), then `values.rs` converts by type OID: int2/int4/float4/float8 → JSON number, int8 → number only when within ±2^53 else string, bool `t/f` → JSON bool, everything else → string. This keeps exact text for numeric, timestamps and unknown types.
- `error.rs`: `tokio_postgres::Error` → `ERROR <SQLSTATE>: <message>` + `DETAIL:`/`HINT:` lines.

- [ ] Tests first (`#[tokio::test]`, skip without `ROWLINE_TEST_POSTGRES`, use only the `shop` DB and tables created by the test itself or the init SQL): connect + `server_info`; wrong password → error text contains `28P01`; `databases()` contains `shop`, not `template0`; `schemas()` = `["public","billing"]`; `objects(public)` has `Orders` (table), `big_orders` (view) with row estimates; `structure("Orders")` PK `id`, FK to customers; page of `"Orders"` with filter `total > 10` sorted desc; round-trip edit of `total` (numeric), `meta` (jsonb), `tags` (array), `token` (uuid) and set `NULL`, then read back exact text; `bigint` 9007199254740993 comes back as string; `bytea` read is `\x…`; `select_read_only("delete from customers")` fails with `25006`; prod-lock session: `execute("update customers set name=name")` fails with the unlock message, same with `unlocked: true` succeeds (inside a test transaction rolled back, or on a test-owned table); cancel: start `select pg_sleep(30)` owned by `tab-a` and `select 1` owned by `tab-b`, `cancel(Some("tab-a"))` → first ends with `57014` within 2 s, second returns; superuser check true for `DB_USER`, false for `reader`; `max_rows` = 5 on a 20-row table → 5 rows, `truncated`.
- [ ] Run, fail, implement, pass.
- [ ] Commit `postgres: driver`.

### Task 5: Manager, commands, Claude/MCP/CLI wiring

**Files:** Modify `src-tauri/src/manager.rs`, `src-tauri/src/commands/{data.rs,schema.rs,connections.rs,jobs.rs}`, `src-tauri/src/claude/mcp.rs`, `src-tauri/src/cli/{server.rs,mod.rs}`.

**Interfaces:**
- Consumes: Task 4 `PostgresSession`.
- Produces:
  - `Session::Postgres`; `Session::open` passes `prod_lock = config.environment == Environment::Prod`.
  - Every `Session` method that names tables or lists objects gains `schema: Option<&str>` (MySQL/SQLite ignore); `select_page`/`count` read `req.schema`; `execute`/`apply_changes`/`select_page`/`count` gain `unlocked: bool` (MySQL/SQLite ignore).
  - Commands accept optional `schema` and `unlocked` (serde default false) in their args. New commands: `list_schemas { id, database }`, `set_active_schema { id, schema }`. `Manager::set_schema/schema(id)` like `set_database`.
  - `select_read_only` for Postgres: calls `readonly::check(sql, Dialect::Postgres)`, `readonly::blocked_schema`, then refuses if `is_superuser`.
  - `list_databases_for` handles Postgres.
  - `jobs.rs`: Postgres backup/restore → `Backup is not available for PostgreSQL yet.`
  - MCP tools and `udb` server: Postgres database = asked or active or config; schema = asked or `Manager::schema(id)` or `public`. `udb query|tables|describe` get `--schema <name>`; HELP text mentions it.
  - Claude access levels unchanged (Off hides, Schema refuses `query`).
- [ ] Tests first: command-level tests (pattern of `commands/connections.rs` tests, skip without env): `list_databases_for` Postgres form; `list_schemas`; `udb query` via `cli/server.rs` test helpers on Postgres uses active schema `billing` so `select * from invoices` works; `query` refused for superuser login (`DB_USER`) and allowed for `reader`; `delete` refused by checker; backup command returns the message.
- [ ] Run, fail, implement, pass; full Rust suite passes.
- [ ] Commit `postgres: commands, Claude and udb`.

### Task 6: Frontend — connection form, start screen, store, API

**Files:** Modify `src/lib/types.ts`, `src/lib/api.ts`, `src/lib/tls.ts` (+test), `src/components/ConnectionForm.tsx`, `src/components/StartScreen.tsx`, `src/store/app.ts`; create `src/lib/engine.ts` (+ `engine.test.ts`).

**Interfaces:**
- Produces in `src/lib/engine.ts`: `isServer(e: Engine): boolean` (mysql|postgres), `quoteIdent(e: Engine, name: string): string`, `engineLabel(e): 'MySQL'|'SQLite'|'PostgreSQL'`, `defaultPort(e): number|null` (3306/5432/null), `sqlDialectName(e): 'mysql'|'postgresql'|'sqlite'`.
- `api.listSchemas(id, database)`, `api.setActiveSchema(id, schema)`; `selectPage/count/execute/applyChanges/commonValues/structure/objects/schemaGraph` pass `schema` (and `unlocked` where Task 5 added it).
- Store: per connection `schemas: string[]`, `schema: string | null` (default rule from spec), `setSchema(id, schema)` (calls `setActiveSchema`, refreshes objects); per tab `writesUnlocked: boolean` (never persisted), `unlockWrites(tabId)`, cleared on tab close.
- Replace `engine === 'mysql'` checks that mean "server engine" with `isServer`, quoting with `quoteIdent`.
- ConnectionForm: third engine card "PostgreSQL / Server connection", port default 5432, TLS + warning, database picker (Task 5 `list_databases_for`). StartScreen badge `Pg` with its own color token (blue-teal, not red).
- [ ] Tests first: `engine.test.ts` for all helpers; `tls.test.ts` Postgres remote → Verify default and warning; store test: unlock tab A, tab B still locked, close A → flag gone.
- [ ] Implement; vitest + tsc pass. Commit `postgres: frontend connection and store`.

### Task 7: Frontend — sidebar schema, tabs, filters, editor, ⌘K, unlock UI

**Files:** Modify `src/components/{Sidebar,TabBar,Header,DataTab,QueryTabView,FilterBar,FilterInput,CommandPalette,BackupMenu,DiagramPane,ConnectionChips}.tsx`, `src/lib/{filters,filterComplete,fieldValues,diagram,paletteSearch}.ts` (+tests).

**Interfaces:** Consumes Task 6 helpers and store.

- Sidebar: schema `<select>` (`data-testid="schema-picker"`) above the table filter, hidden when `schemas.length <= 1`.
- Tab title: `table` for `public`, `schema.table` otherwise; table tabs store `schema`.
- Filters: Postgres quoting; "contains" uses `ILIKE`, and `::text` cast for non-text columns; `filterComplete` and `FilterInput` use the `PostgreSQL` CodeMirror dialect.
- SQL editor: `PostgreSQL` dialect, `formatSql` language `postgresql`.
- ⌘K: columns/tables from `schema_columns` keys (`schema.table`); picking one sets the sidebar schema and opens the table.
- BackupMenu: hide backup/restore for Postgres.
- Unlock UI on prod Postgres tabs (data and SQL): a lock pill in the tab toolbar `Read-only (prod)` with button `Unlock writes` (`data-testid="unlock-writes"`) → confirm dialog `Allow changes to <connection> / <database> in this tab? Other tabs, Claude and udb stay read-only.` → pill turns to `Writes unlocked` (danger color). Edit controls in the grid are disabled while locked, with a tooltip saying why.
- [ ] Tests first: `filters.test.ts` Postgres contains → `"name"::text ILIKE '%x%'`, quoted mixed-case column; `paletteSearch` finds `billing.invoices` for `inv`; a component test that the schema picker is hidden with one schema and shown with two.
- [ ] Implement; vitest + tsc pass. Commit `postgres: frontend browsing and unlock`.

### Task 8: End-to-end check, docs, PR

- [ ] Restart bridge + web (`preview_start` bridge 1421, web 1420). In the dev browser, against the test container: create a Postgres connection (local, then the same as `prod`), switch schema, open `"Orders"`, filter, sort, count, edit a row (local), run SQL, cancel `select pg_sleep(30)`, ⌘K `invoices`, Claude/`udb` refusal as superuser. On the prod copy: edit is blocked, unlock works only in that tab. Fix what breaks; add a test for each bug found.
- [ ] README: Postgres in the feature list and connection section; note on prod lock and the superuser rule.
- [ ] Full suites pass: vitest, tsc, `zsh scripts/test-rust.sh`.
- [ ] Whole-branch review by a fresh reviewer on the most capable model; fix findings.
- [ ] Push `feat/postgres`, open PR to `main` (body: summary, safety section, test plan, screenshots). Do not merge.
