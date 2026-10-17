# Claude panel — follow-ups after review (2026-10-15)

## Done (follow-up round)
- Project folders that contain the home folder or Tabula's settings folder (e.g. `/Users`, `~/Library`) are refused;
  the folder is checked again each time Claude starts (covers paths saved earlier).
- MCP: constant-time token compare; requests with an `Origin` header refused (403); the token moved out of argv
  into a 0600 file (`claude-mcp/<chat>.json`, folder 0700, deleted on close and at app exit); unknown chats get an
  error without touching chat state; a second server start fails.
- Content Security Policy set in `tauri.conf.json` (smoke-tested: grid, SQL editor, query run, Claude chat).
- ⌘L toggles the Claude panel even inside the SQL editor.
- Claude Code errors: "limit" only for plan/rate limits (not context limits); an empty error result shows its subtype.
- Runner: no double "exited" after a failed write; a replaced process can't report "exited" into the new one.
- MySQL MAX_EXECUTION_TIME (error 3024) reported as the same timeout message.
- UI: double-click connect runs once; palette closes on switch/launcher; poll retries back off to 10 s;
  unfinished tool cards say "Not finished"; "+ connection" closes its menu on a second click; resize listeners
  are removed if the panel closes mid-drag.

## Still open (none blocks use)
- Live run with the real Claude Code: whole-server allow rule `mcp__tabula`, Claude Code sends no `Origin`
  header, reading a project folder whose name has a space, a Production approval waiting > 60 s.
- Read-only check: side-effect reads (SLEEP, GET_LOCK, BENCHMARK) are only time-limited; MySQL sql_modes
  NO_BACKSLASH_ESCAPES / ANSI_QUOTES are not modelled (the read-only transaction still blocks writes).
- Tests: no timeout tests (30 s constant); no end-to-end test with two runners at once; no BLOB truncation test.
- Runner: stdin write happens under the global runners lock (only a problem if the pipe is full).
- Stores: `connecting` is one value (two different connections connecting at once); a stale refresh error toast;
  reconnect within 300 ms may restore stale tabs; autoRun may run twice under React StrictMode (dev only);
  ReviewDialog stays open across ⌘1–9.
- Event log per chat is unbounded (fine for normal chat sizes).
- Docs: shorten long sentences in README / design.md.
