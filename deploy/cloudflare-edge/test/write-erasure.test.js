// rewriteAudit takes a predicate today, so a caller can rewrite any row and leave no record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const TOKEN = 'erased:0123456789ab';

function open() {
  return new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
}

test('a predicate cannot rewrite audit rows, and an erasure records one metadata line', () => {
  const lib = open();
  lib.recorded(() => {
    lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')");
    lib.log('r1', 'ada@example.test', 'saved', 'the note');
  });
  const seq = lib.rows("SELECT seq FROM audit WHERE action = 'saved'")[0].seq;
  let err;
  try {
    lib.rewriteAudit(row => Number(row.seq) === Number(seq) ? { actor: TOKEN, detail: '' } : null);
  } catch (error) { err = error; }
  assert.equal(lib.rows('SELECT actor FROM audit WHERE seq = ?', seq)[0].actor, 'ada@example.test');
  assert.equal(err && err.code, 'AUDIT_ERASURE');
  const before = sqlOf(lib).exec('SELECT n FROM audit_anchor').toArray()[0].n;
  const result = lib.rewriteAudit(TOKEN, [seq]);
  assert.equal(result.changed, 1);
  const row = lib.rows('SELECT actor, detail FROM audit WHERE seq = ?', seq)[0];
  assert.equal(row.actor, TOKEN);
  assert.equal(row.detail, '');
  const meta = lib.rows("SELECT action, detail FROM audit WHERE action = 'audit erasure'");
  assert.equal(meta.length, 1);
  assert.equal(String(meta[0].detail).includes('the note'), false);
  assert.equal(String(meta[0].detail).includes('ada@example.test'), false);
  assert.ok(sqlOf(lib).exec('SELECT n FROM audit_anchor').toArray()[0].n > before);
});
