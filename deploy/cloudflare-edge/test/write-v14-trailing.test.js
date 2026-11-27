// Cursor bc-fcb6e581 on 8cdef062..3c5924b, Low. A read followed by
// DROP, CREATE, ALTER, or ATTACH is not a proven read. SQLite rejects the
// text. Both doors still return SQL_DOOR, and refs and audit stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { provenRead } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";
const CASES = [
  'SELECT 1 DROP TABLE refs',
  'SELECT 1 DROP TABLE audit',
  'SELECT 1 CREATE TABLE refs (id TEXT)',
  'SELECT 1 CREATE TABLE audit (id TEXT)',
  'SELECT 1 ALTER TABLE refs RENAME TO gone',
  'SELECT 1 ALTER TABLE audit RENAME TO gone',
  "SELECT 1 ATTACH 'refs' AS other",
  "SELECT 1 ATTACH 'audit' AS other",
];

function hide(run) {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  try { return run(); }
  finally { process.getBuiltinModule = orig; }
}
function codeOf(run) {
  try { run(); return 'ALLOW'; }
  catch (err) { return err.code || 'ERR'; }
}
function refsCount(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n);
}
function refsTitle(raw) {
  return raw.exec("SELECT title FROM refs WHERE id = 'r1'").toArray()[0].title;
}
function auditCount(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n);
}
function chainOf(raw) {
  return raw.exec('SELECT seq, action, "commit" FROM audit ORDER BY seq').toArray()
    .map((row) => row.seq + ' ' + row.action + ' ' + row.commit).join('\n');
}
function snap(raw) {
  return { refs: refsCount(raw), title: refsTitle(raw), audit: auditCount(raw), chain: chainOf(raw) };
}
function unchanged(raw, before, sql) {
  const after = snap(raw);
  assert.equal(after.refs, before.refs, sql);
  assert.equal(after.title, before.title, sql);
  assert.equal(after.audit, before.audit, sql);
  assert.equal(after.chain, before.chain, sql);
}
function open(raw) {
  return new Library(raw, { auditKey: SALT, now: () => STAMP });
}
function shut(raw) {
  return new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
}
function seed(lib) {
  lib.recorded(() => lib.exec(REFS_SEED));
}

test('a read followed by drop, create, alter, or attach is not a proven read', () => {
  assert.equal(CASES.length, 8);
  for (const sql of CASES) assert.equal(provenRead(sql), false, sql);
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  for (const sql of CASES) {
    assert.equal(codeOf(() => lib.exec(sql)), 'SQL_DOOR', sql);
    unchanged(raw, before, sql);
  }
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    for (const sql of CASES) {
      assert.equal(codeOf(() => door.exec(sql)), 'SQL_DOOR', 'fallback ' + sql);
      unchanged(inner, innerBefore, sql);
    }
  });
});
