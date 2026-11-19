# Assessment: consent trigger fallback

## Symptom
On a driver that has only `exec` and `transactionSync`, and when `node:sqlite` is absent, `ensure` swallows `SQL_MULTI`. The three append-only triggers are not installed. `DELETE FROM consent_receipts` then runs.

## Expected
One `CREATE TRIGGER ... BEGIN ...; END` is one statement. A trailing statement is still refused. If a required trigger does not install, `ensure` throws.

## Actual
Hiding `process.getBuiltinModule('node:sqlite')` left `sqlite_master` with no consent triggers and the receipt count at 0. `ensure` had swallowed the error.

## Verdict
valid

## Severity
High.
