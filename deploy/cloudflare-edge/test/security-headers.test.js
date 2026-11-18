// B1 (1): HSTS, COOP, CORP and the Permissions-Policy on EVERY response path of the Worker, early refusals and the Teams tab included.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { teamsRoutes } from '../src/teams-routes.js';
import { baseSecurityHeaders, secure } from '../src/security-headers.js';
import { ENV, ORIGIN, session, ns, jwt } from './security-harness.js';

const MUST = ['cache-control', 'x-content-type-options', 'referrer-policy', 'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'permissions-policy', 'content-security-policy'];
function assertSecure(res, label) {
  for (const h of MUST) assert.ok(res.headers.get(h), `${label}: missing ${h}`);
  assert.equal(res.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains', label);
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', label);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin', label);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', label);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', label);
  const pp = res.headers.get('permissions-policy');
  for (const d of ['microphone=(self)', 'camera=()', 'geolocation=()', 'payment=()']) assert.ok(pp.includes(d), `${label}: ${d}`);
  assert.ok(res.headers.get('content-security-policy').includes("frame-ancestors"), label);
}

test('every route family ships the full security header set', async () => {
  const lib = ns(() => new Response('{"items":[]}', { headers: { 'Content-Type': 'application/json' } })), itv = ns(() => new Response('{}'));
  const env = { ...ENV, LIBRARY: lib, INTERVIEW: itv, TRIGGER_SECRET: 's'.repeat(16), HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 'b', TYPESAFE_API_KEY: '', AI: { toMarkdown: async () => ({ format: 'markdown', data: 'x' }), run: async () => ({ response: '{}' }) } };
  const me = await session(env);
  const rows = [];
  rows.push(['page', await me.go('/')]);
  rows.push(['bootstrap JSON', await me.go('/api/bootstrap')]);
  rows.push(['confirm page', await me.go('/confirm')]);
  rows.push(['go redirect', await me.go('/go/start')]);
  rows.push(['signed-in landing', await me.go('/go/signed-in')]);
  rows.push(['unknown 404', await me.go('/api/nothing')]);
  rows.push(['browser nav redirect', await me.go('/old.html', { headers: { Accept: 'text/html' } })]);
  rows.push(['library GET (DO pass-through)', await me.go('/api/library')]);
  rows.push(['library POST', await me.go('/api/library', { method: 'POST', body: '{}' })]);
  rows.push(['memory GET', await me.go('/api/memory')]);
  rows.push(['memory POST', await me.go('/api/memory/settings', { method: 'POST', body: '{}' })]);
  rows.push(['checkpoint discard', await me.go('/api/checkpoint/discard', { method: 'POST' })]);
  rows.push(['sheet draft', await me.go('/api/sheet/draft', { method: 'POST', body: '{}' })]);
  rows.push(['classify', await me.go('/api/jev/classify', { method: 'POST', body: '{"project":{}}' })]);
  rows.push(['csrf refusal 403', await me.go('/api/library', { method: 'POST', body: '{}', csrf: 'wrong' })]);
  rows.push(['origin refusal 403', await me.go('/api/library', { method: 'POST', body: '{}', origin: 'https://evil.example' })]);
  rows.push(['voice not a websocket 426', await me.go('/api/voice')]);
  rows.push(['voice bad origin 403', await me.go('/api/voice', { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } })]);
  rows.push(['unauthenticated 401', await me.go('/api/bootstrap', { signed: false })]);
  rows.push(['wrong host 403 (early)', await handle(new Request('https://evil.example/'), env, '')]);
  rows.push(['no CSRF_SECRET 500 (early)', await handle(new Request(ORIGIN + '/'), { ...env, CSRF_SECRET: '' }, '')]);
  rows.push(['trigger bearer 401', await handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body: '{}' }), env, '')]);
  rows.push(['trigger accepted (DO answer)', await handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer ' + 's'.repeat(16) } }), env, '')]);
  rows.push(['directory push 401', await handle(new Request(ORIGIN + '/api/directory/push', { method: 'POST', body: '{}' }), env, '')]);
  rows.push(['teams tab (not connected 503)', await handle(new Request(ORIGIN + '/teams/tab'), env, '')]);
  rows.push(['teams bot (not connected 503)', await handle(new Request(ORIGIN + '/api/teams/messages', { method: 'POST', body: '{}' }), env, '')]);
  rows.push(['read-only 503', await handle(new Request(ORIGIN + '/api/library', { method: 'POST', body: '{}' }), { ...env, ATLAS_READ_ONLY: '1' }, '')]);
  for (const [label, res] of rows) assertSecure(res, label);
  assert.ok(rows.length >= 25);
});

test('the connected Teams tab (route-specific CSP) and its bot answers carry the set too, and the tab still lets only Teams frame it', async () => {
  const env = { ...ENV, TEAMS_APP_ID: 'a', TEAMS_TENANT_ID: 't', TEAMS_BOT_SECRET: 's' };
  const tab = await handle(new Request(ORIGIN + '/teams/tab'), env, '');
  assertSecure(tab, 'teams tab connected');
  assert.ok(tab.headers.get('content-security-policy').includes('https://teams.microsoft.com'));
  assertSecure(await teamsRoutes(new Request(ORIGIN + '/teams/tab'), { ...ENV }), 'teamsRoutes standalone (503)');
  assertSecure(await teamsRoutes(new Request(ORIGIN + '/teams/tab'), env), 'teamsRoutes standalone (tab)');
});

test('secure() adds only what is missing, leaves a WebSocket upgrade alone and gives a bare pass-through the data-only CSP', async () => {
  const own = new Response('x', { headers: { 'Strict-Transport-Security': 'max-age=1', 'Content-Security-Policy': "default-src 'self'" } });
  const out = secure(own);
  assert.equal(out.headers.get('strict-transport-security'), 'max-age=1'); assert.equal(out.headers.get('content-security-policy'), "default-src 'self'"); assert.ok(out.headers.get('cross-origin-opener-policy'));
  const ws = Object.assign(new Response(null, { status: 200 }), { webSocket: {} });
  assert.equal(secure(ws), ws);
  const bare = secure(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  assert.equal(bare.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
  const html = secure(new Response('<p>', { headers: { 'Content-Type': 'text/html' } }));
  assert.match(html.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(html.headers.get('content-security-policy'), /script-src 'none'/);
  // a stub's immutable headers do not matter: the copy is new
  assert.deepEqual(Object.keys(baseSecurityHeaders()).sort(), ['Cache-Control', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'Permissions-Policy', 'Referrer-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options']);
});

test('the page CSP is the strict F1 policy: script hashes + blob:, no unsafe-inline script, no inline handlers', async () => {
  const me = await session(ENV);
  const csp = (await me.go('/')).headers.get('content-security-policy');
  assert.match(csp, /script-src ('sha256-[A-Za-z0-9+\/=]+' )+blob:;/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp) && csp.includes("script-src-attr 'none'"));
  assert.ok(csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"));
});
