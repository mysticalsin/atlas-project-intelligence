#!/bin/bash
# Each comparison is its own command. A failing cmp is not hidden inside an && list.
# The trap is installed before mktemp. INT exits 130 and TERM exits 143; EXIT then removes the snapshot.
# A signal can arrive before the trap is installed. SIGKILL cannot be trapped.
set -euo pipefail
unset ATLAS_HOME_URL
export PYTHONDONTWRITEBYTECODE=1
export PYTHONIOENCODING=utf-8
cd "$(dirname "$0")/.."
once=
cleanup() { rm -f "$once"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
once=$(mktemp "${TMPDIR:-/tmp}/atlas-page.XXXXXX")
if [[ "${ATLAS_PAGE_HOLD:-}" == "1" ]]; then
  while true; do sleep 0.1; done
fi
python3 build.py
cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html
cp ATLAS_Voice.html "$once"
if [[ "${ATLAS_PAGE_CORRUPT_FIRST:-}" == "1" ]]; then
  printf 'corrupt\n' > "$once"
fi
python3 build.py
if ! cmp ATLAS_Voice.html "$once"; then
  echo 'cmp-first: the first build output does not match the second' >&2
  if [[ -n "${ATLAS_PAGE_STAGE_LOG:-}" ]]; then printf 'cmp-first\n' >> "$ATLAS_PAGE_STAGE_LOG"; fi
  exit 21
fi
if [[ "${ATLAS_PAGE_CORRUPT_EDGE:-}" == "1" ]]; then
  printf 'corrupt-edge\n' > deploy/cloudflare-edge/src/atlas.html
fi
if ! cmp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html; then
  echo 'cmp-edge: the edge page does not match the built page' >&2
  if [[ -n "${ATLAS_PAGE_STAGE_LOG:-}" ]]; then printf 'cmp-edge\n' >> "$ATLAS_PAGE_STAGE_LOG"; fi
  exit 22
fi
expected=$(awk 'NR==1 { print $1 }' deploy/cloudflare-edge/generated/PAGE_SHA256.txt)
actual=$(sha256sum ATLAS_Voice.html | awk '{ print $1 }')
test "$actual" = "$expected"
node --input-type=module -e 'import { readFileSync } from "node:fs"; import { TEAMS_JS, TEAMS_JS_SHA256, TEAMS_JS_VERSION } from "./deploy/cloudflare-edge/teams/vendor/teams-js.mjs"; const lock = JSON.parse(readFileSync("docs/SOURCE_LOCK.json","utf8")).teams_js; if (lock.version !== TEAMS_JS_VERSION || lock.file_sha256 !== TEAMS_JS_SHA256) process.exit(1); const digest = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(TEAMS_JS))).toString("hex"); if (digest !== lock.file_sha256) process.exit(1);'
