// Cursor review of 2f6448d5. The interrupted migration and a nulled commit fail on that tree.
// Rollback is the node:sqlite stand-in in test/sqlite.js (BEGIN, then ROLLBACK). It is not workerd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { appendAudit, verifyDaily } from '../src/audit-chain.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const EMAIL = 'ada@example.test';
const MALLORY = 'mallory';
const STAMP = '2026-11-16T00:00:00.000Z';
const KEY = 'synthetic-log-salt';
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const MAIN_COLS = ['seq', 'id', 'actor', 'action', 'at', 'detail'];
const DATA = JSON.stringify({ title: 'Story', sector: '', client: { name: 'Acme' }, details: { country: '', serviceLines: [], technologies: [] }, jev: {}, report: {} });
const STATE = JSON.stringify({ tenant: A, validation: { status: 'pending' } });
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });

function anchorOf(sql) {
  return sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
}
function starts(sql) {
  return sql.exec("SELECT COUNT(*) AS n FROM audit WHERE action = 'chain-start'").toArray()[0].n;
}
function columns(sql) {
  return sql.exec("SELECT name FROM pragma_table_info('audit') ORDER BY cid").toArray().map(r => r.name);
}
function objects(sql, name) {
  return sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?", name).toArray()[0].n;
}
// The statement runs, then this exec throws. A caught throw keeps throwing on every
// later exec so the failure still leaves the function. There are eight durable steps:
// four column adds, the chain-start index, the anchor table, the anchor delete, the insert.
function crashAfter(sql, step) {
  let completed = 0;
  let armed = '';
  const kindOf = text => {
    if (/^ALTER TABLE audit ADD COLUMN/i.test(text)) return 'column';
    if (/^CREATE UNIQUE INDEX IF NOT EXISTS audit_one_chain_start/i.test(text)) return 'index';
    if (/^CREATE TABLE IF NOT EXISTS audit_anchor/i.test(text)) return 'anchor-table';
    if (/^DELETE FROM audit_anchor/i.test(text)) return 'anchor-delete';
    if (/^INSERT INTO audit \(seq,/i.test(text)) return 'chain-start';
    return '';
  };
  return {
    exec(q, ...params) {
      if (armed) throw new Error('interrupted after ' + armed);
      const result = sql.exec(q, ...params);
      const kind = kindOf(String(q).replace(/\s+/g, ' ').trim());
      if (!kind) return result;
      completed += 1;
      if (completed >= step) {
        armed = kind;
        throw new Error('interrupted after ' + kind);
      }
      return result;
    },
    transactionSync: fn => sql.transactionSync(fn),
  };
}

test('a throw after each first-migration step leaves the main-shaped table and the next open verifies', () => {
  for (let step = 1; step <= 8; step++) {
    const sql = memorySql();
    sql.exec(MAIN);
    sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'legacy note');
    assert.throws(() => new Library(crashAfter(sql, step), { now: () => STAMP, auditKey: KEY }), /interrupted after/);
    assert.deepEqual(columns(sql), MAIN_COLS, 'step ' + step);
    assert.equal(objects(sql, 'audit_anchor'), 0, 'step ' + step);
    assert.equal(objects(sql, 'audit_one_chain_start'), 0, 'step ' + step);
    assert.equal(starts(sql), 0, 'step ' + step);
    assert.equal(sql.exec('SELECT actor, detail FROM audit').toArray()[0].detail, 'legacy note');
    const lib = new Library(sql, { now: () => STAMP, auditKey: KEY });
    const daily = verifyDaily(lib.sql, KEY);
    assert.equal(daily.ok, true, 'step ' + step);
    assert.equal(daily.reason, 'CHAIN_VERIFIED', 'step ' + step);
    assert.equal(starts(lib.sql), 1, 'step ' + step);
  }
});

test('nulled keyed values with the commit column present stay tampered', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'r1', actor: EMAIL, action: 'saved', at: STAMP, detail: 'one' }, KEY);
  appendAudit(sql, { id: 'r2', actor: 'kim@example.test', action: 'saved', at: STAMP, detail: 'two' }, KEY);
  const seeded = verifyDaily(sql, KEY);
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  const anchor = anchorOf(sql);
  sql.exec('UPDATE audit SET hash = NULL, prev_hash = NULL, "commit" = NULL');
  sql.exec('UPDATE audit SET actor = ? WHERE seq = 2', MALLORY);
  const daily = verifyDaily(fresh(sql), KEY);
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'TAMPERED');
  const still = anchorOf(sql);
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
  assert.equal(starts(sql), 0);
});

test('deleting the signed chain-start stays tampered and does not clear the anchor', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'legacy');
  const lib = new Library(sql, { now: () => STAMP, auditKey: KEY });
  appendAudit(lib.sql, { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'after' }, KEY);
  const seeded = verifyDaily(lib.sql, KEY);
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  const anchor = anchorOf(lib.sql);
  lib.sql.exec("DELETE FROM audit WHERE action = 'chain-start'");
  const daily = verifyDaily(fresh(lib.sql), KEY);
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'TAMPERED');
  const still = anchorOf(lib.sql);
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
  assert.equal(starts(lib.sql), 0);
});

test('an anchor planted on a main-shaped table stays tampered', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'r1', EMAIL, 'saved', STAMP, 'one');
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'r2', MALLORY, 'saved', STAMP, 'two');
  sql.exec('CREATE TABLE audit_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, head TEXT NOT NULL)');
  sql.exec('INSERT INTO audit_anchor (id, n, head) VALUES (1, 2, ?)', 'ab'.repeat(32));
  const lib = new Library(sql, { now: () => STAMP, auditKey: KEY });
  const daily = verifyDaily(lib.sql, KEY);
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'TAMPERED');
  assert.equal(starts(lib.sql), 0);
  const anchor = anchorOf(lib.sql);
  assert.equal(Number(anchor.n), 2);
  assert.equal(anchor.head, 'ab'.repeat(32));
  assert.equal(lib.sql.exec('SELECT actor FROM audit WHERE seq = 2').toArray()[0].actor, MALLORY);
});

test('a kept commit column with nulled commits marks the library line unverified', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'story', actor: MALLORY, action: 'saved', at: STAMP, detail: 'forged' }, KEY);
  sql.exec('UPDATE audit SET "commit" = NULL');
  const lib = new Library(sql, { now: () => STAMP, auditKey: KEY });
  lib.sql.exec('INSERT INTO refs (id, owner, title, status, revision, data, state, tenant, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'story', EMAIL, 'Story', 'draft', 1, DATA, STATE, A, STAMP, STAMP);
  const view = lib.get({ email: EMAIL, role: 'admin', tenant: A }, 'story');
  assert.equal(view.audit.length, 1);
  assert.equal(view.audit[0].unverified, true);
  assert.equal(view.audit[0].actor, MALLORY);
});

test('eight concurrent callers with a non-empty key still migrate with zero bad results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-chain-'));
  const file = join(dir, 'audit.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(MAIN);
  const insert = db.prepare('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)');
  insert.run('r1', EMAIL, 'saved', STAMP, 'one');
  insert.run('r2', MALLORY, 'saved', STAMP, 'two');
  db.close();
  const url = new URL('./chain-callers.mjs', import.meta.url);
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const worker = new Worker(url, { workerData: { file, key: KEY } });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker hung')); }, 20000);
      worker.on('message', message => { clearTimeout(timer); resolve(message); });
      worker.on('error', error => { clearTimeout(timer); reject(error); });
    })));
    const bad = results.filter(r => r.error || r.ok !== true || r.reason !== 'CHAIN_VERIFIED' || r.signed.includes(MALLORY));
    assert.equal(bad.length, 0, JSON.stringify(bad));
    const check = new DatabaseSync(file);
    try { assert.equal(check.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'chain-start'").get().n, 1); }
    finally { check.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
