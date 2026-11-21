# ATLAS-INVITE-SOURCE-ALIAS-SPOOF

Disposition: **ADDENDUM** to Sweep 01 group 10. Not a parallel plan.

Group 10 plan: `docs/sweeps/s01/plans/group-10-erasure-tenant.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of that plan is in progress and addresses Sentinel. This file does not edit that plan.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

The store line is `library.js`, which the whitespace and revoke addenda already assign to the group 10 writer. `library-routes.js:137` allows an admin or a reviewer to call `invite`. That role check stays. This addendum does not edit `library-routes.js` (PR #34).

## APP-FIT

**FIT** against main `8b0972ec`. `invite` stores `str(b.source || actor, 200)` (`library.js:1378`). The route passes `user.email` as `actor` and the request body through. A reviewer in the same tenant can set `body.source` to another person's alias. That person's later erase scrubs the row. No cross-tenant write. Reviewer is a trusted role, and the finding is still that the body chooses the sender.

## Done when

- The stored `source` is the verified actor, end-trimmed the way the whitespace addendum says, and never `body.source`.
- A body that contains `source` set to someone else's alias does not change the stored sender. The invitation is still created for the consultant named in `email`.
- Erase of the person named in the forged `source` does not scrub the row. Erase of the verified actor does.
- A caller who is not an admin or a reviewer is still 403 on this route. That check stays in `library-routes.js` and is not moved.

The 200-cap addendum owns what happens when the actor itself is longer than 200 characters. This addendum only stops the body from choosing the sender.

## Failing test

Name: `a reviewer cannot store another person's alias as invitation source`

On this main the stored `source` is the body value, and an erase of that other person scrubs the row.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "cannot store another person's alias" test/backlog-g10-invite-erase.test.js
```

## Files owned

None as a separate writer. The group 10 writer changes the stored sender expression in `Library.invite` inside `deploy/cloudflare-edge/src/library.js`. The test goes in `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js`.

Do not edit `library-routes.js` or `util.js`.

## Risk

High. Callers that relied on `body.source` to record a sender other than the signed-in reviewer lose that. That reliance is the bug. The audit line already logs `actor`. The column stops being a second, unauthenticated identity.

## Rollback

Revert the expression to read `body.source` again. Rows already stored with the actor stay stored that way.

## Dependencies

| PR | On this row |
|---|---|
| #15 | No. |
| #16 | No. |
| #23 | No. |
| #25 | No. |
| #27 | Do not edit `test/sqlite.js`. |
| #30 | No. |
| #35 | Overlaps `library.js`. Rebase onto #35. #35 also edits `util.js` `email()`. Do not take that hunk. Group 5 owns `email()`. |
| #37 | No. |
| #40 | No. |

Also open: PR #34 edits `library.js` and `library-routes.js`. Rebase the `invite` line onto #34. Leave `library-routes.js` on #34's version. PR #2 also edits `library.js`.
