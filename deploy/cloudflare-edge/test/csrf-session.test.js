// B1 (5), (7), (8): the CSRF token is bound to the Access session (iat), compared in constant time on every HTTP route, inbound x-atlas-* headers
// never survive, and the Access signing keys are fetched with a timeout, cached, throttled and backed off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, verifyAccess, accessIssuedAt } from '../src/app.js';
import { ENV, ORIGIN, TEAM, session, jwt, ns, stubCerts, resetJwksCache, jwk } from './security-harness.js';

const post = (me, path, extra = {}) => me.go(path, { method: 'POST', body: '{}', ...extra });
const ROUTES = ['/api/library', '/api/memory/settings', '/api/checkpoint/discard', '/api/sheet/draft', '/api/jev/classify'];

test('the CSRF token is HMAC(secret, sub|iat): it changes with a new sign-in, not with a refresh of the page', async () => {
  const now = Math.floor(Date.now() / 1000);
  const a = await session(ENV, { iat: now - 30 }), a2 = await session(ENV, { iat: now - 30, exp: now + 900 }), b = await session(ENV, { iat: now - 5 }), c = await session(ENV, { sub: 'someone-else', iat: now - 30 });
  assert.equal(a.csrf.length, 64); assert.equal(a.csrf, a2.csrf);   // same sub + same iat: same token
  assert.notEqual(a.csrf, b.csrf);                                  // new sign-in (new iat): rotated
  assert.notEqual(a.csrf, c.csrf);                                  // another person
  assert.equal(accessIssuedAt(new Request(ORIGIN, { headers: { 'cf-access-jwt-assertion': a.token } })), now - 30);
  assert.equal(accessIssuedAt(new Request(ORIGIN)), 0);
});

test('a token issued for an earlier session is refused after re-login on every state-changing HTTP route; the current one works', async () => {
  const now = Math.floor(Date.now() / 1000), env = { ...ENV, LIBRARY: ns(), INTERVIEW: ns(), HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 'b', spokenAsk: true };
  const oldSession = await session(env, { iat: now - 60 }), newSession = await session(env, { iat: now - 1 });
  for (const path of ROUTES) {
    const stale = await post(newSession, path, { csrf: oldSession.csrf });
    assert.equal(stale.status, 403, path + ' stale token');
    assert.equal((await post(newSession, path, { csrf: '' })).status, 403, path + ' empty token');
    assert.equal((await post(newSession, path, { csrf: newSession.csrf.slice(0, 32) })).status, 403, path + ' truncated (prefix) token');
    assert.equal((await post(newSession, path, { csrf: newSession.csrf + 'a' })).status, 403, path + ' longer token');
    assert.equal((await post(newSession, path, { csrf: newSession.csrf.toUpperCase() })).status, 403, path + ' case-changed token');
    assert.notEqual((await post(newSession, path)).status, 403, path + ' current token passes the CSRF check');
  }
});

test('the HTTP routes use a constant-time comparison and the WebSocket start still does', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8'), sessionJs = readFileSync(new URL('../src/session.js', import.meta.url), 'utf8');
  assert.ok(!/X-Atlas-CSRF'\)\s*!==/.test(app), 'no !== on the CSRF header any more');
  assert.equal((app.match(/bad = csrfRefusal\(request, env, csrf, sec\)/g) || []).length, 10, 'one shared check for discard, consent, erase, privacy flags, sheet, memory, library, transcribe, classify and translate (G2 added consent, erase and flags; D-L2 translate)');
  assert.ok(/same\(String\(init\.csrf \?\? ''\), this\.csrf\)/.test(sessionJs), 'the WS start compare is unchanged');
});

test('inbound x-atlas-* headers are removed before anything reads the request (identity, role, bank, admin, an invented one); csrf and consent survive', async () => {
  const lib = ns(), itv = ns(), env = { ...ENV, LIBRARY: lib, INTERVIEW: itv, HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 'b' };
  const me = await session(env); lib.calls.length = 0; itv.calls.length = 0; const evil = { 'x-atlas-user': 'admin@evil', 'x-atlas-role': 'admin', 'x-atlas-admin': '1', 'x-atlas-email': 'admin@evil', 'x-atlas-bank': 'victim-bank', 'x-atlas-idp': 'e30', 'X-Atlas-New-Header': 'spoof', 'x-atlas-subj': 'f'.repeat(16) };
  await me.go('/api/library', { headers: evil });
  await me.go('/api/memory', { headers: evil });
  await me.go('/api/voice', { headers: { ...evil, Upgrade: 'websocket', Origin: ORIGIN, 'x-atlas-csrf': 'spoofed' } });
  const forwarded = [...lib.calls, ...itv.calls].map(c => c.request.headers);
  assert.equal(forwarded.length, 3);
  for (const h of forwarded) {
    assert.equal(h.get('x-atlas-new-header'), null, 'an unknown x-atlas header is dropped');
    assert.notEqual(h.get('x-atlas-user'), 'admin@evil'); assert.notEqual(h.get('x-atlas-role'), 'admin'); assert.notEqual(h.get('x-atlas-bank'), 'victim-bank');
  }
  const [libH, memH, voiceH] = forwarded;
  assert.equal(libH.get('x-atlas-user'), 'tony@example.com'); assert.equal(libH.get('x-atlas-role'), 'user'); assert.equal(libH.get('x-atlas-admin'), null);
  assert.match(memH.get('x-atlas-bank'), /^atlas-[0-9a-f]{40}$/);
  assert.equal(voiceH.get('x-atlas-admin'), '0'); assert.equal(voiceH.get('x-atlas-csrf'), me.csrf); assert.equal(voiceH.get('x-atlas-subj').length, 32); assert.notEqual(voiceH.get('x-atlas-subj'), 'f'.repeat(16));
  const spoof = me.logs.filter(e => e.event === 'header_spoof'); assert.equal(spoof.length, 3); assert.equal(spoof[0].n, 8);
  // the spoken-ask consent header is a legitimate browser header and still reaches its handler
  const t = await handle(new Request(ORIGIN + '/api/transcribe', { method: 'POST', headers: { 'cf-access-jwt-assertion': me.token, Origin: ORIGIN, 'X-Atlas-CSRF': me.csrf, 'X-Atlas-Consent': 'spoken-ask-v1; once', 'Content-Type': 'audio/L16;rate=24000' }, body: new Uint8Array(10) }), env, '', { flagsOf: () => ({ spokenAsk: true }) });
  assert.equal(t.status, 400); // reached the length check: the consent header was read
});

test('the system word of the cron and the trigger endpoint cannot be forged through headers', async () => {
  const lib = ns(), env = { ...ENV, LIBRARY: lib };
  const me = await session(env);
  await me.go('/api/library/scan-stale', { method: 'POST', body: '{}', headers: { 'x-atlas-role': 'system', 'x-atlas-user': 'atlas-cron' } });
  assert.equal(lib.calls[0].request.headers.get('x-atlas-role'), 'user');
});

// ---- Access signing keys ----
const tick = async (t, ms) => { t.mock.timers.tick(ms); };
test('JWKS: request has a timeout, needs a 200 key list, is cached, and an unknown kid refetches at most once a minute', async t => {
  resetJwksCache(); t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let fetches = 0, signal = null;
  stubCerts(async (u, init) => { fetches++; signal = init?.signal; return new Response(JSON.stringify({ keys: [jwk] })); });
  const tok = await jwt(), unknown = await jwt({}, { alg: 'RS256', kid: 'rotated-away' });
  const req = token => new Request(ORIGIN, { headers: { 'cf-access-jwt-assertion': token } });
  assert.ok(await verifyAccess(req(tok), ENV)); assert.equal(fetches, 1); assert.ok(signal instanceof AbortSignal, 'a timeout signal is passed');
  assert.ok(await verifyAccess(req(tok), ENV)); assert.equal(fetches, 1, 'cached');
  assert.equal(await verifyAccess(req(unknown), ENV), null); assert.equal(fetches, 1, 'unknown kid inside the first minute: no refetch (the keys were just fetched)');
  for (let i = 0; i < 20; i++) assert.equal(await verifyAccess(req(unknown), ENV), null);
  assert.equal(fetches, 1, 'a flood of unknown kids does not reach the identity provider');
  await tick(t, 61000);
  assert.equal(await verifyAccess(req(unknown), ENV), null); assert.equal(fetches, 2, 'after a minute one refetch is allowed');
  for (let i = 0; i < 5; i++) await verifyAccess(req(unknown), ENV);
  assert.equal(fetches, 2);
  await tick(t, 10 * 60000 + 1);
  assert.ok(await verifyAccess(req(await jwt()), ENV)); assert.equal(fetches, 3, 'the ten-minute cache expiry refetches');
});

test('JWKS: a failing or non-200 endpoint backs off, serves the last good keys meanwhile, and never admits an unknown token', async t => {
  resetJwksCache(); t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let mode = 'ok', fetches = 0;
  stubCerts(async () => { fetches++; if (mode === 'ok') return new Response(JSON.stringify({ keys: [jwk] })); if (mode === '500') return new Response('boom', { status: 500 }); if (mode === 'shape') return new Response('{"nope":1}'); throw new Error('timeout'); });
  const req = token => new Request(ORIGIN, { headers: { 'cf-access-jwt-assertion': token } }), tok = await jwt();
  assert.ok(await verifyAccess(req(tok), ENV)); assert.equal(fetches, 1);
  const live = async () => req(await jwt());
  await tick(t, 10 * 60000 + 1); mode = '500';
  assert.ok(await verifyAccess(await live(), ENV), 'stale keys keep serving for a while after a failed refresh'); assert.equal(fetches, 2);
  assert.ok(await verifyAccess(await live(), ENV)); assert.equal(fetches, 2, 'backed off: no immediate retry');
  await tick(t, 6000); mode = 'throw'; await verifyAccess(await live(), ENV); assert.equal(fetches, 3);
  await tick(t, 6000); await verifyAccess(await live(), ENV); assert.equal(fetches, 3, 'the back-off doubled (10 s)');
  await tick(t, 5000); mode = 'shape'; await verifyAccess(await live(), ENV); assert.equal(fetches, 4);
  await tick(t, 61 * 60000); mode = 'throw';
  assert.equal(await verifyAccess(await live(), ENV), null, 'keys older than an hour are not trusted when the provider is unreachable');
  resetJwksCache(); mode = 'ok';
  assert.equal(await verifyAccess(req(await jwt({}, { alg: 'RS256', kid: 'nope' })), ENV), null);
});

test('JWKS: the cache is per team domain; a token issued in the future is refused; a hanging endpoint fails closed', async () => {
  resetJwksCache(); stubCerts();
  const req = token => new Request(ORIGIN, { headers: { 'cf-access-jwt-assertion': token } });
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await verifyAccess(req(await jwt({ iat: now + 3600 })), ENV), null, 'iat in the future');
  assert.ok(await verifyAccess(req(await jwt({ iat: now + 30 })), ENV), 'small clock skew is fine');
  const other = { ...ENV, ACCESS_TEAM_DOMAIN: 'other.cloudflareaccess.com' };
  assert.equal(await verifyAccess(req(await jwt({ iss: 'https://other.cloudflareaccess.com' })), other, async () => { throw new Error('unreachable'); }), null);
  resetJwksCache();
  const keepAlive = setTimeout(() => {}, 1000); // Node's AbortSignal.timeout timer is unref'd; the Worker runtime's is not
  const hung = await verifyAccess(req(await jwt()), { ...ENV, ACCESS_JWKS_TIMEOUT_MS: '60' }, (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  clearTimeout(keepAlive);
  assert.equal(hung, null);
});

test('ATLAS_CSRF_BIND=sub is the rollback: the token follows the person only, so a re-minted Access token (new iat) does not stale an open page', async () => {
  resetJwksCache(); stubCerts(); // the previous test left the key cache in a back-off
  const now = Math.floor(Date.now() / 1000), env = { ...ENV, ATLAS_CSRF_BIND: 'sub', LIBRARY: ns() };
  const a = await session(env, { iat: now - 60 }), b = await session(env, { iat: now - 1 });
  assert.equal(a.csrf, b.csrf);
  assert.equal((await post(b, '/api/library', { csrf: a.csrf })).status, 200);
  const bound = await session({ ...ENV, LIBRARY: ns() }, { iat: now - 60 }), rebound = await session({ ...ENV, LIBRARY: ns() }, { iat: now - 1 });
  assert.notEqual(bound.csrf, rebound.csrf);
});
