# Assessment: attach-detach

## Symptom
ATTACH DATABASE ':memory:' AS extra succeeds on the native path. DETACH of a missing database is ERR_SQLITE_ERROR. The fallback already returns SQL_DOOR.

## Expected
Both statements are SQL_DOOR on both paths, in every door. database_list does not gain extra.

## Actual
ATTACH is not in the verb list, so the native path runs it.

## Verdict
valid

## Severity
Medium. Devin FAIL.
