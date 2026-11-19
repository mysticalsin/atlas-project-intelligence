# Assessment: pragma-setter-allowlist

## Symptom
The schema door accepts PRAGMA journal_mode = WAL and any other non-read pragma except the early writable_schema check.

## Expected
Schema and registered migrations may set only user_version and foreign_keys. Every other assignment is SQL_DOOR before prepare.

## Actual
Any pragmaSetter is allowed when the door kind is schema or registered.

## Verdict
valid

## Severity
High. Sentinel F-I, restated by Inspector.
