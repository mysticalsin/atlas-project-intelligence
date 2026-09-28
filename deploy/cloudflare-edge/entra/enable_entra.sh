#!/usr/bin/env bash
# Adds Microsoft Entra ID to Cloudflare Access and switches the ATLAS app to it. BUILT, NOT RUN.
# Requires explicit approval flag and IT-provided values; see entra/README.md.
set -euo pipefail
[ "${1:-}" = "--i-have-it-approval" ] || { echo "Refusing: pass --i-have-it-approval once Mantu IT has approved (see entra/README.md)." >&2; exit 2; }
for v in CLOUDFLARE_API_TOKEN CF_ACCOUNT_ID ACCESS_APP_ID ENTRA_TENANT_ID ENTRA_CLIENT_ID ENTRA_CLIENT_SECRET; do [ -n "${!v:-}" ] || { echo "Missing $v" >&2; exit 2; }; done
API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
idp=$(python3 -c 'import json,os; print(json.dumps({"name":"Mantu Microsoft Entra ID","type":"azureAD","config":{"client_id":os.environ["ENTRA_CLIENT_ID"],"client_secret":os.environ["ENTRA_CLIENT_SECRET"],"directory_id":os.environ["ENTRA_TENANT_ID"],"support_groups":False,"claims":["tid","oid","roles","preferred_username"]}}))')
IDP_ID=$(curl -sS "${auth[@]}" -X POST "$API/identity_providers" --data "$idp" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["success"], r["errors"]; print(r["result"]["id"])')
echo "Entra connector created: $IDP_ID"
curl -sS "${auth[@]}" -X PATCH "$API/apps/$ACCESS_APP_ID" --data "{\"allowed_idps\":[\"$IDP_ID\"],\"auto_redirect_to_identity\":true}" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["success"], r["errors"]; print("ATLAS Access app now uses Entra ID.")'
echo "Next: deploy with --var IDENTITY_SOURCE:entra --var ENTRA_TENANTS:$ENTRA_TENANT_ID --var ENTRA_REQUIRED_ROLE:ATLAS.Interview"
