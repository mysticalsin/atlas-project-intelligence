# Fix: guarded-create

recorded() refuses a CREATE TABLE, VIEW, VIRTUAL TABLE, INDEX, or TRIGGER whose object name is guarded, in any schema, before statementTail. schema() still creates the real audit table.
