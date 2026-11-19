# Assessment: pragma-tokens

## Symptom
PRAGMA writable_schema /* c */ = ON and PRAGMA "main"."writable_schema" = ON return SQL_DOOR, and the flag then reads 1, on both paths.

## Expected
The flag stays 0. The refusal sees through comments and quoted schema-qualified names, and it happens before prepare.

## Actual
The raw scan treats the character after the name as the operator. A quote or a comment hides the equals sign, so statementTail prepares the pragma and SQLite sets the flag.

## Verdict
valid

## Severity
High. Devin's partial on b9d1ac13.
