# Assessment: recorded trigger

## Symptom
`recorded` accepts `CREATE TRIGGER ... BEGIN DELETE FROM audit; END`. The trigger is stored and a later delete can empty `audit`.

## Expected
A trigger is installed only while `schema` or a registered migration is open. A recorded trigger raises `SCHEMA_DML` and leaves no trigger.

## Actual
On the parent the recorded `CREATE TRIGGER wipe` did not raise `SCHEMA_DML`.

## Verdict
valid

## Severity
Low (L-C).
