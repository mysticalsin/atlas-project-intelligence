// RegExp.prototype.exec captured at load has to answer test().
// A later patch of exec must not hide a delete on any door.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { test as reTest } from '../src/primordials.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const INSERT = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')";

test('a patched exec does not change the captured test', () => {
  const orig = RegExp.prototype.exec;
  RegExp.prototype.exec = function () { return null; };
  let verdict;
  try { verdict = reTest(/a/, 'a'); }
  finally { RegExp.prototype.exec = orig; }
  assert.equal(verdict, true);
});

test('a patched exec still refuses direct, schema, and housekeeping deletes', () => {
  const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec(INSERT));
  const orig = RegExp.prototype.exec;
  const doors = [
    ['direct', () => lib.exec('DELETE FROM refs')],
    ['schema', () => lib.schema(() => lib.exec('DELETE FROM refs'))],
    ['house', () => lib.housekeeping('consent-retention', () => lib.exec('DELETE FROM refs'))],
  ];
  try {
    for (const [name, run] of doors) {
      RegExp.prototype.exec = function () { return null; };
      let err;
      try { run(); }
      catch (error) { err = error; }
      finally { RegExp.prototype.exec = orig; }
      assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1, name);
      assert.ok(err && err.code, name);
    }
  } finally {
    RegExp.prototype.exec = orig;
  }
});
