#!/usr/bin/env bash
# Deploy the ATLAS edge test deployment to Cloudflare (Worker + Durable Object + Workers AI binding).
# One-time: `npx wrangler login` in Terminal. Then: bash deploy/cloudflare-edge/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
python3 ../../build.py >/dev/null && cp ../../ATLAS_Voice.html src/atlas.html
node --test test/*.test.js >/dev/null || { echo "Edge tests failed; not deploying." >&2; node --test test/*.test.js | tail -20; exit 1; }
WRANGLER="npx --yes wrangler@4"
$WRANGLER deploy
if ! $WRANGLER secret list 2>/dev/null | grep -q CSRF_SECRET; then
  openssl rand -hex 32 | $WRANGLER secret put CSRF_SECRET >/dev/null && echo "CSRF_SECRET set."
fi
echo "Live (Cloudflare Access, your email only): https://atlas.tony-walteur.workers.dev"
