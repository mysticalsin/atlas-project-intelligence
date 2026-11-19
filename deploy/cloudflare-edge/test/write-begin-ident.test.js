// Without statementTail or node:sqlite, an identifier begin must not hide a second statement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Library } from '../src/library.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

function bareDriver() {
  const db = new DatabaseSync(':memory:');
  const exec = (q, ...params) => {
    let rest = String(q ?? '');
    let rows = [];
    let offset = 0;
    while (rest.trim()) {
      rest = rest.replace(/^(\s*;)+/, '');
      if (!rest.trim()) break;
      const stmt = db.prepare(rest);
      const src = stmt.sourceSQL;
      const marks = (src.match(/\?/g) || []).length;
      const slice = params.slice(offset, offset + marks);
      offset += marks;
      rows = stmt.all(...slice);
      rest = rest.slice(src.length);
    }
    return { toArray: () => rows.map((row) => ({ ...row })) };
  };
  const transactionSync = (fn) => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already closed */ }
      throw error;
    }
  };
  return { exec, transactionSync };
}

test('an identifier begin does not hide a following delete', () => {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  let left = 0;
  let err;
  try {
    const lib = new Library(bareDriver(), { auditKey: SALT, now: () => STAMP });
    lib.schema(() => lib.exec('CREATE TABLE teams_seen (activity_id TEXT PRIMARY KEY, at TEXT)'));
    lib.recorded(() => lib.exec("INSERT INTO teams_seen (activity_id, at) VALUES ('a', '2020-01-01')"));
    try {
      lib.exec("EXPLAIN QUERY PLAN CREATE TRIGGER t BEFORE DELETE ON teams_seen BEGIN SELECT 1 AS begin; END; DELETE FROM teams_seen");
    } catch (error) { err = error; }
    left = lib.rows('SELECT COUNT(*) AS n FROM teams_seen')[0].n;
  } finally {
    process.getBuiltinModule = orig;
  }
  assert.equal(left, 1);
  assert.equal(err && err.code, 'SQL_MULTI');
});
