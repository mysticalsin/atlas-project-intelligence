# Assessment: qualified-audit

## Symptom
recorded() commits DROP TABLE main.audit, DELETE FROM "main"."audit", UPDATE OR REPLACE, INSERT OR REPLACE INTO audit, and DROP INDEX audit_one_chain_start.

## Expected
Those shapes are SQL_DOOR. The audit table, the chain-start index, and the audit rows stay.

## Actual
On 22990053 the Library path allows them. A schema qualifier or an OR clause is not the name the old guard compared.

## Verdict
valid

## Severity
High. Sentinel F-D and Cursor bc-f37cd093. Plain INSERT INTO consent_receipts stays allowed.
