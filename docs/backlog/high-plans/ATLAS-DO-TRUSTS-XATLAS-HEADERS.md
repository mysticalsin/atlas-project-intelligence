# ATLAS-DO-TRUSTS-XATLAS-HEADERS

Disposition: **ADDENDUM** to Sweep 01 group 13. Not a parallel plan.

Group 13 plan: `docs/sweeps/s01/plans/group-13-worker-auth-routing.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. Devin r8a2f8337 pins PR #38 there, not `a5a24e1`. The branch tip at this freeze is `73dd4df385ee0dbf5f29d00afdf465ea95ea125b` (v4). These addenda cite `4d15c83c`. They do not edit `docs/sweeps/s01/plans/`. The group 13 writer pastes this addendum after that pin.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

Group 16 was checked. It owns `atlas_voice/identity.py` only. This defect is the Worker forward into the Durable Object, which is `deploy/cloudflare-edge/src/app.js`, already group 13's file. It is not the Python sign-in cap.

## APP-FIT

**ADAPT** against main `8b0972ec`.

The library forward already overwrites `x-atlas-user`, `x-atlas-role`, `x-atlas-email`, `x-atlas-tenant`, `x-atlas-tenant-enforced`, and `x-atlas-idp` (`app.js:418-422`). A test that only asserts those six on `/api/library` passes today. That is not a failing test.

The copy is the hole. `/api/memory` builds the forward from the client headers and then sets bank, role, tenant, and tenant-enforced (`app.js:401-404`). It does not set `x-atlas-user` or `x-atlas-subj`, so those client values are copied. The admin role is already overwritten where the Worker sets `x-atlas-role`. `memoryRoutes` reads `x-atlas-bank` and `x-atlas-role` (`memory-routes.js:12`). It does not read `x-atlas-user`. `worker.js:33` and `:59` are not the memory readers. Devin r8a2f8337. `/api/library` and `/api/voice` copy the client headers and then set a known list, so any `x-atlas-*` name they do not set is still the client's. `authz.js:68-69` already says the Durable Object must not trust `x-atlas-tenant-enforced`. The enforcement helper no longer trusts that header when the deployment env is present. The other identity headers are still taken from the request inside the Durable Object.

Production does not read `?as=` (`app.js:254`). That is the CJK addendum's scope, not this one.

## Done when

- Before every Durable Object fetch the Worker makes, every header whose name starts with `x-atlas-` (any case) is deleted, and then only the values derived from the verified token are set. The names include `x-atlas-admin`, `x-atlas-subj`, `x-atlas-bank`, and `x-atlas-csrf`.
- `GET /api/memory` strips the client `x-atlas-*` headers and then sets `x-atlas-user` from the verified library identity. A client `x-atlas-user` and a client `x-atlas-subj` are not on the Interview fetch. The forwarded role is the verified role. The admin role is already overwritten today; the spoof test still asserts that. Do not edit `worker.js`. Devin r8a2f8337.
- `GET /api/library` with a client `x-atlas-subj` or `x-atlas-admin` does not forward those client values. The six headers the Worker already sets stay the verified ones.
- Paths that build a fresh header object (`/api/me/erase`, `/api/consent`, the cron) stay fresh header objects. They do not start copying the client headers.
- `library-routes.js`, `worker.js`, `memory-routes.js`, and `authz.js` are not edited. The Durable Object may keep reading the headers. The Worker stops forwarding a client value under those names and derives the user on the server. Group 13's existing rule stands: do not edit `authz.js`.

## Failing test

Name: `every durable object fetch drops client x-atlas headers`

Sentinel v2, low on review `7343b668` of `2f890c3d` (R8): one table, not one path. Each row is a Worker fetch of a Durable Object: `/api/consent`, `/api/me/erase`, `/api/me/export`, `/api/voice`, `/api/memory`, `/api/library`, the stored spoken-ask consent read (`storedSpokenAsk`), `/api/triggers`, `/api/directory/push`, the limiter fetch inside `consumeLimit`, and the cron posts in `scheduled`. Each column is a client header: `x-atlas-user`, `x-atlas-role`, `x-atlas-email`, `x-atlas-tenant`, `x-atlas-tenant-enforced`, `x-atlas-idp`, `x-atlas-admin`, `x-atlas-subj`, `x-atlas-bank`, `x-atlas-csrf`, also sent in mixed case. The forwarded request does not carry the client value. A path that sets a derived value after the strip shows the derived value. A path that builds a fresh header object stays fresh. The memory `x-atlas-user` case is one cell of this table. On this main that cell forwards the client value.

The group 13 writer adds the table to `deploy/cloudflare-edge/test/sweep01-g13-auth.test.js`, the new file that group already owns. Do not add a second auth test file.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "every durable object fetch drops client x-atlas" test/sweep01-g13-auth.test.js
```

The spoof test, same file. Name: `a spoofed x-atlas-user on /api/memory is replaced by the verified user`. The client sends another person's `x-atlas-user` and another subject's `x-atlas-subj`. The Interview fetch carries the verified user and does not carry the client subject. `worker.js` and `memory-routes.js` are not edited. Devin r8a2f8337.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "spoofed x-atlas-user" test/sweep01-g13-auth.test.js
```

## Files owned

None as a separate writer. The hunk is in `deploy/cloudflare-edge/src/app.js`, which group 13 already owns, and in that group's new test file.

Do not edit `worker.js` (PR #2), `library-routes.js` (PR #34), browser `src/app.js` (PRs #15, #16, #23), or `atlas_voice/identity.py` (group 16).

## Risk

High. Deleting `x-atlas-*` and forgetting to set one of them turns a signed-in request into an anonymous Durable Object call. The test lists the names each path must set after the delete: memory sets bank, role, tenant, tenant-enforced, and user; library sets the six it sets today. A name the Worker does not derive is absent, not copied.

The CJK addendum refuses a non-ByteString identity once, after sign-in verification and before these forwards. This addendum does not itself decide the CJK status code. A path that still runs has already passed that guard, then strips, then sets.

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

Also open: PR #2 edits Worker `app.js` and `worker.js`. If #2 merges, bring it in with an ordinary merge. Do not rebase that pushed branch. Do not take the ledger. The CJK addendum is the other hunk in this same `app.js`.

## Branch base

PR #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1`, brought in by ordinary merge. If PR #15 has landed, bring it in the same way and keep its identity-mismatch return. Do not rebase those pushed branches.

## Known limits

- `memoryRoutes` reads `x-atlas-bank` and `x-atlas-role`. It does not read `x-atlas-user`. The Worker still strips a client `x-atlas-user` and `x-atlas-subj` and sets the user from the verified token.
- `worker.js` is not edited. `worker.js:33` and `:59` are not the memory readers.
- The admin role is already overwritten. The spoof test still asserts the forwarded role is the verified role.

## Ask

| Ask | None. This row does not ask Tony. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> PR12 I-3 (Info, unchanged): the Durable Object trusts the x-atlas-* headers (library-routes.js:53-54, :67-68)
