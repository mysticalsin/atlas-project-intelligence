// A statement object can toString to a read, then to a DELETE. Only a string is SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

test('a statement object cannot flip its text to DELETE', () => {
  const lib = new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
  lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
  let calls = 0;
  const statement = { toString() { calls += 1; return calls < 3 ? 'SELECT 1' : 'DELETE FROM refs'; } };
  let err;
  try { lib.exec(statement); }
  catch (error) { err = error; }
  assert.equal(err && err.code, 'SQL_TEXT');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
});
