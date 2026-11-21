# ATLAS-INVITE-SOURCE-200CAP

Disposition: **ADDENDUM** to Sweep 01 group 10. Not a parallel plan.

Group 10 plan: `docs/sweeps/s01/plans/group-10-erasure-tenant.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of that plan is in progress and addresses Sentinel. This file does not edit that plan.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

Same `invite` store line as the spoof addendum. One writer, one expression. The spoof addendum drops `body.source`. This addendum drops the prefix cut on the actor that remains.

## APP-FIT

**ADAPT** against main `8b0972ec`.

The cut is still there: `str(b.source || actor, 200)` at `library.js:1375-1378`. `str` collapses whitespace and keeps 200 code points. Two actors that share that prefix store one `source`. Erase matches the full alias (`operate.js:109`), so erasing the 200-character actor scrubs the longer actor's row as well.

The adaptation: `invitation-tenant-erase.test.js` now pins the cut. `pinning: invite stores the first 200 characters of a 201-character actor` expects the stored source to be the first 200 characters. That pin locks the bug. The writer rewrites that pin in the same change. Leaving it green means the fix cannot land.

A 73-character `tid:oid` and a normal mailbox are inside 200 today. They are not the collision. The collision is any actor longer than 200.

## Done when

- `invite` stores the verified actor with end-trim and without a prefix cut, for every actor of 254 characters or fewer. 254 is the mailbox length `email()` already refuses past (`util.js`). A `tid:oid` fits. 201 characters are stored whole.
- An actor longer than 254 characters is 400, and no invitation row is inserted. The function does not store a shared prefix.
- Erase of a 200-character actor scrubs only the row whose stored source is that whole actor. A longer actor that begins with those 200 characters is kept, source unchanged, and is not in the scrubbed count.
- The `<= 60` prefix arm in `operate.js:105` stays. `ATLAS-ERASE-PREFIX-ARM-TEST` is already fixed on main, and `ATLAS-LEGACY-PREFIX-RECEIPT` is still Tony's decision. This addendum does not delete that arm and does not scrub legacy 60-character prefixes.
- `util.js` `email()` is not edited. Its 200-character slice is a different cap, on addresses, owned by group 5.

## Failing test

Name: `erasing a 200-character actor does not scrub a longer actor that shares that prefix`

On this main both rows store the same 200 characters, and the erase reports both scrubbed.

The rewritten pin, same change: `pinning: invite stores a 201-character actor whole`. On this main that assertion fails because the store cuts at 200. After the fix it passes. The old pin name is removed so the suite cannot keep requiring the cut.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "does not scrub a longer actor" test/backlog-g10-invite-erase.test.js
cd deploy/cloudflare-edge && node --test --test-name-pattern "201-character actor" test/invitation-tenant-erase.test.js
```

## Files owned

None as a separate writer. The group 10 writer edits the stored-source expression in `deploy/cloudflare-edge/src/library.js` and rewrites the 201-character pin in `deploy/cloudflare-edge/test/invitation-tenant-erase.test.js`. The new collision test goes in `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js`.

Do not edit `operate.js` for this row except to leave the 60-character arm alone. Do not edit `util.js`.

## Risk

High. Storing an unbounded actor would let a reviewer write a very large `source`. The 254 refusal is the bound, and it refuses instead of cutting. Two actors that differ only after 254 characters cannot both be stored. That pair cannot be a legal mailbox either. Rewriting the existing pin is required. A writer who only adds a new test and leaves the old pin will have a red suite after a correct fix, or will revert the fix to satisfy the pin.

## Rollback

Revert the store expression and restore the 201-character pin. Rows stored whole stay whole. Erase of a short actor no longer matches them, which is the safe direction. Legacy 60-character prefixes are unchanged.

## Dependencies

| PR | On this row |
|---|---|
| #15 | No. |
| #16 | No. |
| #23 | No. |
| #25 | No. |
| #27 | Do not edit `test/sqlite.js`. |
| #30 | No. |
| #35 | Overlaps `library.js` and `util.js`. Rebase the `invite` line onto #35. Do not edit `email()`. |
| #37 | No. |
| #40 | No. |

Also open: PR #34 and PR #2 edit `library.js`. Rebase onto both. Apply this expression in the same edit as the spoof addendum so the line is written once.
