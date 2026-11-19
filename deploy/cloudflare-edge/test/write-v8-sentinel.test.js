// Sentinel residuals on b9d1ac13. Temp creates, a token-based writable_schema
// refusal, a captured Math.max, rename onto a protected name, and the
// schema pragma-setter list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

function native() {
  const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.log('library', 'atlas', 'note', 'seed'));
  return lib;
}

function fallback() {
  const raw = memorySql();
  const lib = new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.log('library', 'atlas', 'note', 'seed'));
  return lib;
}

function hide(run) {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  try { return run(); }
  finally { process.getBuiltinModule = orig; }
}

function run(lib, sql, door) {
  let err;
  try {
    if (door === 'recorded') lib.recorded(() => lib.exec(sql));
    else if (door === 'schema') lib.schema(() => lib.exec(sql));
    else if (door === 'house') lib.housekeeping('teams-seen', () => lib.exec(sql));
    else lib.exec(sql);
  } catch (error) { err = error; }
  return err ? (err.code || 'ERR') : 'ALLOW';
}

function tempNames(lib) {
  return lib.rows('SELECT name FROM sqlite_temp_master').map((row) => row.name);
}

test('recorded refuses a temp or temporary qualifier on a protected create', () => {
  const cases = [
    'CREATE TABLE temp.audit (id TEXT)',
    'CREATE TABLE "temp".audit (id TEXT)',
    'CREATE VIEW temp.audit AS SELECT 1 AS id',
    'CREATE VIRTUAL TABLE temp.audit USING fts4(x)',
    'CREATE TEMP VIRTUAL TABLE audit USING fts4(x)',
    'CREATE TEMPORARY VIRTUAL TABLE consent_receipts USING fts4(x)',
    'CREATE TEMP INDEX audit ON refs(owner)',
    'CREATE TEMPORARY INDEX audit_anchor ON refs(owner)',
    'CREATE INDEX temporary.privacy_gate ON refs(owner)',
    'CREATE TEMP TRIGGER audit BEFORE UPDATE ON refs BEGIN SELECT 1; END',
    'CREATE TRIGGER temp.consent_receipts BEFORE UPDATE ON refs BEGIN SELECT 1; END',
  ];
  for (const sql of cases) {
    const lib = native();
    const code = run(lib, sql, 'recorded');
    assert.equal(code, 'SQL_DOOR', sql);
    assert.equal(tempNames(lib).includes('audit'), false, sql);
    assert.equal(lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'audit'")[0].n, 1, sql);
    const other = hide(() => run(fallback(), sql, 'recorded'));
    assert.equal(other, 'SQL_DOOR', sql);
  }
});

test('writable_schema assignment is refused from tokens in every door', () => {
  const cases = [
    ['PRAGMA "writable_schema" = ON', 'direct'],
    ['PRAGMA "writable_schema" = ON', 'recorded'],
    ['PRAGMA "writable_schema" = ON', 'schema'],
    ['PRAGMA "writable_schema" = ON', 'house'],
    ['PRAGMA [writable_schema] = ON', 'schema'],
    ['PRAGMA `writable_schema` = ON', 'schema'],
    ['PRAGMA writable_schema /*c*/ = ON', 'schema'],
    ['PRAGMA writable_schema /*c*/ (1)', 'direct'],
    ['PRAGMA "main"."writable_schema" = ON', 'schema'],
  ];
  for (const [sql, door] of cases) {
    const left = run(native(), sql, door);
    const right = hide(() => run(fallback(), sql, door));
    assert.equal(left, 'SQL_DOOR', sql + ' ' + door);
    assert.equal(right, 'SQL_DOOR', sql + ' ' + door);
    const lib = native();
    run(lib, sql, door);
    assert.equal(lib.rows('PRAGMA writable_schema')[0].writable_schema, 0, sql + ' ' + door);
  }
});

test('a patched Math.max cannot hide a delete after a parenthesis', () => {
  const orig = Math.max;
  Math.max = (a, b) => (a === 0 ? 99 : orig(a, b));
  try {
    const lib = native();
    lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
    const code = run(lib, 'WITH c AS (SELECT 1) DELETE FROM refs', 'direct');
    assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
    assert.equal(code, 'SQL_DOOR');
  } finally {
    Math.max = orig;
  }
});

test('recorded refuses ALTER TABLE RENAME TO a protected name', () => {
  const cases = [
    'ALTER TABLE refs RENAME TO consent_receipts',
    'ALTER TABLE refs RENAME TO audit',
    'ALTER TABLE refs RENAME TO "audit_anchor"',
    'ALTER TABLE refs RENAME TO privacy_gate',
  ];
  for (const sql of cases) {
    const lib = native();
    const code = run(lib, sql, 'recorded');
    assert.equal(code, 'SQL_DOOR', sql);
    assert.equal(lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'refs'")[0].n, 1, sql);
    assert.equal(hide(() => run(fallback(), sql, 'recorded')), 'SQL_DOOR', sql);
  }
});

test('schema and registered doors set only user_version and foreign_keys', () => {
  const refused = [
    'PRAGMA journal_mode = WAL',
    'PRAGMA schema_version = 1',
    'PRAGMA nosuch = 1',
    'PRAGMA optimize',
  ];
  for (const sql of refused) {
    const lib = native();
    assert.equal(run(lib, sql, 'schema'), 'SQL_DOOR', sql);
    assert.equal(hide(() => run(fallback(), sql, 'schema')), 'SQL_DOOR', sql);
  }
  const allowed = native();
  assert.equal(run(allowed, 'PRAGMA user_version = 7', 'schema'), 'ALLOW');
  assert.equal(allowed.rows('PRAGMA user_version')[0].user_version, 7);
  assert.equal(run(allowed, 'PRAGMA foreign_keys = ON', 'schema'), 'ALLOW');
});
