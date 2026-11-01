#!/usr/bin/env bash
# Deploy the ATLAS edge test deployment to Cloudflare (Worker + Durable Object + Workers AI binding).
# One-time: `npx wrangler login` in Terminal. Then: bash deploy/cloudflare-edge/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
python3 ../../build.py >/dev/null && cp ../../ATLAS_Voice.html src/atlas.html
node --test test/*.test.js >/dev/null || { echo "Edge tests failed; not deploying." >&2; node --test test/*.test.js | tail -20; exit 1; }
# Pinned to an exact version (B1): a floating major tag would let a new release run with the Cloudflare token. Update deliberately, run the tests, then change this line.
WRANGLER="npx --yes wrangler@4.156.0"
$WRANGLER deploy
if ! $WRANGLER secret list 2>/dev/null | grep -q CSRF_SECRET; then
  openssl rand -hex 32 | $WRANGLER secret put CSRF_SECRET >/dev/null && echo "CSRF_SECRET set."
fi
# SETTINGS_KEY (v2.2 V2) seals the keys an admin saves in ATLAS -> Settings -> Voice (AES-GCM, key derived with HKDF). Created once, like CSRF_SECRET; never printed. Rotating it makes saved keys unreadable until
# they are saved again (put the old value in SETTINGS_KEY_PREVIOUS while rotating; handoff/SECURITY_RUNBOOK.md section 4).
if ! $WRANGLER secret list 2>/dev/null | grep -q '"SETTINGS_KEY"'; then
  openssl rand -hex 32 | $WRANGLER secret put SETTINGS_KEY >/dev/null && echo "SETTINGS_KEY set."
fi
echo "Live (Cloudflare Access, your email only): https://atlas.tony-walteur.workers.dev"
