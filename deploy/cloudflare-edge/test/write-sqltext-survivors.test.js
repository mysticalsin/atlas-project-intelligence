// Kills changed-line mutants in sql-text.js that the alias table does not reach.
// Two of them turn a write-shaped string into a proven read. The decision is
// handoff/decisions/sqltext-alias-explain.md. Red is shown by mutants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { hiddenWrite, isMutatingStatement, provenRead } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";

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
function snap(raw) {
  const refs = Number(raw.exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n);
  const title = raw.exec("SELECT title FROM refs WHERE id = 'r1'").toArray()[0].title;
  const audit = Number(raw.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n);
  return refs + ' ' + title + ' ' + audit;
}
function doors(sql, primaryCode, fallbackCode) {
  const raw = memorySql();
  const lib = new Library(raw, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec(REFS_SEED));
  const before = snap(raw);
  const primary = codeOf(() => lib.exec(sql));
  const after = snap(raw);
  let fallback = 'SKIP';
  hide(() => {
    const inner = memorySql();
    const shut = new Library({ exec: inner.exec.bind(inner), transactionSync: inner.transactionSync.bind(inner) }, { auditKey: SALT, now: () => STAMP });
    shut.recorded(() => shut.exec(REFS_SEED));
    const prior = snap(inner);
    fallback = codeOf(() => shut.exec(sql));
    assert.equal(snap(inner), prior, sql);
  });
  assert.equal(primary, primaryCode, sql);
  assert.equal(fallback, fallbackCode, sql);
  assert.equal(after, before, sql);
}
function classify(sql, read, mut, hid) {
  assert.equal(provenRead(sql), read, sql);
  assert.equal(isMutatingStatement(sql), mut, sql);
  assert.equal(hiddenWrite(sql), hid, sql);
}

test('a trailing word other than vacuum or reindex is not a proven read', () => {
  const writes = [
    'SELECT 1 DROP',
    'SELECT 1 DROP FROM refs',
    'SELECT 1 DROP;',
    'SELECT 1 CREATE',
    'SELECT 1 CREATE TABLE t(a)',
    'SELECT 1 ALTER',
    'SELECT 1 ALTER TABLE refs RENAME TO x',
    'SELECT 1 ATTACH',
    "SELECT 1 ATTACH 'x' AS other",
    'SELECT 1 DETACH',
    'SELECT 1 DETACH other',
    'SELECT 1 PRAGMA',
    'SELECT 1 FROM refs DROP',
    'SELECT 1 WHERE DROP',
    'SELECT 1 GROUP BY DROP',
    'SELECT 1 HAVING DROP',
    'SELECT 1 ORDER BY DROP',
    'SELECT 1 LIMIT DROP',
    'SELECT 1 OFFSET DROP',
    'VALUES (1) DROP',
    'VALUES (1) DROP FROM refs',
    'WITH x AS (SELECT 1) SELECT 1 DROP FROM refs',
    'EXPLAIN QUERY PLAN SELECT 1 DROP FROM refs',
  ];
  for (const sql of writes) {
    classify(sql, false, true, sql.startsWith('WITH') || sql.startsWith('EXPLAIN'));
    doors(sql, 'SQL_DOOR', 'SQL_DOOR');
  }
});

test('a with-write inside explain query plan is not a proven read', () => {
  const plans = [
    'EXPLAIN QUERY PLAN WITH x AS (SELECT 1) DELETE FROM refs',
    "EXPLAIN QUERY PLAN WITH x AS (SELECT 1) INSERT INTO refs (id) VALUES ('z')",
    "EXPLAIN QUERY PLAN WITH x AS (SELECT 1) UPDATE refs SET title = 'z'",
  ];
  for (const sql of plans) {
    classify(sql, false, false, false);
    doors(sql, 'ALLOW', 'SQL_DOOR');
  }
});

test('empty text and a comment are not a mutation', () => {
  for (const sql of ['', ' ', '   ', '\n', '\t', '-- c\n', '/* c */']) {
    assert.equal(isMutatingStatement(sql), false, JSON.stringify(sql));
  }
});

test('a second pragma inside an explain plan is a hidden write', () => {
  const sql = 'EXPLAIN QUERY PLAN PRAGMA user_version PRAGMA writable_schema = ON';
  assert.equal(hiddenWrite(sql), true, sql);
});

test('explain analyze stays a hidden write', () => {
  classify('EXPLAIN ANALYZE', false, true, true);
  classify('EXPLAIN ANALYZE refs', false, true, true);
  doors('EXPLAIN ANALYZE', 'SQL_DOOR', 'SQL_DOOR');
  doors('EXPLAIN ANALYZE refs', 'SQL_DOOR', 'SQL_DOOR');
});

test('a vacuum alias survives a group, order, limit, offset, or set clause', () => {
  const reads = [
    'SELECT 1 VACUUM GROUP BY 1',
    'SELECT 1 REINDEX GROUP BY 1',
    'SELECT 1 VACUUM ORDER BY 1',
    'SELECT 1 VACUUM LIMIT 1',
    'SELECT 1 VACUUM LIMIT 1 OFFSET 0',
    'SELECT 1 VACUUM UNION SELECT 2',
    'SELECT 1 VACUUM EXCEPT SELECT 2',
    'SELECT 1 VACUUM INTERSECT SELECT 2',
    'SELECT 1 VACUUM;',
    'SELECT 1 REINDEX;',
  ];
  for (const sql of reads) {
    classify(sql, true, false, false);
    doors(sql, 'ALLOW', 'ALLOW');
  }
  classify('SELECT 1 VACUUM HAVING 1', true, false, false);
  classify('SELECT 1 VACUUM OFFSET 0', true, false, false);
});
