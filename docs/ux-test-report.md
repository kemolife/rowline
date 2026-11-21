# Rowline UX test report

Tester view: new user, first time in the app. Tested in the built-in browser pane with the HTTP bridge.
Data: MySQL `shop` (docker test container) and the `filter-test` SQLite connection (not opened, see "Not tested").
No code changed. No edits saved to the database (I checked: no row has `note = 'UXTEST'`).
I created one saved query "UXTEST sleep". Delete worked at the last try (see note in issue 14).

Window sizes used: 1400x880 (the app's default window), 1024x768 (the pane's own size), 768 and 375 wide.
The app's `tauri.conf.json` says min window is **960x600**, so 1024 and 960 wide are real sizes users can have.

Severity: **blocker** = user cannot do the task. **annoying** = user can work around it. **polish** = small.

---

## Top issues (ordered by impact)

| # | Severity | Issue |
|---|----------|-------|
| 1 | blocker (at ≤1100 px wide) | Data toolbar: **Columns** and **Row details** buttons are hidden under the Row details panel |
| 2 | annoying | **Diagram / Schema changes** shows 14 "removed" `rowline_*` tables that are not in `shop` and drowns the real tables |
| 3 | annoying | After switching database, an open table tab still shows the **old database's data** under the new database name |
| 4 | annoying | Dialogs (New / Edit connection) are **taller than the window**: title and Save/Cancel are cut off, no scroll |
| 5 | annoying | Sidebar row counts are **wrong** (`customers 93`, real 500; `orders` real 5,000) and look exact |
| 6 | annoying | Data footer: texts **overlap** (row count, "1 selected", Delete row, Discard, Save) |
| 7 | annoying | Start screen: the "⋯" menu of a connection is **hidden behind the next project card** (only "Edit" is visible, "Delete" is not reachable) |
| 8 | annoying | **Run all** stops on the first error and shows only the error. Results of earlier statements are lost |
| 9 | annoying | WHERE (SQL filter) box is **not focused** after you click "SQL"; typing goes nowhere; **Esc** after Cancel erases what you typed |
| 10 | polish | **Esc / Enter** do not work in the two search boxes (start screen search, sidebar table filter) |

---

## Issues in detail

### 1. Columns and Row details buttons unreachable at ~1024 px (blocker at that width)
- **Where:** Data tab, toolbar. Any table. Window ≈ 1024 px wide (app minimum is 960).
- **Steps:** Open `customers`. Look at the toolbar. The Row details panel is open by default.
- **What happened:** Buttons "Sort", "Columns" and "Toggle row details" are drawn *under* the Row details panel. `elementFromPoint` on the Columns button returns the page container, not the button. The visible toolbar ends with a cut "S…". The user cannot hide columns and cannot close the Row details panel with the mouse.
- **Expected:** Toolbar wraps, shrinks (icon only), or the panel does not cover it. The user must always be able to close the panel.
- **Fix idea:** Make toolbar `flex-wrap`/`overflow-x: auto`, or collapse labels to icons under ~1100 px. Auto-close Row details when the window is narrow. Add a close "×" in the Row details header.
- Note: at 1400 px wide everything fits. Many laptops give less than that for the content area (sidebar + 370 px panel).

### 2. Diagram and "Schema changes" mix in tables from another database
- **Where:** Sidebar tab "Diagram", and the Relations tab.
- **Steps:** Connect to docker-mysql (db `shop`). Open the "Diagram" sidebar tab.
- **What happened:** "Schema changes: since 21/10/2026 −14 tables", all `rowline_*` tables marked "removed" (red, struck through). They are not in `shop`. Open relation diagram: "14 of 18 tables", the 14 ghost tables fill the canvas and the 2 real tables (`orders`, `customers`) are tiny in the top-left corner at 45 % zoom. The left list also groups by prefix (ROWLINE_COMPANY_PRODUCT …) so the real tables are at the bottom.
- **Expected:** The change list only for the current database, or at least a clear way to see it is old data. Real tables first.
- **Fix idea:** Key the saved schema snapshot by connection + database. Default "Changes since" to off or "Mark as seen". Fit-to-view on open should focus on current (non-removed) tables.
- Note: I cannot tell how this snapshot was created (earlier connection settings?). It may be only my test data, but a new user could get the same after changing the database of a connection.

### 3. Switching database does not close or rename open tabs
- **Where:** Sidebar database picker.
- **Steps:** Open `orders` (shop). Pick `information_schema` in the picker.
- **What happened:** The top bar changes to `docker-mysql · information_schema · orders` but the grid still shows rows of `shop.orders`. The table list shows 78 information_schema tables. Switch back: fine.
- **Expected:** Tabs belong to one database. Either keep a visible "shop" label on the tab, or close/ask when switching.
- **Why it matters:** the user may edit or delete rows believing they are in another database. Edits go to the old one.
- **Fix idea:** Show database in the tab tooltip/label when it differs from the current one, or have one tab set per database.

### 4. Connection dialog taller than the window
- **Where:** Start screen → "New connection", also "Edit".
- **Steps:** Click New connection at 1024x768.
- **What happened:** The form is 828 px high, top −31 px, bottom 799 px. The title bar and the footer buttons (Test / Cancel / Save) are cut off. The dialog does not scroll (wheel does nothing). I could only close it with Esc. The app's min height is 600 px, so it is worse for small windows.
- **Expected:** Dialog has `max-height: 100vh - margin`, a scrolling body, and a sticky footer.
- **Fix idea:** `max-h-[calc(100vh-48px)] overflow-y-auto` on the body, footer sticky.
- Good: Esc closes it. Password field shows "Saved" when editing.

### 5. Sidebar row counts look exact but are estimates
- **Where:** Sidebar → Tables, number on the active row. Also Diagram list (`customers 93`).
- **What happened:** `customers 93` in the sidebar, 500 rows in the grid footer (`information_schema.TABLE_ROWS` = 93; real `COUNT(*)` = 500). `orders` estimate is 0 (real 5,000). The grid footer is right ("500 rows", "5,000 rows").
- **Expected:** An estimate is marked ("~93") or hidden when stale. Two numbers for the same table confuse people.
- **Fix idea:** Show `~` and a tooltip "estimate from the database"; hide when 0 for a table that has rows; or load the exact count lazily.

### 6. Data footer: overlapping texts
- **Where:** Data tab, bottom bar.
- **Steps:** (a) at 1024 px width open any table; (b) select a row; (c) edit a cell.
- **What happened:** (a) "1–300 of 500" is drawn over the row count text. (b) After selecting a row, "Delete row 302…", "5,000 rows · 1 selected" overlap. (c) After an edit, the footer has "Discard / Save ⌘S" **and** a second "1 unsaved change / Discard / Save" bar in the Row panel area. Same actions twice, texts on top of each other.
- **Expected:** One place for pending changes. No overlap. Shorten texts (drop the duplicate "N rows" when "1–300 of N" is shown).
- **Fix idea:** Truncate with ellipsis, hide "N rows" at narrow width, remove one of the two Save/Discard bars.

### 7. Connection "⋯" menu hidden behind next project
- **Where:** Start screen, first project card ("2Solar").
- **Steps:** Hover the connection row → click "⋯" → menu opens (Edit, Delete).
- **What happened:** The menu is drawn behind the next project card ("Personal"). Only the top of "Edit" is visible. "Delete" is not visible or clickable (a card covers it). I could click the visible edge of "Edit".
- **Expected:** Menu on top of everything (portal, high z-index) or flips up.
- **Fix idea:** Render menu in a portal; or `overflow: visible` + z-index on the open card.
- Also: right-click on a row does nothing (no context menu); the "⋯" only appears on hover.

### 8. Run all hides results before an error
- **Where:** Query tab.
- **Steps:** Type 3 statements; the 3rd uses a table that does not exist (`SELECT * FROM nope`). Click **Run all**.
- **What happened:** One run: "Run 2 of 2 — error". The result area shows only the red error. The history list shows one entry with all SQL. The two good statements ran (28 ms) but no result is shown. Without the bad line, Run all gives "Result 1 / Result 2" tabs (nice).
- **Expected:** Keep results of statements 1–2 and add an error result tab for statement 3 (with the statement text), or ask "stop on error?".
- **Fix idea:** Per-statement result tabs also for failed ones; mark the failing statement in the editor.
- Also: the error text is raw: ``MySQL: Server error: `ERROR 1146 (42S02): Table 'shop.nope' doesn't exist'`` with stray backticks. A nice touch is the warning triangle in the editor gutter for the unknown table before running.

### 9. SQL filter box focus, Cancel and Esc
- **Where:** Data tab → "SQL" button (WHERE filter).
- **Steps:** Click "SQL". Type `SLEEP(0.05) = 0`. Press Enter.
- **What happened:**
  1. The input appears but **focus stays on the SQL button**. My typing was lost, then Enter *closed* the box. You must click the box a second time.
  2. The input is very small (the placeholder is cut: "e.g. `custom…`").
  3. While the query runs, the old rows stay on screen with no dim/spinner (only the Refresh button turns into Cancel). The footer shows the old count.
  4. Esc cancels the load, but also **clears the typed WHERE text**. Cancel button works and keeps the text ("Cancelled. The rows were not loaded." + "Try again").
  5. The "Cancelled" message is red like an error. The footer still says "1–300 of 5,000" for an empty grid.
- **Expected:** Focus the box on open. Dim the grid or show a loading bar while loading. Keep the text on Esc-cancel.
- **Fix idea:** `autoFocus` / `ref.focus()` on open; `aria-busy` overlay; Esc cancels only the request.

### 10. Esc and Enter in search boxes
- **Where:** Start screen "Search connections"; sidebar "Filter tables".
- **What happened:** Esc does not clear the text (typing `filtzzzz`, Esc: still there). Enter in the table filter does not open the first match. No ✕ clear button. (Esc does close dialogs and menus, which is good, so people will try it.)
- **Fix idea:** Esc clears, then blurs. Enter opens the top match, arrows move the selection.

---

## More findings

### 11. Row details panel
- Always open, takes ~370 px, and shows "Select a row to see all its fields" for an empty state. Good for wide screens, heavy for small ones (see issue 1).
- Values are **cut** with no wrap or tooltip (`user6@example.cc`, `2026-10-21 08:23:`). Long text (notes, JSON) would be unreadable. *Fix idea:* wrap or click-to-expand; copy button.
- `is_active` shows `1` in the panel but a checkbox in the grid. Inconsistent (polish).
- Bool checkboxes in the grid look editable (they are), but no hint.
- "Referenced by: orders.customer_id" is a great link. Click opens `orders` filtered by `customer_id = 6` (12 rows of 5,000).

### 12. Sort and filter chips
- Header click sorts text-wise (`1, 10, 100, 101…` for `full_name`). Expected for strings, fine. Tri-state click (asc, desc, none) works. "Sort none" chip next to Filter is clipped to "Sort non" once a chip is added (polish).
- Filter popup: column / operator / value, "Active" checkbox, Enter applies. Chip `country = DE` + footer "100 rows of 500 in table" is very clear (**good**).
- Operator list is long but complete (IS NULL, BETWEEN, IN …). No AND/OR hint (not tested deeply).

### 13. Paging
- Next/prev work (`301–600 of 5,000`). 300/page default, 100/300/1000 options.
- No "page X of Y" and no jump to a page. With 5,000 rows, getting to page 12 is 11 clicks (polish).

### 14. Editing cells
- Double-click a cell, type, Enter: cell turns yellow, a dot appears on the tab, row selection moves down (spreadsheet style). "⌘Z" undoes it. Footer shows Discard / Save ⌘S. Clear, safe (**good**).
- Delete is a "mark for deletion — nothing is deleted until you review and save" (**good**).
- Saved query delete: in the browser, `window.confirm` is used. The first 3 tries did nothing in my pane. After I forced `window.confirm` to true, the query disappeared on the 4th. I think this is a pane limit, not an app bug, but I cannot prove it. The open tab keeps the title of the deleted query ("UXTEST sleep") and shows "Save…" again (OK).

### 15. Structure tab
- Very good: columns with type, nullable, default, keys (PK icon, AI, FK link `→ customers.id`, index), enum chips (`new paid shipped cancelled`), indexes, foreign keys, DDL with Copy, "Virtual foreign key". Counters at top (Columns 6, Indexes 3, Foreign keys 1) work as jump links.
- **Keys** toggle: filters columns to 2 of 6 and *also* filters the Indexes and Foreign keys tables. After the toggle, "Copy names" and "View data" appear. "View data" opens the Data tab with only those columns (Columns 2/6). Nice, but "View data" shows only when a filter is on, so it is hard to find. Fix idea: always show "View data".
- The hidden-columns state stays on that Data tab ("Columns 2/6") until you open the Columns menu and click "Show all". It is easy to forget why some columns are missing.
- **Columns menu** ("Hide all / Show all / Only keys", search, counter `2 of 6 shown`): good. "Hide all" still keeps the primary key. The label is a small lie (polish).

### 16. Query tabs
- Good: ⌘T new tab, ⌘↵ run statement at cursor, Run all, Cancel (⌘.), row limit picker (5,000), Beautify, Save…, History, `.sql` import/export. Results: Grid / Fields / JSON / Text, Copy, Export, "Ask Claude", `N rows · ms`. Result tabs per statement. Every run is kept ("Run 4 of 4" menu with time and status) (**good**).
- A cancelled `SELECT SLEEP(30)` shows as a normal success with `SLEEP(30) = 1` after 8,105 ms. MySQL returns 1 when interrupted, but the UI says nothing about "cancelled" (annoying for a user who clicked Cancel). Also "Running… the result is added as a new run." is a tiny line at the very bottom, far from the Cancel button, with no timer.
- Saved queries: Save… dialog is clear, toast "Saved … to Queries", tab renamed. Context menu: Open / Rename / Copy SQL / Delete.
- Tab context menu: Close, Close others, Close tabs to the right, Close all. No Rename or Duplicate (polish).
- Tab drag to reorder: works (orders moved before customers).
- History pane: SQL list with time, duration, db, CLI badge, "Blocked" reasons in red (nice). The 240 px column wraps meta text into 3 lines (`21 Oct 12:58 · 7 ms · 1 row · sh…`), cut off. One click opens the SQL in a **new** tab each time (many clicks = many tabs). It does not run it. *Fix idea:* single line meta, tooltip, reuse the empty tab.

### 17. ⌘K command palette
- Works: tables, views, "New query ⌘T", "Toggle sidebar ⌘B", "Refresh tables", Theme, Install the rowline command, Disconnect, "Switch database: …".
- The top (selected) item is `active_customers` (alphabetical), not the table I am on or recent ones. No actions for Diagram, History, Saved queries, Structure of the current table. "Theme: switch to system" cycles but there is no feedback (dark→system looked the same, no toast). *Fix idea:* sort recent first; show a toast with the new theme; add the missing view actions.
- The "Disconnect" action sits next to harmless actions.

### 18. Sidebar
- Table filter works (also finds views: `cust` → `active_customers`, `customers`). Shows "MATCHES 2".
- Pin works (star on hover). But a pinned table then shows **three times**: PINNED, RECENT and TABLES. Recent with 1–2 items just repeats the list below. *Fix idea:* hide pinned/recent items from the other lists, or show Recent only after 3+ items.
- The "Tables" count and views section are clear. Database picker is a native `<select>` (fine). It lists `information_schema` and `performance_schema` with the same weight as `shop` (polish).
- Top bar icons without text: sparkle (Claude panel), "⋯" (More actions: **Backup database… / Restore database…**), exit arrow (Disconnect). Tooltips exist. "Restore database…" next to a harmless menu with no hint that it is destructive (I did not click it).

### 19. Start screen
- Clear: projects as groups, tags (Dev / Local), search, "New project", "New connection". Search shows "No connection matches …". 
- The same connection `docker-mysql` shows twice (under "2Solar" and under "No project") with the same host/port. A new user cannot tell which is which or why. *Fix idea:* mark duplicates, or show a "also in …" hint. (May be only my test data.)
- Every connection says "Never" for last used even after use (I came back to this screen only through the first load, so it may be correct). Not re-checked after disconnect.
- Long SQLite path is cut in the middle of the line and not selectable by a tooltip (not checked).
- "Drag a connection onto a project to group it" is a good hint, but only visible in the "No project" group.

### 20. Themes and narrow windows
- Light theme (system emulation): clean, grid and diagram both fine. Theme follows the system; I could not find a direct "Light/Dark" choice besides the start-screen footer button ("Dark") and the palette cycle.
- **768 px wide:** sidebar + Row details (≈370 px) leave ~100 px for the grid. The connection chip text is cut to `docker-mysql · shop · or…`.
- **375 px wide:** sidebar takes the full width, the main area is pushed off-screen to the right, the connection chip and badges overlap the toolbar icons. No layout for small screens (the app's min is 960, so this is polish for desktop users, but it shows how fixed the widths are).

---

## What felt good
- Fast connect, clean dark UI, clear colors for environment (DEV tag, project tag in the top bar).
- Filter chips and "100 rows of 500 in table"; "Referenced by" link in Row details; FK arrows in cells.
- Structure tab: complete and well organized (enum chips, FK links, DDL copy, counters).
- Columns menu with search and presets.
- Safe editing: yellow cell, tab dot, ⌘Z, Discard, "mark for deletion — nothing is deleted until you review and save".
- Cancel exists for both grid loading and query run; Esc and ⌘. work.
- Query runs are kept ("Run 4 of 4"), per-statement result tabs, "Blocked" history with reasons.
- Saved queries with toast and tab rename. Tab drag reorder, tab context menu.
- Command palette with shortcuts shown.
- Read-only protection in History ("Only read-only queries are allowed…" for CLI), good for agents.

## Not tested / limits
- SQLite connection `filter-test`: not opened. Only MySQL was clicked through. SQLite may behave differently.
- Real native dialogs: delete confirm uses `window.confirm` in the browser. The Tauri `ask` dialog was not tested.
- "Mark as seen" in Diagram, Virtual foreign key, Backup / Restore, Export CSV/JSON, Ask Claude panel, the `rowline` command install: not clicked.
- Keyboard shortcuts checked: ⌘K, ⌘T, ⌘B, ⌘↵, ⌘., ⌘Z, Esc. Not checked: ⌘F, ⌘R, ⌘S, ⌘⌫ (they appear in tooltips).
- Pane size is fixed at 1024x768, so "1024 px" findings (1, 6) were checked there. At 1400x880 they were fine.
- No screenshots are saved in the repo (this report is the only file created). Screenshots were taken during the session for issues 1, 3, 4, 6, 7, 2.
