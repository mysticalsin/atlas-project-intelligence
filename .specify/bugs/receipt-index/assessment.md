# Assessment: receipt-index

## Symptom
CREATE INDEX on consent_receipts or privacy_gate is allowed in the recorded door.

## Expected
That create is SQL_DOOR in recorded(). The schema install of consent_receipts_subject still runs.

## Actual
indexForbidden only treats audit and audit_anchor as protected ON targets, so the schema install is not blocked and the recorded door is open.

## Verdict
valid

## Severity
Low. Inspector info on b9d1ac13. No registered migration creates that index.
