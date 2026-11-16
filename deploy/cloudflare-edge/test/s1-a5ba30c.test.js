// Review of a5ba30c. These fail on that tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { appendAudit, rowHash, verifyDaily } from '../src/audit-chain.js';
import { eraseMine } from '../src/subject-rights.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const EMAIL = 'ada@example.test';
const MALLORY = 'mallory';
const STAMP = '2026-11-16T00:00:00.000Z';
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });
const DATA = JSON.stringify({ title: 'Story', sector: '', client: { name: 'Acme' }, details: { country: '', serviceLines: [], technologies: [] }, jev: {}, report: {} });
const STATE = JSON.stringify({ tenant: A, validation: { status: 'pending' } });

function story(sql) {
  sql.exec('INSERT INTO refs (id, owner, title, status, revision, data, state, tenant, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'story', EMAIL, 'Story', 'draft', 1, DATA, STATE, A, STAMP, STAMP);
}

test('a copied commit on a new event is not chain-verified and does not advance the anchor', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'r1', actor: 'ada@example.test', action: 'saved', at: STAMP, detail: 'the note' });
  appendAudit(sql, { id: 'r2', actor: 'kim@example.test', action: 'saved', at: STAMP, detail: 'other' });
  const first = verifyDaily(sql);
  assert.equal(first.reason, 'CHAIN_VERIFIED');
  assert.equal(first.checked, 2);
  const anchor = sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  const source = sql.exec('SELECT * FROM audit WHERE seq = 1').toArray()[0];
  const prev = sql.exec('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').toArray()[0].hash;
  const forged = { id: 'forged', actor: source.actor, action: 'validated', at: '2099-01-01T00:00:00.000Z', detail: source.detail, commit: source.commit };
  sql.exec('INSERT INTO audit (id, actor, action, at, detail, prev_hash, hash, "commit", tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    forged.id, forged.actor, forged.action, forged.at, forged.detail, prev, rowHash(prev, forged), source.commit, '');
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
  const after = sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  assert.equal(Number(after.n), Number(anchor.n));
  assert.equal(after.head, anchor.head);
});

test('a tenant edit on a keyed row is not chain-verified', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('ALTER TABLE audit ADD COLUMN tenant TEXT');
  appendAudit(sql, { id: 'r1', actor: 'ada@example.test', action: 'saved', at: STAMP, detail: 'one', tenant: 'tenant-a' });
  sql.exec("UPDATE audit SET tenant = 'tenant-b' WHERE seq = 1");
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
});

test('null hashes and a dropped commit column are tampered and do not migrate', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'story', actor: 'ada@example.test', action: 'saved', at: STAMP, detail: 'one' });
  appendAudit(sql, { id: 'story', actor: 'kim@example.test', action: 'saved', at: STAMP, detail: 'two' });
  const seeded = verifyDaily(sql);
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  const anchor = sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  sql.exec('UPDATE audit SET hash = NULL, prev_hash = NULL');
  sql.exec('UPDATE audit SET actor = ? WHERE seq = 2', MALLORY);
  sql.exec('DROP INDEX IF EXISTS audit_one_chain_start');
  sql.exec('ALTER TABLE audit DROP COLUMN "commit"');
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'TAMPERED');
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
  const still = sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM audit WHERE action = 'chain-start'").toArray()[0].n, 0);
});

test('Library.get marks a pre-chain row legacy and unverified', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', MALLORY, 'saved', STAMP, 'forged');
  const lib = new Library(sql, { now: () => STAMP });
  story(lib.sql);
  const view = lib.get({ email: EMAIL, role: 'admin', tenant: A }, 'story');
  const daily = verifyDaily(lib.sql, lib.auditKey);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  assert.equal(view.audit.length, 1);
  assert.equal(view.audit[0].actor, MALLORY);
  assert.equal(view.audit[0].legacy, true);
  assert.equal(view.audit[0].unverified, true);
  assert.notDeepEqual(Object.keys(view.audit[0]).sort(), ['action', 'actor', 'at', 'detail']);
});

test('an unsigned chain-start does not squat the keyed start or block erasure', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'audit', MALLORY, 'chain-start', STAMP, 'squat');
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'note ' + EMAIL);
  const lib = new Library(sql, { now: () => STAMP });
  const daily = verifyDaily(lib.sql, lib.auditKey);
  assert.equal(daily.ok, true);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  const starts = lib.sql.exec('SELECT seq, actor, "commit" FROM audit WHERE action = ? ORDER BY seq', 'chain-start').toArray();
  const committed = starts.filter(r => r.commit);
  assert.equal(committed.length, 1);
  assert.equal(starts.some(r => r.commit == null), true);
  assert.ok(committed.every(r => starts.filter(s => s.commit == null).every(s => Number(r.seq) !== Number(s.seq))));
  story(lib.sql);
  const out = eraseMine(lib, { email: EMAIL, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) }, 'ab'.repeat(16));
  assert.equal(out.auditRefused, undefined);
});
