// Inspector 27c82cc6 on dd87761f. provenRead of a top-level DELETE after
// WITH x AS (SELECT 1) was true on that head. The verb after the CTE list is
// the statement verb. The bracket alias must not remove the refs row either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { provenRead } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const PLAIN = 'WITH x AS (SELECT 1) DELETE FROM audit';
const BRACKET = 'WITH a AS (SELECT 1 AS [x(]) DELETE FROM refs';
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
function auditCount(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n);
}
function refsRowsLeft(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n);
}

test('WITH x AS (SELECT 1) DELETE FROM audit is not a proven read on either door', () => {
  assert.equal(provenRead(PLAIN), false);
  assert.equal(provenRead('WITH x AS (SELECT 1) UPDATE audit SET action = \'wiped\''), false);
  assert.equal(provenRead('WITH x AS (SELECT 1) INSERT INTO audit (actor, action, at, detail) VALUES (\'x\', \'wiped\', \'t\', \'{}\')'), false);
  const raw = memorySql();
  const lib = new Library(raw, { auditKey: SALT, now: () => STAMP });
  assert.equal(auditCount(raw), 1);
  assert.equal(codeOf(() => lib.exec(PLAIN)), 'SQL_DOOR');
  assert.equal(auditCount(raw), 1);
  hide(() => {
    const inner = memorySql();
    const door = new Library({ exec: inner.exec.bind(inner), transactionSync: inner.transactionSync.bind(inner) }, { auditKey: SALT, now: () => STAMP });
    assert.equal(auditCount(inner), 1);
    assert.equal(codeOf(() => door.exec(PLAIN)), 'SQL_DOOR');
    assert.equal(auditCount(inner), 1);
  });
});

test('a bracketed alias delete leaves the refs row on both doors', () => {
  assert.equal(provenRead(BRACKET), false);
  const raw = memorySql();
  const lib = new Library(raw, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec(REFS_SEED));
  const refsRowsLeftBefore = refsRowsLeft(raw);
  assert.equal(refsRowsLeftBefore, 1);
  assert.equal(codeOf(() => lib.exec(BRACKET)), 'SQL_DOOR');
  const refsRowsLeftAfter = refsRowsLeft(raw);
  assert.equal(refsRowsLeftAfter, 1);
  hide(() => {
    const inner = memorySql();
    const door = new Library({ exec: inner.exec.bind(inner), transactionSync: inner.transactionSync.bind(inner) }, { auditKey: SALT, now: () => STAMP });
    door.recorded(() => door.exec(REFS_SEED));
    const refsRowsLeft = Number(inner.exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n);
    assert.equal(refsRowsLeft, 1);
    assert.equal(codeOf(() => door.exec(BRACKET)), 'SQL_DOOR');
    assert.equal(Number(inner.exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n), 1);
  });
});
