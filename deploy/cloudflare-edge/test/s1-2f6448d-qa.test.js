// Non-writer QA of 2f6448d5. These fail on that tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { appendAudit, verifyDaily, GENESIS } from '../src/audit-chain.js';

const EMAIL = 'ada@example.test';
const STAMP = '2026-11-16T00:00:00.000Z';
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });

function anchorRows(sql) {
  try { return sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray(); }
  catch (e) { if (/no such table/i.test(String(e?.message || e))) return []; throw e; }
}
// Legacy row, signed chain-start, one later signed event. Then drop the start and the legacy row.
function suffix(sql) {
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'legacy');
  const lib = new Library(sql, { now: () => STAMP });
  appendAudit(lib.sql, { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'later' });
  const seeded = verifyDaily(lib.sql);
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  assert.equal(seeded.checked, 2);
  lib.sql.exec('DELETE FROM audit WHERE action = ? OR "commit" IS NULL', 'chain-start');
  const left = lib.sql.exec('SELECT prev_hash, hash FROM audit').toArray();
  assert.equal(left.length, 1);
  assert.notEqual(left[0].prev_hash, GENESIS);
  return { sql: lib.sql, hash: left[0].hash, anchor: anchorRows(lib.sql)[0] };
}

test('a signed suffix with the anchor deleted is not chain-verified and does not write an anchor', () => {
  const { sql } = suffix(memorySql());
  sql.exec('DELETE FROM audit_anchor');
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
  assert.ok(daily.reason === 'TAMPERED' || daily.reason === 'TRUNCATED', daily.reason);
  assert.equal(anchorRows(sql).length, 0);
});

test('a signed suffix whose anchor was rewritten to that one row is not chain-verified', () => {
  const { sql, hash } = suffix(memorySql());
  sql.exec('UPDATE audit_anchor SET n = 1, head = ? WHERE id = 1', hash);
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
  assert.ok(daily.reason === 'TAMPERED' || daily.reason === 'TRUNCATED', daily.reason);
  const still = anchorRows(sql)[0];
  assert.equal(Number(still.n), 1);
  assert.equal(still.head, hash);
});

test('a signed suffix under the original anchor does not verify and appendAudit refuses', () => {
  const { sql, anchor } = suffix(memorySql());
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
  const still = anchorRows(sql)[0];
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
  const before = sql.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n;
  assert.throws(() => appendAudit(fresh(sql), { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'more' }), err => err.status === 409);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n, before);
});

test('a lock error while probing a column is not read as a missing column', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'legacy');
  const lib = new Library(sql, { now: () => STAMP });
  const daily = verifyDaily(lib.sql);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  const wrapped = {
    exec(q, ...params) {
      if (String(q).includes('SELECT "commit" FROM audit LIMIT 0')) throw new Error('database is locked');
      return lib.sql.exec(q, ...params);
    },
  };
  assert.throws(() => verifyDaily(wrapped), /locked|busy/);
});
