// Cursor review and non-writer QA of 61bbb9dc. These fail on that tree.
// Rollback checks use test/sqlite.js, a node:sqlite stand-in, not workerd.
// memorySql sends deferred BEGIN/COMMIT, which Durable Object SQL rejects; application code does not.
// The file callers in chain-callers.mjs use BEGIN IMMEDIATE. App code calls transactionSync only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { appendAudit, verifyChain, verifyDaily, rowHash, GENESIS, ensureChain } from '../src/audit-chain.js';

const EMAIL = 'ada@example.test';
const STAMP = '2026-11-16T00:00:00.000Z';
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const MAIN_COLS = ['seq', 'id', 'actor', 'action', 'at', 'detail'];
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });

function anchorRows(sql) {
  try { return sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray(); }
  catch (e) { if (/no such table/i.test(String(e?.message || e))) return []; throw e; }
}
// Legacy row, signed chain-start, then `events` later signed rows. Drop the start and the
// unsigned row, point the surviving rows at genesis, and recompute the public hashes.
function relink(events) {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'legacy');
  const lib = new Library(sql, { now: () => STAMP });
  for (let i = 0; i < events; i++) appendAudit(sqlOf(lib), { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'later-' + i });
  const seeded = verifyDaily(sqlOf(lib));
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  const kept = sqlOf(lib).exec('SELECT seq, id, action, at, "commit" FROM audit WHERE action != ? AND "commit" IS NOT NULL ORDER BY seq', 'chain-start').toArray();
  assert.equal(kept.length, events);
  sqlOf(lib).exec('DELETE FROM audit WHERE action = ? OR "commit" IS NULL', 'chain-start');
  let prev = GENESIS;
  for (const row of kept) {
    const hash = rowHash(prev, row);
    sqlOf(lib).exec('UPDATE audit SET prev_hash = ?, hash = ? WHERE seq = ?', prev, hash, row.seq);
    prev = hash;
  }
  const left = sqlOf(lib).exec('SELECT prev_hash FROM audit ORDER BY seq').toArray();
  assert.equal(left[0].prev_hash, GENESIS);
  return { sql: sqlOf(lib), head: prev };
}
function refuses(sql) {
  const before = sql.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n;
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
  assert.throws(() => appendAudit(fresh(sql), { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'more' }), err => err.status === 409);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n, before);
  return daily;
}

test('a relinked suffix with the anchor deleted is not verified, writes no anchor, and appends nothing', () => {
  const { sql } = relink(1);
  sql.exec('DELETE FROM audit_anchor');
  refuses(sql);
  assert.equal(anchorRows(sql).length, 0);
});

test('a relinked suffix whose anchor was rewritten to n=1 and the new hash is not verified and appends nothing', () => {
  const { sql, head } = relink(1);
  sql.exec('UPDATE audit_anchor SET n = 1, head = ? WHERE id = 1', head);
  refuses(sql);
  const still = anchorRows(sql)[0];
  assert.equal(Number(still.n), 1);
  assert.equal(still.head, head);
});

test('reordering two signed rows and recomputing the public hashes is not a chain', () => {
  const { sql } = relink(2);
  sql.exec('DELETE FROM audit_anchor');
  refuses(sql);
  assert.equal(anchorRows(sql).length, 0);
  const rows = sql.exec('SELECT seq, id, action, at, "commit" FROM audit ORDER BY seq').toArray();
  assert.equal(rows.length, 2);
  const [first, second] = rows;
  const swapped = [second, first];
  let prev = GENESIS;
  for (const row of swapped) {
    const hash = rowHash(prev, row);
    sql.exec('UPDATE audit SET prev_hash = ?, hash = ? WHERE seq = ?', prev, hash, row.seq);
    prev = hash;
  }
  const again = verifyChain(fresh(sql));
  assert.equal(again.ok, false);
  assert.notEqual(again.reason, 'CHAIN_VERIFIED');
});

test('an empty table gets one signed chain-start', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  new Library(sql, { now: () => STAMP });
  const starts = sql.exec('SELECT prev_hash, "commit" FROM audit WHERE action = ?', 'chain-start').toArray();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].prev_hash, GENESIS);
  assert.ok(starts[0].commit);
  assert.equal(verifyDaily(sql).reason, 'CHAIN_VERIFIED');
});

test('a forged seq below zero is walked and is not shown as a verified line', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  const lib = new Library(sql, { now: () => STAMP });
  lib.log('story', EMAIL, 'saved', 'real');
  const real = sql.exec('SELECT hash, "commit", prev_hash FROM audit WHERE action = ?', 'saved').toArray()[0];
  sql.exec('INSERT INTO audit (seq, id, actor, action, at, detail, prev_hash, hash, "commit", tombstone) VALUES (-1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'story', 'forged@example.test', 'saved', STAMP, 'forged', real.prev_hash, real.hash, real.commit, '');
  const forged = lib.auditLines('story').find(line => line.actor === 'forged@example.test');
  assert.equal(forged.unverified, true);
  assert.equal(verifyChain(fresh(sql)).ok, false);
});

test('an empty-string commit is unverified', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  const lib = new Library(sql, { now: () => STAMP });
  lib.log('story', EMAIL, 'saved', 'real');
  sql.exec('UPDATE audit SET "commit" = ? WHERE action = ?', '', 'saved');
  const line = lib.auditLines('story').find(item => item.action === 'saved');
  assert.equal(line.unverified, true);
});

test('wiped keyed values with no anchor are tampered without waiting', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'legacy');
  const lib = new Library(sql, { now: () => STAMP });
  verifyDaily(sqlOf(lib));
  sqlOf(lib).exec('UPDATE audit SET hash = NULL, prev_hash = NULL, "commit" = NULL');
  sqlOf(lib).exec('DELETE FROM audit_anchor');
  const started = Date.now();
  const daily = verifyDaily(fresh(sqlOf(lib)));
  assert.equal(daily.reason, 'TAMPERED');
  assert.ok(Date.now() - started < 200, 'waited ' + (Date.now() - started) + 'ms');
});

test('an unmigrated database without transactionSync is not migrated', () => {
  const db = memorySql();
  db.exec(MAIN);
  db.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'legacy');
  const bare = { exec: db.exec.bind(db) };
  assert.throws(() => ensureChain(bare, 'synthetic-log-salt'), /transactionSync|atomic/);
  assert.deepEqual(db.exec('PRAGMA table_info(audit)').toArray().map(column => column.name), MAIN_COLS);
  assert.equal(anchorRows(db).length, 0);
});
