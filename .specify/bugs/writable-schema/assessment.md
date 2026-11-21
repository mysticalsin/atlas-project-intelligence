# Assessment: writable-schema

## Symptom
PRAGMA writable_schema = ON is allowed on the native path and on the fallback path, and the flag becomes 1.

## Expected
The statement is SQL_DOOR in every door, and the flag stays 0. A bare PRAGMA writable_schema still reads the flag.

## Actual
provenRead treats every pragma as a read, so the door never sees the assignment. Preparing the statement runs it.

## Verdict
valid

## Severity
High. Devin FAIL and Cursor bc-f37cd093.
