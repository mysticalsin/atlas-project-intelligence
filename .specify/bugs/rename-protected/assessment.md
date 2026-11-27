# Assessment: rename-protected

## Symptom
ALTER TABLE refs RENAME TO consent_receipts is allowed in recorded() and refs is gone.

## Expected
RENAME TO a guarded name is SQL_DOOR and refs stays. Registered renames of other tables stay.

## Actual
The alter check looks at the source table, not the RENAME TO target.

## Verdict
valid

## Severity
High. Sentinel F-H.
