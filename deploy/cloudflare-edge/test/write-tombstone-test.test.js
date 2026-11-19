// A patched RegExp.prototype.test must not accept a non-tombstone rewrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

test('a patched test does not rewrite a row for a non-tombstone', () => {
  const lib = new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
  lib.recorded(() => {
    lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')");
    lib.log('r1', 'ada@example.test', 'saved', 'the note');
  });
  const seq = lib.rows("SELECT seq FROM audit WHERE action = 'saved'")[0].seq;
  const orig = RegExp.prototype.test;
  RegExp.prototype.test = function (value) {
    if (String(this.source).includes('erased')) return true;
    return orig.call(this, value);
  };
  let err;
  let result;
  try { result = lib.rewriteAudit('not-a-tombstone', [seq]); }
  catch (error) { err = error; }
  finally { RegExp.prototype.test = orig; }
  assert.equal(lib.rows('SELECT actor FROM audit WHERE seq = ?', seq)[0].actor, 'ada@example.test');
  assert.equal(err && err.code, 'AUDIT_ERASURE');
  assert.notEqual(result && result.changed, 1);
});
