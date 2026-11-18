// Sentinel on 9d47ae2b: a production open without LOG_SALT must not burn the audit migration.
// These fail on that tree. Rollback checks use test/sqlite.js, a node:sqlite stand-in, not workerd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { appendAudit, auditKey, ensureChain, verifyChain, verifyDaily, GENESIS } from '../src/audit-chain.js';

const EMAIL = 'ada@example.test';
const STAMP = '2026-11-16T00:00:00.000Z';
const SALT = 'synthetic-log-salt';
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const MAIN_COLS = ['seq', 'id', 'actor', 'action', 'at', 'detail'];
const PROD = { DATA_MODE: 'production' };
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });

function columns(sql) {
  return sql.exec("SELECT name FROM pragma_table_info('audit')").toArray().map(row => row.name);
}
function rows(sql) {
  return sql.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n;
}
function anchorTable(sql) {
  return sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit_anchor'").toArray()[0].n;
}
function mainShaped(sql, count) {
  assert.deepEqual(columns(sql), MAIN_COLS);
  assert.equal(rows(sql), count);
  assert.equal(anchorTable(sql), 0);
}
function legacy(sql) {
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'legacy');
}
function open(sql, key) {
  return new Library(sql, { now: () => STAMP, auditKey: key });
}
function refused(sql, key) {
  assert.throws(() => open(sql, key), err => err.status === 503 && err.code === 'LOG_SALT');
}

test('a production env without LOG_SALT leaves an empty table main-shaped', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  assert.equal(auditKey(PROD), null);
  refused(sql, auditKey(PROD));
  mainShaped(sql, 0);
  ensureChain(fresh(sql), null, fn => sql.transactionSync(fn));
  verifyChain(fresh(sql), null);
  verifyDaily(fresh(sql), null);
  mainShaped(sql, 0);
});

test('a production env without LOG_SALT leaves a main-shaped table with its rows', () => {
  const sql = memorySql();
  legacy(sql);
  refused(sql, auditKey(PROD));
  mainShaped(sql, 1);
  const actor = sql.exec('SELECT actor, action, detail FROM audit').toArray()[0];
  assert.equal(actor.actor, EMAIL);
  assert.equal(actor.detail, 'legacy');
});

test('opening with no key, then with LOG_SALT, migrates and verifies', () => {
  const sql = memorySql();
  legacy(sql);
  refused(sql, null);
  mainShaped(sql, 1);
  open(sql, SALT);
  const daily = verifyDaily(sql, SALT);
  assert.equal(daily.ok, true);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  assert.equal(sql.exec('SELECT prev_hash, "commit" FROM audit WHERE action = ?', 'chain-start').toArray()[0].prev_hash, GENESIS);
  appendAudit(sql, { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'after' }, SALT);
  assert.equal(verifyDaily(fresh(sql), SALT).reason, 'CHAIN_VERIFIED');
});

test('opening with no key twice, then with LOG_SALT, migrates and verifies', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  refused(sql, auditKey(PROD));
  refused(sql, null);
  mainShaped(sql, 0);
  open(sql, auditKey({ DATA_MODE: 'production', LOG_SALT: SALT }));
  assert.equal(verifyDaily(sql, SALT).reason, 'CHAIN_VERIFIED');
  appendAudit(sql, { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'after' }, SALT);
  assert.equal(verifyChain(fresh(sql), SALT).ok, true);
});

test('no key on an already-migrated chain refuses construction, returns LOG_SALT, and does not re-migrate', () => {
  const sql = memorySql();
  legacy(sql);
  const lib = open(sql, SALT);
  lib.log('story', EMAIL, 'saved', 'kept');
  verifyDaily(sql, SALT);
  const before = sql.exec('SELECT seq, action, "commit" FROM audit ORDER BY seq').toArray();
  const anchor = sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray();
  refused(sql, null);
  const verdict = verifyChain(fresh(sql), null);
  assert.equal(verdict.reason, 'LOG_SALT');
  assert.notEqual(verdict.reason, 'TAMPERED');
  assert.equal(verifyDaily(fresh(sql), null).reason, 'LOG_SALT');
  assert.throws(() => appendAudit(sql, { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'nope' }, null), err => err.status === 503);
  assert.deepEqual(sql.exec('SELECT seq, action, "commit" FROM audit ORDER BY seq').toArray(), before);
  assert.deepEqual(sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray(), anchor);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM audit WHERE action = 'chain-start'").toArray()[0].n, 1);
});

test('non-production key fallbacks are unchanged', () => {
  assert.equal(auditKey(undefined), '');
  assert.equal(auditKey({}), '');
  assert.equal(auditKey({ DATA_MODE: 'local' }), '');
  assert.equal(auditKey({ CSRF_SECRET: 'csrf-demo' }), 'subject-v1:csrf-demo');
  assert.equal(auditKey({ DATA_MODE: 'production', LOG_SALT: SALT }), SALT);
  assert.equal(auditKey(PROD), null);

  const empty = memorySql();
  empty.exec(MAIN);
  open(empty, '');
  assert.equal(verifyDaily(empty, '').reason, 'CHAIN_VERIFIED');

  const derived = memorySql();
  derived.exec(MAIN);
  const key = auditKey({ CSRF_SECRET: 'csrf-demo' });
  open(derived, key);
  assert.equal(verifyDaily(derived, key).reason, 'CHAIN_VERIFIED');
  assert.equal(verifyDaily(fresh(derived), '').reason, 'COMMIT_MISMATCH');
});
