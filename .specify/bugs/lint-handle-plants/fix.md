# Fix: lint holes

## Approach
Default parameters are tainted when the default is a handle source. A `get` taken from `WeakMap.prototype`, or from an alias of it, is a handle source. A comma expression is peeled before the callee check. `eval` and `new Function` are violations. `this.#sql.exec` is a raw exec. A binding initialized from `this.#sql` is tainted for `.exec` only.

## Files
`deploy/cloudflare-edge/test/write-lint.js`.

## Deviations
None. The real `const sql = this.#sql` passes into audit helpers are not flagged.
