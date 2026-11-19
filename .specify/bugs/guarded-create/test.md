# Test: guarded-create

On b9d1ac13 the exact statement is ALLOW and sqlite_temp_master contains audit. After the fix it is SQL_DOOR and the temp catalog stays empty, on both paths.
