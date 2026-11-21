# Assessment: tombstone test

## Symptom
`RegExp.prototype.test` forced true for the tombstone source lets `rewriteAudit('not-a-tombstone', [seq])` set the actor to `not-a-tombstone`.

## Expected
Only `erased:` plus twelve lowercase hex digits is accepted. Any other result is a refusal in `rewriteAudit` and `rewriteRows`.

## Actual
The red fails `AssertionError`, expected `ada@example.test`, actual `not-a-tombstone`.

## Verdict
valid

## Severity
Medium. Cursor bc-130a631f.
