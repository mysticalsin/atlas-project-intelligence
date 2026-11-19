# Assessment: consent delete on a damaged chain

## Symptom
The consent-retention delete still runs when the audit chain does not verify. The 409 from the metadata log is swallowed, so the receipt is gone and the failure is not reported.

## Expected
A damaged chain raises `CHAIN_DAMAGED` before that delete. The receipt stays. Other housekeeping, including teams-seen, still runs.

## Actual
After a real audit line was tampered, the old receipt count went from 1 to 0 and no `CHAIN_DAMAGED` was raised.

## Verdict
valid

## Severity
Low (L-B).

## Note
`fab7d5fdfbe7642d6616386866cc662d639e01df` tampered a chain that contained only `chain-start`, so the chain still verified and the delete was a legal retention delete. `9b7ee475a26bf504f5939b8ca768d681aff2a63d` writes a log line first.
