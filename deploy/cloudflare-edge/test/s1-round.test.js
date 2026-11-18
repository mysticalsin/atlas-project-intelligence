// Round on cdb55bcc plus the browser and erasure residuals. These fail on that tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { memoryRoutes } from '../src/memory-routes.js';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { appendAudit, verifyChain, verifyDaily } from '../src/audit-chain.js';
import { eraseMine } from '../src/subject-rights.js';
import { privacyRoutes } from '../src/operate.js';
import { ensure as ensureOutreach } from '../src/outreach.js';
import { ensureJourney } from '../src/journey.js';
import * as profile from '../src/profile.js';
import { FakeStorage } from './reconnect-harness.js';
import { ENV, ORIGIN, session } from './security-harness.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
const EMAIL = 'ada@example.test';
const STAMP = '2026-11-16T00:00:00.000Z';
const DELETE_ENV = { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' };

function store() {
  const lib = new Library(memorySql(), { now: () => STAMP });
  profile.ensure(lib);
  ensureOutreach(lib);
  return lib;
}
const user = tenant => ({ email: EMAIL, mail: EMAIL, role: 'user', tenant, tenantEnforced: true, subj: 'ab'.repeat(16) });

test('ensureChain does not seal a NULL commit from the actor now in the row', () => {
  const sql = memorySql();
  sql.exec('CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)');
  appendAudit(sql, { id: 'r1', actor: 'a1@example.test', action: 'saved', at: STAMP, detail: 'one' });
  appendAudit(sql, { id: 'r2', actor: 'a2@example.test', action: 'saved', at: STAMP, detail: 'two' });
  const anchored = verifyDaily(sql);
  assert.equal(anchored.ok, true);
  const before = sql.exec('SELECT n, head FROM audit_anchor').toArray()[0];
  sql.exec('UPDATE audit SET hash = NULL, "commit" = NULL, actor = ? WHERE seq = 2', 'mallory');
  const fresh = { exec: (...args) => sql.exec(...args) };
  const checked = verifyChain(fresh);
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'UNSEALED');
  const tail = sql.exec('SELECT * FROM audit WHERE seq = 2').toArray()[0];
  assert.equal(tail.actor, 'mallory');
  assert.equal(tail.commit, null);
  assert.equal(tail.hash, null);
  const daily = verifyDaily({ exec: (...args) => sql.exec(...args) });
  assert.equal(daily.ok, false);
  assert.deepEqual(sql.exec('SELECT n, head FROM audit_anchor').toArray()[0], before);
});

test('memoryRoutes answers /api/limit the way the Interview object does', async () => {
  const storage = new FakeStorage();
  const call = () => memoryRoutes(new Request('https://atlas.internal/api/limit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ checks: [{ bucket: 'sheet', max: 1, windowMs: 3600000 }] }),
  }), { storage, hs: null, env: {} });
  assert.equal((await call()).status, 200);
  const again = await call();
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers.get('retry-after')) >= 1);
});

test('transcribe without consent is 403 before the limiter is asked', async () => {
  let hits = 0;
  const interview = { idFromName: n => n, get: () => ({ fetch: async () => { hits += 1; return new Response('missing', { status: 404 }); } }) };
  const env = { ...ENV, INTERVIEW: interview, STT_MODEL: 'stt', AI: { run: async () => { throw new Error('stt'); } } };
  const me = await session(env);
  const res = await handle(new Request(ORIGIN + '/api/transcribe', {
    method: 'POST', body: new Uint8Array(9600),
    headers: { 'cf-access-jwt-assertion': me.token, Origin: ORIGIN, 'X-Atlas-CSRF': me.csrf, 'Content-Type': 'audio/L16;rate=24000' },
  }), env, '', { flagsOf: () => ({ spokenAsk: true, ask: true }) });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /consent/);
  assert.equal(hits, 0);
});

test('sheet draft reaches the handler when Interview is the memory route', async () => {
  const storage = new FakeStorage();
  const interview = { idFromName: n => n, get: () => ({ fetch: request => memoryRoutes(request, { storage, hs: null, env: {} }) }) };
  const env = { ...ENV, INTERVIEW: interview, AI: { toMarkdown: async () => ({ format: 'markdown', data: 'x' }), run: async () => ({ response: '{"project":{}}' }) } };
  const me = await session(env);
  const res = await me.go('/api/sheet/draft', { method: 'POST', body: '{}' }, env);
  const body = await res.json();
  assert.notEqual(body.code, 'LIMIT_UNAVAILABLE');
  assert.notEqual(res.status, 503);
});

function plantCopies(lib) {
  for (const tenant of [A, B]) {
    sqlOf(lib).exec('INSERT INTO refs (id, owner, title, status, revision, data, state, tenant, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'story-' + tenant.slice(0, 4), 'kim@example.test', 'Kim', 'draft', 1, '{}', '{}', tenant, STAMP, STAMP);
    lib.log('story-' + tenant.slice(0, 4), 'kim@example.test', 'interview invitation', 'manual for ' + EMAIL);
    sqlOf(lib).exec('INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'kim@example.test', tenant, 'kim@example.test', JSON.stringify({ managerEmail: { value: EMAIL, at: STAMP } }), '{}', '{}', STAMP, STAMP, STAMP);
    sqlOf(lib).exec('INSERT INTO directory_imports (batch, tenant, source, by, started_at, finished_at, rows, rejected, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'batch-' + tenant.slice(0, 4), tenant, 'csv', EMAIL, STAMP, STAMP, 1, 0, 'applied');
    sqlOf(lib).exec('INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, payload, created_at, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'out-' + tenant.slice(0, 4), 'gap_request', 'subj-' + tenant.slice(0, 4), 'email_draft', 'kim@example.test', 'pending_approval', JSON.stringify({ note: 'please ask ' + EMAIL }), STAMP, tenant);
  }
}

test('subject erasure removes same-tenant address copies and leaves the other tenant', () => {
  const lib = store();
  plantCopies(lib);
  eraseMine(lib, user(A), user(A).subj);
  const text = row => JSON.stringify(row);
  const auditA = sqlOf(lib).exec('SELECT actor, detail FROM audit WHERE id = ?', 'story-abcd').toArray()[0];
  const auditB = sqlOf(lib).exec('SELECT detail FROM audit WHERE id = ?', 'story-bbbb').toArray()[0];
  assert.equal(text(auditA).includes(EMAIL), false);
  assert.equal(auditB.detail, 'manual for ' + EMAIL);
  const profileA = JSON.parse(sqlOf(lib).exec('SELECT edits FROM profiles WHERE tenant = ?', A).toArray()[0].edits);
  const profileB = JSON.parse(sqlOf(lib).exec('SELECT edits FROM profiles WHERE tenant = ?', B).toArray()[0].edits);
  assert.equal(String(profileA.managerEmail.value).toLowerCase() === EMAIL, false);
  assert.equal(profileB.managerEmail.value, EMAIL);
  assert.equal(sqlOf(lib).exec('SELECT by FROM directory_imports WHERE tenant = ?', A).toArray()[0].by === EMAIL, false);
  assert.equal(sqlOf(lib).exec('SELECT by FROM directory_imports WHERE tenant = ?', B).toArray()[0].by, EMAIL);
  const outA = sqlOf(lib).exec('SELECT to_email, payload FROM outreach WHERE tenant = ?', A).toArray()[0];
  const outB = sqlOf(lib).exec('SELECT payload FROM outreach WHERE tenant = ?', B).toArray()[0];
  assert.equal(outA.to_email, 'kim@example.test');
  assert.equal(outA.payload.includes(EMAIL), false);
  assert.equal(outB.payload.includes(EMAIL), true);
});

test('tenant privacy delete does not rewrite those same-tenant copies', async () => {
  const lib = store();
  plantCopies(lib);
  const { libraryRoutes } = await import('../src/library-routes.js');
  const res = await libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', {
    method: 'POST', body: '{}',
    headers: { 'x-atlas-user': EMAIL, 'x-atlas-role': 'user', 'x-atlas-email': EMAIL, 'x-atlas-tenant': A, 'x-atlas-tenant-enforced': '1' },
  }), lib, { env: DELETE_ENV });
  assert.equal(res.status, 200);
  assert.equal(sqlOf(lib).exec('SELECT detail FROM audit WHERE id = ?', 'story-abcd').toArray()[0].detail, 'manual for ' + EMAIL);
  assert.equal(JSON.parse(sqlOf(lib).exec('SELECT edits FROM profiles WHERE tenant = ?', A).toArray()[0].edits).managerEmail.value, EMAIL);
  assert.equal(sqlOf(lib).exec('SELECT by FROM directory_imports WHERE tenant = ?', A).toArray()[0].by, EMAIL);
  assert.equal(sqlOf(lib).exec('SELECT payload FROM outreach WHERE tenant = ?', A).toArray()[0].payload.includes(EMAIL), true);
});

test('a privacy delete that cannot write its receipt leaves the journey row', async () => {
  const lib = store();
  ensureJourney(lib);
  sqlOf(lib).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', EMAIL, A, '{}', STAMP);
  const orig = lib.log.bind(lib);
  lib.log = (id, actor, action, detail) => {
    if (action === 'privacy delete') throw new Error('disk');
    return orig(id, actor, action, detail);
  };
  await assert.rejects(() => privacyRoutes({ method: 'POST', parts: ['privacy', 'delete'], user: user(A), lib, env: DELETE_ENV, body: {} }));
  assert.equal(sqlOf(lib).exec('SELECT subject FROM journey WHERE subject = ? AND tenant = ?', EMAIL, A).toArray().length, 1);
});
