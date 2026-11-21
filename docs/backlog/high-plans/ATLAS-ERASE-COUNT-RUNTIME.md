# ATLAS-ERASE-COUNT-RUNTIME

Disposition: **ADDENDUM** to Sweep 01 group 10. Not a parallel plan.

Group 10 plan: `docs/sweeps/s01/plans/group-10-erasure-tenant.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. Devin r8a2f8337 pins PR #38 there, not `a5a24e1`. The branch tip at this freeze is `73dd4df385ee0dbf5f29d00afdf465ea95ea125b` (v4). These addenda cite `4d15c83c`. They do not edit `docs/sweeps/s01/plans/`.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

`operate.js` is not in group 10's current file list. The whitespace addendum already gives that writer the invitation compare in `operate.js`. This count hunk goes to the same writer so a second branch does not edit the same function.

## APP-FIT

**ADAPT** against main `8b0972ec`.

The receipt still counts with `SELECT changes()` after the delete (`operate.js:112`) and after each scrub update (`operate.js:119`). That is the Sentinel finding: `changes()` is connection state, and it has not been verified on the Durable Object runtime.

The adaptation: the existing pin `pinning: the scrub count is changes() when that differs from the pre-write select` stays, asserted as written. A trigger that ignores one of two updates still yields select length 2, a `changes()` sum of 1, and receipt `scrubbed` 1. Do not delete that pin and do not point it at the select length. The new red test is the lying-`changes()` case: `changes()` returns 0 after a delete that removed a row, and the receipt still reports the row delta. Devin r8a2f8337. The fix counts rows that actually changed, without calling `changes()`.

## Done when

- `removed` is the number of invitation rows in scope before the delete minus the number still in scope after it, both counts inside the same transaction.
- Sentinel v2, info on review `7343b668` of `2f890c3d` (R2): the before count and the after count use the same predicate. Same SQL text, same bound values. A wider before-count would report a row the delete did not remove. This is wording. The failing test name does not change.
- `scrubbed` is the number of sent rows whose `source` changed, not the length of the select and not `changes()`. The trigger pin still reports `scrubbed` 1 when one of two updates is ignored.
- A SQL double whose `changes()` returns 0 after a delete that removed a row still produces `removed` equal to the row delta. The delete itself still happens. The count is not what decides whether the write ran.
- No other `changes()` call is rewritten. `library.js` `writeStatus` (`:1040`) is a compare-and-swap, not this receipt. Leave it.

## Failing test

Name: `the invitation receipt counts rows removed when changes() returns 0`

The test uses a SQL double, local to the new test file, whose `changes()` is 0 after a successful delete. On this main the receipt reports `removed: 0` while the row is gone.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "when changes\\(\\) returns 0" test/backlog-g10-invite-erase.test.js
```

The existing trigger pin stays in `test/invitation-tenant-erase.test.js` and must stay green. Do not delete it and do not point it at the select length.

TEST COMMAND for that pin:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "scrub count is changes" test/invitation-tenant-erase.test.js
```

## Files owned

None as a separate writer. The group 10 writer edits the two count lines in `eraseSubjectInvitations` inside `deploy/cloudflare-edge/src/operate.js`, and adds the double in `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js`.

Do not edit `test/sqlite.js` (PR #27). Do not edit `library.js` for this row.

## Risk

High only because the number is what the person is told was erased. A count taken before the write over-reports when a trigger ignores a row. A count taken from `changes()` under-reports when the driver does not keep connection state. Before-and-after row counts inside the transaction match both cases. A partial transaction still rolls back with the existing `transactionSync` refusal. This addendum does not add a second transaction.

## Rollback

Revert the count hunk. The delete and the scrub stay. The receipt goes back to `changes()`. Rows already erased are not restored.

## Dependencies

| PR | On this row |
|---|---|
| #15 | No. |
| #16 | No. |
| #23 | No. |
| #25 | No. |
| #27 | Do not edit `test/sqlite.js`. The lying `changes()` double lives in the new test file. |
| #30 | No. |
| #35 | No. This row does not edit `library.js`. |
| #37 | No. A missing workerd binary is #37's CI question. This test does not require workerd. The Durable Object claim stays "not verified on workerd" until #37's job can run it. Do not mark the runtime verified from `memorySql`. |
| #40 | No. |

Also open: PR #2 edits `operate.js`. Bring this hunk in with an ordinary merge of that head. Do not rebase that pushed branch. Do not take the ledger from #2 into this addendum.

## Branch base

main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Bring in, by ordinary merge, PR #34, PR #35, PR #2, and PR #41 (`097c5c6680d1b8cfd55db23d39cd027ff69c9133`, `cursor/atlas-living-cv`). Do not rebase those pushed branches. PR #41 also edits `operate.js` (living import, `privacyRoutes`). Those hunks do not overlap this addendum. Do not revert them.

## Known limits

- The existing pin `pinning: the scrub count is changes() when that differs from the pre-write select` stays, asserted as written.
- The new test is the lying-`changes()` case. The product code does not call `changes()` for this receipt.
- `library.js` `writeStatus` is not this receipt. It is not rewritten.
- A green `memorySql` run does not verify the Durable Object runtime.

## Ask

| Ask | None. This row does not ask Tony. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> PR12 I-4 (Info): erase counts rely on SELECT changes(), not verified on the real Durable Object runtime
