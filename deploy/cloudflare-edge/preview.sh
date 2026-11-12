#!/bin/sh
# Upload a Preview only. The guard refuses first when this build has no ledger.
# This does not deploy the live Worker and does not change account billing.
# Access is not in the previews block. Pass the preview audience and the team domain.
# The audience must not be the production audience. The team may be the existing one.
#   bash preview.sh --var ACCESS_AUD:<preview audience> --var ACCESS_TEAM_DOMAIN:tony-walteur.cloudflareaccess.com
set -eu
cd "$(dirname "$0")"
node preview-guard.mjs
exec npx --yes wrangler@4.135.0 preview --name gate8 "$@"
