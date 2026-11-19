# Assessment: eval-alias

## Symptom
const e = eval; e('1') is not a lint violation.

## Expected
The call is a violation. The existing eval plants stay violations, and lintDir(src) stays empty.

## Actual
isEvalCall matches a callee named eval or a member named eval. An alias is neither.

## Verdict
valid

## Severity
Low. Cursor bc-f37cd093.
