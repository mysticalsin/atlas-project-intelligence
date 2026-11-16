// Review fixes for slice 1. These fail on 91e5f2c and describe the behaviour the fix must reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, scheduled } from '../src/app.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { secure } from '../src/security-headers.js';
import { secEvent } from '../src/security-log.js';
import { eraseMine, exportMine, pseudonymiseAudit } from '../src/subject-rights.js';
import { verifyChain } from '../src/audit-chain.js';
import * as profile from '../src/profile.js';
import * as claims from '../src/claims.js';
import * as bids from '../src/bids.js';
import * as privacy from '../src/privacy.js';
import * as outreach from '../src/outreach.js';
import { limitRoute } from '../src/ratelimit.js';
import { FakeStorage } from './reconnect-harness.js';
import { ENV, ORIGIN, jwt, session, ns } from './security-harness.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
const EMAIL = 'ada@example.test';
const scriptSrc = csp => ((/(?:^|; )\s*script-src ([^;]*)/.exec(csp || '') || [])[1] || '');
const ref = () => ({ title: 'Northwind pilot alias', stage: 'Pilot', sector: 'Insurance', consultant: { name: 'Ada', role: 'Consultant' },
  client: { name: 'Northwind Mutual', location: 'Lyon', contact: 'Ops' },
  details: { projectId: 'PRJ-SYN', country: 'France', consultants: [{ name: 'Jo', email: 'jo@example.test', role: 'PO' }] },
  answers: ['The client had a slow queue.', 'I rebuilt the routing step.', 'We kept a manual fallback.', 'The queue was shorter on the team dashboard.', 'Dashboard export v1.', 'Similar service desks.'],
  validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: true } });
const ada = tenant => ({ email: EMAIL, mail: EMAIL, role: 'user', tenant, tenantEnforced: true, subj: 'ab'.repeat(16) });
const libEnv = { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' };

function fresh() {
  const lib = new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
  profile.ensure(lib);
  return lib;
}
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

test('each page gets only the connect, blob and trusted-type capabilities it uses', async () => {
  const page = '<html><script id="atlas-runtime" type="application/json">{}</script><script>/* page */</script></body>';
  const token = await jwt();
  const get = path => handle(new Request(ORIGIN + path, { headers: { 'cf-access-jwt-assertion': token } }), ENV, page);
  const confirm = (await get('/confirm')).headers.get('content-security-policy');
  assert.match(confirm, /connect-src 'self'(;|$)/);
  assert.equal(confirm.includes('blob:'), false);
  assert.equal(/wss:|ws:/.test(confirm), false);
  assert.equal(confirm.includes('worker-src'), false);
  assert.equal(confirm.includes('media-src'), false);
  assert.match(confirm, /trusted-types 'none'/);
  assert.equal(scriptSrc(confirm).includes('unsafe-inline'), false);

  const home = (await get('/')).headers.get('content-security-policy');
  assert.match(home, /connect-src 'self' wss:/);
  assert.match(home, /script-src [^;]*blob:/);
  assert.match(home, /worker-src blob:/);
  assert.match(home, /media-src blob:/);
  assert.match(home, /trusted-types atlas-html/);
  assert.match(home, /style-src 'unsafe-inline'/);

  for (const path of ['/go/signed-in', '/privacy']) {
    const csp = (await get(path)).headers.get('content-security-policy');
    assert.equal(/connect-src/.test(csp), false, path);
    assert.equal(csp.includes('blob:'), false, path);
    assert.equal(/wss:|ws:/.test(csp), false, path);
  }
  const json = (await get('/api/bootstrap')).headers.get('content-security-policy');
  assert.match(json, /default-src 'none'/);
  assert.equal(json.includes('blob:'), false);
  assert.equal(/wss:|ws:/.test(json), false);
  assert.equal(json.includes('worker-src'), false);
});

test('a subject export and erase stay inside one tenant for confirmations and bid use', async () => {
  const lib = fresh();
  claims.ensure(lib);
  bids.ensure(lib);
  const insertReq = (id, refId, tenant, to, by) => lib.sql.exec(
    'INSERT INTO confirmation_requests (id, ref_id, to_email, created_by, created_at, status, tenant) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, refId, to, by, '2026-01-01T00:00:00.000Z', 'open', tenant);
  insertReq('req-a-to', 'ref-a', A, EMAIL, 'sam@example.test');
  insertReq('req-b-to', 'ref-b', B, EMAIL, 'sam@example.test');
  insertReq('req-a-by', 'ref-a2', A, 'sam@example.test', EMAIL);
  insertReq('req-b-by', 'ref-b2', B, 'sam@example.test', EMAIL);
  lib.sql.exec("INSERT INTO bids (id, owner, title, created_at, updated_at, tenant) VALUES ('bid-a', ?, 'A', '2026-01-01', '2026-01-01', ?), ('bid-b', ?, 'B', '2026-01-01', '2026-01-01', ?)", EMAIL, A, EMAIL, B);
  lib.sql.exec("INSERT INTO bid_references (bid_id, ref_id, used_by) VALUES ('bid-a', 'ref-a', ?), ('bid-b', 'ref-b', ?)", EMAIL, EMAIL);
  const exported = exportMine(lib, ada(A), 'ab'.repeat(16));
  const ids = exported.confirmationRequests.map(r => r.id).sort();
  const refIds = exported.confirmationRequests.map(r => r.refId).sort();
  assert.deepEqual(ids, ['req-a-by', 'req-a-to']);
  assert.deepEqual(refIds, ['ref-a', 'ref-a2']);
  assert.equal(JSON.stringify(exported).includes('req-b'), false);
  assert.equal(JSON.stringify(exported).includes('ref-b'), false);
  eraseMine(lib, ada(A), 'ab'.repeat(16));
  const left = lib.sql.exec('SELECT id, to_email, created_by, tenant FROM confirmation_requests ORDER BY id').toArray();
  const byId = Object.fromEntries(left.map(r => [r.id, r]));
  assert.equal(byId['req-b-to'].to_email, EMAIL);
  assert.equal(byId['req-b-by'].created_by, EMAIL);
  assert.notEqual(byId['req-a-to'].to_email, EMAIL);
  assert.notEqual(byId['req-a-by'].created_by, EMAIL);
  const used = Object.fromEntries(lib.sql.exec('SELECT bid_id, used_by FROM bid_references').toArray().map(r => [r.bid_id, r.used_by]));
  assert.equal(used['bid-b'], EMAIL);
  assert.notEqual(used['bid-a'], EMAIL);
});

test('staffing and teams rows are erased for this tenant without an outreach table, and the other tenant stays', () => {
  const lib = fresh();
  assert.equal(lib.sql.exec("SELECT name FROM sqlite_master WHERE name = 'outreach'").toArray().length, 0);
  lib.sql.exec('CREATE TABLE staffing (project_id TEXT, consultant_email TEXT, tenant TEXT)');
  lib.sql.exec('CREATE TABLE teams_conversations (subject TEXT PRIMARY KEY, email TEXT, tenant_id TEXT)');
  lib.sql.exec('INSERT INTO staffing (project_id, consultant_email, tenant) VALUES (?, ?, ?), (?, ?, ?)', 'p', EMAIL, A, 'p', EMAIL, B);
  lib.sql.exec('INSERT INTO teams_conversations (subject, email, tenant_id) VALUES (?, ?, ?), (?, ?, ?)', 'sa', EMAIL, A, 'sb', EMAIL, B);
  eraseMine(lib, ada(A), 'ab'.repeat(16));
  assert.deepEqual(lib.sql.exec('SELECT tenant FROM staffing ORDER BY tenant').toArray().map(r => r.tenant), [B]);
  assert.deepEqual(lib.sql.exec('SELECT tenant_id FROM teams_conversations ORDER BY tenant_id').toArray().map(r => r.tenant_id), [B]);
});

test('erasure does not run SQL for evidence, approvals or jobs, which this slice does not create', () => {
  const lib = fresh();
  lib.sql.exec("CREATE TABLE evidence_records (id TEXT PRIMARY KEY, owner_sub TEXT, status TEXT, state_json TEXT)");
  lib.sql.exec("INSERT INTO evidence_records (id, owner_sub, status, state_json) VALUES ('ev', ?, 'draft', '{}')", EMAIL);
  lib.sql.exec('CREATE TABLE approvals (id TEXT, approver_sub TEXT)');
  lib.sql.exec("INSERT INTO approvals (id, approver_sub) VALUES ('ap', ?)", EMAIL);
  lib.sql.exec('CREATE TABLE jobs (id TEXT, actor TEXT)');
  lib.sql.exec('CREATE TABLE job_events (id TEXT, actor TEXT)');
  lib.sql.exec("INSERT INTO jobs (id, actor) VALUES ('job', ?)", EMAIL);
  lib.sql.exec("INSERT INTO job_events (id, actor) VALUES ('evt', ?)", EMAIL);
  const out = eraseMine(lib, ada(A), 'ab'.repeat(16));
  assert.equal(out.erased === true || out.libraryErased === true || out.counts, true);
  assert.equal(lib.sql.exec('SELECT owner_sub FROM evidence_records').toArray()[0].owner_sub, EMAIL);
  assert.equal(lib.sql.exec('SELECT approver_sub FROM approvals').toArray()[0].approver_sub, EMAIL);
  assert.equal(lib.sql.exec('SELECT actor FROM jobs').toArray()[0].actor, EMAIL);
  assert.equal(lib.sql.exec('SELECT actor FROM job_events').toArray()[0].actor, EMAIL);
});

test('a failure mid-erase rolls the whole erase back', async () => {
  const lib = fresh();
  const user = ada(A);
  const first = await lib.upsert(user, { localId: 'one', reference: ref() });
  const second = await lib.upsert(user, { localId: 'two', reference: ref() });
  const real = lib.sql.exec.bind(lib.sql);
  let n = 0;
  lib.sql.exec = (q, ...p) => {
    if (String(q).includes("title = '[erased]'") && ++n === 2) throw new Error('injected mid-erase');
    return real(q, ...p);
  };
  assert.throws(() => eraseMine(lib, user, 'ab'.repeat(16)), /injected mid-erase/);
  assert.equal(lib.row(first.id).data.title, 'Northwind pilot alias');
  assert.equal(lib.row(second.id).data.title, 'Northwind pilot alias');
});

test('pseudonymising one tenant does not rewrite later audit links', () => {
  const lib = fresh();
  lib.log('ref-a', EMAIL, 'saved', 'note ' + EMAIL);
  lib.log('ref-b', 'kim@example.test', 'saved', 'other tenant');
  const before = lib.sql.exec('SELECT seq, prev_hash, hash FROM audit ORDER BY seq').toArray();
  const out = pseudonymiseAudit(lib, [EMAIL], 'erased:abcd01abcd01', { ids: ['ref-a'] });
  const after = lib.sql.exec('SELECT seq, prev_hash, hash, actor FROM audit ORDER BY seq').toArray();
  assert.equal(out.refused, undefined);
  assert.notEqual(after[0].actor, EMAIL);
  assert.equal(after[1].prev_hash, before[1].prev_hash);
  assert.equal(after[1].hash, before[1].hash);
  assert.equal(verifyChain(lib.sql).ok, true);
  assert.equal(verifyChain(lib.sql).head, before[1].hash);
});

test('the daily cron records an anchor and reports head truncation, tail truncation and a mid-chain edit', async () => {
  const events = [];
  const orig = console.log;
  console.log = line => { try { const j = JSON.parse(line); if (j.atlas_sec) events.push(j); } catch { /* not a security line */ } };
  try {
    const run = async lib => {
      events.length = 0;
      const waited = [];
      const gateway = { idFromName: () => 'g', get: () => ({ fetch: r => libraryRoutes(r, lib, { env: { ATLAS_TENANT_ISOLATION: 'local-synthetic' } }) }) };
      await scheduled({}, { LIBRARY: gateway, ATLAS_TENANT_ISOLATION: 'local-synthetic', ORIGIN, CSRF_SECRET: 's' }, { waitUntil: p => waited.push(p) });
      await Promise.all(waited);
      return events.slice();
    };
    const chain = () => {
      const lib = fresh();
      for (let i = 1; i <= 4; i++) lib.log('r' + i, 'a@example.test', 'saved', 'd' + i);
      return lib;
    };
    let lib = chain();
    const ok = await run(lib);
    assert.equal(ok.some(e => e.event === 'audit_chain_ok' && e.n === 4 && /^[0-9a-f]{16}$/.test(e.head)), true);
    assert.equal(lib.sql.exec("SELECT name FROM sqlite_master WHERE name = 'audit_anchor'").toArray().length, 1);
    lib.sql.exec('DELETE FROM audit WHERE seq = (SELECT MIN(seq) FROM audit)');
    const tail = await run(lib);
    assert.equal(tail.some(e => e.event === 'audit_chain_break'), true, 'dropping the oldest rows must not still look like a full chain');
    lib = chain();
    await run(lib);
    lib.sql.exec('DELETE FROM audit WHERE seq = (SELECT MAX(seq) FROM audit)');
    const head = await run(lib);
    assert.equal(head.some(e => e.event === 'audit_chain_break' && e.reason === 'TRUNCATED'), true);
    lib = chain();
    await run(lib);
    lib.sql.exec("UPDATE audit SET action = 'tampered' WHERE seq = 2");
    const mid = await run(lib);
    assert.equal(mid.some(e => e.event === 'audit_chain_break' && e.reason === 'HASH_MISMATCH'), true);
  } finally { console.log = orig; }
});

test('read-only freezes the cron after the audit-chain check', async () => {
  const lib = fresh();
  const saved = await lib.upsert({ email: EMAIL, role: 'user', tenant: '', tenantEnforced: false }, { localId: 'old', reference: ref() });
  lib.sql.exec("UPDATE refs SET updated_at = '2020-01-01T00:00:00.000Z', next_review = '2020-06-01T00:00:00.000Z', state = ? WHERE id = ?", JSON.stringify({ draft: true, tenant: '' }), saved.id);
  const events = [];
  const orig = console.log;
  console.log = line => { try { const j = JSON.parse(line); if (j.atlas_sec) events.push(j); } catch { /* ignore */ } };
  try {
    const waited = [];
    const gateway = { idFromName: () => 'g', get: () => ({ fetch: r => libraryRoutes(r, lib, { env: { ATLAS_TENANT_ISOLATION: 'local-synthetic', ATLAS_READ_ONLY: '1' } }) }) };
    await scheduled({}, { LIBRARY: gateway, ATLAS_TENANT_ISOLATION: 'local-synthetic', ATLAS_READ_ONLY: '1', ORIGIN, CSRF_SECRET: 's' }, { waitUntil: p => waited.push(p) });
    await Promise.all(waited);
  } finally { console.log = orig; }
  assert.equal(lib.sql.exec('SELECT COUNT(*) AS n FROM invitations').toArray()[0].n, 0);
  assert.equal(lib.row(saved.id).data.title, 'Northwind pilot alias');
  assert.equal(lib.row(saved.id).merged_into || null, null);
  assert.equal(events.some(e => e.event === 'audit_chain_ok' || e.event === 'audit_chain_break'), true);
});

test('scan-stale returns the same payload main returns when the cron tenant has an old draft', async () => {
  const make = async () => {
    const lib = fresh();
    const saved = await lib.upsert({ email: EMAIL, role: 'user', tenant: '', tenantEnforced: false }, { localId: 'old', reference: ref() });
    lib.sql.exec("UPDATE refs SET updated_at = '2020-01-01T00:00:00.000Z', next_review = '2020-06-01T00:00:00.000Z', state = ? WHERE id = ?", JSON.stringify({ draft: true, tenant: '' }), saved.id);
    return lib;
  };
  const user = { email: 'atlas-cron', role: 'system', tenant: '', tenantEnforced: false };
  const twin = await make();
  const expected = { invited: twin.scanStale(user), ...outreach.daily(twin, user), ...(profile.READY ? profile.daily(twin, twin.now(), user) : {}) };
  assert.equal(expected.invited, 1);
  const live = await make();
  const res = await libraryRoutes(new Request('https://atlas.internal/api/library/scan-stale', { method: 'POST', body: '{}', headers: { 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system', 'x-atlas-tenant-enforced': '0' } }), live, { env: { ATLAS_TENANT_ISOLATION: 'local-synthetic' } });
  assert.deepEqual(await res.json(), expected);
});

const OID = '66666666-7777-4888-8999-000000000000';
const entraEnv = (extra = {}) => ({ ...ENV, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: A, LOG_SALT: 'synthetic-log-salt', ...extra });
const entraClaims = { email: EMAIL, custom: { tid: A, oid: OID } };

test('export and erase name the Interview object parts they do not cover', async () => {
  const bodyOf = action => new Response(JSON.stringify(action === 'erase' ? { erased: true, counts: { referencesErased: 1 } } : { schema: 'atlas.subject-export.v1', references: [] }), { headers: { 'content-type': 'application/json' } });
  const library = { idFromName: () => 'g', get: () => ({ fetch: async r => bodyOf(new URL(r.url).pathname.endsWith('/erase') ? 'erase' : 'export') }) };
  const interview = { idFromName: () => 'i', get: () => ({ fetch: async () => new Response('{"ok":true}') }) };
  const me = await session(entraEnv({ LIBRARY: library, INTERVIEW: interview }), entraClaims);
  const headers = { Origin: ORIGIN, 'X-Atlas-CSRF': me.csrf };
  const exported = await (await me.go('/api/me/export', { headers })).json();
  assert.equal(exported.complete, false);
  for (const store of ['interview-checkpoint', 'interview-consent', 'interview-memory']) {
    const row = exported.notCovered.find(s => s.store === store);
    assert.equal(row.exported, false, store);
    assert.equal(row.erased, false, store);
  }
  const erased = await (await me.go('/api/me/erase', { method: 'POST', body: '{"confirmed":true}', headers })).json();
  assert.equal(erased.complete, false);
  assert.equal(erased.erased, false);
  assert.equal(erased.libraryErased, true);
  assert.equal(erased.notCovered.every(s => s.erased === false), true);
});

test('GET /api/me/export rejects a missing origin before the library', async () => {
  let calls = 0;
  const library = { idFromName: () => 'g', get: () => ({ fetch: async () => { calls += 1; return new Response('{}', { headers: { 'content-type': 'application/json' } }); } }) };
  const interview = { idFromName: () => 'i', get: () => ({ fetch: async () => new Response('{"ok":true}') }) };
  const me = await session(entraEnv({ LIBRARY: library, INTERVIEW: interview }), entraClaims);
  const res = await me.go('/api/me/export');
  assert.equal(res.status, 403);
  assert.equal(calls, 0);
  const ok = await me.go('/api/me/export', { headers: { Origin: ORIGIN, 'X-Atlas-CSRF': me.csrf } });
  assert.equal(ok.status, 200);
  assert.equal(calls, 1);
});

test('the limiter fails closed when the Interview binding is missing or the object errors', async () => {
  const me = await session({ ...ENV, LOG_SALT: 'synthetic-log-salt' });
  const missing = await me.go('/api/sheet/draft', { method: 'POST', body: '{}' });
  assert.equal(missing.status, 503);
  const broken = { ...ENV, LOG_SALT: 'synthetic-log-salt', INTERVIEW: { idFromName: () => 'x', get: () => ({ fetch: async () => { throw new Error('DO down'); } }) } };
  const down = await me.go('/api/sheet/draft', { method: 'POST', body: '{}' }, broken);
  assert.equal(down.status, 503);
});

test('csp reports are actually rate limited', async () => {
  const stores = new Map();
  const interview = ns(async (r, name) => {
    const st = stores.get(name) || stores.set(name, new FakeStorage()).get(name);
    return new URL(r.url).pathname === '/api/limit' ? limitRoute(r, st) : new Response('{}');
  });
  const env = { ...ENV, INTERVIEW: interview, LOG_SALT: 'synthetic-log-salt' };
  const post = () => handle(new Request(ORIGIN + '/api/csp-report', { method: 'POST', body: '{"csp-report":{"effective-directive":"script-src","blocked-uri":"https://evil.example/a"}}', headers: { 'content-type': 'application/csp-report', 'cf-connecting-ip': '203.0.113.9' } }), env, '');
  for (let i = 0; i < 120; i++) assert.equal((await post()).status, 204, 'report ' + i);
  assert.equal((await post()).status, 429);
  const bare = { ...ENV };
  delete bare.LOG_SALT;
  const open = await handle(new Request(ORIGIN + '/api/csp-report', { method: 'POST', body: '{}' }), bare, '');
  assert.equal(open.status, 503);
});

test('a production deployment without LOG_SALT does not use the constant subject key', async () => {
  const env = { ...ENV, DATA_MODE: 'production' };
  delete env.LOG_SALT;
  const page = '<html><script id="atlas-runtime" type="application/json">{}</script></body>';
  const res = await handle(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': await jwt() } }), env, page);
  assert.equal(res.status, 503);
  const text = await res.text();
  const constant = (await hmacHex('atlas-subject', 'user-abc')).slice(0, 32);
  assert.equal(text.includes(constant), false);
  assert.equal(text.includes('atlas-subject'), false);
  const salted = { ...ENV, DATA_MODE: 'production', LOG_SALT: 'synthetic-log-salt' };
  const html = await (await handle(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': await jwt() } }), salted, page)).text();
  const key = JSON.parse(/<script id="atlas-runtime" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]).subjectKey;
  assert.equal(key, (await hmacHex('synthetic-log-salt', 'user-abc')).slice(0, 32));
  assert.notEqual(key, constant);
});

test('an uncaught error still returns security headers, and HTML without a policy gets a default-deny CSP', async () => {
  const res = await handle(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': await jwt() } }), { ...ENV, LOG_SALT: 'synthetic-log-salt' }, null);
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
  const text = await res.text();
  assert.equal(/TypeError|Cannot read|null/.test(text), false);
  const html = secure(new Response('<p>', { headers: { 'content-type': 'text/html' } }));
  const csp = html.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'none'/);
});

test('erasure holds are listed only for the verified tenant', async () => {
  const lib = fresh();
  privacy.ensure(lib);
  try { lib.sql.exec('ALTER TABLE erasure_holds ADD COLUMN tenant TEXT'); } catch { /* the fix may already add it */ }
  lib.sql.exec("INSERT INTO erasure_holds (id, kind, entity, subject_hash, reason, at, status, tenant) VALUES ('h-a', 'reference', 'a-hold', 'h', 'published_reference', '2026-01-01', 'pending_dpo', ?), ('h-b', 'reference', 'b-hold', 'h', 'published_reference', '2026-01-01', 'pending_dpo', ?)", A, B);
  const headers = { 'x-atlas-user': 'ada@example.test', 'x-atlas-role': 'admin', 'x-atlas-email': EMAIL, 'x-atlas-tenant': A, 'x-atlas-tenant-enforced': '1' };
  const res = await libraryRoutes(new Request('https://atlas.internal/api/library/erasure-holds', { headers }), lib, { env: libEnv });
  assert.equal(res.status, 200);
  const items = (await res.json()).items;
  assert.deepEqual(items.map(i => i.entity), ['a-hold']);
  const other = await libraryRoutes(new Request('https://atlas.internal/api/library/erasure-holds/h-b/resolve', { method: 'POST', body: '{"action":"retain"}', headers }), lib, { env: libEnv });
  assert.equal(other.status, 404);
  assert.equal(lib.sql.exec("SELECT status FROM erasure_holds WHERE id = 'h-b'").toArray()[0].status, 'pending_dpo');
});

test('a log bucket is an allow-listed name, never free text', async () => {
  const bad = await secEvent(ENV, 'rate_limited', { bucket: 'ada@example.com' }, () => {});
  assert.equal(bad.bucket, undefined);
  assert.equal(JSON.stringify(bad).includes('example'), false);
  const good = await secEvent(ENV, 'rate_limited', { bucket: 'sheet' }, () => {});
  assert.equal(good.bucket, 'sheet');
});
