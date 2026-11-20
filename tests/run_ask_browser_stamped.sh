#!/usr/bin/env bash
# Repeat tests/ask_browser.py with rev-parse stamps per run (evidence for PR10 F-1).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${1:-}"
N="${2:-8}"
if [[ -z "$LOG" ]]; then echo "usage: $0 <log-file> [count]" >&2; exit 2; fi
: >"$LOG"
for i in $(seq 1 "$N"); do
  {
    echo "=== ask_browser run ${i}/${N} ==="
    echo "HEAD=$(git rev-parse HEAD)"
    echo "TREE=$(git rev-parse HEAD^{tree})"
    date -u +%Y-%m-%dT%H:%M:%SZ
    python3 tests/ask_browser.py
    echo "exit=$?"
  } >>"$LOG" 2>&1 || true
done