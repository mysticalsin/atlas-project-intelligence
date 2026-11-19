// Cursor delta on 1d17c810. These fail on that tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { eraseMine, pseudonymiseAudit } from '../src/subject-rights.js';
import { verifyChain, verifyDaily, rowHash } from '../src/audit-chain.js';
import * as profile from '../src/profile.js';
import { ORIGIN } from './security-harness.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
const EMAIL = 'ada@example.test';
const TOKEN = 'erased:0123456789ab';
const OTHER = 'erased:ffffffffffff';

function lib() {
  return new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
}
function chain(n = 10) {
  const store = lib();
  for (let i = 1; i <= n; i++) store.log('r' + i, 'a' + i + '@example.test', 'saved', 'd' + i);
  return store;
}

test('swapping a tombstone token fails verify', () => {
  const store = chain(2);
  pseudonymiseAudit(store, ['a1@example.test'], TOKEN, { ids: ['r1'] });
  assert.equal(verifyChain(sqlOf(store)).ok, true);
  sqlOf(store).exec('UPDATE audit SET actor = ? WHERE seq = 1', OTHER);
  assert.equal(verifyChain(sqlOf(store)).ok, false);
});

test('splicing a seq-10 tombstone proof onto seq 1 fails verify and does not anchor', () => {
  const store = chain(10);
  pseudonymiseAudit(store, ['a10@example.test'], TOKEN, { ids: ['r10'] });
  assert.equal(sqlOf(store).exec('SELECT head FROM audit_anchor').toArray().length, 1);
  sqlOf(store).exec('DELETE FROM audit_anchor');
  const rows = sqlOf(store).exec('SELECT seq, id, action, at, prev_hash, "commit", actor, tombstone FROM audit ORDER BY seq').toArray();
  const donor = rows[9];
  const commit = '0' + donor.commit;
  const first = rows[0];
  let prev = rowHash(first.prev_hash, { ...first, commit });
  sqlOf(store).exec('UPDATE audit SET actor = ?, detail = ?, "commit" = ?, hash = ?, tombstone = ? WHERE seq = 1', donor.actor, '', commit, prev, donor.tombstone);
  for (const r of rows.slice(1)) {
    const hash = rowHash(prev, r);
    sqlOf(store).exec('UPDATE audit SET prev_hash = ?, hash = ? WHERE seq = ?', prev, hash, r.seq);
    prev = hash;
  }
  const checked = verifyDaily(sqlOf(store));
  assert.equal(checked.ok, false);
  assert.equal(sqlOf(store).exec('SELECT head FROM audit_anchor').toArray().length, 0);
});

test('the reseal route is gone', async () => {
  const store = lib();
  store.log('r', EMAIL, 'saved', 'd');
  const res = await libraryRoutes(new Request('https://atlas.internal/api/library/reseal-chain', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-user': 'atlas', 'x-atlas-role': 'system' },
    body: JSON.stringify({ confirm: 'reseal-audit-chain' }),
  }), store, { env: { ATLAS_TENANT_ISOLATION: 'local-synthetic', ORIGIN, CSRF_SECRET: 's' } });
  assert.equal(res.status, 404);
});

test('erasure tombstones library, directory and profile audit rows', () => {
  const store = lib();
  profile.ensure(store);
  const user = { email: EMAIL, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) };
  store.log('library', EMAIL, 'privacy delete', 'journey 1');
  store.log('directory', EMAIL, 'directory cleared', '1 rows');
  store.log('profile', EMAIL, 'profile deleted', 'this tenant only');
  store.log('other', 'kim@example.test', 'saved', 'kept');
  eraseMine(store, user, user.subj);
  const rows = sqlOf(store).exec('SELECT id, actor, detail FROM audit').toArray();
  const text = JSON.stringify(rows);
  assert.equal(text.includes(EMAIL), false);
  assert.equal(rows.some(r => r.actor === 'kim@example.test' && r.detail === 'kept'), true);
});

test('erasure pseudonymises another person\'s directory manager address and keeps their row', () => {
  const store = lib();
  profile.ensure(store);
  const user = { email: EMAIL, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) };
  for (const tenant of [A, B]) {
    sqlOf(store).exec('INSERT INTO directory (key, source, name, manager_email, tenant) VALUES (?, ?, ?, ?, ?)', 'kim@example.test', 'dna', 'Kim', EMAIL, tenant);
  }
  eraseMine(store, user, user.subj);
  const mine = sqlOf(store).exec('SELECT key, manager_email FROM directory WHERE tenant = ?', A).toArray()[0];
  const theirs = sqlOf(store).exec('SELECT manager_email FROM directory WHERE tenant = ?', B).toArray()[0];
  assert.equal(mine.key, 'kim@example.test');
  assert.equal(String(mine.manager_email).toLowerCase() === EMAIL, false);
  assert.equal(theirs.manager_email, EMAIL);
});

test('erasure pseudonymises a manager-only trust binding and deletes the subject\'s own', () => {
  const store = lib();
  const user = { email: EMAIL, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) };
  const stamp = '2026-11-16T00:00:00.000Z';
  sqlOf(store).exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', 'kim@example.test', EMAIL, 'directory', A, stamp);
  sqlOf(store).exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', EMAIL, 'sam@example.test', 'directory', A, stamp);
  sqlOf(store).exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', 'kim@example.test', EMAIL, 'directory', B, stamp);
  eraseMine(store, user, user.subj);
  const kept = sqlOf(store).exec('SELECT owner, email FROM manager_trust WHERE tenant = ? AND owner = ?', A, 'kim@example.test').toArray()[0];
  assert.ok(kept, 'the consultant binding stays');
  assert.equal(kept.owner, 'kim@example.test');
  assert.equal(String(kept.email).toLowerCase() === EMAIL, false);
  assert.equal(sqlOf(store).exec('SELECT owner FROM manager_trust WHERE tenant = ? AND owner = ?', A, EMAIL).toArray().length, 0);
  assert.equal(sqlOf(store).exec('SELECT email FROM manager_trust WHERE tenant = ?', B).toArray()[0].email, EMAIL);
});
