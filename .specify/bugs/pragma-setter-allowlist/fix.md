# Fix: pragma-setter-allowlist

refusePragma allows a setter through only when the whole statement is user_version or foreign_keys and the door is schema or registered. writable_schema is never on that list.
