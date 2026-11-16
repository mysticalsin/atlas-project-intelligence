// B1 (10): the library audit trail is a hash chain, verified by the daily cron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { sha256Hex, hmacHex, rowHash, appendAudit, verifyChain, ensureChain, GENESIS } from '../src/audit-chain.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const row = (n, extra = {}) => ({ id: 'r' + n, actor: 'a' + n + '@example.com', action: 'saved', at: '2026-10-31T10:0' + n + ':00Z', detail: 'detail ' + n, ...extra });
const table = (sql, extraCols = '') => sql.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT' + extraCols + ')');

test('sha256 is correct (vs node:crypto) for empty, block-boundary, long and non-ASCII input', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'é€😀 mixed ünïcode'.repeat(30)]) assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
});

test('hmac-sha256 matches node:crypto, including a key longer than the block', () => {
  for (const [k, m] of [['', 'abc'], ['key', 'msg'], ['k'.repeat(80), 'long key'], ['subject-v1:s', 'ada@example.test']]) {
    assert.equal(hmacHex(k, m), createHmac('sha256', k).update(m).digest('hex'));
  }
});

test('rows chain: each row\'s prev_hash is the previous hash, the first starts at GENESIS, an unchanged table verifies', () => {
  const sql = memorySql(); table(sql);
  for (let i = 1; i <= 5; i++) appendAudit(sql, row(i));
  const rows = sql.exec('SELECT * FROM audit ORDER BY seq').toArray();
  assert.equal(rows[0].prev_hash, GENESIS);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev_hash, rows[i - 1].hash);
  assert.equal(rows[2].hash, rowHash(rows[1].hash, rows[2]));
  const v = verifyChain(sql); assert.deepEqual([v.ok, v.checked, v.head], [true, 5, rows[4].hash]);
  assert.deepEqual(verifyChain((() => { const s = memorySql(); table(s); return s; })()), { ok: true, checked: 0, head: GENESIS });
});

test('tampering is found at the first broken row: edit (HASH_MISMATCH), delete in the middle or insert (LINK_BROKEN), unsealed row, edited hash', () => {
  const build = () => { const sql = memorySql(); table(sql); for (let i = 1; i <= 6; i++) appendAudit(sql, row(i)); return sql; };
  let sql = build(); sql.exec("UPDATE audit SET actor = 'mallory@evil' WHERE seq = 3");
  assert.equal(verifyChain(sql).reason, 'COMMIT_MISMATCH');
  sql = build(); sql.exec("UPDATE audit SET detail = 'quietly changed' WHERE seq = 6");
  assert.equal(verifyChain(sql).reason, 'COMMIT_MISMATCH');
  sql = build(); sql.exec("UPDATE audit SET action = 'tampered' WHERE seq = 3");
  assert.deepEqual(pick(verifyChain(sql)), { ok: false, brokenSeq: 3, reason: 'HASH_MISMATCH', checked: 2 });
  sql = build(); sql.exec('DELETE FROM audit WHERE seq = 4');
  assert.deepEqual(pick(verifyChain(sql)), { ok: false, brokenSeq: 5, reason: 'LINK_BROKEN', checked: 3 });
  sql = build(); sql.exec("INSERT INTO audit (id, actor, action, at, detail, prev_hash, hash) VALUES ('x','x','x','x','x', 'f', 'e')");
  assert.equal(verifyChain(sql).ok, false);
  sql = build(); sql.exec("UPDATE audit SET hash = '" + '0'.repeat(64) + "' WHERE seq = 2");
  assert.equal(verifyChain(sql).ok, false);
  sql = build(); sql.exec('UPDATE audit SET prev_hash = NULL WHERE seq = 2');
  assert.equal(verifyChain(sql).reason, 'UNSEALED');
  // an attacker who rewrites the action and recomputes the hash is caught by the commit, which binds the action
  sql = build(); const r2 = sql.exec('SELECT * FROM audit WHERE seq = 2').toArray()[0], forged = { ...r2, action: 'forged' };
  sql.exec('UPDATE audit SET action = ?, hash = ? WHERE seq = 2', 'forged', rowHash(r2.prev_hash, forged));
  assert.deepEqual(pick(verifyChain(sql)), { ok: false, brokenSeq: 2, reason: 'COMMIT_MISMATCH', checked: 1 });
});
const pick = v => ({ ok: v.ok, brokenSeq: v.brokenSeq, reason: v.reason, checked: v.checked });

test('a deleted oldest prefix (a retention sweep) leaves a valid chain; deleting the newest rows is not detectable in-table, which is why the head is logged', () => {
  const sql = memorySql(); table(sql); for (let i = 1; i <= 5; i++) appendAudit(sql, row(i));
  const head5 = verifyChain(sql).head;
  sql.exec('DELETE FROM audit WHERE seq <= 2'); assert.equal(verifyChain(sql).ok, true);
  sql.exec('DELETE FROM audit WHERE seq = 5'); const after = verifyChain(sql); assert.equal(after.ok, true); assert.notEqual(after.head, head5, 'the logged head no longer matches the anchor');
});

test('rows with no hashes migrate to one chain-start and the old rows stay unsigned', () => {
  const sql = memorySql(); table(sql);
  for (let i = 1; i <= 3; i++) sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', ...Object.values(row(i)));
  assert.throws(() => sql.exec('SELECT hash FROM audit'));
  appendAudit(sql, row(4));
  const rows = sql.exec('SELECT * FROM audit ORDER BY seq').toArray();
  assert.equal(rows[0].hash, null);
  assert.equal(rows[0].commit, null);
  assert.equal(rows[1].actor, 'a2@example.com');
  assert.equal(rows.filter(r => r.action === 'chain-start').length, 1);
  const v = verifyChain(sql);
  assert.equal(v.ok, true);
  assert.equal(v.legacyUnverified, 3);
  // a NULL hash and a NULL commit after the column exists are not sealed from the actor now in the row
  const sql2 = memorySql(); table(sql2); appendAudit(sql2, row(1));
  sql2.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', ...Object.values(row(2)));
  ensureChainFresh(sql2);
  const unsealed = verifyChain({ exec: (...a) => sql2.exec(...a) });
  assert.equal(unsealed.ok, false);
  assert.equal(unsealed.reason, 'UNSEALED');
});
function ensureChainFresh(sql) { const proxy = { exec: (...a) => sql.exec(...a) }; ensureChain(proxy); }

test('Library: every audit write goes through the chain, the audit view is unchanged, and the daily verification passes on real activity', async () => {
  const sql = memorySql(), lib = new Library(sql, { now: () => '2026-10-31T10:00:00.000Z' }); // (an existing audit table without the chain columns is upgraded by the constructor's first audit write)
  const owner = { email: 'owner@example.com', role: 'user' }, admin = { email: 'admin@example.com', role: 'admin' };
  const saved = await lib.upsert(owner, { localId: 'p1', reference: { title: 'Claims triage alias', stage: 'Pilot', sector: 'Insurance', client: { name: 'Zebracorp' }, details: { country: 'France' }, answers: ['We built it.'] } });
  lib.log(saved.id, admin.email, 'viewed', 'x'.repeat(500));
  const v = verifyChain(sql); assert.equal(v.ok, true); assert.ok(v.checked >= 2);
  const detail = lib.get(admin, saved.id);
  assert.deepEqual(Object.keys(detail.audit[0]).sort(), ['action', 'actor', 'at', 'detail']);
  assert.equal(sql.exec("SELECT detail FROM audit WHERE action = 'viewed'").toArray()[0].detail.length, 300, 'details are still cut at 300 characters');
  sql.exec("UPDATE audit SET action = 'tampered' WHERE seq = 1");
  assert.equal(verifyChain(sql).ok, false);
});
