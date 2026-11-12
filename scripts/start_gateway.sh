#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Only source an operator-owned .env that you have inspected.
# The process calls spend.require_ledger before it binds a port. Off starts only when
# ATLAS_LEDGER_DEV is 1, dev or test. A missing ATLAS_LEDGER_URL or ATLAS_LEDGER_TOKEN refuses.
if [[ -f .env ]]; then set -a; source .env; set +a; fi
exec "${PYTHON:-python3}" -m atlas_voice.server
