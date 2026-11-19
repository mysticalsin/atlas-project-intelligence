// Cursor bc-fdd1abd4 on ab1850b9. A quoted identifier or an alias is not a
// verb. The fallback door is the production store: no statementTail and no
// node:sqlite. A healthy chain must stay verified there. Standalone
// transaction verbs stay refused on both paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Library } from '../src/library.js';
import { provenRead } from '../src/sql-text.js';
import { verifyChain } from '../src/audit-chain.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const QUOTED = 'SELECT "commit" FROM audit LIMIT 0';
const ALIAS = 'SELECT 1 AS begin';
const STANDALONE = ['ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s', 'RELEASE s'];

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

test('a quoted verb word stays a proven read and a healthy chain stays verified on fallback', () => {
  assert.equal(provenRead(QUOTED), true);
  hide(() => {
    const raw = memorySql();
    const lib = new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
    lib.recorded(() => lib.log('library', 'atlas', 'note', 'seed'));
    assert.equal(codeOf(() => lib.exec(QUOTED)), 'ALLOW');
    const lines = lib.auditLines('library');
    assert.ok(lines.length >= 1);
    assert.equal(lines.some((line) => line.unverified === true), false);
  });
});

test('an aliased verb word stays a proven read on the fallback path', () => {
  assert.equal(provenRead(ALIAS), true);
  assert.equal(provenRead('SELECT 1 AS "commit"'), true);
  hide(() => {
    const raw = memorySql();
    const lib = new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
    assert.equal(codeOf(() => lib.exec(ALIAS)), 'ALLOW');
  });
});

test('standalone ANALYZE and transaction control stay refused on both paths', () => {
  const native = memorySql();
  const nativeLib = new Library(native, { auditKey: SALT, now: () => STAMP });
  const raw = memorySql();
  const fallbackLib = new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
  for (const sql of STANDALONE) {
    assert.equal(codeOf(() => nativeLib.exec(sql)), 'SQL_DOOR', sql + ' native');
    assert.equal(hide(() => codeOf(() => fallbackLib.exec(sql))), 'SQL_DOOR', sql + ' fallback');
  }
});

test('a signed row before the chain start stays tampered', () => {
  const driver = memorySql();
  new Library(driver, { auditKey: SALT, now: () => STAMP });
  driver.exec(
    'INSERT INTO audit (seq, id, actor, action, at, detail, prev_hash, hash, "commit", tombstone) VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'story', 'ada@example.test', 'saved', STAMP, 'note', '0'.repeat(64), 'aa', 'bb', ''
  );
  const verdict = verifyChain(driver, SALT, '');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'TAMPERED');
});

test('classifyChain keeps the missing-start and signed-before refusals', () => {
  const src = readFileSync(new URL('../src/audit-chain.js', import.meta.url), 'utf8');
  const from = src.indexOf('function classifyChain');
  const to = src.indexOf('function appendChainStart');
  const body = src.slice(from, to);
  assert.match(body, /if \(start === null\) return 'tampered';/);
  assert.match(body, /if \(signedBefore !== false\) return 'tampered';/);
});
