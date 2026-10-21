# Rowline

A fast, native-feeling desktop client for **MySQL** and **SQLite**, built for macOS first.
Browse and edit tables, write SQL, back up a database, and ask Claude questions about your data —
in one small app that opens instantly.

Built with Tauri 2 + Rust (backend) and React + TypeScript (frontend).
Design notes: [docs/design.md](docs/design.md), [docs/plan.md](docs/plan.md).

## Install

There is no prebuilt download yet, so build the app from source.
Requirements: macOS, Rust (stable, 1.90+), Node 22+.

```bash
git clone https://github.com/kemolife/rowline.git
cd rowline
npm install
npm run tauri build -- --bundles app   # → src-tauri/target/release/bundle/macos/Rowline.app
cp -R src-tauri/target/release/bundle/macos/Rowline.app /Applications/
```

The build is not code-signed. On first launch, use right-click → Open if macOS blocks it.

The Claude panel needs [Claude Code](https://claude.com/claude-code) installed and logged in. Everything else works without it.

## Features

### Connections

- MySQL (host, port, user, password, default database, TLS: Off / Required / Verify) and SQLite files.
- Environment tag — Local, Dev, Staging, Production — shown as a colored badge in the header.
  A Production connection gets a red frame around the whole window, and its writes always ask for confirmation.
  The Review changes dialog shows the environment, connection and database the SQL will run on.
- **Projects**: give a connection a project (connection form → *Project*). The connection list is grouped by
  project; in the rail, a project's connections sit together under a colored badge, with a stripe in the
  project color; the header shows the project too. Colors come from the name, nothing to set up.
  Without a project, Rowline guesses one: connections whose names start with the same word (`2solar dev`,
  `2Solar-prod`) or that open the same database are grouped (at least two). Guessed projects have a dashed badge;
  *Use* in the connection form keeps the guess.
- The connection list shows one card per project (fold it up with the header): connections sorted Production first,
  host · user · database, when each was last opened, and the last one used has a dark Connect button.
  *New project* picks a name and its connections; drag a connection onto another project to move it;
  the ⋯ of a project renames it, ungroups it, or keeps a guessed project.
- Several connections open at once. The connection rail on the left switches between them (`⌘1`…`⌘9`);
  each one keeps its own tabs, query text and Claude chat.
- Right-click a connection in the rail to edit, rename or disconnect it, or click its label in the header.
  Changing how it connects offers a reconnect; open tabs stay.
- Survives laptop sleep: a MySQL connection that died while the Mac slept is checked and replaced
  before the next query.

### Browse and edit data

- Canvas data grid that stays smooth with large pages; paging and sort by header click.
- Headers show PK / FK badges, the sort arrow and a short type. NULL is a faint dash, 0/1 columns are checkboxes,
  weekday columns get a Mon/Tue hint.
- Foreign keys: click the ↗ in a cell (or ⌘-click the cell) to open the related row in a new tab;
  the right-click menu can also open it in the same tab.
- Filters without SQL: `+ Filter` adds a chip (column, operator, value — `=`, `contains`, `IN`, `BETWEEN`, `IS NULL`…),
  plus an ORDER BY chip. The `SQL` button switches to a raw `WHERE` box with autocomplete. Filters are kept with the tab.
- Edit cells in the grid or in the row panel; add and delete rows; undo / redo (`⌘Z` / `⌘⇧Z`).
- `⌘S` shows the exact SQL first and applies all changes in one transaction.
- **Virtual foreign keys**: Structure → *+ Virtual foreign key*, or *Save* on a guessed relation in the diagram.
  They work like real foreign keys: ↗ jumps, referencing rows, the diagram, JOIN completion and Claude.
- **Referencing rows**: the row panel lists the tables that point to the selected row (*Referenced by*), and the
  right-click menu of a key cell has *Rows in …*; one click opens those rows, filtered.
- Select several cells: count, sum, average, min and max show at the bottom right.
- Row panel: a compact field list, edited in place; changed fields are marked. The `⋯` menu of a field sets
  NULL, DEFAULT, EMPTY, NOW() (set by the database), PRETTY (format JSON) or Load from file….
- Sidebar: pinned tables (★), recent tables, and tables grouped by name prefix (`agenda_*`); long names are cut
  in the middle so the end stays readable.
- Right-click a cell: copy value, copy row as JSON, filter by value (= / ≠ / IS NULL), set NULL, delete row.
- Data | Structure in the same tab: columns, indexes, foreign keys, DDL.
- Export CSV / JSON.

### SQL

- Editor with schema autocomplete; ▶ next to every statement runs just that one; Beautify (`⌘I`).
- Run the statement at the cursor (`⌘↵`), run all (`⌘⇧↵`), run a selection, cancel (`⌘.`); a row limit per tab.
- Completion like PhpStorm: only what fits where the cursor is — statement words at the start (`SE` → SELECT),
  tables after FROM / JOIN, columns of the query's tables after SELECT / WHERE / ON / BY, `alias.` → its columns.
  Tab or Enter takes the highlighted one; what you pick often moves up.
- `JOIN ` suggests tables related to the ones in the query, with the ON part (foreign keys, virtual and guessed).
- Warnings while you type: unknown tables and columns, `UPDATE` / `DELETE` without `WHERE` (running one asks first).
- Every run is kept while the tab is open: step back to an earlier result without running the query again.
- See a result as Grid, Fields (records side by side, for wide tables), JSON or Text. Copy or export it as CSV, TSV, JSON, Markdown, SQL INSERT or a text table.
  **Copy for Claude** copies the query and a Markdown table (max 50 rows); **Ask Claude** puts it into the Claude panel.
- Sidebar tabs: **Items** (tables and views), **Queries** (saved queries of this connection),
  **History** (queries you ran — click one to open it again).
- `⌘S` in a SQL tab saves the query by name, `⌘⇧S` saves a copy.

### Backup and restore

From the `⋯` menu in the header, with progress and Cancel.

- **MySQL:** a plain `.sql` file written by Rowline itself — no `mysqldump` needed. Structure, data, views,
  triggers and routines from one consistent snapshot. Restore runs a `.sql` file.
- **SQLite:** a safe copy made with SQLite's own online backup; restore copies a backup back.
- A cancelled or failed backup leaves no half-written file.

### Relation diagram

Sidebar → **Diagram** → *Open relation diagram*.

- Tables with their key columns (max 12 per box) and their relations, laid out automatically. Zoom, pan, drag
  tables, minimap. Zoomed out below 85%, boxes show only the table name. Tables without relations are hidden
  (search still finds them).
- While a diagram is open, the sidebar shows its **outline**: find a table, tables grouped around the most linked
  ones (each group has a colour, also on the boxes), and the selected table with its relations.
- Big databases (more than 120 linked tables) start in **focus mode**: pick one of the most linked tables or search;
  it is shown with the tables it links to, and *Show related tables* adds more. *Show all* is still there (slow).
- **By name**: show only tables like `tbl_*` (prefix), `*_log` (suffix) or any part of the name. Common prefixes
  and suffixes are offered on the start card; in the outline, type a pattern and click *Show only … matching tables*.
  *Show related tables* on a table adds the tables it links to.
- Lines are curved; the ends show the relation type: open circle = many (the foreign key side), filled circle = one.
- **Guessed relations**: old schemas often have no foreign keys, so `customer_id` → `customers.id` and
  `ds_person_id` → `ds_person.ds_person_id` are drawn as dashed lines (can be turned off). *Save* in the outline
  makes one a virtual foreign key.
- Hover or click a table: its relations and their columns light up, the rest fades. Double-click opens the data.
- **Ask Claude** (outline button, or select tables or lines with ⇧-drag): ready-made questions or your own; the
  selected tables, columns and relations go along as context. With a project folder, Claude can also read your
  models and migrations.
- **Schema changes**: *Mark as seen* saves a snapshot (the last 5 are kept). Later, new tables and columns show
  in green, dropped ones in red, changed ones in amber — on the diagram and in the sidebar.

### Command line for agents (`rowline`)

Let Claude Code (or any agent, script or terminal) check data through Rowline, read-only, without ever
seeing a password. Typical use: the agent reads the code for a bug ticket, writes a SELECT, runs it itself.

Install once: **Command line** at the bottom of the start screen (or *Install the rowline command* in `⌘K`).
It links `~/.local/bin/rowline` to the app; add `~/.local/bin` to your `PATH` if it is not there.

```bash
rowline connections                                   # open connections: name, environment, engine, database
rowline tables --conn "prod core"                     # tables with row estimates
rowline describe orders --conn "prod core"            # columns, indexes, foreign keys
rowline query --conn "prod core" "SELECT id, status FROM orders WHERE id = 42"
rowline query -f table -n 20 "SELECT …"               # json (default), table or csv; --db to pick a database
```

- Talks to the running app over a Unix socket that only your user can open
  (`~/Library/Application Support/app.rowline.desktop/rowline.sock`). Rowline must be running.
- Only connections that are **open in the app** can be used; close one and the agent loses it.
  A unique part of the name is enough, and `--conn` is optional with one open connection.
- The database is the one selected in the app, unless `--db` says otherwise.
- **Read-only, on every connection**: one SELECT / SHOW / DESCRIBE / EXPLAIN / WITH … SELECT statement.
  Writes, several statements, `INTO OUTFILE`, `FOR UPDATE`, `LOAD_FILE` and the like are refused before they
  reach the database (exit code 2), and the query runs in a read-only transaction with a 30 s limit.
- At most 200 rows by default (`--limit`, up to 1,000); long text values are cut to 2 KB.
- Every query, blocked ones too, shows up in the connection's **History** with a *CLI* mark.
- Exit codes: 0 ok, 1 error, 2 refused, 3 Rowline is not running. `rowline help` explains it all.

To tell Claude Code about it, add to your project's `CLAUDE.md`:

```
To check data in the database, use the `rowline` command (read-only; run `rowline help` first).
```

### Claude panel (`⌘L`)

Ask questions about your data in plain language. Rowline uses the Claude Code you already have installed
and its login — no API key.

- Claude can only read. Every query runs in a read-only transaction (MySQL) or on a read-only
  connection (SQLite), max 200 rows, 30 s.
- On Production connections Claude's queries wait for your approval.
- Per connection you choose what Claude may see: schema + data, schema only, or off.
- Optional project folder per connection that Claude may read (Read, Grep, Glob only — nothing else,
  nothing outside that folder).
- Query cards in the panel have *Open in grid* (runs it) and *Open in SQL tab*.
- Claude Code is found in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`
  or through your login shell. Set `ROWLINE_CLAUDE_BIN` to use another binary.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `⌘K` / `⌘P` | Quick open |
| `⌘T` | New SQL tab |
| `⌘W` | Close tab |
| `⌘B` | Toggle sidebar |
| `⌘L` | Claude panel |
| `⌘1` … `⌘9` | Switch connection |
| `⌘↵` / `⌘⇧↵` | Run statement / run all |
| `⌘.` | Cancel running query |
| `⌘S` | Review and apply changes (data) · save query (SQL) |
| `⌘I` | Beautify SQL |
| `⌘⌫` | Mark selected rows for deletion |
| `⌘⇧S` | Save query as copy |
| `⌘Z` / `⌘⇧Z` | Undo / redo edits |
| `⌘R` | Refresh data |
| `⌘F` | Focus the `WHERE` filter |

## Where your data lives

Everything stays on your Mac, in `~/Library/Application Support/app.rowline.desktop/`:

| File | What |
| --- | --- |
| `connections.json` | Saved connections (no passwords) |
| `secrets.json` | Passwords, readable only by your macOS user (`0600`) |
| `queries.json` | Saved queries |
| `history.json` | Query history |
| `virtual_keys.json` | Virtual foreign keys |
| `schema-snapshots/` | Schema snapshots for the relation diagram's change view |
| `rowline.sock` | Socket for the `rowline` command while the app runs (`0600`) |

## Develop

Requirements: Rust (stable, 1.90+), Node 22+.

```bash
npm install
npm run tauri dev          # desktop app with hot reload
```

UI in a normal browser (handy for testing): the dev bridge exposes the same backend commands over HTTP on
`127.0.0.1:1421`. It uses its own config folder and password file, never the app's data.

```bash
npm run devserver          # terminal 1: backend bridge
npm run dev                # terminal 2: http://127.0.0.1:1420
```

Test the Claude panel without using your plan: `ROWLINE_CLAUDE_BIN="$PWD/scripts/fake-claude.sh" npm run devserver`
replays a recorded answer.

### Project layout

| Path | What |
| --- | --- |
| `src/` | React frontend: `components/`, `store/` (Zustand), `lib/` (API client, helpers) |
| `src-tauri/src/commands/` | Backend commands, one file per area (connections, data, queries, jobs, files, chat) |
| `src-tauri/src/drivers/` | `mysql/` (session, queries, values, backup) and `sqlite.rs` |
| `src-tauri/src/claude/` | Claude Code runner and the read-only MCP server it talks to |
| `src-tauri/src/readonly.rs` | Read-only SQL check used for Claude's queries |
| `src-tauri/src/backup.rs` | Background jobs, `.sql` script splitting, atomic file writes |

All frontend calls go through one entry point, `commands::dispatch`, used by both the Tauri app and the
dev bridge.

## Test

```bash
npm test                   # frontend unit tests (Vitest)
./scripts/test-rust.sh     # Rust tests (SQLite always; MySQL when the test DB in dev/docker runs)
```

MySQL tests run when `ROWLINE_TEST_MYSQL="host:port:user:password:database"` is set.
`scripts/test-rust.sh` sets it from `dev/docker/.env` (not in git). Start the test MySQL once:

```bash
cd dev/docker && docker compose up -d   # MySQL 8.4 on 127.0.0.1:13306 with a small `shop` database
```

## Build

See [Install](#install) for the release build.
