# ATLAS-DO-TRUSTS-XATLAS-HEADERS

Disposition: **ADDENDUM** to Sweep 01 group 13. Not a parallel plan.

Group 13 plan: `docs/sweeps/s01/plans/group-13-worker-auth-routing.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of that plan is in progress and addresses Sentinel. This file does not edit that plan. The group 13 writer pastes this addendum after v2 settles.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

Group 16 was checked. It owns `atlas_voice/identity.py` only. This defect is the Worker forward into the Durable Object, which is `deploy/cloudflare-edge/src/app.js`, already group 13's file. It is not the Python sign-in cap.

## APP-FIT

**ADAPT** against main `8b0972ec`.

The library forward already overwrites `x-atlas-user`, `x-atlas-role`, `x-atlas-email`, `x-atlas-tenant`, `x-atlas-tenant-enforced`, and `x-atlas-idp` (`app.js:418-422`). A test that only asserts those six on `/api/library` passes today. That is not a failing test.

The copy is the hole. `/api/memory` builds the forward from the client headers and then sets bank, role, tenant, and tenant-enforced (`app.js:401-404`). It does not set `x-atlas-user`. A client header `x-atlas-user` is what the Interview object reads (`worker.js:33` and `:59`). `/api/library` and `/api/voice` copy the client headers and then set a known list, so any `x-atlas-*` name they do not set is still the client's. `authz.js:68-69` already says the Durable Object must not trust `x-atlas-tenant-enforced`. The enforcement helper no longer trusts that header when the deployment env is present. The other identity headers are still taken from the request inside the Durable Object.

Production does not read `?as=` (`app.js:254`). That is the CJK addendum's scope, not this one.

## Done when

- Before every Durable Object fetch the Worker makes, every header whose name starts with `x-atlas-` (any case) is deleted, and then only the values derived from the verified token are set.
- `GET /api/memory` with a client `x-atlas-user` of another person and a client `x-atlas-role` of `admin` forwards the verified user and the verified role. The Interview fetch does not carry the client values.
- `GET /api/library` with a client `x-atlas-subj` or `x-atlas-admin` does not forward those client values. The six headers the Worker already sets stay the verified ones.
- Paths that build a fresh header object (`/api/me/erase`, `/api/consent`, the cron) stay fresh header objects. They do not start copying the client headers.
- `library-routes.js`, `worker.js`, and `authz.js` are not edited. The Durable Object may keep reading the headers. The Worker stops forwarding a client value under those names. Group 13's existing rule stands: do not edit `authz.js`.

## Failing test

Name: `a client x-atlas-user on /api/memory is not forwarded to the interview object`

On this main the Interview `fetch` receives the client `x-atlas-user`. The test stubs `env.INTERVIEW.get().fetch` and reads the headers of the request it was given.

The group 13 writer adds the case to `deploy/cloudflare-edge/test/sweep01-g13-auth.test.js`, the new file that group already owns. Do not add a second auth test file.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "client x-atlas-user on /api/memory" test/sweep01-g13-auth.test.js
```

## Files owned

None as a separate writer. The hunk is in `deploy/cloudflare-edge/src/app.js`, which group 13 already owns, and in that group's new test file.

Do not edit `worker.js` (PR #2), `library-routes.js` (PR #34), browser `src/app.js` (PRs #15, #16, #23), or `atlas_voice/identity.py` (group 16).

## Risk

High. Deleting `x-atlas-*` and forgetting to set one of them turns a signed-in request into an anonymous Durable Object call. The test lists the names each path must set after the delete: memory sets bank, role, tenant, tenant-enforced, and user; library sets the six it sets today. A name the Worker does not derive is absent, not copied.

The CJK addendum lands in the same function, after the strip. A non-ByteString value is handled there so the set does not throw. This addendum does not itself decide the CJK status code.

## Rollback

Revert the strip. Client-supplied `x-atlas-*` headers are forwarded again on the copy paths. No stored data changes.

## Dependencies

| PR | On this row |
|---|---|
| #15 | Overlaps Worker `app.js` (identity-change 409 and header strip). Group 13 already says: land #30, then this branch; if #15 merges first, keep its identity-mismatch return and its header strip. This addendum's delete-all-`x-atlas-*` must not drop #15's strip of `X-Atlas-Bound-*`. Keep both. |
| #16 | Browser `src/app.js` and generated CSP. Do not take them. Group 13 already says #16 does not edit Worker `app.js`. |
| #23 | Browser shell and generated CSP. No Worker `app.js`. Do not take them. |
| #25 | No. |
| #27 | No. |
| #30 | Group 13 stacks on #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1`. This addendum uses that same base. Do not re-implement `accessConfigured`. Do not edit `deploy.sh`. |
| #35 | No. |
| #37 | No. |
| #40 | No. |

Also open: PR #2 edits Worker `app.js` and `worker.js`. Rebase onto #2 if it merges. Do not take the ledger. The CJK addendum is the other hunk in this same `app.js`.
