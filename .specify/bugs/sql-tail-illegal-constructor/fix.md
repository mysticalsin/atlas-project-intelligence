# Fix: illegal constructor

## Approach
`sqliteRemainder` catches a throw from `getBuiltinModule` and from `new DatabaseSync`, records the scratch database as unavailable, and returns null.

## Files
`deploy/cloudflare-edge/src/sql-tail.js`.

## Deviations
None. A later call does not retry the constructor.
