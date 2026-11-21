# Fix: primordial call

## Approach
`primordials.js` snapshots unbound `toLowerCase`, `trim`, `replace`, `test`, `exec`, `some`, `every`, and `includes` with `bind.bind(call)`. `sql-text.js` uses them for the split, the shape, and the verb test. `library.js` uses them for the housekeeping list, the consent-trigger names, the tombstone row check, and the housekeeping reason. An unexpected result or a throw is a write. A list match must be exactly `true`.

## Files
`deploy/cloudflare-edge/src/primordials.js`, `deploy/cloudflare-edge/src/sql-text.js`, `deploy/cloudflare-edge/src/library.js`.

## Deviations
None. The recorded-insert case under the same poison already passed on the parent and still passes.
