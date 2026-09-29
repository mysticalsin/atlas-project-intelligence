# Windows / Microsoft 365 sign-in for ATLAS (Microsoft Entra ID) — built, NOT enabled
Goal: Mantu people on Windows (Edge/Chrome) sign in with their Mantu Microsoft account, usually silently via Windows single sign-on. Only assigned people get in; each person keeps a private, stable identity.

```
Windows PC (Edge/Chrome, signed into Mantu M365)
  → Cloudflare Access  ── Entra ID connector (OIDC) ──→ Microsoft Entra (Mantu tenant)
  → Access JWT with custom claims {tid, oid, roles, preferred_username}
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
| App roles, assigned to the pilot people: `ATLAS.Interview` (the sign-in role named in `ENTRA_REQUIRED_ROLE`), `ATLAS.Reviewer` (library reviewer) and `ATLAS.Admin` (administrator). The Worker reads exactly `ATLAS.Admin` and `ATLAS.Reviewer` (`src/app.js`); any other role name grants nothing | App roles + Enterprise app → Users and groups |
| Optional: Conditional Access (managed device, MFA) | Applies automatically through Entra |

## Enable (only with IT approval and a Mantu-owned Cloudflare account)
1. `CLOUDFLARE_API_TOKEN` (Access: Apps and Policies Edit, Access: Organizations/IdPs Edit), `CF_ACCOUNT_ID`, `ACCESS_APP_ID`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` in the environment. Then `bash entra/enable_entra.sh --i-have-it-approval`. It adds the Entra connector with the `tid`/`oid`/`roles` claims and switches the ATLAS Access app to it.
2. Deploy with `--var IDENTITY_SOURCE:entra --var ENTRA_TENANTS:<tenant-id> --var ENTRA_REQUIRED_ROLE:ATLAS.Interview`.
3. Test with two different assigned users and one unassigned user (who must be refused), plus a user from another tenant.

Rollback: re-run the deploy without `IDENTITY_SOURCE`, and restore the One-time PIN IdP on the Access app.

Tests: `test/app.test.js` → "Entra (Windows / Microsoft 365) identity path" (off by default; tenant, UUID claims and role enforced when on).
