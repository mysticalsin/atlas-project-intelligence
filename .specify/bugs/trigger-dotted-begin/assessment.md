# Assessment: trigger-dotted-begin

## Symptom
splitStatements of CREATE TRIGGER t BEFORE INSERT ON refs WHEN NEW.begin BEGIN SELECT 1; END; DELETE FROM audit returns length 1.

## Expected
The length is 2. The DELETE is not inside the trigger.

## Actual
A begin preceded by a dot is treated as the body keyword because the next identifier is BEGIN.

## Verdict
valid

## Severity
Low. Sentinel F-C. The word begin is still not the security boundary.
