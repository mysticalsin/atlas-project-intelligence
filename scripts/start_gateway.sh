#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Only source an operator-owned .env that you have inspected.
if [[ -f .env ]]; then set -a; source .env; set +a; fi
exec "${PYTHON:-python3}" -m atlas_voice.server
