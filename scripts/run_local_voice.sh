#!/usr/bin/env bash
# Talk to ATLAS on this Mac using Cloudflare Workers AI speech (no GPU).
#   bash scripts/run_local_voice.sh      then open http://localhost:8080 in Chrome (headphones recommended)
# The key is read from ~/.config/atlas/workers-ai.key at launch and exported only to this process;
# it is never written into the project folder (which OneDrive syncs). Local mode: loopback, one user.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY_FILE="${WORKERS_AI_KEY_FILE:-$HOME/.config/atlas/workers-ai.key}"
[ -s "$KEY_FILE" ] || { echo "Missing $KEY_FILE (Cloudflare Workers AI token)." >&2; exit 1; }
ACCOUNT="${WORKERS_AI_ACCOUNT:-294885a27b3cc0a1cbe5d0ccbe38de4f}"
KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
code=$(curl -s -o /dev/null -w '%{http_code}' -H @<(printf 'Authorization: Bearer %s\n' "$KEY") \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/ai/models/search?search=nova-3")
[ "$code" = 200 ] || { echo "Workers AI rejected the token (HTTP $code). Re-save it, then retry." >&2; exit 1; }
WAI="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/ai/v1/chat/completions"
export ATLAS_VOICE_PROVIDER=workers ATLAS_AUTH=local ATLAS_BIND=127.0.0.1 ATLAS_PORT=8080 ATLAS_ORIGIN=http://localhost:8080
# This script calls paid Workers AI. Off is not set. The gateway enforces unless a ledger is configured.
if [[ -z "${ATLAS_LEDGER_URL:-}" || -z "${ATLAS_LEDGER_TOKEN:-}" ]]; then
  echo "Paid Workers AI needs ATLAS_LEDGER_URL and ATLAS_LEDGER_TOKEN." >&2
  exit 1
fi
export ATLAS_MAX_INTERVIEWS=1 ATLAS_WIKI_ROOT="${ATLAS_WIKI_ROOT:-$HOME/.local/share/atlas/wiki}"
export WORKERS_AI_ACCOUNT="$ACCOUNT" WORKERS_AI_API_KEY="$KEY" WORKERS_TTS_VOICE="${WORKERS_TTS_VOICE:-harmonia}"
export CONVERSATION_CHAT_URL="$WAI" CONVERSATION_MODEL="${CONVERSATION_MODEL:-@cf/meta/llama-3.3-70b-instruct-fp8-fast}" CONVERSATION_API_KEY="$KEY"
export ANALYST_CHAT_URL="$WAI" ANALYST_MODEL="${ANALYST_MODEL:-@cf/openai/gpt-oss-120b}" ANALYST_API_KEY="$KEY"
unset KEY
mkdir -p "$ATLAS_WIKI_ROOT"
python3 build.py >/dev/null
echo "ATLAS on http://localhost:8080 — Cloudflare voice (nova-3 / aura-1 '$WORKERS_TTS_VOICE'), Ctrl-C to stop."
exec "${PYTHON:-python3}" -m atlas_voice.server
