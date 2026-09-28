#!/usr/bin/env bash
# Store ATLAS's provider keys as Cloudflare Worker secrets. Nothing is printed, written to disk or kept in the project.
# Uses hidden macOS dialogs; if dialogs cannot open (for example from an IDE prompt), run it in Terminal instead:
#   bash deploy/cloudflare-edge/set-keys.sh
set -uo pipefail
cd "$(dirname "$0")"
WRANGLER="npx --yes wrangler@4"
REASON="" VALUE=""
ask() { # $1 prompt, $2 hidden (true/false). Sets VALUE, and REASON when nothing was entered (no subshell).
  local out rc; VALUE=""; REASON=""
  out="$(osascript -e "text returned of (display dialog \"$1\" default answer \"\" with hidden answer $2 with title \"ATLAS keys\")" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then VALUE="$out"; [ -z "$VALUE" ] && REASON="left empty"; return; fi
  case "$out" in *"-128"*|*"canceled"*|*"cancelled"*) REASON="cancelled"; return;; esac
  if [ -t 0 ]; then # no dialog available: hidden prompt in this terminal
    if [ "$2" = true ]; then read -rs -p "$1: " VALUE; echo; else read -r -p "$1: " VALUE; fi
    [ -z "$VALUE" ] && REASON="left empty"; return
  fi
  REASON="the dialog could not open here (run this script in the Terminal app)"
}
put() { # $1 secret name, $2 value (never echoed)
  if [ -n "$2" ]; then
    if printf '%s' "$2" | $WRANGLER secret put "$1" >/dev/null 2>&1; then echo "✓ $1 stored"; else echo "✗ $1 could not be stored (is wrangler logged in? run: npx wrangler login)"; fi
  else echo "· $1 skipped: $REASON"; fi
}
# Hindsight Cloud (https://api.hindsight.vectorize.io) is the default; set HINDSIGHT_URL only for a self-hosted server.
ask 'Hindsight API key (Hindsight Cloud → Organization → API Keys; hidden)' true; put HINDSIGHT_API_KEY "$VALUE"
ask 'TypeSafe (JEV) API key (hidden)' true; put TYPESAFE_API_KEY "$VALUE"
ask 'ElevenLabs API key for French, Portuguese, German and more (hidden; English and Spanish work without it)' true; put ELEVENLABS_API_KEY "$VALUE"; VALUE=""
echo "Secrets apply immediately (no redeploy needed). Verify: ATLAS → your profile → 'Test Hindsight and JEV connections'."
