// CREATE TEMP TRIGGER is a trigger. recorded must not install it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

for (const sql of [
  'CREATE TEMP TRIGGER wipe AFTER DELETE ON refs BEGIN DELETE FROM audit; END',
  'CREATE TEMPORARY TRIGGER wipe AFTER DELETE ON refs BEGIN DELETE FROM audit; END',
]) {
  test('recorded refuses ' + sql.slice(0, 22), () => {
    const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
    const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
    let err;
    try { lib.recorded(() => lib.exec(sql)); }
    catch (error) { err = error; }
    assert.equal(err && err.code, 'SCHEMA_DML');
    assert.equal(lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before);
    assert.equal(lib.rows("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'wipe'").length, 0);
  });
}
