// Cursor ACCEPT WITH RESIDUALS on 1b1ea05, plus the QA pass on the same tree.
// These fail on that tree and describe the behaviour the fix must reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { eraseMine, exportMine, pseudonymiseAudit } from '../src/subject-rights.js';
import { verifyChain, verifyDaily, sha256Hex, GENESIS, ensureChain, contentCommit, rowHash } from '../src/audit-chain.js';
import * as profile from '../src/profile.js';
import * as privacy from '../src/privacy.js';
import * as outreach from '../src/outreach.js';
import { ensureJourney } from '../src/journey.js';
import { ensureTelemetry, personaKey } from '../src/telemetry.js';
import { ENV, ORIGIN, jwt, ns } from './security-harness.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
const EMAIL = 'ada@example.test';
const LIBID = A + ':66666666-7777-4888-8999-000000000000';
const ref = () => ({ title: 'Northwind pilot alias', stage: 'Pilot', sector: 'Insurance', consultant: { name: 'Ada', role: 'Consultant' },
  client: { name: 'Northwind Mutual', location: 'Lyon', contact: 'Ops' },
  details: { projectId: 'PRJ-SYN', country: 'France', consultants: [{ name: 'Jo', email: 'jo@example.test', role: 'PO' }] },
  answers: ['The client had a slow queue.', 'I rebuilt the routing step.', 'We kept a manual fallback.', 'The queue was shorter on the team dashboard.', 'Dashboard export v1.', 'Similar service desks.'],
  validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: true } });

function fresh() {
  const lib = new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
  profile.ensure(lib);
  return lib;
}
function chain() {
  const lib = new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
  lib.log('r', EMAIL, 'saved', 'the note');
  lib.log('r2', 'kim@example.test', 'saved', 'other');
  return lib;
}

test('a direct edit of the audit actor fails verify', () => {
  const lib = chain();
  lib.sql.exec("UPDATE audit SET actor = 'mallory@evil.test' WHERE seq = 1");
  assert.equal(verifyChain(lib.sql).ok, false);
});

test('a direct edit of the audit detail fails verify', () => {
  const lib = chain();
  lib.sql.exec("UPDATE audit SET detail = 'rewritten' WHERE seq = 1");
  assert.equal(verifyChain(lib.sql).ok, false);
});

test('a forged erasure tombstone without the proof fails verify', () => {
  const lib = chain();
  lib.sql.exec("UPDATE audit SET actor = 'erased:0123456789ab', detail = '' WHERE seq = 1");
  assert.equal(verifyChain(lib.sql).ok, false);
});

test('a proper erasure tombstone still verifies and does not move the head', () => {
  const lib = chain();
  const head = lib.sql.exec("SELECT hash FROM audit WHERE id = 'r2'").toArray()[0].hash;
  pseudonymiseAudit(lib, [EMAIL], 'erased:0123456789ab', { ids: ['r'] });
  const row = lib.sql.exec("SELECT actor, detail, tombstone FROM audit WHERE id = 'r'").toArray()[0];
  assert.equal(row.actor, 'erased:0123456789ab');
  assert.equal(row.detail, '');
  assert.equal(typeof row.tombstone, 'string');
  assert.equal(row.tombstone.length > 0, true);
  assert.equal(verifyChain(lib.sql).ok, true);
  assert.equal(lib.sql.exec("SELECT hash FROM audit WHERE id = 'r2'").toArray()[0].hash, head);
});

test('erasure pseudonymises privacy logs that hold the mailbox or the library identity', async () => {
  const lib = fresh();
  const user = { email: LIBID, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) };
  await lib.upsert(user, { localId: 'p', reference: ref() });
  exportMine(lib, user, user.subj);
  privacy.setFlags(lib, LIBID, { restricted: true }, { actor: EMAIL, subj: user.subj });
  lib.log('other', 'kim@example.test', 'saved', 'kept for someone else');
  eraseMine(lib, user, user.subj);
  const rows = lib.sql.exec('SELECT actor, detail FROM audit').toArray();
  const text = JSON.stringify(rows);
  assert.equal(text.includes(EMAIL), false);
  assert.equal(text.includes(LIBID), false);
  assert.equal(rows.some(r => r.actor === 'kim@example.test' && r.detail === 'kept for someone else'), true);
});

test('erase clears this tenant journey, directory, trust, telemetry and a manager-only staffing address', async () => {
  const lib = fresh();
  outreach.ensure(lib);
  ensureJourney(lib);
  ensureTelemetry(lib);
  const user = { email: EMAIL, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) };
  const other = { email: EMAIL, mail: EMAIL, role: 'user', tenant: B, tenantEnforced: true };
  const personaA = await personaKey(user);
  const personaB = await personaKey(other);
  const stamp = '2026-11-16T00:00:00.000Z';
  for (const [tenant, payload] of [[A, '{"name":"Ada A"}'], [B, '{"name":"Ada B"}']]) {
    lib.sql.exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', EMAIL, tenant, payload, stamp);
    lib.sql.exec('INSERT INTO directory (key, source, name, tenant) VALUES (?, ?, ?, ?)', EMAIL, 'dna', 'Ada ' + tenant.slice(0, 1), tenant);
    lib.sql.exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', EMAIL, 'sam@example.test', 'directory', tenant, stamp);
    lib.sql.exec('INSERT INTO telemetry (id, at, tenant, persona, kind) VALUES (?, ?, ?, ?, ?)', 'tel-' + tenant.slice(0, 1), stamp, tenant, tenant === A ? personaA : personaB, 'usage');
    lib.sql.exec('INSERT INTO staffing (project_id, consultant_email, manager_email, tenant) VALUES (?, ?, ?, ?)', 'prj-' + tenant.slice(0, 1), 'kim@example.test', EMAIL, tenant);
  }
  eraseMine(lib, user, user.subj);
  const cell = (q, ...p) => lib.sql.exec(q, ...p).toArray();
  assert.equal(cell('SELECT payload FROM journey WHERE subject = ? AND tenant = ?', EMAIL, A).length, 0);
  assert.equal(cell('SELECT payload FROM journey WHERE subject = ? AND tenant = ?', EMAIL, B)[0].payload, '{"name":"Ada B"}');
  assert.equal(cell('SELECT name FROM directory WHERE key = ? AND tenant = ?', EMAIL, A).length, 0);
  assert.equal(cell('SELECT name FROM directory WHERE key = ? AND tenant = ?', EMAIL, B)[0].name, 'Ada b');
  assert.equal(cell("SELECT owner FROM manager_trust WHERE lower(owner) = ? AND lower(tenant) = ?", EMAIL, A).length, 0);
  assert.equal(cell("SELECT owner FROM manager_trust WHERE lower(owner) = ? AND lower(tenant) = ?", EMAIL, B).length, 1);
  assert.equal(cell('SELECT id FROM telemetry WHERE persona = ? AND tenant = ?', personaA, A).length, 0);
  assert.equal(cell('SELECT id FROM telemetry WHERE persona = ? AND tenant = ?', personaB, B).length, 1);
  const staffA = cell('SELECT consultant_email, manager_email FROM staffing WHERE project_id = ?', 'prj-a')[0];
  assert.equal(staffA.consultant_email, 'kim@example.test');
  assert.equal(String(staffA.manager_email).toLowerCase() === EMAIL, false);
  assert.equal(cell('SELECT manager_email FROM staffing WHERE project_id = ?', 'prj-b')[0].manager_email, EMAIL);
});

test('report-only still enforces the strict policy on confirm, privacy and the re-sign-in page', async () => {
  const env = { ...ENV, ATLAS_CSP: 'report-only' };
  const token = await jwt();
  for (const path of ['/confirm', '/privacy', '/go/signed-in']) {
    const res = await handle(new Request(ORIGIN + path, { headers: { 'cf-access-jwt-assertion': token } }), env, '<html></html>');
    const csp = res.headers.get('content-security-policy') || '';
    assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false, path + ' ' + csp);
    assert.equal(csp.includes('blob:'), false, path + ' ' + csp);
  }
  const home = await handle(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': token } }), env, '<html><body></body></html>');
  assert.match(home.headers.get('content-security-policy') || '', /script-src[^;]*'unsafe-inline'/);
});

test('verify-chain returns the chain result, not a constant success', async () => {
  const lib = fresh();
  lib.log('r', EMAIL, 'saved', 'd');
  lib.sql.exec("UPDATE audit SET action = 'tampered' WHERE id = 'r'");
  const res = await libraryRoutes(new Request('https://atlas.internal/api/library/verify-chain', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-user': 'atlas', 'x-atlas-role': 'system' }, body: '{}',
  }), lib, { env: { ATLAS_TENANT_ISOLATION: 'local-synthetic', ORIGIN, CSRF_SECRET: 's' } });
  const body = await res.json();
  assert.equal(body.verified, false);
  assert.equal(body.reason, 'HASH_MISMATCH');
});

test('a tail truncation is TRUNCATED and does not move the anchor', () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
  for (let i = 1; i <= 4; i++) lib.log('r' + i, 'a@example.test', 'saved', 'd' + i);
  const first = verifyDaily(lib.sql);
  assert.equal(first.ok, true);
  const anchor = lib.sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  lib.sql.exec('DELETE FROM audit WHERE seq = (SELECT MAX(seq) FROM audit)');
  assert.throws(() => lib.log('r5', 'a@example.test', 'saved', 'pad-1'), err => err.status === 409);
  const again = verifyDaily(lib.sql);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'TRUNCATED');
  const still = lib.sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  assert.equal(still.n, anchor.n);
  assert.equal(still.head, anchor.head);
});

test('a same-length rewrite with a valid commit is ANCHOR_MOVED and does not move the anchor', () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
  for (let i = 1; i <= 4; i++) lib.log('r' + i, 'a@example.test', 'saved', 'd' + i);
  const first = verifyDaily(lib.sql);
  assert.equal(first.ok, true);
  const anchor = lib.sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  const last = lib.sql.exec('SELECT seq, id, action, at, actor, detail, prev_hash FROM audit ORDER BY seq DESC LIMIT 1').toArray()[0];
  const commit = contentCommit(lib.auditKey, { ...last, detail: 'rewritten' });
  const hash = rowHash(last.prev_hash, { ...last, commit });
  lib.sql.exec('UPDATE audit SET detail = ?, "commit" = ?, hash = ? WHERE seq = ?', 'rewritten', commit, hash, last.seq);
  assert.equal(verifyChain(lib.sql).ok, true);
  const again = verifyDaily(lib.sql);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'ANCHOR_MOVED');
  const still = lib.sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  assert.equal(still.n, anchor.n);
  assert.equal(still.head, anchor.head);
});

test('appending rows keeps the stored head in place and then advances the anchor', () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
  for (let i = 1; i <= 3; i++) lib.log('r' + i, 'a@example.test', 'saved', 'd' + i);
  const first = verifyDaily(lib.sql);
  lib.log('r4', 'a@example.test', 'saved', 'd4');
  const again = verifyDaily(lib.sql);
  assert.equal(again.ok, true);
  assert.equal(again.checked, 5);
  assert.notEqual(again.head, first.head);
});

test('rows hashed under the previous formula stay broken', () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
  lib.log('r1', 'a@example.test', 'saved', 'd1');
  lib.log('r2', 'a@example.test', 'saved', 'd2');
  const rows = lib.sql.exec('SELECT seq, id, action, at FROM audit ORDER BY seq').toArray();
  let prev = GENESIS;
  for (const r of rows) {
    const hash = sha256Hex(JSON.stringify([prev, String(r.id), String(r.action), String(r.at)]));
    lib.sql.exec('UPDATE audit SET prev_hash = ?, hash = ?, "commit" = NULL, tombstone = NULL WHERE seq = ?', prev, hash, r.seq);
    prev = hash;
  }
  const before = lib.sql.exec('SELECT hash FROM audit ORDER BY seq').toArray().map(r => r.hash);
  assert.equal(verifyChain(lib.sql).reason, 'TAMPERED');
  ensureChainFresh(lib.sql);
  assert.deepEqual(lib.sql.exec('SELECT hash FROM audit ORDER BY seq').toArray().map(r => r.hash), before);
  assert.equal(verifyDaily(lib.sql).reason, 'TAMPERED');
  assert.equal(verifyChain(lib.sql).ok, false);
});
function ensureChainFresh(sql) { ensureChain({ exec: (...a) => sql.exec(...a) }); }

test('reseal-chain is not a route', async () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
  lib.log('r', EMAIL, 'saved', 'd');
  const env = { ATLAS_TENANT_ISOLATION: 'local-synthetic', ORIGIN, CSRF_SECRET: 's' };
  const post = (role, body) => libraryRoutes(new Request('https://atlas.internal/api/library/reseal-chain', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-user': 'atlas', 'x-atlas-role': role }, body: JSON.stringify(body),
  }), lib, { env });
  assert.equal((await post('user', { confirm: 'reseal-audit-chain' })).status, 404);
  assert.equal((await post('system', {})).status, 404);
  assert.equal((await post('system', { confirm: 'reseal-audit-chain' })).status, 404);
  assert.equal(verifyChain(lib.sql).ok, true);
});

test('a non-production CSP report still accepts the CSRF_SECRET fallback', async () => {
  const env = { ORIGIN, CSRF_SECRET: 's', DATA_MODE: 'demo', INTERVIEW: ns(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) };
  const res = await handle(new Request(ORIGIN + '/api/csp-report', {
    method: 'POST',
    headers: { 'content-type': 'application/csp-report', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ 'csp-report': { 'effective-directive': 'connect-src', 'blocked-uri': 'https://evil.example/nope' } }),
  }), env, '<html></html>');
  assert.equal(res.status, 204);
});

test('a production CSP report without LOG_SALT does not hash the IP with CSRF_SECRET', async () => {
  const env = { ...ENV, DATA_MODE: 'production', CSRF_SECRET: 's', INTERVIEW: ns(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) };
  delete env.LOG_SALT;
  const res = await handle(new Request(ORIGIN + '/api/csp-report', {
    method: 'POST',
    headers: { 'content-type': 'application/csp-report', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ 'csp-report': { 'effective-directive': 'connect-src', 'blocked-uri': 'https://evil.example/nope' } }),
  }), env, '<html></html>');
  assert.equal(res.status, 503);
});
