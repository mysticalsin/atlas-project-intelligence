// G2 at the Worker: the privacy notice, the consent state in bootstrap, /api/consent, GET /api/me/export, the two-step POST /api/me/erase, /api/me/privacy, and the identity the
// Worker forwards. Every state change needs Origin and the CSRF token; the verified sign-in is the only identity; the security log carries numbers and codes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV, ORIGIN, session, ns } from './security-harness.js';
import { PRIVACY } from '../src/policy.generated.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function world({ libraryReply = null, interviewReply = null, env: extra = {} } = {}) {
  const lib = ns((req) => { const p = new URL(req.url).pathname; return (libraryReply && libraryReply(req, p)) || (p === '/api/privacy/export' ? json({ schema: 'atlas.subject-export.v1', references: [{ title: 'Mine' }] })
    : p === '/api/privacy/erase' ? json({ erased: true, counts: { referencesErased: 2 }, pendingReview: [{ kind: 'bid', reason: 'bid_record' }] }) : p === '/api/privacy/flags' ? json({ restricted: false, objectScoring: false, objectMatching: false, objectMemory: req.method === 'POST' }) : json({})); });
  const itv = ns((req) => { const p = new URL(req.url).pathname; return (interviewReply && interviewReply(req, p)) || (p === '/api/consent' && req.method === 'GET' ? json({ purposes: { checkpoint: { granted: true }, memory: { granted: false } }, blocked: {} })
    : p === '/api/consent' ? json({ purposes: { memory: { granted: true } }, changed: [{ purpose: 'memory', granted: true }] }) : p === '/api/me/export' ? json({ consent: {}, checkpoint: null, memory: { enabled: false, documents: [] } })
    : p === '/api/me/erase' ? json({ checkpointPurged: 3, memory: { forgotten: true, error: '' }, consentCleared: true, complete: true }) : p === '/api/checkpoint' ? json({ resumable: null, consent: { purposes: { checkpoint: { granted: true }, memory: { granted: false } }, blocked: {} } }) : json({})); });
  return { lib, itv, env: { ...ENV, LIBRARY: lib, INTERVIEW: itv, HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 'b', ...extra } };
}
const hdr = (c, name) => c.request.headers.get(name);
const body = async c => JSON.parse(await c.request.clone().text());

test('G2 /privacy: the notice is a readable page with the controller, DPO and lawful-basis placeholders, the retention table with every period marked as a proposal, and no script', async () => {
  const { env } = world(), me = await session(env), res = await me.go('/privacy');
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/html/); const html = await res.text();
  assert.doesNotMatch(html, /<script/i); assert.match(html, /Privacy notice/); assert.match(html, new RegExp(PRIVACY.version.replace(/\./g, '\\.')));
  for (const needle of ['[CONTROLLER', '[DPO name', '[LAWFUL BASIS', '[TRANSFER MECHANISMS', 'Cloudflare', 'ElevenLabs', 'Hindsight', 'TypeSafe', 'Download my data', 'Delete my data', '24 hours', 'No automated decisions about people', 'Typing instead of speaking', 'PROPOSAL — DPO to confirm', 'Drafts', 'trade-union membership'])
    assert.ok(html.includes(needle) || html.includes(needle.replace('Drafts', 'Private drafts')), needle);
  assert.doesNotMatch(html, /compliant/i); assert.doesNotMatch(html, /SYNTHETIC/);
  assert.equal((await me.go('/privacy', { signed: false })).status, 401, 'behind the sign-in like every page');
  const ext = await session({ ...env, EXTERNAL_EMAILS: 'client@x.example' }, { email: 'client@x.example' }); assert.equal((await ext.go('/privacy')).status, 200, 'an external confirmer can read what is done with their answers');
  assert.equal((await ext.go('/api/me/export')).status, 403, 'and nothing else of this surface');
  assert.equal((await me.go('/privacy', { method: 'POST', body: '{}' })).status, 404);
});

test('G2 bootstrap: carries the consent wording (one required toggle), the notice URL and the consent state in force from the person\'s own object; nothing without an Interview object', async () => {
  const { env, itv } = world(), me = await session(env), b = await (await me.go('/api/bootstrap')).json();
  assert.equal(b.privacy.version, PRIVACY.version); assert.equal(b.privacy.noticeUrl, '/privacy'); assert.deepEqual(Object.keys(b.privacy.toggles), ['capture', 'checkpoint', 'memory', 'notice']); assert.equal(b.privacy.toggles.capture.required, true);
  assert.deepEqual(b.consent, { purposes: { checkpoint: true, memory: false }, blocked: {} }); assert.ok(itv.calls.some(c => new URL(c.request.url).pathname === '/api/checkpoint' && c.name), 'one question to the person\'s own object carries both the resumable interview and the consent state');
  assert.match(b.privacy.toggles.capture.text, /private draft/); assert.equal(typeof b.privacy.special, 'string');
  const bare = await session({ ...ENV }), nb = await (await bare.go('/api/bootstrap')).json(); assert.equal(nb.consent, null); assert.ok(nb.privacy.version);
  const slow = world({ interviewReply: () => new Promise(() => {}) }), s2 = await session(slow.env), t0 = Date.now(); const sb = await (await s2.go('/api/bootstrap')).json();
  assert.equal(sb.consent, null); assert.ok(Date.now() - t0 < 4000, 'a slow object never holds the page');
});

test('G2 POST /api/consent: Origin and CSRF, the verified identity and subject key forwarded, a bounded body, rate limited; the browser never names a person', async () => {
  const { env, itv } = world(), me = await session(env); itv.calls.length = 0;
  assert.equal((await me.go('/api/consent', { method: 'POST', body: '{}', csrf: false })).status, 403); assert.equal((await me.go('/api/consent', { method: 'POST', body: '{}', origin: 'https://evil.example' })).status, 403);
  assert.equal(itv.calls.filter(c => new URL(c.request.url).pathname === '/api/consent').length, 0, 'nothing reached the object');
  const res = await me.go('/api/consent', { method: 'POST', body: JSON.stringify({ purposes: { memory: true }, channel: 'profile' }), headers: { 'x-atlas-user': 'victim@x', 'x-atlas-subj': 'f'.repeat(32) } });
  assert.equal(res.status, 200); assert.deepEqual((await res.json()).changed, [{ purpose: 'memory', granted: true }]);
  const call = itv.calls.find(c => new URL(c.request.url).pathname === '/api/consent' && c.request.method === 'POST');
  assert.equal(call.name, 'user-abc'); assert.equal(hdr(call, 'x-atlas-user'), 'tony@example.com'); assert.match(hdr(call, 'x-atlas-subj'), /^[0-9a-f]{32}$/); assert.notEqual(hdr(call, 'x-atlas-subj'), 'f'.repeat(32)); assert.deepEqual(await body(call), { purposes: { memory: true }, channel: 'profile' });
  assert.equal((await me.go('/api/consent', { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
  const none = await session({ ...ENV }); assert.equal((await none.go('/api/consent', { method: 'POST', body: '{}' })).status, 404);
});

test('G2 GET /api/me/export: one JSON file from the library and the person\'s own object under their own identity; no-store; an attachment; a library 429 and a failure are passed on honestly', async () => {
  const { env, lib, itv } = world(), me = await session(env); lib.calls.length = 0; itv.calls.length = 0;
  const res = await me.go('/api/me/export'); assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="atlas-my-data\.json"/); assert.equal(res.headers.get('cache-control'), 'no-store'); assert.match(res.headers.get('content-type'), /application\/json/);
  const out = await res.json(); assert.equal(out.schema, 'atlas.my-data.v1'); assert.equal(out.library.schema, 'atlas.subject-export.v1'); assert.deepEqual(out.interview.memory, { enabled: false, documents: [] }); assert.equal(out.privacyNoticeVersion, PRIVACY.version); assert.ok(out.exportedAt);
  const l = lib.calls.find(c => new URL(c.request.url).pathname === '/api/privacy/export'), i = itv.calls.find(c => new URL(c.request.url).pathname === '/api/me/export');
  assert.equal(hdr(l, 'x-atlas-user'), 'tony@example.com'); assert.match(hdr(l, 'x-atlas-subj'), /^[0-9a-f]{32}$/); assert.equal(l.name, 'global'); assert.equal(i.name, 'user-abc'); assert.match(hdr(i, 'x-atlas-bank'), /^atlas-[0-9a-f]{40}$/);
  assert.equal((await me.go('/api/me/export', { signed: false })).status, 401); assert.equal((await me.go('/api/me/export', { headers: { 'x-atlas-user': 'victim@x' } })).status, 200);
  assert.equal(lib.calls.at(-1).request.headers.get('x-atlas-user'), 'tony@example.com', 'a spoofed identity header never survives');
  const limited = world({ libraryReply: (r, p) => p === '/api/privacy/export' ? new Response('{"error":"Too many requests."}', { status: 429, headers: { 'Retry-After': '1800', 'Content-Type': 'application/json' } }) : null }), m2 = await session(limited.env);
  const r429 = await m2.go('/api/me/export'); assert.equal(r429.status, 429); assert.equal(r429.headers.get('retry-after'), '1800');
  const broken = world({ libraryReply: (r, p) => p === '/api/privacy/export' ? new Response('boom', { status: 500 }) : null }), m3 = await session(broken.env); assert.equal((await m3.go('/api/me/export')).status, 502);
  const half = world({ interviewReply: (r, p) => p === '/api/me/export' ? new Response('boom', { status: 500 }) : null }), m4 = await session(half.env); assert.equal((await m4.go('/api/me/export')).status, 502, 'never a partial file presented as complete');
});

test('G2 POST /api/me/erase: CSRF and Origin, a confirmation step with a short-lived token tied to this sign-in, then the erasure in the library and the person\'s object; the hold exception is reported', async () => {
  const { env, lib, itv } = world(), me = await session(env), other = await session(env, { sub: 'someone-else', email: 'else@example.com' }); lib.calls.length = 0; itv.calls.length = 0;
  assert.equal((await me.go('/api/me/erase', { method: 'POST', body: '{}', csrf: false })).status, 403); assert.equal((await me.go('/api/me/erase', { method: 'POST', body: '{}', origin: false })).status, 403);
  const step1 = await (await me.go('/api/me/erase', { method: 'POST', body: '{}' })).json();
  assert.match(step1.confirmToken, /^\d{13}\.[0-9a-f]{16}\.[0-9a-f]{64}$/); // X1: exp.nonce.mac (single use) assert.equal(step1.expiresInSeconds, 600); assert.ok(step1.willHappen.length >= 3); assert.ok(step1.kept.some(k => /DPO/.test(k)));
  assert.equal(lib.calls.length + itv.calls.length, 0, 'asking for the token erases and touches nothing');
  for (const bad of [step1.confirmToken.slice(0, -1) + (step1.confirmToken.endsWith('0') ? '1' : '0'), 'x', '1.' + step1.confirmToken.split('.')[1], (Date.now() - 1000) + '.' + step1.confirmToken.split('.')[1]]) {
    const r = await me.go('/api/me/erase', { method: 'POST', body: JSON.stringify({ confirm: bad }) }); assert.equal(r.status, 403, bad);
  }
  assert.equal((await other.go('/api/me/erase', { method: 'POST', body: JSON.stringify({ confirm: step1.confirmToken }) })).status, 403, 'a token from another sign-in is worthless');
  assert.equal(lib.calls.length + itv.calls.length, 0, 'every refusal left everything in place');
  assert.ok(me.logs.some(e => e.event === 'privacy_erase' && e.reason === 'CONFIRM_ISSUED') && me.logs.some(e => e.event === 'privacy_erase' && e.reason === 'CONFIRM_INVALID'), 'numbers and codes only in the security log');
  assert.doesNotMatch(JSON.stringify(me.logs), /tony@example|user-abc|confirmToken/);
  const done = await (await me.go('/api/me/erase', { method: 'POST', body: JSON.stringify({ confirm: step1.confirmToken }) })).json();
  assert.equal(done.complete, true); assert.equal(done.library.counts.referencesErased, 2); assert.equal(done.library.pendingReview[0].reason, 'bid_record'); assert.equal(done.interview.checkpointPurged, 3);
  const l = lib.calls.find(c => new URL(c.request.url).pathname === '/api/privacy/erase'); assert.deepEqual(await body(l), { confirmed: true }); assert.equal(hdr(l, 'x-atlas-user'), 'tony@example.com');
  const i = itv.calls.find(c => new URL(c.request.url).pathname === '/api/me/erase'); assert.equal(i.name, 'user-abc'); assert.match(hdr(i, 'x-atlas-bank'), /^atlas-[0-9a-f]{40}$/);
});

test('G2 erase: when part of it did not finish the answer says so and a repeat finishes it (every step is idempotent); a rate-limited library passes its 429 on', async () => {
  const { env } = world({ interviewReply: (r, p) => p === '/api/me/erase' ? json({ checkpointPurged: 1, memory: { forgotten: false, error: 'The memory service did not confirm. Try again.' }, consentCleared: true, complete: false }) : null }), me = await session(env);
  const t = (await (await me.go('/api/me/erase', { method: 'POST', body: '{}' })).json()).confirmToken;
  const r = await (await me.go('/api/me/erase', { method: 'POST', body: JSON.stringify({ confirm: t }) })).json();
  assert.equal(r.complete, false); assert.match(r.retry, /Delete my data again/); assert.equal(r.interview.memory.forgotten, false);
  const rl = world({ libraryReply: (q, p) => p === '/api/privacy/erase' ? new Response('{"error":"Too many requests."}', { status: 429, headers: { 'Retry-After': '900' } }) : null }), m2 = await session(rl.env);
  const t2 = (await (await m2.go('/api/me/erase', { method: 'POST', body: '{}' })).json()).confirmToken; const r2 = await m2.go('/api/me/erase', { method: 'POST', body: JSON.stringify({ confirm: t2 }) });
  assert.equal(r2.status, 429); assert.equal(r2.headers.get('retry-after'), '900'); assert.equal(rl.itv.calls.filter(c => new URL(c.request.url).pathname === '/api/me/erase').length, 0, 'the object is untouched when the library refused');
});

test('G2 /api/me/privacy: GET shows consent and flags; POST (CSRF) sets restriction and objection flags in the library and tells the person\'s object to block memory', async () => {
  const { env, lib, itv } = world(), me = await session(env); lib.calls.length = 0; itv.calls.length = 0;
  const get = await (await me.go('/api/me/privacy')).json(); assert.equal(get.noticeVersion, PRIVACY.version); assert.deepEqual(get.consent.purposes, { checkpoint: true, memory: false }); assert.equal(get.flags.restricted, false);
  assert.equal((await me.go('/api/me/privacy', { method: 'POST', body: '{"objectMemory":true}', csrf: false })).status, 403);
  const set = await (await me.go('/api/me/privacy', { method: 'POST', body: JSON.stringify({ objectMemory: true }) })).json(); assert.equal(set.flags.objectMemory, true);
  const fl = lib.calls.find(c => c.request.method === 'POST' && new URL(c.request.url).pathname === '/api/privacy/flags'); assert.deepEqual(await body(fl), { objectMemory: true });
  const block = itv.calls.find(c => new URL(c.request.url).pathname === '/api/consent/block'); assert.deepEqual(await body(block), { memory: true });
  assert.equal((await me.go('/api/me/privacy', { method: 'PUT', body: '{}' })).status, 404);
});

test('G2 forwarded identity: the library, memory and voice paths carry the verified pseudonymous subject key (never from the browser); the memory path also carries the verified user', async () => {
  const { env, lib, itv } = world(), me = await session(env); lib.calls.length = 0; itv.calls.length = 0;
  await me.go('/api/library', { headers: { 'x-atlas-subj': 'f'.repeat(32) } }); await me.go('/api/memory', { headers: { 'x-atlas-subj': 'f'.repeat(32), 'x-atlas-user': 'victim@x' } });
  const subj = hdr(lib.calls[0], 'x-atlas-subj'); assert.match(subj, /^[0-9a-f]{32}$/); assert.notEqual(subj, 'f'.repeat(32));
  const mem = itv.calls.find(c => new URL(c.request.url).pathname.startsWith('/api/memory')); assert.equal(hdr(mem, 'x-atlas-subj'), subj); assert.equal(hdr(mem, 'x-atlas-user'), 'tony@example.com');
});

test('G2 internal paths: the library\'s /api/privacy/*, the object\'s /api/consent/block and /api/me/* internals are not reachable by a browser; only the Worker\'s own handlers reach them', async () => {
  const { env, lib, itv } = world(), me = await session(env); lib.calls.length = 0; itv.calls.length = 0;
  for (const [method, path] of [['GET', '/api/privacy/export'], ['POST', '/api/privacy/erase'], ['POST', '/api/privacy/receipts'], ['POST', '/api/privacy/flags'], ['GET', '/api/privacy/state'], ['POST', '/api/consent/block'], ['POST', '/api/me/export'], ['GET', '/api/me/erase'], ['GET', '/api/consent']]) {
    const res = await me.go(path, { method, body: method === 'POST' ? JSON.stringify({ confirmed: true, memory: true, items: [] }) : undefined });
    assert.ok([404, 405].includes(res.status) || (path === '/api/consent' && res.status === 404), method + ' ' + path + ' -> ' + res.status);
  }
  assert.equal(lib.calls.length + itv.calls.filter(c => new URL(c.request.url).pathname !== '/api/limit').length, 0, 'nothing reached a Durable Object');
  const ext = await session({ ...env, EXTERNAL_EMAILS: 'client@x.example' }, { email: 'client@x.example' });
  for (const path of ['/api/me/privacy', '/api/consent', '/api/me/erase']) assert.equal((await ext.go(path, path === '/api/me/privacy' ? {} : { method: 'POST', body: '{}' })).status, 403, 'external: ' + path);
});
