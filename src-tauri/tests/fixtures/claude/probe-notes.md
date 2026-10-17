# Claude CLI probe notes (claude 2.1.296, 2026-10-15)

## Step 2: stream-json answer (hello.jsonl)
- Command exactly as in brief; `--setting-sources ""` was ACCEPTED (exit 0). Task 9 uses `--setting-sources ""`.
- Process ended by itself after one answer (stdin closed). 12 lines.
- Top-level `"type"` values seen: `system`, `stream_event`, `assistant`, `rate_limit_event`, `result`.
  - `system` subtypes: `init` (has `session_id`, `tools`, `model`, `cwd`, `permissionMode`, `mcp_servers`, ...), `status`, `post_turn_summary`.
  - `stream_event` inner `event.type`: message_start, content_block_start, content_block_delta (text_delta), content_block_stop, message_delta, message_stop.
  - Line order: system/init, system/status, stream_events..., assistant, ..., rate_limit_event, system/post_turn_summary, result.
- A raw `grep -o '"type":"..."'` also counts nested types (message, text, text_delta, content_block_*, message_*); those are not top-level.
- `result` line: subtype `success`, `is_error`: false (present), `duration_ms`: 6234 (present), `total_cost_usd`: 0.02522 (present), `result`: "Hello from Claude", also `session_id`, `usage`, `permission_denials`, `terminal_reason`.

## Step 3: folder-scoped read
- Flags as in brief (`--tools Read,Grep,Glob --allowedTools "Read(/$P/**)"`, cwd = $P).
- in.txt WAS read ("inside"). The outside file was NOT read: Read returned an error ("permissions to read from .../rowline-outside.txt, but you haven't granted it yet", tool_result `is_error":true`), `result.permission_denials` listed the Read of the outside path, and the final answer said permission was denied.
- The word "outside" in the grep output came only from paths/messages, not from file content.
- The folder restriction holds (in -p mode with no prompt, unlisted reads are denied).

## Step 4: two messages in one process
- Result lines counted: 2. Second answer was "42" (context kept). One process handles several user messages on stdin.

## Step 5: MCP allow-rule format
- `claude --help` shows `--allowedTools, --allowed-tools <tools...>`: "Comma or space-separated list of tool names to allow (e.g. "Bash(git *) Edit")".
- Help does NOT document the `mcp__<server>` (whole server) form. Not confirmed here; Task 9 uses `mcp__rowline`, Task 13 must confirm in the live run.
