# Assessment: lint holes

## Symptom
These plants were not flagged: a default parameter calling `rawSql`, a destructured `WeakMap.prototype.get`, `(0, rawSql)(this)`, an alias of `WeakMap.prototype`, `eval`, `new Function`, `this.#sql.exec` beside the one allowed `_sql.exec`, and `const s = this.#sql; s.exec`.

## Expected
Each plant is a raw-exec violation. `lintDir` on `src` stays empty. The one `_sql.exec` in `library.js` stays legal. Passing `this.#sql` into an audit helper is not a violation.

## Actual
`lintSource` returned no exec violation for each plant. Patterns that were already flagged (call, apply, bind, and `Reflect.apply` on a tainted value) were not planted again.

## Verdict
valid

## Severity
Medium.
