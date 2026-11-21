# ATLAS-ERASE-COUNT-RUNTIME

Disposition: **ADDENDUM** to Sweep 01 group 10. Not a parallel plan.

Group 10 plan: `docs/sweeps/s01/plans/group-10-erasure-tenant.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of that plan is in progress and addresses Sentinel. This file does not edit that plan.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

`operate.js` is not in group 10's current file list. The whitespace addendum already gives that writer the invitation compare in `operate.js`. This count hunk goes to the same writer so a second branch does not edit the same function.

## APP-FIT

**ADAPT** against main `8b0972ec`.

The receipt still counts with `SELECT changes()` after the delete (`operate.js:112`) and after each scrub update (`operate.js:119`). That is the Sentinel finding: `changes()` is connection state, and it has not been verified on the Durable Object runtime.

The adaptation: `invitation-tenant-erase.test.js` around the test `pinning: the scrub count is changes() when that differs from the pre-write select` now requires the receipt to follow `changes()` when a trigger ignores one of two updates (select length 2, `changes()` sum 1, receipt `scrubbed` 1). Replacing the count with the pre-write select length would fail that pin and would report a row the trigger did not change. The fix has to count rows that actually changed, without calling `changes()`.

## Done when

- `removed` is the number of invitation rows in scope before the delete minus the number still in scope after it, both counts inside the same transaction.
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

Also open: PR #2 edits `operate.js`. Rebase this hunk onto that head. Do not take the ledger from #2 into this addendum.
