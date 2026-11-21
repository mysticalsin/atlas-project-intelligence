# Assessment: slice and push

## Symptom
With `statementTail` still returning the real tail, `String.prototype.slice` returning `false`, `true`, `0`, or `-1` makes `isMutatingStatement('DELETE FROM refs')` false and the row is deleted. `Array.prototype.push` that keeps only the last value does the same. `charCodeAt` returning `0` does the same.

## Expected
Those methods are captured at load. A slice that is not the requested span fails closed.

## Actual
The red leaves 0 rows. `AssertionError` `0 !== 1`.

## Verdict
valid

## Severity
High. Cursor bc-130a631f.
