#!/usr/bin/env bash
# Red-first: fixed stop before MIN_BYTES (ASK_BROWSER_RED_DEMO=1 uses 120 ms gate).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export ASK_BROWSER_RED_DEMO=1
set +e
python3 tests/ask_browser.py >/tmp/ask-browser-red-demo.out 2>&1
code=$?
set -e
if [[ "$code" -eq 0 ]]; then
  echo "expected failure with ASK_BROWSER_RED_DEMO=1" >&2
  tail -30 /tmp/ask-browser-red-demo.out >&2
  exit 1
fi
echo "red demo: exit $code (expected nonzero with 120 ms gate vs MIN_BYTES=4800)"
exit 0