// Sentinel on dd87761f. A parenthesis hidden in a quoted name must not make
// WITH ... DELETE a proven read. The fallback door is no statementTail and no
// node:sqlite. Nested parentheses stay a statement boundary too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { provenRead, isMutatingStatement } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const BRACKET = 'WITH a AS (SELECT 1 AS [x(]) DELETE FROM refs';
const TICK = 'WITH a AS (SELECT 1 AS `x(`) DELETE FROM refs';
const QUOTED = 'WITH a AS (SELECT 1 AS "x(") DELETE FROM refs';
const NESTED = 'WITH a AS ((SELECT 1 AS [x(])) DELETE FROM refs';

function hide(run) {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  try { return run(); }
  finally { process.getBuiltinModule = orig; }
}

function codeOf(fn) {
  try { fn(); return 'ALLOW'; }
  catch (error) { return error.code || 'ERR'; }
}

function refuses(sql, mutating) {
  assert.equal(provenRead(sql), false, sql);
  if (mutating) assert.equal(isMutatingStatement(sql), true, sql);
  hide(() => {
    const raw = memorySql();
    const lib = new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
    assert.equal(codeOf(() => lib.exec(sql)), 'SQL_DOOR', sql);
  });
}

test('a bracketed parenthesis does not hide a CTE delete on the fallback door', () => {
  refuses(BRACKET, true);
});

test('a backtick parenthesis does not hide a CTE delete on the fallback door', () => {
  refuses(TICK, true);
});

test('a double-quoted parenthesis does not hide a CTE delete on the fallback door', () => {
  refuses(QUOTED, true);
});

test('nested parentheses do not hide a CTE delete on the fallback door', () => {
  refuses(NESTED);
});
