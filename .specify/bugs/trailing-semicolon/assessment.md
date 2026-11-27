# Assessment: trailing-semicolon

## Symptom
The fallback refuses SELECT 1; and EXPLAIN QUERY PLAN SELECT 1; with SQL_MULTI. The native path allows them.

## Expected
One trailing semicolon followed only by whitespace or comments is one statement on both paths. A second semicolon or any other statement is still SQL_MULTI.

## Actual
bareSemicolon returns true on every semicolon outside quotes, comments, and brackets.

## Verdict
valid

## Severity
Low. Inspector on 22990053.
