# ATLAS-INVITE-REVOKE-ERASE

Disposition: **ADDENDUM** to Sweep 01 group 10. Not a parallel plan.

Group 10 plan: `docs/sweeps/s01/plans/group-10-erasure-tenant.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of that plan is in progress and addresses Sentinel. This file does not edit that plan.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

`library.js` is not in group 10's current file list. The whitespace addendum already gives that writer the tenant store line in `invite`. Dismiss and done are the same file. One writer applies both.

## APP-FIT

**FIT** against main `8b0972ec`. `updateInvitation` sets status and, for `done`, `reference_id`. It does not write `source` (`library.js:1445-1447`, and the closed-story dismiss at `:1436`). After dismiss or done, `source` still holds the sender, up to 200 characters, which is the carried Sentinel note.

## Done when

- `dismiss` and `done` replace `source` with a fresh `erased:` token in the same recorded update that sets the status. The token is not the sender's address and not the actor argument.
- The row stays for the recipient. Status, slot, and reference id stay on the rules they already have. The compare-and-swap on the open status stays.
- `schedule` does not clear `source`. The invitation is still open, and the sender is still the person a later subject-erase has to scrub.
- A subject erase that runs after the revoke does not need the old source. The token does not match any alias.
- Another tenant's invitation is still 404 before any write, including this source write.

## Failing test

Name: `dismiss and done replace invitation source with an erased token`

On this main, dismiss leaves `source` equal to the actor.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "replace invitation source with an erased token" test/backlog-g10-invite-erase.test.js
```

## Files owned

None as a separate writer. The group 10 writer edits the two terminal updates inside `Library.updateInvitation` in `deploy/cloudflare-edge/src/library.js`, and adds the test in `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js`.

Do not edit `library-routes.js`. The route already calls `updateInvitation`.

## Risk

High. Clearing `source` on `schedule` would drop attribution while the invitation is still open, and a later erase would miss a sent row. This addendum does not do that. The token must be unique per row so two revoked rows do not share a sender-shaped value.

## Rollback

Revert the status updates' column list. Revoked rows already tokenised stay tokenised. They are not restored to the sender's address.

## Dependencies

| PR | On this row |
|---|---|
| #15 | No. |
| #16 | No. |
| #23 | No. |
| #25 | No. |
| #27 | Do not edit `test/sqlite.js`. |
| #30 | No. |
| #35 | Overlaps `library.js`. Rebase the status hunk onto #35. |
| #37 | No. |
| #40 | No. |

Also open: PR #34 edits `library.js` and `library-routes.js`. Rebase onto #34. Do not take #34's merge, import, or lock edits except as the base. PR #2 also edits `library.js`. Rebase onto that head as well.
