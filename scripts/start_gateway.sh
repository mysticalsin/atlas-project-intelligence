#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Only source an operator-owned .env that you have inspected.
# The process calls spend.require_ledger before it binds a port. Off is refused unless
# this process binds to loopback with ATLAS_AUTH=local and no paid upstream is configured.
if [[ -f .env ]]; then set -a; source .env; set +a; fi
if [[ "${LEDGER_MODE:-}" == "off" ]]; then
  bind="${ATLAS_BIND:-}"
  case "$bind" in
    127.0.0.1|localhost|::1) ;;
    *) echo "LEDGER_MODE=off is refused unless ATLAS_BIND is loopback." >&2; exit 1 ;;
  esac
  if [[ "${ATLAS_AUTH:-}" != "local" ]]; then
    echo "LEDGER_MODE=off is refused unless ATLAS_AUTH=local." >&2
    exit 1
  fi
fi
exec "${PYTHON:-python3}" -m atlas_voice.server
