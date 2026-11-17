// Review of b8df2ab. The three tamper shapes fail on that tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { appendAudit, verifyDaily } from '../src/audit-chain.js';
import { eraseMine } from '../src/subject-rights.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const EMAIL = 'ada@example.test';
const MALLORY = 'mallory';
const STAMP = '2026-11-16T00:00:00.000Z';
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });

function anchorOf(sql) {
  return sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
}
function starts(sql) {
  return sql.exec("SELECT COUNT(*) AS n FROM audit WHERE action = 'chain-start'").toArray()[0].n;
}

test('nulled keyed values with the commit column present are tampered and do not re-migrate', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'r1', actor: 'ada@example.test', action: 'saved', at: STAMP, detail: 'one' });
  appendAudit(sql, { id: 'r2', actor: 'kim@example.test', action: 'saved', at: STAMP, detail: 'two' });
  const seeded = verifyDaily(sql);
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  const anchor = anchorOf(sql);
  sql.exec('UPDATE audit SET hash = NULL, prev_hash = NULL, "commit" = NULL');
  sql.exec('UPDATE audit SET actor = ? WHERE seq = 2', MALLORY);
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'TAMPERED');
  const still = anchorOf(sql);
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
  assert.equal(starts(sql), 0);
  assert.equal(sql.exec('SELECT actor FROM audit WHERE seq = 2').toArray()[0].actor, MALLORY);
});

test('deleting the signed chain-start is tampered and does not re-seed or clear the anchor', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'legacy');
  const lib = new Library(sql, { now: () => STAMP });
  appendAudit(lib.sql, { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'after the start' });
  const seeded = verifyDaily(lib.sql, lib.auditKey);
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  assert.equal(starts(lib.sql), 1);
  const anchor = anchorOf(lib.sql);
  const kept = lib.sql.exec('SELECT seq, "commit" FROM audit WHERE action = ? AND "commit" IS NOT NULL', 'saved').toArray()[0];
  lib.sql.exec("DELETE FROM audit WHERE action = 'chain-start'");
  const daily = verifyDaily(fresh(lib.sql), lib.auditKey);
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'TAMPERED');
  const still = anchorOf(lib.sql);
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
  assert.equal(starts(lib.sql), 0);
  assert.equal(lib.sql.exec('SELECT "commit" FROM audit WHERE seq = ?', kept.seq).toArray()[0].commit, kept.commit);
});

test('a chain of only unsigned rows is tampered and does not re-seed or clear the anchor', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'r1', actor: 'ada@example.test', action: 'saved', at: STAMP, detail: 'one' });
  appendAudit(sql, { id: 'r2', actor: 'kim@example.test', action: 'saved', at: STAMP, detail: 'two' });
  const seeded = verifyDaily(sql);
  assert.equal(seeded.reason, 'CHAIN_VERIFIED');
  const anchor = anchorOf(sql);
  sql.exec('UPDATE audit SET "commit" = NULL');
  sql.exec('UPDATE audit SET actor = ? WHERE seq = 2', MALLORY);
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'TAMPERED');
  const still = anchorOf(sql);
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
  assert.equal(starts(sql), 0);
  assert.equal(sql.exec('SELECT actor, "commit" FROM audit WHERE seq = 2').toArray()[0].actor, MALLORY);
  assert.equal(sql.exec('SELECT "commit" FROM audit WHERE seq = 2').toArray()[0].commit, null);
});

test('a fresh database with no anchor and no commit column migrates', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit_anchor'").toArray()[0].n, 0);
  const daily = verifyDaily(sql);
  assert.equal(daily.ok, true);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  assert.equal(daily.checked, 0);
  appendAudit(sql, { id: 'r1', actor: EMAIL, action: 'saved', at: STAMP, detail: 'first' });
  const again = verifyDaily(fresh(sql));
  assert.equal(again.reason, 'CHAIN_VERIFIED');
  assert.equal(again.checked, 1);
});

test('a main-shaped database migrates and erasure tombstones the legacy row', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'note ' + EMAIL);
  const lib = new Library(sql, { now: () => STAMP });
  const daily = verifyDaily(lib.sql, lib.auditKey);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  assert.equal(daily.legacyUnverified, 1);
  assert.equal(starts(lib.sql), 1);
  lib.sql.exec('INSERT INTO refs (id, owner, title, status, revision, data, state, tenant, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'story', EMAIL, 'Story', 'draft', 1, '{}', '{}', A, STAMP, STAMP);
  const out = eraseMine(lib, { email: EMAIL, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) }, 'ab'.repeat(16));
  assert.equal(out.auditRefused, undefined);
  const legacy = lib.sql.exec("SELECT actor, detail FROM audit WHERE action != 'chain-start' AND id = 'story'").toArray()[0];
  assert.match(legacy.actor, /^erased:[0-9a-f]{12}$/);
  assert.equal(legacy.detail, '');
  assert.equal(verifyDaily(lib.sql, lib.auditKey).ok, true);
});
