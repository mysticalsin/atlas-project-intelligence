// B1 (2): pseudonymous security events at every refusal, and proof that no person-identifying or content field ever reaches them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { secEvent, routeTemplate, EVENTS, ipHash } from '../src/security-log.js';
import { ENV, ORIGIN, session, ns, jwt } from './security-harness.js';

const IP = '203.0.113.77', EMAIL = 'tony@example.com';

test('routeTemplate keeps short words only: ids, e-mail addresses, encodings and the query never survive', () => {
  assert.equal(routeTemplate('/api/library/' + 'ab12'.repeat(8) + '/validate'), '/api/library/:id/validate');
  assert.equal(routeTemplate('/api/library/people/tony%40example.com'), '/api/library/people/:id');
  assert.equal(routeTemplate('/api/library/people/tony@example.com/x'), '/api/library/people/:id/x');
  assert.equal(routeTemplate('/go/bid/' + 'f'.repeat(32)), '/go/bid/:id');
  assert.equal(routeTemplate('/api/sheet/draft?email=tony@example.com'), '/api/sheet/draft');
  assert.equal(routeTemplate('/a/b/c/d/e/f/g/h'), '/a/b/c/d/e/f');
  assert.equal(routeTemplate(''), '/');
});

test('secEvent writes only whitelisted, sanitised fields and never what a caller passes by accident', async () => {
  const lines = [], write = l => lines.push(l);
  const rec = await secEvent({ ...ENV }, 'csrf_fail', { route: '/api/library/' + 'c'.repeat(32), method: 'post', status: '403', reason: 'CSRF_MISMATCH', subj: 'ABCDEF0123456789ZZ', role: 'user', ip: IP, colo: 'FRA', ray: 'abc123-FRA',
    email: EMAIL, body: 'confidential client text', authorization: 'Bearer secret', token: 'eyJ.x.y', name: 'Tony Walteur', n: 3 }, write);
  assert.deepEqual(Object.keys(rec).sort(), ['atlas_sec', 'colo', 'event', 'ip_h', 'method', 'n', 'ray', 'reason', 'role', 'route', 'status', 'subj', 'ts', 'v'].sort());
  assert.equal(rec.route, '/api/library/:id'); assert.equal(rec.method, 'POST'); assert.equal(rec.status, 403); assert.equal(rec.subj, 'abcdef0123456789');
  assert.match(rec.ip_h, /^[0-9a-f]{16}$/);
  const text = lines.join('\n');
  for (const secret of [EMAIL, IP, 'confidential', 'Bearer', 'eyJ', 'Walteur', 'secret']) assert.ok(!text.includes(secret), secret);
  // a hostile reason string is not echoed
  assert.equal((await secEvent(ENV, 'authn_fail', { reason: 'tony@example.com is bad' }, () => {})).reason, 'UNSPECIFIED');
  assert.equal((await secEvent(ENV, 'not-an-event', {}, () => {})).event, 'internal_error');
  assert.equal((await secEvent(ENV, 'authn_fail', { role: 'superuser', method: 'TELEPORT' }, () => {})).role, undefined);
  assert.ok(EVENTS.includes('audit_chain_break') && EVENTS.includes('kill_switch') && EVENTS.includes('rate_limited'));
});

test('hashed addresses are keyed, stable per address and different per address or salt; absent without a secret', async () => {
  const a = await ipHash(ENV, IP), b = await ipHash(ENV, '203.0.113.78'), c = await ipHash({ ...ENV, LOG_SALT: 'other-salt' }, IP);
  assert.equal(a, await ipHash(ENV, IP)); assert.notEqual(a, b); assert.notEqual(a, c); assert.equal(a.length, 16);
  assert.equal(await ipHash({}, IP), ''); assert.equal(await ipHash(ENV, ''), '');
});

test('refusals on every layer are logged once each with route template, reason code and pseudonym, and the whole log holds no PII', async () => {
  const lib = ns(r => new URL(r.url).pathname.endsWith('/forbidden') ? new Response('{"error":"Not allowed: reviewer is the owner"}', { status: 403 })
    : new URL(r.url).pathname.endsWith('/slow') ? new Response('{"error":"Too many"}', { status: 429 }) : new Response('{}'));
  const env = { ...ENV, LIBRARY: lib, INTERVIEW: ns(), EXTERNAL_EMAILS: 'ext@example.com', TRIGGER_SECRET: 't'.repeat(16) };
  const me = await session(env);
  const subjectKey = (await (await me.go('/api/bootstrap')).json()).identity.subjectKey, ip = { 'cf-connecting-ip': IP, 'cf-ray': 'ray1-FRA' };
  me.logs.length = 0;
  await me.go('/api/library', { method: 'POST', body: '{"title":"CLIENT-SECRET-TEXT"}', csrf: 'nope', headers: ip });
  await me.go('/api/library', { method: 'POST', body: '{}', csrf: false, headers: ip });
  await me.go('/api/library', { method: 'POST', body: '{}', origin: 'https://evil.example', headers: ip });
  await me.go('/api/library/' + 'a1'.repeat(16) + '/forbidden?email=' + EMAIL, { method: 'POST', body: '{}', headers: ip });
  await me.go('/api/library/slow', { method: 'POST', body: '{}', headers: ip });
  await me.go('/api/library', { method: 'POST', body: 'x'.repeat(10), headers: { ...ip, 'Content-Length': '999999' } }).catch(() => {});
  await me.go('/api/bootstrap', { signed: false, headers: ip });
  const ext = await session(env, { email: 'ext@example.com', sub: 'ext-1' });
  await ext.go('/api/memory', { headers: ip });
  const beforeBearer = ext.logs.length;
  await (await import('../src/app.js')).handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body: '{}', headers: { ...ip, Authorization: 'Bearer wrong-wrong-wrong' } }), env, '', { log: l => ext.logs.push(JSON.parse(l)) });
  const all = [...me.logs, ...ext.logs];
  const by = (ev, reason) => all.filter(e => e.event === ev && (!reason || e.reason === reason));
  assert.equal(by('csrf_fail', 'CSRF_MISMATCH').length, 1); assert.equal(by('csrf_fail', 'CSRF_MISSING').length, 1); assert.equal(by('origin_fail', 'ORIGIN_MISMATCH').length, 1);
  assert.equal(by('access_denied', 'FORBIDDEN').length, 1); assert.equal(by('rate_limited').length, 1); assert.equal(by('body_too_large').length, 1);
  assert.equal(by('authn_fail', 'ACCESS_JWT_MISSING').length, 1); assert.equal(by('external_denied', 'EXTERNAL_ROLE_PATH').length, 1); assert.equal(by('bearer_fail', 'BEARER_INVALID').length, 1);
  const denied = by('access_denied')[0];
  assert.equal(denied.route, '/api/library/:id/forbidden'); assert.equal(denied.status, 403); assert.equal(denied.subj, subjectKey.slice(0, 16)); assert.equal(denied.role, 'user'); assert.match(denied.ip_h, /^[0-9a-f]{16}$/); assert.equal(denied.ray, 'ray1-FRA');
  assert.equal(by('csrf_fail')[0].method, 'POST');
  const text = JSON.stringify(all);
  for (const secret of [EMAIL, 'ext@example.com', IP, 'CLIENT-SECRET-TEXT', 'user-abc', 'ext-1', 'Bearer', 'wrong-wrong', me.token.slice(0, 40), me.csrf, 'a1'.repeat(16), 'reviewer is the owner', 'Not allowed'])
    assert.ok(!text.includes(secret), 'PII leaked: ' + secret);
  for (const e of all) for (const k of Object.keys(e)) assert.ok(['atlas_sec', 'v', 'ts', 'event', 'route', 'method', 'status', 'reason', 'subj', 'role', 'ip_h', 'colo', 'ray', 'n', 'bucket', 'head'].includes(k), 'unexpected field ' + k);
  void beforeBearer;
});

test('a successful request logs nothing (no noise, no content)', async () => {
  const me = await session({ ...ENV, LIBRARY: ns() });
  await me.go('/api/library'); await me.go('/api/bootstrap'); await me.go('/');
  assert.deepEqual(me.logs, []);
});
