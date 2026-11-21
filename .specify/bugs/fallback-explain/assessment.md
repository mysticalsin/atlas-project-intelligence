# Assessment: fallback explain

## Symptom
On `f8121280`, with `node:sqlite` hidden, `EXPLAIN QUERY PLAN CREATE TRIGGER ... BEGIN SELECT 1 AS begin; END; DELETE FROM audit` is one read. The driver runs it and the audit row is deleted. `DROP` tails and `EXPLAIN QUERY PLAN DROP TABLE` are the same class.

## Expected
Without a prepare boundary, run a string only when it is provably one read. `EXPLAIN` is a read only when the explained statement is a read. Do not special-case the word `begin`.

## Actual
The red `write-fallback-read.test.js` on `f8121280` fails `AssertionError` `65 !== 64` on Devin's statement. On the parent that already split identifier `begin`, `EXPLAIN QUERY PLAN DROP TABLE audit` still reaches the driver (`69 !== 68`).

## Verdict
valid

## Severity
High. Devin FAIL on `f8121280`. Inspector N-2.
