# Assessment: recorded guard

## Symptom
`recorded()` runs `DROP TABLE audit`, `DELETE FROM audit`, `DROP TRIGGER consent_receipts_no_delete`, `UPDATE audit`, `DELETE FROM audit_anchor`, and `ALTER TABLE audit`.

## Expected
Those statements are refused. The housekeeping consent sweep and the registered migration shapes stay.

## Actual
The red sees the audit table gone (`0 !== 1`), the consent trigger gone, and two audit rows rewritten.

## Verdict
valid

## Severity
Medium. Cursor bc-130a631f. `rewriteRows` uses the raw handle and is covered by the tombstone check, not by this door.
