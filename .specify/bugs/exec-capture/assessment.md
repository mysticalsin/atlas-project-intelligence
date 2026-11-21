# Assessment: captured exec

## Symptom
`primordials.test` calls `RegExp.prototype.test`, which reads `exec` from the live prototype. After load, `exec` returning null makes `test(/a/, 'a')` false.

## Expected
`test` calls the `exec` captured at load. Classification and the audit path do not call `RegExp.prototype.test`. A patched `exec` still refuses a delete on the direct, schema, and housekeeping doors.

## Actual
On `f8121280` and on the parent, the red fails `AssertionError` `false !== true`. The three doors already refuse on the parent because classification has no regex.

## Verdict
valid

## Severity
Medium. Devin FAIL on `f8121280`.
