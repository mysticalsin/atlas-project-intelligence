// A recorded write must not install a trigger that can empty the audit table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

test('a recorded trigger that deletes audit is refused and the rows stay', () => {
  const lib = new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
  const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  let err;
  try {
    lib.recorded(() => lib.exec('CREATE TRIGGER wipe AFTER DELETE ON refs BEGIN DELETE FROM audit; END'));
  } catch (error) { err = error; }
  assert.equal(err && err.code, 'SCHEMA_DML');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before);
  assert.equal(lib.rows("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'wipe'").length, 0);
});
