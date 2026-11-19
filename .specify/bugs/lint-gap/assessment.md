# Assessment: lint gaps

## Symptom
These plants are clean: `Reflect.apply(_sql.exec, _sql, ...)`, `(0, eval)(...)`, `globalThis.eval(...)`, and `let proto; proto = WeakMap.prototype; function leak({exec} = rawSql(this))`.

## Expected
Each plant is a violation.

## Actual
`lintSource` returns no exec findings. `AssertionError` expected true, actual false.

## Verdict
valid

## Severity
Medium. Cursor bc-130a631f.
