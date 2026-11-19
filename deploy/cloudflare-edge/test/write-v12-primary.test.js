// Devin on dd87761f. A parenthesis inside a quoted alias or CTE name must not
// make WITH ... DELETE a proven read. The primary door (statementTail) and the
// fallback door (no statementTail, node:sqlite hidden) both refuse it, and the
// row count stays. All four quote styles, for refs and for audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { provenRead } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const STYLES = ['single', 'double', 'bracket', 'tick'];
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";
const REFS_WRITES = [
  'DELETE FROM refs',
  "UPDATE refs SET title = 'wiped'",
  "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('pwn', 'ada@example.test', 'wiped', 'in_review', 1, '{}', '{}')",
  "REPLACE INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'wiped', 'in_review', 1, '{}', '{}')",
];
const AUDIT_WRITES = [
  'DELETE FROM audit',
  "UPDATE audit SET action = 'wiped'",
  "INSERT INTO audit (actor, action, at, detail) VALUES ('x', 'wiped', 't', '{}')",
  "REPLACE INTO audit (seq, actor, action, at, detail) VALUES (1, 'x', 'wiped', 't', '{}')",
];

function wrap(style, payload) {
  if (style === 'single') return "'" + payload.replaceAll("'", "''") + "'";
  if (style === 'double') return '"' + payload.replaceAll('"', '""') + '"';
  if (style === 'bracket') return '[' + payload + ']';
  return '`' + payload.replaceAll('`', '``') + '`';
}
function forms(writes) {
  const out = [];
  for (const style of STYLES) {
    const quoted = wrap(style, 'x(');
    for (const write of writes) {
      out.push('WITH a AS (SELECT 1 AS ' + quoted + ') ' + write);
      out.push('WITH ' + quoted + ' AS (SELECT 1) ' + write);
    }
  }
  return out;
}
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
function seed(lib) {
  lib.recorded(() => lib.exec(REFS_SEED));
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

const REFS = forms(REFS_WRITES);
const AUDIT = forms(AUDIT_WRITES);

test('quoted CTE aliases and names are not proven reads', () => {
  assert.equal(REFS.length, 32);
  assert.equal(AUDIT.length, 32);
  for (const sql of REFS.concat(AUDIT)) assert.equal(provenRead(sql), false, sql);
  assert.equal(provenRead('WITH a AS (SELECT 1 AS [x(]) DELETE FROM refs'), false);
  assert.equal(provenRead('WITH a AS (SELECT 1 AS `x(`) DELETE FROM refs'), false);
  assert.equal(provenRead('WITH a AS (SELECT 1 AS "x(") DELETE FROM refs'), false);
  assert.equal(provenRead("WITH a AS (SELECT 1 AS 'x(') DELETE FROM refs"), false);
});

test('the primary door refuses a quoted CTE write and keeps refs and audit', () => {
  const raw = memorySql();
  const lib = new Library(raw, { auditKey: SALT, now: () => STAMP });
  seed(lib);
  const before = snap(raw);
  assert.equal(before.refs, 1);
  assert.equal(before.title, 'kept');
  assert.equal(before.audit, 1);
  for (const sql of REFS.concat(AUDIT)) {
    assert.equal(codeOf(() => lib.exec(sql)), 'SQL_DOOR', sql);
    unchanged(raw, before, sql);
  }
});

test('the fallback door refuses a quoted CTE write and keeps refs and audit', () => {
  hide(() => {
    const raw = memorySql();
    const lib = new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
    seed(lib);
    const before = snap(raw);
    assert.equal(before.refs, 1);
    assert.equal(before.audit, 1);
    for (const sql of REFS.concat(AUDIT)) {
      assert.equal(codeOf(() => lib.exec(sql)), 'SQL_DOOR', sql);
      unchanged(raw, before, sql);
    }
  });
});

test('explain query plan of one delete stays a description on the primary door', () => {
  const sql = 'EXPLAIN QUERY PLAN DELETE FROM refs';
  assert.equal(provenRead(sql), false);
  const raw = memorySql();
  const lib = new Library(raw, { auditKey: SALT, now: () => STAMP });
  seed(lib);
  const before = snap(raw);
  assert.equal(codeOf(() => lib.exec(sql)), 'ALLOW');
  unchanged(raw, before, sql);
  hide(() => {
    const inner = memorySql();
    const door = new Library({ exec: inner.exec.bind(inner), transactionSync: inner.transactionSync.bind(inner) }, { auditKey: SALT, now: () => STAMP });
    seed(door);
    const innerBefore = snap(inner);
    assert.equal(codeOf(() => door.exec(sql)), 'SQL_DOOR');
    unchanged(inner, innerBefore, sql);
  });
});
