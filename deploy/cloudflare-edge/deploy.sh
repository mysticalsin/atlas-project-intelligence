#!/usr/bin/env bash
# Deploy the ATLAS edge test deployment to Cloudflare (Worker + Durable Object + Workers AI binding).
# One-time: `npx wrangler login` in Terminal. Then: bash deploy/cloudflare-edge/deploy.sh
# Each step is its own command. The page that would be deployed is hashed after the tests,
# because the tests can rewrite it. A failed build does not deploy a page that was already there.
# Exit 11 build, 12 copy, 13 tests, 14 the final page hash, 15 operator config.
# ATLAS_DEPLOY_STAGE_LOG receives the stage name.
# The committed wrangler.jsonc keeps placeholders. Live ORIGIN, ACCESS_TEAM_DOMAIN and ACCESS_AUD
# come from the environment or from deploy.local.env (gitignored). A missing or placeholder value
# stops before wrangler. The Worker also refuses those Access values if that file is deployed as committed.
set -euo pipefail
cd "$(dirname "$0")"
PINNED_PAGE=""
DEPLOY_CONFIG=""
cleanup() {
  local status=$?
  if [[ -n "$PINNED_PAGE" && -f "$PINNED_PAGE" ]]; then
    cp "$PINNED_PAGE" src/atlas.html || true
    local alias
    for alias in ATLAS_Project_Intelligence.html ATLAS_Intelligence.html ATLAS_Voice_Studio.html ATLAS_Voice.html; do
      cp "$PINNED_PAGE" "../../$alias" || true
    done
    rm -f "$PINNED_PAGE"
  fi
  if [[ -n "$DEPLOY_CONFIG" && -f "$DEPLOY_CONFIG" ]]; then
    rm -f "$DEPLOY_CONFIG"
  fi
  exit "$status"
}
trap cleanup EXIT
stage_log() {
  if [[ -n "${ATLAS_DEPLOY_STAGE_LOG:-}" ]]; then
    printf '%s\n' "$1" >> "$ATLAS_DEPLOY_STAGE_LOG"
  fi
}
die() {
  stage_log "$1"
  exit "$2"
}
load_operator_file() {
  local file="deploy.local.env" line key raw
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      echo "ABORT: deploy.local.env must contain only NAME=value lines." >&2
      die config 15
    fi
    key="${BASH_REMATCH[1]}"
    raw="${BASH_REMATCH[2]}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    if [[ ${#raw} -ge 2 && "$raw" == \"*\" && "$raw" == *\" ]]; then
      raw="${raw:1:${#raw}-2}"
    fi
    case "$key" in
      ATLAS_ORIGIN|ATLAS_ACCESS_TEAM_DOMAIN|ATLAS_ACCESS_AUD)
        if [[ -z "${!key:-}" ]]; then
          printf -v "$key" '%s' "$raw"
          export "$key"
        fi
        ;;
      *)
        echo "ABORT: deploy.local.env has an unknown name." >&2
        die config 15
        ;;
    esac
  done < "$file"
}
apply_operator_config() {
  [[ -f wrangler.jsonc ]] || return 0
  load_operator_file
  local origin="${ATLAS_ORIGIN:-}" team="${ATLAS_ACCESS_TEAM_DOMAIN:-}" aud="${ATLAS_ACCESS_AUD:-}"
  if [[ ! "$origin" =~ ^https://[a-z0-9.-]+$ || "$origin" == "https://atlas.example.test" ]]; then
    echo "ABORT: set ATLAS_ORIGIN to the live https origin. The committed placeholder is refused." >&2
    die config 15
  fi
  if [[ ! "$team" =~ ^[a-z0-9][a-z0-9.-]*$ || "$team" == *example.test ]]; then
    echo "ABORT: set ATLAS_ACCESS_TEAM_DOMAIN to the Access team hostname. A placeholder is refused." >&2
    die config 15
  fi
  if [[ ! "$aud" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "ABORT: set ATLAS_ACCESS_AUD to the 64-character Access audience tag. A placeholder is refused." >&2
    die config 15
  fi
  PINNED_PAGE="$(mktemp)"
  cp src/atlas.html "$PINNED_PAGE"
  DEPLOY_CONFIG="$(mktemp --suffix=.json "./deploy.wrangler.XXXXXX")"
  ATLAS_ORIGIN="$origin" ATLAS_ACCESS_TEAM_DOMAIN="$team" ATLAS_ACCESS_AUD="$aud" ATLAS_DEPLOY_CONFIG="$DEPLOY_CONFIG" python3 - <<'PY'
import json, os
from pathlib import Path
text = Path("wrangler.jsonc").read_text(encoding="utf-8")
data = json.loads("\n".join(line for line in text.splitlines() if not line.strip().startswith("//")))
data["vars"]["ORIGIN"] = os.environ["ATLAS_ORIGIN"]
data["vars"]["ACCESS_TEAM_DOMAIN"] = os.environ["ATLAS_ACCESS_TEAM_DOMAIN"]
data["vars"]["ACCESS_AUD"] = os.environ["ATLAS_ACCESS_AUD"]
Path(os.environ["ATLAS_DEPLOY_CONFIG"]).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
  if ! ATLAS_HOME_URL="$origin" python3 ../../build.py; then
    die build 11
  fi
  if ! cp ../../ATLAS_Voice.html src/atlas.html; then
    die copy 12
  fi
  local alias
  for alias in ATLAS_Project_Intelligence.html ATLAS_Intelligence.html ATLAS_Voice_Studio.html ATLAS_Voice.html; do
    cp "$PINNED_PAGE" "../../$alias"
  done
}
if ! env -u ATLAS_HOME_URL python3 ../../build.py; then
  die build 11
fi
stage_log built
if ! cp ../../ATLAS_Voice.html src/atlas.html; then
  die copy 12
fi
stage_log copied
if ! node --test test/*.test.js; then
  die test 13
fi
stage_log tested
if [[ ! -f src/atlas.html || ! -f generated/PAGE_SHA256.txt ]]; then
  die hash 14
fi
expected=$(awk 'NR==1 { print $1 }' generated/PAGE_SHA256.txt)
actual=$(sha256sum src/atlas.html | awk '{ print $1 }')
if [[ "$actual" != "$expected" ]]; then
  die hash 14
fi
stage_log hashed
apply_operator_config
if [[ "${ATLAS_DEPLOY_STUB:-}" == "1" ]]; then
  stage_log deploy
  printf 'deploy\n' >> "${ATLAS_DEPLOY_STUB_LOG:?}"
  exit 0
fi
stage_log deploy
if [[ -n "$DEPLOY_CONFIG" ]]; then
  npx --yes wrangler@4 deploy --config "$DEPLOY_CONFIG"
else
  npx --yes wrangler@4 deploy
fi
if ! npx --yes wrangler@4 secret list 2>/dev/null | grep -q CSRF_SECRET; then
  openssl rand -hex 32 | npx --yes wrangler@4 secret put CSRF_SECRET >/dev/null
  echo "CSRF_SECRET set."
fi
if [[ -n "${ATLAS_ORIGIN:-}" ]]; then
  echo "Live (Cloudflare Access): ${ATLAS_ORIGIN}"
else
  echo "Live (Cloudflare Access)."
fi
