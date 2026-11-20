#!/usr/bin/env bash
# Repeat tests/ask_browser.py with rev-parse stamps per run (evidence for PR10 F-1).
# A count is a canonical ASCII integer from 1 to 32, or omitted for 8.
# Anything else is refused before the log is truncated and before Python starts.
# Refusal is not a clamp. See handoff/decisions/askrunner-count.md.
set -euo pipefail

# Return 0 only when VALUE is an ASCII decimal integer from 1 to MAX.
# [0-9] is evaluated under LC_ALL=C, so fullwidth digits, superscripts, and
# fractions are not digits. An arithmetic failure returns 1 (fail closed).
is_canonical_count() {
  local n=$1 max=$2
  (
    LC_ALL=C
    [[ "$n" =~ ^[1-9][0-9]*$ ]] || exit 1
    [[ ${#n} -le 2 ]] || exit 1
    local value
    value=$((10#$n)) || exit 1
    (( value >= 1 && value <= max )) || exit 1
    exit 0
  )
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${1:-}"
MAX=32
if [[ -z "$LOG" ]]; then echo "usage: $0 <log-file> [count]" >&2; exit 2; fi
if [[ $# -ge 2 ]]; then
  N="$2"
else
  N=8
fi
if ! is_canonical_count "$N" "$MAX"; then
  printf "invalid count: '%s' is not an integer from 1 to %s\n" "$N" "$MAX" >&2
  exit 2
fi
: >"$LOG"
fail=0
for i in $(seq 1 "$N"); do
  rc=0
  {
    echo "=== ask_browser run ${i}/${N} ==="
    echo "HEAD=$(git rev-parse HEAD)"
    echo "TREE=$(git rev-parse HEAD^{tree})"
    date -u +%Y-%m-%dT%H:%M:%SZ
    python3 tests/ask_browser.py || rc=$?
    echo "exit=$rc"
  } >>"$LOG" 2>&1
  [[ "$rc" -eq 0 ]] || fail=1
done
[[ "$fail" -eq 0 ]] || exit 1
