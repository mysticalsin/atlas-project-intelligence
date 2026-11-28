// Cursor review of b8df2ab. These fail on that tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { appendAudit, rewriteRows, rowHash, verifyChain, verifyDaily } from '../src/audit-chain.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const EMAIL = 'ada@example.test';
const MALLORY = 'mallory';
const STAMP = '2026-11-16T00:00:00.000Z';
const ERASED = 'erased:0123456789ab';
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });
const DATA = JSON.stringify({ title: 'Story', sector: '', client: { name: 'Acme' }, details: { country: '', serviceLines: [], technologies: [] }, jev: {}, report: {} });
const STATE = JSON.stringify({ tenant: A, validation: { status: 'pending' } });

function anchorOf(sql) {
  return sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
}
function tombstone(sql, seq) {
  const out = rewriteRows(sql, row => Number(row.seq) === seq ? { actor: ERASED, detail: '' } : null);
  assert.equal(out.refused, undefined);
}

test('rewriting id, action and at on a tombstone is not chain-verified and does not move the anchor', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'r1', actor: EMAIL, action: 'saved', at: STAMP, detail: 'one' });
  appendAudit(sql, { id: 'r2', actor: EMAIL, action: 'saved', at: STAMP, detail: 'two' });
  tombstone(sql, 2);
  const seeded = verifyDaily(sql);
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  const anchor = anchorOf(sql);
  const row = sql.exec('SELECT prev_hash, "commit" FROM audit WHERE seq = 2').toArray()[0];
  const forged = { id: 'forged', action: 'validated', at: '2099-01-01T00:00:00.000Z', commit: row.commit };
  sql.exec('UPDATE audit SET id = ?, action = ?, at = ?, hash = ? WHERE seq = 2', forged.id, forged.action, forged.at, rowHash(row.prev_hash, forged));
  const chain = verifyChain(fresh(sql));
  assert.equal(chain.ok, false);
  assert.equal(chain.reason, 'COMMIT_MISMATCH');
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
  const still = anchorOf(sql);
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
});

test('a forged tombstone does not move the anchor appendAudit already wrote', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'r1', actor: EMAIL, action: 'saved', at: STAMP, detail: 'one' });
  const anchor = anchorOf(sql);
  assert.ok(anchor);
  tombstone(sql, 1);
  const row = sql.exec('SELECT prev_hash, "commit" FROM audit WHERE seq = 1').toArray()[0];
  const forged = { id: 'forged', action: 'validated', at: '2099-01-01T00:00:00.000Z', commit: row.commit };
  sql.exec('UPDATE audit SET id = ?, action = ?, at = ?, hash = ? WHERE seq = 1', forged.id, forged.action, forged.at, rowHash(row.prev_hash, forged));
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
  const still = anchorOf(sql);
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
});

test('a tenant edit on a tombstone is not chain-verified and does not move the anchor', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('ALTER TABLE audit ADD COLUMN tenant TEXT');
  appendAudit(sql, { id: 'r1', actor: EMAIL, action: 'saved', at: STAMP, detail: 'one', tenant: 'tenant-a' });
  tombstone(sql, 1);
  const seeded = verifyDaily(sql);
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  const anchor = anchorOf(sql);
  sql.exec("UPDATE audit SET tenant = 'tenant-b' WHERE seq = 1");
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
  const still = anchorOf(sql);
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
});

test('null hashes and a dropped commit column mark every library audit line unverified', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'story', actor: MALLORY, action: 'saved', at: STAMP, detail: 'forged' });
  verifyDaily(sql);
  sql.exec('UPDATE audit SET hash = NULL, prev_hash = NULL');
  sql.exec('DROP INDEX IF EXISTS audit_one_chain_start');
  sql.exec('ALTER TABLE audit DROP COLUMN "commit"');
  const lib = new Library(sql, { now: () => STAMP });
  sqlOf(lib).exec('INSERT INTO refs (id, owner, title, status, revision, data, state, tenant, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'story', EMAIL, 'Story', 'draft', 1, DATA, STATE, A, STAMP, STAMP);
  const view = lib.get({ email: EMAIL, role: 'admin', tenant: A }, 'story');
  assert.equal(view.audit.length > 0, true);
  assert.equal(view.audit.every(line => line.unverified === true), true);
  assert.equal(view.audit.some(line => Object.keys(line).sort().join() === 'action,actor,at,detail'), false);
});

test('an old non-partial chain-start index is replaced and does not block the signed start', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'audit', MALLORY, 'chain-start', STAMP, 'squat');
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'note');
  sql.exec("CREATE UNIQUE INDEX audit_one_chain_start ON audit(action) WHERE action = 'chain-start'");
  const lib = new Library(sql, { now: () => STAMP });
  const daily = verifyDaily(sqlOf(lib), lib.auditKey);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  const idx = sqlOf(lib).exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'audit_one_chain_start'").toArray()[0].sql;
  assert.match(idx, /"commit" IS NOT NULL/);
  const starts = sqlOf(lib).exec('SELECT "commit" FROM audit WHERE action = ?', 'chain-start').toArray();
  assert.equal(starts.filter(r => r.commit).length, 1);
  assert.equal(starts.some(r => r.commit == null), true);
});
