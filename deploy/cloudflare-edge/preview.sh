#!/bin/sh
# Upload a Preview only. The guard refuses first when this build has no ledger.
# This does not deploy the live Worker and does not change account billing.
# Access is not in wrangler.jsonc. Pass it on the command line, and not the production values:
#   bash preview.sh --var ACCESS_AUD:<preview audience> --var ACCESS_TEAM_DOMAIN:<preview team>
set -eu
cd "$(dirname "$0")"
node preview-guard.mjs
exec npx --yes wrangler@4.135.0 preview --name gate8 "$@"
