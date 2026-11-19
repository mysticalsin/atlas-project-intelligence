# Assessment: math-max

## Symptom
A patched Math.max makes WITH c AS (SELECT 1) DELETE FROM refs look like a non-mutation, and the rows are deleted.

## Expected
The three depth sites in sql-text.js use Math.max captured at load.

## Actual
splitBody, the mutating WITH scan, and hasCreateAsSelect call the live Math.max.

## Verdict
valid

## Severity
Medium. Sentinel F-G.
