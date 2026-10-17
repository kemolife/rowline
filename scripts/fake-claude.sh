#!/bin/sh
# Test stand-in for `claude -p --input-format stream-json`: answers every input line with a recorded reply.
case "$1" in --version) echo "0.0.0 (fake Claude Code)"; exit 0 ;; esac
# Tests set ROWLINE_FAKE_CLAUDE_PIDFILE to learn the process id (to check that Rowline kills it).
if [ -n "$ROWLINE_FAKE_CLAUDE_PIDFILE" ]; then echo $$ > "$ROWLINE_FAKE_CLAUDE_PIDFILE"; fi
FIXTURE="${ROWLINE_FAKE_CLAUDE_FIXTURE:-$(cd "$(dirname "$0")" && pwd)/../src-tauri/tests/fixtures/claude/hello.jsonl}"
while IFS= read -r _line; do
  cat "$FIXTURE"
done
