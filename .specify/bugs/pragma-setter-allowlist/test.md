# Test: pragma-setter-allowlist

On b9d1ac13 PRAGMA journal_mode = WAL in schema is ALLOW. After the fix it is SQL_DOOR. PRAGMA user_version = 7 and PRAGMA foreign_keys = ON in schema still run.
