#!/usr/bin/env bash
# Adds Microsoft Entra ID to Cloudflare Access and switches the ATLAS app to it. BUILT, NOT RUN.
# Requires explicit approval flag and IT-provided values; see entra/README.md.
# The trap removes only the local temp directory on EXIT, INT, TERM, and HUP. It does not delete a remote identity provider; restoring the previous Access login is an IT action in the Cloudflare dashboard.
# A dollar sign or other shell metacharacter in the API token or the client secret is refused before any file is written. Hash, backtick, and exclamation are refused by their own code-point checks. Tilde, plus, slash, and equals stay allowed: Microsoft secrets use them, and this script never expands the value in the shell.
set -euo pipefail
[ "${1:-}" = "--i-have-it-approval" ] || { echo "Refusing: pass --i-have-it-approval once Mantu IT has approved (see entra/README.md)." >&2; exit 2; }
xtrace=0
case $- in
  *x*) xtrace=1 ;;
esac
set +x
for v in CLOUDFLARE_API_TOKEN CF_ACCOUNT_ID ACCESS_APP_ID ENTRA_TENANT_ID ENTRA_CLIENT_ID ENTRA_CLIENT_SECRET; do
  if [[ -v $v ]]; then
    [ -n "${!v}" ] || { echo "Missing $v" >&2; exit 2; }
  else
    echo "Missing $v" >&2
    exit 2
  fi
done
if [ "$xtrace" = 1 ]; then set -x; fi
API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access"
umask 077
dir=$(mktemp -d)
trap 'if [ -n "${dir:-}" ] && [ -d "$dir" ]; then rm -rf "$dir"; fi' EXIT INT TERM HUP
# Claim order matters: Access trims custom claims from the END of this list above ~1 KB, so the identity claims come
# first and the name claims (WOW_ZERO_CONFIG §5.5, on-screen use only) last. Never add "groups".
python3 - "$dir" <<'PY'
import json, os, sys
directory = sys.argv[1]

def accepted(value):
    if not isinstance(value, str) or not value:
        return False
    for ch in value:
        if ord(ch) == 35:
            return False
        if ord(ch) == 96:
            return False
        if ord(ch) == 33:
            return False
        if ch in "\n\r\t\"'\\ *?;&|()<>[]{}" or ch == "$" or ord(ch) < 33 or ord(ch) > 126:
            return False
    return True

token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
secret = os.environ.get("ENTRA_CLIENT_SECRET", "")
if not accepted(token) or not accepted(secret):
    sys.stderr.write("Refusing: the API token or client secret has a character this script will not write.\n")
    raise SystemExit(2)

def write_private(name, text):
    fd = os.open(os.path.join(directory, name), os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)

write_private("curl.cfg", "header = \"Authorization: Bearer %s\"\nheader = \"Content-Type: application/json\"\n" % token)
write_private("idp.json", json.dumps({
    "name": "Mantu Microsoft Entra ID",
    "type": "azureAD",
    "config": {
        "client_id": os.environ["ENTRA_CLIENT_ID"],
        "client_secret": secret,
        "directory_id": os.environ["ENTRA_TENANT_ID"],
        "support_groups": False,
        "claims":["tid","oid","roles","preferred_username","name","given_name","family_name"],
    },
}))
PY
if ! curl -q --fail --proto '=https' --silent --show-error --config "$dir/curl.cfg" --output "$dir/post.body" --stderr "$dir/post.err" --url "$API/identity_providers" --request POST --data-binary @"$dir/idp.json"; then
  echo "Cloudflare refused the identity provider request." >&2
  exit 1
fi
IDP_ID=$(python3 - "$dir/post.body" <<'PY'
import json, sys
ok = False
ident = ""
try:
    report = json.load(open(sys.argv[1], encoding="utf-8"))
    ident = report["result"]["id"]
    ok = report.get("success") is True and isinstance(ident, str) and ident.isascii() and 1 <= len(ident) <= 128 and ident.replace("-", "").replace("_", "").isalnum()
except Exception:
    ok = False
if not ok:
    sys.stderr.write("Cloudflare refused the identity provider request.\n")
    raise SystemExit(1)
sys.stdout.write(ident)
PY
)
echo "Entra connector created: $IDP_ID"
python3 - "$dir" "$IDP_ID" <<'PY'
import json, os, sys
directory, ident = sys.argv[1], sys.argv[2]
fd = os.open(os.path.join(directory, "patch.json"), os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump({"allowed_idps": [ident], "auto_redirect_to_identity": True}, handle)
PY
if ! curl -q --fail --proto '=https' --silent --show-error --config "$dir/curl.cfg" --output "$dir/patch.body" --stderr "$dir/patch.err" --url "$API/apps/$ACCESS_APP_ID" --request PATCH --data-binary @"$dir/patch.json"; then
  echo "Cloudflare refused the identity provider request." >&2
  exit 1
fi
python3 - "$dir/patch.body" <<'PY'
import json, sys
ok = False
try:
    report = json.load(open(sys.argv[1], encoding="utf-8"))
    ok = report.get("success") is True
except Exception:
    ok = False
if not ok:
    sys.stderr.write("Cloudflare refused the identity provider request.\n")
    raise SystemExit(1)
sys.stdout.write("ATLAS Access app now uses Entra ID.\n")
PY
echo "Next: deploy with --var IDENTITY_SOURCE:entra --var ENTRA_TENANTS:$ENTRA_TENANT_ID --var ENTRA_REQUIRED_ROLE:ATLAS.Interview"
