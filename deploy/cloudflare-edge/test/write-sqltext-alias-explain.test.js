// ATLAS-SQLTEXT-ALIAS-VERB-INCONSISTENT and
// ATLAS-SQLTEXT-EXPLAIN-TRAILING-VERB-READ.
// A bare VACUUM or REINDEX after a read can be a column or table alias.
// A real VACUUM or REINDEX statement stays a write. EXPLAIN QUERY PLAN of
// one write verb returns a plan on the primary door and is not a proven
// read. A second verb, a nested write, or VACUUM outside alias position
// is a write on both doors. The decision is
// handoff/decisions/sqltext-alias-explain.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { hiddenWrite, isMutatingStatement, provenRead } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";
const INSERT = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r2', 'ada@example.test', 'added', 'in_review', 1, '{}', '{}')";
const UPDATE = "UPDATE refs SET title = 'changed' WHERE id = 'r1'";
const DELETE = 'DELETE FROM refs';

function allow(sql) {
  return { sql, read: true, mut: false, hid: false, primary: 'ALLOW', fallback: 'ALLOW' };
}
function write(sql, hid) {
  return { sql, read: false, mut: true, hid, primary: 'SQL_DOOR', fallback: 'SQL_DOOR' };
}
function plan(sql) {
  return { sql, read: false, mut: false, hid: false, primary: 'ALLOW', fallback: 'SQL_DOOR' };
}

const TABLE = [
  allow('SELECT 1 VACUUM'),
  allow('SELECT 1 REINDEX'),
  allow('select 1 vacuum'),
  allow('SeLeCt 1 ReInDeX'),
  allow('SELECT 1 /* c */ VACUUM'),
  allow('/* c */ SELECT 1 REINDEX'),
  allow('SELECT 1 AS VACUUM'),
  allow('SELECT 1 AS reindex'),
  allow('SELECT 1 "VACUUM"'),
  allow('SELECT 1 [REINDEX]'),
  allow('SELECT 1 `VACUUM`'),
  allow('SELECT 1 VACUUM FROM refs'),
  allow('SELECT 1 FROM refs VACUUM'),
  allow('SELECT 1 FROM refs REINDEX'),
  allow('SELECT 1 vacuum WHERE 1'),
  allow('WITH x AS (SELECT 1) SELECT 1 VACUUM'),
  allow('EXPLAIN QUERY PLAN SELECT 1'),
  allow('EXPLAIN QUERY PLAN SELECT 1 VACUUM'),
  allow('EXPLAIN QUERY PLAN SELECT 1 FROM refs REINDEX'),
  allow('explain query plan select 1'),
  allow('EXPLAIN QUERY PLAN PRAGMA table_info(refs)'),
  allow('EXPLAIN QUERY PLAN SELECT 1 FROM (SELECT 2) ANALYZE'),

  write('VACUUM', false),
  write('vAcUuM', false),
  write('VACUUM main', false),
  write('REINDEX', false),
  write('rEiNdEx', false),
  write('REINDEX refs', false),
  write(DELETE, false),
  write('dElEtE fRoM refs', false),
  write(INSERT, false),
  write(UPDATE, false),
  write('SELECT 1 REINDEX refs', false),
  write('SELECT 1 VACUUM main', false),
  write('SELECT 1 VACUUM, 2', false),
  write('SELECT (VACUUM)', false),
  write('SELECT (REINDEX)', false),
  write('SELECT 1 DROP TABLE refs', false),
  write('WITH x AS (SELECT 1) VACUUM', true),
  write('WITH x AS (SELECT 1) REINDEX', true),
  write('EXPLAIN ' + DELETE, true),
  write('EXPLAIN ' + INSERT, true),
  write('EXPLAIN ' + UPDATE, true),
  write('EXPLAIN VACUUM', true),
  write('EXPLAIN REINDEX', true),
  write('eXpLaIn DeLeTe FrOm refs', true),
  write('EXPLAIN /* c */ DELETE FROM refs', true),
  write('EXPLAIN /* c */ VACUUM', true),
  write('EXPLAIN /* c */ REINDEX', true),
  write('EXPLAIN PRAGMA writable_schema = ON', true),
  write('EXPLAIN QUERY PLAN SELECT 1 DELETE FROM refs', true),
  write('EXPLAIN QUERY PLAN SELECT 1 DROP TABLE refs', true),
  write('EXPLAIN QUERY PLAN SELECT 1 ' + INSERT, true),
  write('EXPLAIN QUERY PLAN SELECT 1 ' + UPDATE, true),
  write('EXPLAIN QUERY PLAN DELETE FROM refs VACUUM', true),
  write('EXPLAIN QUERY PLAN SELECT (DELETE FROM refs)', true),
  write('EXPLAIN QUERY PLAN WITH x AS (DELETE FROM refs RETURNING id) SELECT 1', true),
  write('/* x */ EXPLAIN QUERY PLAN DELETE FROM refs', true),
  write('EXPLAIN QUERY PLAN PRAGMA writable_schema = ON', false),

  plan('EXPLAIN QUERY PLAN ' + DELETE),
  plan('EXPLAIN QUERY PLAN ' + INSERT),
  plan('EXPLAIN QUERY PLAN ' + UPDATE),
  plan('EXPLAIN QUERY PLAN VACUUM'),
  plan('EXPLAIN QUERY PLAN REINDEX'),
  plan('explain query plan delete from refs'),
  plan('EXPLAIN /* c */ QUERY PLAN DELETE FROM refs'),
  plan('EXPLAIN QUERY PLAN /* c */ DELETE FROM refs'),
  plan('EXPLAIN QUERY PLAN /* c */ ' + INSERT),
  plan('EXPLAIN QUERY PLAN /* c */ ' + UPDATE),
  plan('EXPLAIN QUERY PLAN /* c */ VACUUM'),
  plan('EXPLAIN QUERY PLAN /* c */ REINDEX'),
  plan('eXpLaIn QuErY pLaN vAcUuM'),
  plan('eXpLaIn QuErY pLaN rEiNdEx'),
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
function changed(after, before) {
  return after.refs !== before.refs || after.title !== before.title || after.audit !== before.audit || after.chain !== before.chain;
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
function collect(raw, lib, cases, expectCode, bad, label) {
  seed(lib);
  const before = snap(raw);
  for (const sql of cases) {
    const code = codeOf(() => lib.exec(sql));
    if (code !== expectCode) bad.push(label + ' ' + code + ' !== ' + expectCode + ' ' + sql);
    let after;
    try { after = snap(raw); }
    catch (err) { bad.push(label + ' snap ' + sql + ' ' + err.message); continue; }
    if (changed(after, before)) bad.push(label + ' changed ' + sql);
  }
}
function collectSame(cases, expectCode, bad) {
  if (!cases.length) return;
  const raw = memorySql();
  collect(raw, open(raw), cases, expectCode, bad, 'primary');
  hide(() => {
    const inner = memorySql();
    collect(inner, shut(inner), cases, expectCode, bad, 'fallback');
  });
}
function collectPlan(cases, bad) {
  if (!cases.length) return;
  const raw = memorySql();
  collect(raw, open(raw), cases, 'ALLOW', bad, 'primary');
  hide(() => {
    const inner = memorySql();
    collect(inner, shut(inner), cases, 'SQL_DOOR', bad, 'fallback');
  });
}

test('alias and explain table', () => {
  assert.equal(TABLE.length, 73);
  const bad = [];
  for (const row of TABLE) {
    let got;
    try {
      got = { read: provenRead(row.sql), mut: isMutatingStatement(row.sql), hid: hiddenWrite(row.sql) };
    } catch (err) {
      bad.push('classify ' + row.sql + ' ' + err.message);
      continue;
    }
    if (got.read !== row.read) bad.push(row.sql + ' read ' + got.read + ' !== ' + row.read);
    if (got.mut !== row.mut) bad.push(row.sql + ' mut ' + got.mut + ' !== ' + row.mut);
    if (got.hid !== row.hid) bad.push(row.sql + ' hid ' + got.hid + ' !== ' + row.hid);
  }
  collectSame(TABLE.filter((row) => row.primary === 'ALLOW' && row.fallback === 'ALLOW').map((row) => row.sql), 'ALLOW', bad);
  collectSame(TABLE.filter((row) => row.primary === 'SQL_DOOR' && row.fallback === 'SQL_DOOR').map((row) => row.sql), 'SQL_DOOR', bad);
  collectPlan(TABLE.filter((row) => row.primary === 'ALLOW' && row.fallback === 'SQL_DOOR').map((row) => row.sql), bad);
  assert.deepEqual(bad, []);
});
