// A patched RegExp.prototype.exec must not classify a delete as a read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

test('a patched RegExp exec still refuses a door-shut delete', () => {
  const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
  const orig = RegExp.prototype.exec;
  RegExp.prototype.exec = function () { return null; };
  let err;
  try {
    try { lib.exec('DELETE FROM refs'); }
    catch (error) { err = error; }
  } finally {
    RegExp.prototype.exec = orig;
  }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
  assert.equal(err && err.code, 'SQL_DOOR');
});
