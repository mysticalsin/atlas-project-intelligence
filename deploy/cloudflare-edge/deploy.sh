#!/usr/bin/env bash
# Deploy the ATLAS edge test deployment to Cloudflare (Worker + Durable Object + Workers AI binding).
# One-time: `npx wrangler login` in Terminal. Then: bash deploy/cloudflare-edge/deploy.sh
# Each step is its own command. The page that would be deployed is hashed after the tests,
# because the tests can rewrite it. A failed build does not deploy a page that was already there.
# Exit 11 build, 12 copy, 13 tests, 14 the final page hash. ATLAS_DEPLOY_STAGE_LOG receives the stage name.
set -euo pipefail
cd "$(dirname "$0")"
stage_log() {
  if [[ -n "${ATLAS_DEPLOY_STAGE_LOG:-}" ]]; then
    printf '%s\n' "$1" >> "$ATLAS_DEPLOY_STAGE_LOG"
  fi
}
die() {
  stage_log "$1"
  exit "$2"
}
if ! python3 ../../build.py; then
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
if [[ "${ATLAS_DEPLOY_STUB:-}" == "1" ]]; then
  stage_log deploy
  printf 'deploy\n' >> "${ATLAS_DEPLOY_STUB_LOG:?}"
  exit 0
fi
stage_log deploy
npx --yes wrangler@4 deploy
if ! npx --yes wrangler@4 secret list 2>/dev/null | grep -q CSRF_SECRET; then
  openssl rand -hex 32 | npx --yes wrangler@4 secret put CSRF_SECRET >/dev/null
  echo "CSRF_SECRET set."
fi
echo "Live (Cloudflare Access, your email only): https://atlas.tony-walteur.workers.dev"
