# Tabula — implementation plan (v1)

Each step ends with tests passing and a short manual check.

1. **Scaffold** — Vite + React 18 + TS, Tauri 2 (`src-tauri`), Tailwind 4, lint/format basics, git.
2. **Core types + sqlgen** (TDD) — identifier quoting per dialect, `select_page` SQL with filter/sort/limit,
   `UPDATE/INSERT/DELETE` builders with bound params, statement splitter for the SQL editor.
3. **SQLite driver** (TDD with temp DB) — objects, structure, page, count, execute, apply_changes (transaction).
4. **MySQL driver** — same trait, text protocol, cancel via `KILL QUERY`; integration tests against Docker.
5. **Store** — connections.json (no passwords), secrets.json (0600) for passwords, query history.
6. **Commands + dev bridge** — Tauri commands; `devserver` feature with axum `POST /api/:cmd`.
7. **UI shell** — tokens/theme (light+dark), header with connection pill, sidebar, tabs, start screen,
   connection form (MySQL / SQLite file), connect flow.
8. **Data tab** — Glide grid, paging, sort, WHERE filter, Data|Structure toggle, row panel.
9. **Editing** — pending change store (Vitest), cell edit, add/delete row, review-SQL dialog, ⌘S/⌘Z.
10. **Query tab** — CodeMirror with schema autocomplete, run current/all, multiple results, cancel, history.
11. **Polish** — ⌘K palette / ⌘P quick open, export CSV/JSON, prod safety confirm, empty/error states.
12. **Verify + package** — browser E2E through the dev bridge, `tauri build` → `Tabula.app`.
