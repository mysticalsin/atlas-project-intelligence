// Slice 1 red tests: hash-only CSP, platform headers, and privacy routes that must not weaken tenant isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import * as profile from '../src/profile.js';

const TEAM = 'team.cloudflareaccess.com', AUD = 'aud-123', ORIGIN = 'https://atlas.example.workers.dev';
const b64u = b => Buffer.from(b).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
globalThis.fetch = async url => { assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys: [jwk] })); };
async function jwt(claims = {}, header = { alg: 'RS256', kid: 'k1' }) {
  const now = Math.floor(Date.now() / 1000), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'user-abc', email: 'tony@example.com', exp: now + 600, iat: now, ...claims };
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}
const ENV = { ORIGIN, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, CSRF_SECRET: 'test-secret', TALKER_MODEL: 'talker', TTS_VOICE: 'harmonia',
  ATLAS_ADMIN_ROLES: 'ATLAS.Admin', ATLAS_PRESALES_ROLES: 'ATLAS.Presales,ATLAS.Publish', ATLAS_REVIEWER_ROLES: 'ATLAS.Reviewer,ATLAS.Review' };
const signed = async (path, claims = {}, init = {}) => new Request(ORIGIN + path, { ...init, headers: { 'cf-access-jwt-assertion': await jwt(claims), ...(init.headers || {}) } });
const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
const ref = () => ({ title: 'Northwind pilot alias', stage: 'Pilot', sector: 'Insurance', consultant: { name: 'Ada', role: 'Consultant' },
  client: { name: 'Northwind Mutual', location: 'Lyon', contact: 'Ops' },
  details: { projectId: 'PRJ-SYN', country: 'France', consultants: [{ name: 'Jo', email: 'jo@example.test', role: 'PO' }] },
  answers: ['The client had a slow queue.', 'I rebuilt the routing step.', 'We kept a manual fallback.', 'The queue was shorter on the team dashboard.', 'Dashboard export v1.', 'Similar service desks.'],
  validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: true } });

function scriptSrc(csp) {
  const m = /(?:^|; )\s*script-src ([^;]*)/.exec(csp || '');
  return m ? m[1] : '';
}

test('html responses use a hash-only script policy and every refusal carries the platform headers', async () => {
  const { htmlCsp, legacyCsp } = await import('../src/csp.js');
  const built = htmlCsp({ hashes: ['sha256-abc'], connect: 'wss://atlas.example', scriptBlob: true, workerBlob: true, mediaBlob: true });
  assert.equal(scriptSrc(built).includes('unsafe-inline'), false);
  assert.match(built, /script-src 'sha256-abc' blob:/);
  assert.match(built, /script-src-attr 'none'/);
  assert.match(built, /style-src 'unsafe-inline'/);
  assert.match(built, /require-trusted-types-for 'script'/);
  assert.match(legacyCsp('wss://atlas.example'), /script-src 'unsafe-inline' blob:/);

  const refused = await handle(new Request(ORIGIN + '/'), ENV, '<html></html>');
  assert.equal(refused.status, 401);
  const csp = refused.headers.get('content-security-policy');
  assert.equal(scriptSrc(csp).includes('unsafe-inline'), false);
  assert.match(csp, /default-src 'none'/);
  assert.equal(csp.includes('blob:'), false);
  assert.equal(/wss:|ws:/.test(csp), false);
  assert.equal(refused.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
  assert.equal(refused.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(refused.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(refused.headers.get('x-content-type-options'), 'nosniff');
});

test('the served page keeps its executable scripts stable and puts per-person facts in a JSON block', async () => {
  const marker = '<script id="atlas-runtime" type="application/json">{}</script><script>/* page */</script>';
  const r = await handle(await signed('/'), ENV, marker);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.equal(html.includes('window.ATLAS_RUNTIME='), false);
  const block = /<script id="atlas-runtime" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(block, 'runtime JSON block');
  const data = JSON.parse(block[1]);
  assert.equal(data.authMode, 'access');
  assert.equal(typeof data.subjectKey, 'string');
  assert.equal(data.subjectKey.length > 0, true);
  assert.equal(html.includes('<script>/* page */</script>'), true);
  const csp = r.headers.get('content-security-policy');
  assert.equal(scriptSrc(csp).includes('unsafe-inline'), false);
  assert.match(csp, /sha256-/);
});

test('read-only mode refuses a library write before the library object is requested', async () => {
  let calls = 0;
  const stub = { idFromName() { calls += 1; return 'g'; }, get() { calls += 1; return { fetch() { calls += 1; return new Response('{}'); } }; } };
  const boot = await (await handle(await signed('/api/bootstrap'), { ...ENV, LIBRARY: stub }, '')).json();
  const res = await handle(await signed('/api/library', {}, { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json' } }), { ...ENV, LIBRARY: stub, ATLAS_READ_ONLY: '1' }, '');
  assert.equal(res.status, 503);
  assert.equal(calls, 0);
});

test('a subject erase without a verified tenant does not call the library', async () => {
  let calls = 0;
  const stub = { idFromName() { calls += 1; return 'g'; }, get() { calls += 1; return { fetch() { calls += 1; return new Response('{}'); } }; } };
  const boot = await (await handle(await signed('/api/bootstrap'), { ...ENV, LIBRARY: stub }, '')).json();
  const res = await handle(await signed('/api/me/erase', {}, { method: 'POST', body: '{"confirmed":true}', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json', 'x-atlas-tenant': A } }), { ...ENV, LIBRARY: stub }, '');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /verified tenant/);
  assert.equal(calls, 0);
});

test('library erasure stays inside the verified tenant and does not report the other one', async () => {
  const l = new Library(memorySql(), { now: () => '2026-11-12T00:00:00.000Z' });
  profile.ensure(l);
  const ada = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenantEnforced: true };
  const mine = await l.upsert({ ...ada, tenant: A }, { localId: 'mine', reference: ref() });
  const other = await l.upsert({ ...ada, tenant: B }, { localId: 'other', reference: ref() });
  l.sql.exec("INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES ('ada@example.test', '', 'ada@example.test', '{}', '{}', '{}', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')");
  const headers = { 'x-atlas-user': 'ada@example.test', 'x-atlas-role': 'user', 'x-atlas-email': 'ada@example.test', 'x-atlas-tenant-enforced': '1', 'x-atlas-subj': 'ab'.repeat(16) };
  const env = { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' };
  const missing = await libraryRoutes(new Request('https://atlas.internal/api/privacy/erase', { method: 'POST', body: '{"confirmed":true}', headers: { ...headers, 'x-atlas-tenant': '' } }), l, { env });
  assert.equal(missing.status, 403);
  assert.equal(l.row(mine.id).data.title, 'Northwind pilot alias');
  const erased = await libraryRoutes(new Request('https://atlas.internal/api/privacy/erase', { method: 'POST', body: '{"confirmed":true}', headers: { ...headers, 'x-atlas-tenant': A } }), l, { env });
  assert.equal(erased.status, 200);
  const body = await erased.json();
  assert.equal(JSON.stringify(body).includes(B), false);
  assert.equal(JSON.stringify(body).includes('kim@example.test'), false);
  assert.equal(l.row(other.id).data.title, 'Northwind pilot alias');
  assert.equal(l.row(other.id).owner, 'ada@example.test');
  assert.equal(l.row(mine.id).data.title, '[erased]');
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM profiles WHERE subject = 'ada@example.test' AND tenant = ''")[0].n, 1);
  const legacy = await (await libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', { method: 'POST', body: '{}', headers: { 'x-atlas-user': 'ada@example.test', 'x-atlas-role': 'user', 'x-atlas-email': 'ada@example.test', 'x-atlas-tenant': B, 'x-atlas-tenant-enforced': '1' } }), l, { env })).json();
  assert.equal(legacy.complete, false);
  assert.equal(l.row(other.id).owner, 'ada@example.test');
  assert.equal(JSON.stringify(legacy).includes(A), false);
});
