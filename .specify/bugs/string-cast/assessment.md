# Assessment: string-cast

## Symptom
A String that rewrites only DELETE FROM refs to select 1, while statementTail still sees the original, deletes the row.

## Expected
The classifier sees DELETE. The row stays and the code is SQL_DOOR or SQL_MULTI.

## Actual
lower, trim, and the splitter coerce with the live String. A String that returns select 1 for every value fail-closes, so the red restores String inside statementTail and rewrites only that text.

## Verdict
valid

## Severity
Medium. Sentinel F-A.
