// Devin's partial gate on 8cdef06. Paren depth, a hidden-DELETE ?1, and one
// explicit block comment. Both doors. The row count stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { provenRead } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";
const NESTED_DELETE = 'WITH x AS (SELECT (1) FROM (SELECT 2)) DELETE FROM refs';
const NESTED_READ = 'WITH x AS (SELECT (1) FROM (SELECT 2)) SELECT title FROM refs';
const NESTED_DROP = 'WITH x AS (SELECT (1) FROM (SELECT 2)) DROP TABLE refs';
const Q1_HIDDEN = "WITH x AS (SELECT ?1(') ) DELETE FROM refs";
const Q1_AFTER = 'SELECT ?1 DELETE FROM refs';
const COMMENT_READ = 'SELECT /* delete */ 1 FROM refs';
const COMMENT_WRITE = 'WITH /*(*/ "x(" AS (SELECT 1) /*;*/ DELETE FROM refs';

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

test('a nested parenthesis does not hide a depth-0 delete', () => {
  assert.equal(provenRead(NESTED_DELETE), false);
  assert.equal(provenRead(NESTED_DELETE.replace('refs', 'audit')), false);
  doors([NESTED_DELETE, NESTED_DELETE.replace('refs', 'audit')], 'SQL_DOOR');
});

test('a depth greater than zero verb is not the statement verb', () => {
  assert.equal(provenRead(NESTED_READ), true, NESTED_READ);
  assert.equal(provenRead(NESTED_DROP), false, NESTED_DROP);
  doors([NESTED_READ], 'ALLOW');
  doors([NESTED_DROP], 'SQL_DOOR');
});

test('a quoted ?1 suffix does not hide a delete', () => {
  assert.equal(provenRead(Q1_HIDDEN), false, Q1_HIDDEN);
  doors([Q1_HIDDEN], 'SQL_DOOR');
});

test('a delete after ?1 is not a proven read', () => {
  assert.equal(provenRead(Q1_AFTER), false, Q1_AFTER);
  assert.equal(provenRead('SELECT ?1'), true);
  doors([Q1_AFTER], 'SQL_DOOR');
  doors(['SELECT ?1'], 'ALLOW');
});

test('a block comment does not hide or invent a write', () => {
  assert.equal(provenRead(COMMENT_READ), true, COMMENT_READ);
  assert.equal(provenRead(COMMENT_WRITE), false, COMMENT_WRITE);
  assert.equal(provenRead('SELECT 1 /* comment */'), true);
  doors([COMMENT_READ, 'SELECT 1 /* comment */'], 'ALLOW');
  doors([COMMENT_WRITE], 'SQL_DOOR');
});
