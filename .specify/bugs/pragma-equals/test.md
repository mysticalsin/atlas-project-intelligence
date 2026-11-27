# Test: pragma-equals

On b9d1ac13 PRAGMA foreign_keys = table_info is ALLOW. After the fix it is SQL_DOOR and the foreign_keys flag is unchanged. The same holds for PRAGMA writable_schema = each allowlisted read name and PRAGMA <name> = writable_schema.
