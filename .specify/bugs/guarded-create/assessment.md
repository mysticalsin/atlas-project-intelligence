# Assessment: guarded-create

## Symptom
CREATE TABLE temp.audit AS SELECT * FROM main.audit is allowed in recorded(), and the temp table receives later unqualified writes.

## Expected
CREATE of audit, audit_anchor, consent_receipts, or privacy_gate is SQL_DOOR in any schema, including a temp. qualifier and any quoting, before prepare.

## Actual
createShadow only matches the TEMP keyword on a table or view. A schema qualifier temp. is a different name, so the shadow is created.

## Verdict
valid

## Severity
High. Cursor bc-9bb004c7 and Devin's partial on b9d1ac13.
