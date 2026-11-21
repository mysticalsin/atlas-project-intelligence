# Assessment: sql shape trim

## Symptom
`sqlShape` called the live `String.prototype.trim` and `replace`. A trim that rewrites a string starting with `DELETE FROM audit` into the consent-delete shape let housekeeping empty `audit`.

## Expected
Shape comparison uses the load-time snapshot. A trim that does not return the original string does not match the allowlist.

## Actual
On the parent the audit count went from 1 to 0. `AssertionError` `0 !== 1`.

## Verdict
valid

## Severity
Medium. Same root as the call poison. Fixed in the same module.
