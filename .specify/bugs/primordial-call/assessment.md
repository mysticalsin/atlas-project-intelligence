# Assessment: primordial call

## Symptom
With `Function.prototype.call` patched to return null, before or after `sql-text.js` loads, `isMutatingStatement` classifies `DELETE FROM refs` as a read. `Library.exec` runs it and the row is deleted. A selective `String.prototype.trim` and `Array.prototype.some` returning true widen the housekeeping allowlist the same way.

## Expected
The classifier, the splitter, and the door checks use methods captured once at load. A later patch of `call`, `apply`, `bind`, or `Reflect.apply` does not reach them. A non-boolean, a null, or a throw counts as a write.

## Actual
On `29b0727385a54e32e646ea0f0867e9c0da7839df` the captured methods were still invoked with the live `.call`. The red `write-primordial-call.test.js` left 0 rows for the delete, the trimmed audit delete, and the `some` delete.

## Verdict
valid

## Severity
Medium. Confirmed by Devin on `29b07273` (M-A) and by the trim and `some` probes.
