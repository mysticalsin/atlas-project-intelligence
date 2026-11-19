# Test: fallback explain

## Reproduction
`node --test --test-name-pattern 'fallback refuses' test/write-fallback-read.test.js` with `node:sqlite` hidden. The matrix is alias `begin`, column `begin`, alias `end`, column `end`, six trigger events, `WHEN begin`, `EXPLAIN`, `EXPLAIN QUERY PLAN`, and tails `DELETE` and `DROP` of `audit` and `refs`, plus the bare DDL and DML explains.

## Result
verified

On `f8121280` the first form calls the driver (`65 !== 64`). On the parent, `EXPLAIN QUERY PLAN DROP TABLE audit` calls the driver (`69 !== 68`). After the fix the node matrix and the workerd sample do not call the driver. Mutation: ignore `provenRead`. The same test fails `69 !== 68`. Restored, not committed.
