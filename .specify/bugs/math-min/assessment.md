# Assessment: math-min

## Symptom
Math.min = (a) => a makes /*c*/ DELETE FROM refs classify as empty. The delete runs and the ref is gone.

## Expected
The verb is still visible. The delete is refused and the row stays.

## Actual
The comment scanner bounds the close with the live Math.min, so the first argument replaces the end index.

## Verdict
valid

## Severity
Medium. Sentinel F-A. Twelve call sites in sql-text.js.
