# Fix: pragma-equals

The token stream keeps `=`. The name is the word before it, or the word after a schema dot. The statement is refused before prepare unless it is a proven read, or a user_version or foreign_keys setter inside schema or a registered migration.
