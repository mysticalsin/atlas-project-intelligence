# Assessment: audit-ready-some

## Symptom
Array.prototype.some returning false makes auditReady false. A recorded DELETE FROM refs then commits on a chain whose hash was broken through the raw handle.

## Expected
The delete is CHAIN_DAMAGED and the row stays.

## Actual
auditReady uses the live some and treats a throw as not ready. The pre-check ready && !healthy then does not run.

## Verdict
valid

## Severity
Medium. Cursor bc-f37cd093.
