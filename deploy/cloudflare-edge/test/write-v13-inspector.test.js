// Inspector 4c1ee8f4 on 8cdef06, Low. A bare write verb inside parentheses
// is not a proven read. SQLite rejects these today. Both doors still return
// SQL_DOOR, and the row stays. REPLACE( is a function. REPLACE INTO is a write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { provenRead } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";
const NESTED = [
  'SELECT (DELETE FROM audit)',
  'SELECT 1 FROM (DELETE FROM audit)',
  "SELECT (UPDATE audit SET action = 'w')",
  "SELECT 1 FROM (UPDATE audit SET action = 'w')",
  "SELECT (INSERT INTO audit (actor) VALUES ('x'))",
  "SELECT 1 FROM (INSERT INTO audit (actor) VALUES ('x'))",
  'SELECT (DROP TABLE audit)',
  'SELECT 1 FROM (DROP TABLE audit)',
  'SELECT (ALTER TABLE refs RENAME TO gone)',
  'SELECT 1 FROM (ALTER TABLE refs RENAME TO gone)',
  'SELECT (CREATE TABLE gone (id TEXT))',
  'SELECT 1 FROM (CREATE TABLE gone (id TEXT))',
  "SELECT (ATTACH 'x' AS other)",
  "SELECT 1 FROM (ATTACH 'x' AS other)",
  'SELECT (DETACH other)',
  'SELECT 1 FROM (DETACH other)',
  'SELECT (PRAGMA user_version)',
  'SELECT 1 FROM (PRAGMA user_version)',
  'SELECT (VACUUM)',
  'SELECT 1 FROM (VACUUM)',
  'SELECT (REINDEX)',
  'SELECT 1 FROM (REINDEX)',
  'SELECT (ANALYZE)',
  'SELECT 1 FROM (ANALYZE)',
  "SELECT (REPLACE INTO refs (id) VALUES ('pwn'))",
  "SELECT 1 FROM (REPLACE INTO refs (id) VALUES ('pwn'))",
];
const READS = [
  "SELECT REPLACE(title, 'a', 'b') FROM refs",
  "SELECT (REPLACE(title, 'a', 'b')) FROM refs",
  'SELECT 1 AS "delete"',
  'SELECT 1 AS "drop"',
  'SELECT 1 FROM (SELECT 2) ANALYZE',
  'WITH x AS (SELECT 1) SELECT 2',
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
function doors(cases, expectCode) {
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  for (const sql of cases) {
    assert.equal(codeOf(() => lib.exec(sql)), expectCode, sql);
    unchanged(raw, before, sql);
  }
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    for (const sql of cases) {
      assert.equal(codeOf(() => door.exec(sql)), expectCode, 'fallback ' + sql);
      unchanged(inner, innerBefore, sql);
    }
  });
}

test('a parenthesised write verb is not a proven read', () => {
  assert.equal(NESTED.length, 26);
  assert.ok(NESTED.includes('SELECT (DELETE FROM audit)'));
  assert.ok(NESTED.includes('SELECT 1 FROM (DELETE FROM audit)'));
  assert.ok(NESTED.includes('SELECT (DROP TABLE audit)'));
  assert.ok(NESTED.includes('SELECT (VACUUM)'));
  assert.ok(NESTED.includes('SELECT (PRAGMA user_version)'));
  for (const sql of NESTED) assert.equal(provenRead(sql), false, sql);
  doors(NESTED, 'SQL_DOOR');
});

test('REPLACE( stays a function and a depth-0 alias stays a read', () => {
  for (const sql of READS) assert.equal(provenRead(sql), true, sql);
  assert.equal(provenRead('SELECT 1 AS delete'), true);
  assert.equal(provenRead('SELECT 1 AS replace'), true);
  doors(READS, 'ALLOW');
});
