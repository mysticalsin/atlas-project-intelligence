# Assessment: production-clock

## Symptom
A Library built with only auditKey stamps an audit line with a patched toISOString of 9999-01-01T00:00:00.000Z.

## Expected
The stamp is the captured clock. The patched toISOString does not move it.

## Actual
The constructor default calls new Date().toISOString() on the live prototype. worker.js does not pass now.

## Verdict
valid

## Severity
Medium. Cursor bc-f37cd093.
