# Windows / Microsoft 365 sign-in for ATLAS (Microsoft Entra ID) — built, NOT enabled
Goal: Mantu people on Windows (Edge/Chrome) sign in with their Mantu Microsoft account, usually silently via Windows single sign-on. Only assigned people get in; each person keeps a private, stable identity.

```
Windows PC (Edge/Chrome, signed into Mantu M365)
  → Cloudflare Access  ── Entra ID connector (OIDC) ──→ Microsoft Entra (Mantu tenant)
  → Access JWT with custom claims {tid, oid, roles, preferred_username, name, given_name, family_name}
  → ATLAS Worker: IDENTITY_SOURCE=entra → tenant allow-list + app role → person key "tid:oid"
```
The key `tid:oid` is the same scheme as the Python gateway's Entra mode (`atlas_voice/identity.py`), so private continuity (Hindsight banks) maps one-to-one if the self-hosted route is used later.

## What Mantu IT provides (nothing here is invented)
| Item | Where |
|---|---|
| Directory (tenant) ID | Entra admin centre → Overview |
| App registration (client ID) for "ATLAS via Cloudflare Access" | Redirect URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` |
| Client secret (stored only in Cloudflare) | Certificates & secrets |
| API permissions: `openid`, `email`, `profile`, `offline_access`, `User.Read` (+ `GroupMember.Read.All` only if groups are used) | Admin consent required |
| Optional claims `given_name` and `family_name` on the ID token (they need the `profile` scope). `name` is a standard `profile` claim (ASSUMED; check it in the test tenant) | App registration → Token configuration |
| App roles: `ATLAS.Interview` (the sign-in role named in `ENTRA_REQUIRED_ROLE`), `ATLAS.Reviewer` (library reviewer) and `ATLAS.Admin` (administrator). The Worker reads exactly `ATLAS.Admin` and `ATLAS.Reviewer` (`src/app.js`); any other role name grants nothing. **Assign `ATLAS.Interview` to a group that covers all consultants**, not person by person (see *Who gets in* below) | App roles + Enterprise app → Users and groups |
| Optional: Conditional Access (managed device, MFA) | Applies automatically through Entra |

## Who gets in (no per-person step)
Sign-in is usually silent on Mantu-managed browsers (Windows single sign-on), with one Microsoft sign-in otherwise. What decides *who* gets in:
- `ENTRA_REQUIRED_ROLE=ATLAS.Interview` (enforced in `src/app.js`) admits only people who hold that app role. Assign the role to **a group that covers all consultants**, so a new joiner needs nothing from anyone; or
- leave `ENTRA_REQUIRED_ROLE` unset and gate with a Cloudflare Access policy on the Entra group or on the Mantu email domains ("Emails ending in"). Then the app role is not needed for sign-in.

## Name claims (profile prefill, on screen only)
`enable_entra.sh` asks Access for `["tid","oid","roles","preferred_username","name","given_name","family_name"]`. Access puts them in the JWT's `custom` object, best effort, and trims that object **from the end of the list** when it grows past about 1 KB. So the identity claims the Worker needs (`tid`, `oid`, `roles`) come first and the name claims last: a long name or many roles drops the name claims, never the identity. Never add `groups`. The Worker reads the three name claims only from the already verified token, forwards them to the profile (`x-atlas-idp`, always overwritten) and uses them to fill the name and the first name shown on screen. They never reach an AI model (docs/WOW_ZERO_CONFIG.md §0.4, §5.5). Missing name claims simply fall through to the next profile source. `tests/test_entra_claims.py` keeps the order.

Switching to Entra changes the person key from the email to `tid:oid`, so profile edits made under the email sign-in are not carried over; the sources refill the profile and people re-edit if needed.

## Enable (only with IT approval and a Mantu-owned Cloudflare account)
1. `CLOUDFLARE_API_TOKEN` (Access: Apps and Policies Edit, Access: Organizations/IdPs Edit), `CF_ACCOUNT_ID`, `ACCESS_APP_ID`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` in the environment. Then `bash entra/enable_entra.sh --i-have-it-approval`. It adds the Entra connector with the `tid`/`oid`/`roles`/`preferred_username` claims followed by the name claims, and switches the ATLAS Access app to it.
2. Deploy with `--var IDENTITY_SOURCE:entra --var ENTRA_TENANTS:<tenant-id>`, plus `--var ENTRA_REQUIRED_ROLE:ATLAS.Interview` when the role (assigned to a group) is the gate.
3. Test with two different assigned users and one unassigned user (who must be refused), plus a user from another tenant.

Rollback: re-run the deploy without `IDENTITY_SOURCE`, and restore the One-time PIN IdP on the Access app.

Tests: `test/app.test.js` → "Entra (Windows / Microsoft 365) identity path" (off by default; tenant, UUID claims and role enforced when on).
