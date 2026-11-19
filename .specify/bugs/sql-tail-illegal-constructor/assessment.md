# Assessment: illegal constructor

## Symptom
At workerd compatibility date 2026-09-01 or later, `node:sqlite` `DatabaseSync` throws `Illegal constructor`. `sql-tail.js` did not catch it, so `new Library` threw that error before any driver SQL.

## Expected
A throwing constructor is the same as a missing module: return null and use the in-isolate split. `Library` does not surface `Illegal constructor` at compatibility 2025-09-01 or 2026-09-01.

## Actual
The parent red reported `Illegal constructor` from `new Library` on node and from the workerd worker at 2026-09-01.

## Verdict
valid

## Severity
Medium. Latent availability (M-B).
