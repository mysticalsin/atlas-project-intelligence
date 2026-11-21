// Sweep 01 group 13. Red before the cert pin, the refusal page, the trigger cap,
// the x-atlas strip, and the non-ByteString sign-in guard.
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle, scheduled, verifyAccess } from '../src/app.js';
import { productionDemoConflict } from '../src/authz.js';
import * as app from '../src/app.js';

const TEAM = 'team.example';
const AUD = 'aud-g13';
const ORIGIN = 'https://atlas.example';
const TID = '11111111-1111-4111-8111-111111111111';
const CJK = '用户@example.test';
const LATIN = 'caf\u00e9@example.test';
const LATIN_LAST = '\u00ff@example.test';
const PAGE = '<!doctype html><html><body><h2>Ready when you are</h2><p>isn\'t answering</p><div id="marker">PAGE-MARKER-G13</div><script id="atlas-runtime" type="application/json">{}</script></body></html>';
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const { publicKey: attackerPublic, privateKey: attackerPrivate } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const realJwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k-real', alg: 'RS256', use: 'sig' };
const attackerJwk = { ...(await crypto.subtle.exportKey('jwk', attackerPublic)), kid: 'k-attacker', alg: 'RS256', use: 'sig' };
const realNow = Date.now;
const resetJwks = () => { if (typeof app.resetJwksCache === 'function') app.resetJwksCache(); };

function env(extra = {}) {
  return {
    ORIGIN, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, CSRF_SECRET: 'test-secret', LOG_SALT: 'synthetic-log-salt',
    ATLAS_TENANT_ISOLATION: 'local-synthetic', ...extra,
  };
}

async function sign(key, claims = {}, header = { alg: 'RS256', kid: 'k-real' }, team = TEAM) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: [AUD], iss: `https://${team}`, sub: `${TID}:user-abc`, email: 'tony@example.com', exp: now + 7200, iat: now, ...claims };
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(body));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return input + '.' + b64u(sig);
}

function requestFor(token, path = '/', init = {}) {
  const headers = new Headers(init.headers || {});
  if (token) headers.set('cf-access-jwt-assertion', token);
  return new Request(ORIGIN + path, { method: init.method || 'GET', headers, body: init.body, duplex: init.body && typeof init.body !== 'string' && !(init.body instanceof Uint8Array) ? 'half' : undefined });
}

function jsonResponse(keys, status = 200) {
  return new Response(JSON.stringify({ keys }), { status, headers: { 'content-type': 'application/json' } });
}

describe('group 13 auth', { concurrency: false }, () => {
  beforeEach(() => { resetJwks(); Date.now = realNow; });
  afterEach(() => { Date.now = realNow; });

  test('M1 only alg RS256 is imported', async () => {
    const imported = [];
    const orig = crypto.subtle.importKey.bind(crypto.subtle);
    crypto.subtle.importKey = async (format, keyData, algorithm, extractable, usages) => {
      imported.push({ alg: keyData && keyData.alg, algorithm });
      return orig(format, keyData, algorithm, extractable, usages);
    };
    try {
      const fetcher = async () => jsonResponse([realJwk]);
      const token = await sign(privateKey);
      const who = await verifyAccess(requestFor(token), env(), fetcher);
      assert.equal(who && who.email, 'tony@example.com');
      assert.equal(imported.length, 1);
      assert.equal(imported[0].alg, 'RS256');
      for (const alg of ['none', 'HS256', 'PS256', 'ES256']) {
        resetJwks();
        imported.length = 0;
        const badHeader = await sign(privateKey, {}, { alg, kid: 'k-real' });
        assert.equal(await verifyAccess(requestFor(badHeader), env(), async () => jsonResponse([realJwk])), null, alg);
        const badKey = { ...realJwk, alg, kid: 'k-' + alg };
        let threw = false;
        try {
          assert.equal(await verifyAccess(requestFor(await sign(privateKey, {}, { alg: 'RS256', kid: badKey.kid })), env(), async () => jsonResponse([badKey])), null, 'jwk ' + alg);
        } catch { threw = true; }
        assert.equal(threw, false, 'jwk ' + alg + ' must return null');
        assert.equal(imported.length, 0, 'jwk ' + alg + ' is not imported');
      }
      resetJwks();
      imported.length = 0;
      const missing = { ...realJwk };
      delete missing.alg;
      missing.kid = 'k-missing';
      assert.equal(await verifyAccess(requestFor(await sign(privateKey, {}, { alg: 'RS256', kid: 'k-missing' })), env(), async () => jsonResponse([missing])), null);
      assert.equal(imported.length, 0, 'a missing alg is not imported');
    } finally {
      crypto.subtle.importKey = orig;
    }
  });

  test('M2 a cached JWKS older than one hour does not verify', async () => {
    const start = 1_800_000_000_000;
    let now = start;
    let mode = 'good';
    let fetches = 0;
    Date.now = () => now;
    const fetcher = async () => {
      fetches += 1;
      if (mode === 'good') return jsonResponse([realJwk]);
      return new Response('no', { status: 500 });
    };
    const token = await sign(privateKey, { exp: Math.floor(start / 1000) + 8 * 3600 });
    const unknown = await sign(privateKey, { exp: Math.floor(start / 1000) + 8 * 3600 }, { alg: 'RS256', kid: 'k-unknown' });
    assert.equal((await verifyAccess(requestFor(token), env(), fetcher)).sub, `${TID}:user-abc`);
    mode = 'fail';
    now = start + 30 * 60 * 1000;
    const before = fetches;
    assert.equal(await verifyAccess(requestFor(unknown), env(), fetcher), null);
    assert.equal(fetches, before + 1, 'a young cache still attempts a refresh for an unknown kid');
    assert.equal((await verifyAccess(requestFor(token), env(), fetcher)).email, 'tony@example.com');
    now = start + 32 * 60 * 1000;
    assert.equal(await verifyAccess(requestFor(unknown), env(), fetcher), null);
    assert.equal(fetches, before + 2, 'a second failure inside the hour is allowed');
    assert.equal((await verifyAccess(requestFor(token), env(), fetcher)).email, 'tony@example.com', 'the young set is kept');
    now = start + 61 * 60 * 1000;
    assert.equal(await verifyAccess(requestFor(token), env(), fetcher), null, 'a stale set is not used when refresh fails');
    now = start + 63 * 60 * 1000;
    assert.equal(await verifyAccess(requestFor(token), env(), fetcher), null, 'a second failure after the hour does not keep the set');
  });

  test('M3 unknown kids share one refetch per minute', async () => {
    const start = 1_800_000_000_000;
    let now = start;
    Date.now = () => now;
    const keys = [];
    for (let i = 0; i < 40; i += 1) {
      const kid = i === 0 ? 'k-keep' : i === 32 ? 'k-drop' : 'k-pad-' + i;
      const base = i === 0 || i === 32 ? realJwk : { kty: 'RSA', alg: 'RS256', use: 'sig', n: 'AA', e: 'AQAB' };
      keys.push({ ...base, kid, alg: 'RS256' });
    }
    let phase = 'prime';
    let fetches = 0;
    const fetcher = async () => {
      fetches += 1;
      return jsonResponse(phase === 'prime' ? [{ ...realJwk, kid: 'k-keep' }] : keys);
    };
    const kept = await sign(privateKey, { exp: Math.floor(start / 1000) + 8 * 3600 }, { alg: 'RS256', kid: 'k-keep' });
    assert.ok(await verifyAccess(requestFor(kept), env(), fetcher));
    phase = 'many';
    now = start + 61 * 1000;
    const burst = fetches;
    for (let i = 0; i < 5; i += 1) {
      const token = await sign(privateKey, { exp: Math.floor(start / 1000) + 8 * 3600 }, { alg: 'RS256', kid: 'unknown-' + i });
      assert.equal(await verifyAccess(requestFor(token), env(), fetcher), null);
    }
    assert.equal(fetches - burst, 1, 'one refetch for the burst');
    now = start + 90 * 1000;
    for (let i = 0; i < 5; i += 1) {
      const token = await sign(privateKey, { exp: Math.floor(start / 1000) + 8 * 3600 }, { alg: 'RS256', kid: 'unknown-b-' + i });
      assert.equal(await verifyAccess(requestFor(token), env(), fetcher), null);
    }
    assert.equal(fetches - burst, 1, 'a second burst inside 60 seconds does not refetch');
    assert.ok(await verifyAccess(requestFor(kept), env(), fetcher), 'the kept key is still the cached set');
    const dropped = await sign(privateKey, { exp: Math.floor(start / 1000) + 8 * 3600 }, { alg: 'RS256', kid: 'k-drop' });
    assert.equal(await verifyAccess(requestFor(dropped), env(), fetcher), null, 'the 33rd key is not cached');
  });

  test('L1 fetch errors and token time claims fail closed', async () => {
    const start = 1_800_000_000_000;
    Date.now = () => start;
    const token = await sign(privateKey, { exp: Math.floor(start / 1000) + 600, nbf: Math.floor(start / 1000) - 10 });
    assert.equal(await verifyAccess(requestFor(token), env(), async () => { throw new Error('down'); }), null);
    resetJwks();
    assert.equal(await verifyAccess(requestFor(token), env(), async () => new Response('not-json', { status: 200 })), null);
    resetJwks();
    assert.equal(await verifyAccess(requestFor(token), env(), async () => jsonResponse([])), null);
    resetJwks();
    const noKid = await sign(privateKey, {}, { alg: 'RS256' });
    assert.equal(await verifyAccess(requestFor(noKid), env(), async () => jsonResponse([realJwk])), null);
    resetJwks();
    const expired = await sign(privateKey, { exp: Math.floor(start / 1000) - 5 });
    assert.equal(await verifyAccess(requestFor(expired), env(), async () => jsonResponse([realJwk])), null);
    resetJwks();
    const early = await sign(privateKey, { nbf: Math.floor(start / 1000) + 30, exp: Math.floor(start / 1000) + 600 });
    assert.equal(await verifyAccess(requestFor(early), env(), async () => jsonResponse([realJwk])), null, 'nbf in the future');
    resetJwks();
    assert.equal((await verifyAccess(requestFor(token), env(), async () => jsonResponse([realJwk]))).email, 'tony@example.com');
  });

  test('L3 a team value with a port, path, trailing dot, or IP is refused', async () => {
    let n = 0;
    for (const team of ['team.example:443', 'team.example/extra', 'team.example.', '203.0.113.10', '::1', 'user@attacker.example', '', 'foo.example.test']) {
      n += 1;
      const token = await sign(privateKey, {}, { alg: 'RS256', kid: 'k-host-' + n });
      let called = 0;
      const fetcher = async () => { called += 1; return jsonResponse([realJwk]); };
      assert.equal(await verifyAccess(requestFor(token), env({ ACCESS_TEAM_DOMAIN: team }), fetcher), null, team);
      assert.equal(called, 0, team);
    }
  });

  test('D1 team.example.evil is not the pinned host', async () => {
    const evilIss = await sign(privateKey, { iss: 'https://team.example.evil' });
    let called = 0;
    assert.equal(await verifyAccess(requestFor(evilIss), env(), async () => { called += 1; return jsonResponse([realJwk]); }), null);
    called = 0;
    const asEvil = await sign(privateKey, { iss: 'https://team.example.evil' }, { alg: 'RS256', kid: 'k-evil-host' }, 'team.example.evil');
    assert.equal(await verifyAccess(requestFor(asEvil), env({ ACCESS_TEAM_DOMAIN: 'team.example.evil' }), async () => { called += 1; return new Response('no', { status: 500 }); }), null);
    assert.equal(called, 1, 'team.example.evil is a normal hostname when it is the configured team');
  });

  test('D1 a followed redirect would authenticate and manual refuses', async () => {
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url: String(url), redirect: init && init.redirect });
      if (!init || init.redirect !== 'manual') return jsonResponse([attackerJwk]);
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/jwks' } });
    };
    const followed = await fetcher('https://team.example/cdn-cgi/access/certs');
    assert.equal(followed.status, 200);
    const attackerToken = await sign(attackerPrivate, {}, { alg: 'RS256', kid: 'k-attacker' });
    const attackerKey = await crypto.subtle.importKey('jwk', attackerJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const [h, p, s] = attackerToken.split('.');
    const signedByAttacker = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', attackerKey, Uint8Array.from(Buffer.from(s, 'base64url')), new TextEncoder().encode(h + '.' + p));
    assert.equal(signedByAttacker, true, 'omitting manual would hand the attacker key to importKey');
    calls.length = 0;
    assert.equal(await verifyAccess(requestFor(attackerToken), env(), fetcher), null);
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(calls[0].url, 'https://team.example/cdn-cgi/access/certs');
  });

  test('a redirect or a non-JSON body keeps a young cache and drops an old one', async () => {
    const start = 1_800_000_000_000;
    let now = start;
    Date.now = () => now;
    const token = await sign(privateKey, { exp: Math.floor(start / 1000) + 8 * 3600 });
    assert.ok(await verifyAccess(requestFor(token), env(), async () => jsonResponse([realJwk])));
    for (const status of [301, 302, 303, 307, 308]) {
      now = start + 20 * 60 * 1000;
      assert.ok(await verifyAccess(requestFor(token), env(), async () => new Response(null, { status })), 'young ' + status);
    }
    now = start + 25 * 60 * 1000;
    assert.ok(await verifyAccess(requestFor(token), env(), async () => new Response('nope', { status: 200 })), 'young non-json');
    now = start + 61 * 60 * 1000;
    assert.equal(await verifyAccess(requestFor(token), env(), async () => new Response(null, { status: 302 })), null);
    now = start + 63 * 60 * 1000;
    assert.equal(await verifyAccess(requestFor(token), env(), async () => new Response('<html>', { status: 200 })), null);
  });

  test('a positive RS256 cert still verifies and oct is not imported', async () => {
    const imported = [];
    const orig = crypto.subtle.importKey.bind(crypto.subtle);
    crypto.subtle.importKey = async (format, keyData, algorithm, extractable, usages) => {
      imported.push(keyData && keyData.kty);
      return orig(format, keyData, algorithm, extractable, usages);
    };
    try {
      const who = await verifyAccess(requestFor(await sign(privateKey)), env(), async () => jsonResponse([realJwk]));
      assert.equal(who.email, 'tony@example.com');
      resetJwks();
      imported.length = 0;
      const oct = { kty: 'oct', alg: 'HS256', kid: 'k-oct', k: 'AQ' };
      assert.equal(await verifyAccess(requestFor(await sign(privateKey, {}, { alg: 'RS256', kid: 'k-oct' })), env(), async () => jsonResponse([oct])), null);
      assert.deepEqual(imported, []);
    } finally {
      crypto.subtle.importKey = orig;
    }
  });
});

function installCerts() {
  globalThis.fetch = async () => jsonResponse([realJwk]);
}

function binding(calls, tag) {
  return {
    idFromName: name => name,
    get: () => ({
      fetch: async request => {
        calls.push({ tag, request, path: new URL(request.url).pathname });
        return new Response('{"ok":true,"spokenAsk":{"version":1},"erased":false}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    }),
  };
}

function atlasOf(request) {
  const out = new Map();
  for (const [key, value] of request.headers) if (key.toLowerCase().startsWith('x-atlas-')) out.set(key.toLowerCase(), value);
  return out;
}

function assertAtlas(map, expected, label) {
  for (const key of map.keys()) assert.equal(Object.prototype.hasOwnProperty.call(expected, key), true, label + ' forwarded ' + key + '=' + map.get(key));
  for (const [key, rule] of Object.entries(expected)) {
    const value = map.get(key);
    if (rule instanceof RegExp) assert.match(String(value), rule, label + ' ' + key);
    else assert.equal(value, rule, label + ' ' + key);
  }
}

const SPOOF = {
  'x-atlas-user': 'other@example.test',
  'x-atlas-role': 'admin',
  'x-atlas-email': 'other@example.test',
  'x-atlas-tenant': '22222222-2222-4222-8222-222222222222',
  'x-atlas-tenant-enforced': '1',
  'x-atlas-idp': 'spoof-idp',
  'x-atlas-subj': 'spoof-subject',
  'x-atlas-admin': '1',
  'x-atlas-bank': 'spoof-bank',
  'x-atlas-csrf': 'spoof-csrf',
  'x-atlas-bound-subject': 'spoof-bound',
  'x-atlas-extra': 'spoof-extra',
};

describe('group 13 routes', { concurrency: false }, () => {
  beforeEach(() => { resetJwks(); Date.now = realNow; installCerts(); });
  afterEach(() => { Date.now = realNow; });

  test('L4 the refusal page escapes HTML', async () => {
    const conflict = env({ DATA_MODE: 'production', ATLAS_DEV_IDENTITY: '1', ATLAS_LOCAL_TENANT: '11111111-1111-4111-8111-111111111111' });
    const token = await sign(privateKey);
    const res = await handle(requestFor(token, '/'), conflict, PAGE);
    const html = await res.text();
    assert.equal(res.status, 503);
    assert.equal(typeof app.refusalDocument, 'function');
    const nasty = app.refusalDocument('DATA_MODE=production cannot be combined with <script>alert(1)</script>');
    assert.match(nasty, /&lt;script&gt;/);
    assert.equal(/<script[\s>]/i.test(nasty), false);
    assert.equal(html.includes(app.refusalDocument(productionDemoConflict(conflict).error)), true);
    assert.equal(html.includes('Ready when you are'), false);
    assert.equal(html.includes('isn\'t answering'), false);
  });

  test('C-3 GET / names a refused production combination and still serves production alone', async () => {
    const token = await sign(privateKey);
    const conflict = env({ DATA_MODE: 'production' });
    const refused = await handle(requestFor(token, '/'), conflict, PAGE);
    const html = await refused.text();
    assert.equal(refused.status, 503);
    assert.match(html, /DATA_MODE=production cannot be combined/);
    assert.equal(html.includes('Ready when you are'), false);
    assert.equal(html.includes('isn\'t answering'), false);
    assert.equal(html.includes('PAGE-MARKER-G13'), false);
    const alone = await handle(requestFor(token, '/'), env({ DATA_MODE: 'production', ATLAS_TENANT_ISOLATION: undefined, ATLAS_DEV_IDENTITY: undefined, ATLAS_LOCAL_TENANT: undefined }), PAGE);
    const body = await alone.text();
    assert.equal(alone.status, 200);
    assert.match(body, /PAGE-MARKER-G13/);
    const api = await handle(requestFor(token, '/api/bootstrap'), conflict, PAGE);
    assert.equal(api.status, 503);
  });

  test('L2 the bearer is checked before the body and the body is read once', async () => {
    const calls = [];
    const base = env({
      ATLAS_TENANT_ISOLATION: undefined, DATA_MODE: 'production', TRIGGER_SECRET: 'trigger-secret-value',
      ATLAS_SYSTEM_TENANT: TID, LIBRARY: binding(calls, 'library'),
    });
    const tracked = (size, headers) => {
      let reads = 0;
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close(); } });
      const getReader = stream.getReader.bind(stream);
      stream.getReader = (...args) => { reads += 1; return getReader(...args); };
      return { reads: () => reads, request: new Request(ORIGIN + '/api/triggers', { method: 'POST', headers, body: stream, duplex: 'half' }) };
    };
    const wrong = tracked(20000, { Authorization: 'Bearer trigger-secret-wrong' });
    const denied = await handle(wrong.request, base, '');
    assert.equal(denied.status, 401);
    assert.equal(wrong.reads(), 0);
    assert.equal(calls.length, 0);
    const right = tracked(20000, { Authorization: 'Bearer trigger-secret-value' });
    const tooBig = await handle(right.request, base, '');
    assert.equal(tooBig.status, 413);
    assert.equal(right.reads(), 1);
    assert.equal(calls.length, 0);
    for (const size of [100, 16384, 16385, 20000]) {
      for (const mode of ['absent', 'zero', 'real']) {
        calls.length = 0;
        const headers = { Authorization: 'Bearer trigger-secret-value' };
        if (mode === 'zero') headers['Content-Length'] = '0';
        if (mode === 'real') headers['Content-Length'] = String(size);
        const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close(); } });
        const res = await handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', headers, body: stream, duplex: 'half' }), base, '');
        const reaches = size <= 16384;
        assert.equal(res.status, reaches ? 200 : 413, size + ' ' + mode);
        assert.equal(calls.length, reaches ? 1 : 0, size + ' ' + mode);
      }
    }
  });

  test('a client x-atlas-user on /api/memory is not forwarded to the interview object', async () => {
    const calls = [];
    const token = await sign(privateKey);
    const live = env({ INTERVIEW: binding(calls, 'interview'), LIBRARY: binding(calls, 'library') });
    const res = await handle(requestFor(token, '/api/memory', { headers: { ...SPOOF } }), live, PAGE);
    assert.equal(res.status, 200);
    const memory = calls.filter(call => call.path === '/api/memory');
    assert.equal(memory.length, 1);
    const headers = atlasOf(memory[0].request);
    assert.equal(headers.get('x-atlas-user'), 'tony@example.com');
    assert.equal(headers.get('x-atlas-role'), 'user');
    assert.equal(headers.has('x-atlas-subj'), false);
    assert.equal(headers.has('x-atlas-extra'), false);
    assert.match(headers.get('x-atlas-bank'), /^atlas-[0-9a-f]{40}$/);
  });

  test('every durable object fetch drops client x-atlas headers', async () => {
    const calls = [];
    const token = await sign(privateKey);
    const live = env({
      INTERVIEW: binding(calls, 'interview'), LIBRARY: binding(calls, 'library'),
      HINDSIGHT_URL: 'https://hs.example', HINDSIGHT_API_KEY: 'k', HINDSIGHT_OPT_IN: '1',
    });
    const boot = await (await handle(requestFor(token, '/api/bootstrap'), live, PAGE)).json();
    const user = {
      'x-atlas-user': 'tony@example.com', 'x-atlas-role': 'user', 'x-atlas-email': 'tony@example.com',
      'x-atlas-tenant': TID, 'x-atlas-tenant-enforced': '0',
    };
    const rows = [];
    const run = async (label, request, filter) => {
      const before = calls.length;
      const res = await handle(request, live, PAGE, { flagsOf: () => ({ spokenAsk: true }) });
      rows.push({ label, status: res.status, calls: calls.slice(before).filter(filter) });
    };
    await run('memory', requestFor(token, '/api/memory', { headers: SPOOF }), call => call.path === '/api/memory');
    await run('library', requestFor(token, '/api/library', { headers: SPOOF }), call => call.tag === 'library' && call.path === '/api/library');
    await run('voice', requestFor(token, '/api/voice', { headers: { ...SPOOF, Upgrade: 'websocket', Origin: ORIGIN } }), call => call.path === '/api/voice');
    await run('consent', requestFor(token, '/api/consent', { method: 'POST', headers: { ...SPOOF, Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json' }, body: '{}' }), call => call.path === '/api/consent');
    await run('erase', requestFor(token, '/api/me/erase', { method: 'POST', headers: { ...SPOOF, Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json' }, body: '{"confirmed":true}' }), call => call.path === '/api/privacy/erase' || call.path === '/api/limit');
    await run('export', requestFor(token, '/api/me/export', { headers: { ...SPOOF, Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf } }), call => call.path === '/api/privacy/export' || call.path === '/api/limit');
    await run('transcribe', requestFor(token, '/api/transcribe', { method: 'POST', headers: { ...SPOOF, Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'X-Atlas-Consent': 'spoken-ask-v1; always', 'content-type': 'text/plain' }, body: 'x' }), call => call.path === '/api/library/profile/consents');
    const system = env({
      ATLAS_TENANT_ISOLATION: undefined, DATA_MODE: 'production', LOG_SALT: 'synthetic-log-salt',
      TRIGGER_SECRET: 'trigger-secret-value', DIRECTORY_PUSH_SECRET: 'push-secret-value', ATLAS_SYSTEM_TENANT: TID,
      LIBRARY: binding(calls, 'library'), ORIGIN, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, CSRF_SECRET: 'test-secret',
    });
    const systemSpoof = { 'x-atlas-user': 'other@example.test', 'x-atlas-role': 'admin', 'x-atlas-subj': 'spoof-subject', 'x-atlas-extra': 'spoof-extra', 'x-atlas-idp': 'spoof-idp' };
    const beforeTrigger = calls.length;
    const trigger = await handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', headers: { Authorization: 'Bearer trigger-secret-value', ...systemSpoof }, body: '{}' }), system, PAGE);
    rows.push({ label: 'trigger', status: trigger.status, calls: calls.slice(beforeTrigger) });
    const beforePush = calls.length;
    const push = await handle(new Request(ORIGIN + '/api/directory/push', { method: 'POST', headers: { Authorization: 'Bearer push-secret-value', ...systemSpoof }, body: '{"rows":[]}' }), system, PAGE);
    rows.push({ label: 'push', status: push.status, calls: calls.slice(beforePush) });
    const beforeCron = calls.length;
    const waited = [];
    await scheduled({}, live, { waitUntil: promise => waited.push(promise) });
    await Promise.all(waited);
    rows.push({ label: 'cron', status: 200, calls: calls.slice(beforeCron) });

    const expect = {
      memory: { ...user, 'x-atlas-bank': /^atlas-[0-9a-f]{40}$/ },
      library: { ...user, 'x-atlas-idp': 'e30' },
      voice: { ...user, 'x-atlas-admin': '0', 'x-atlas-bank': /^atlas-[0-9a-f]{40}$/, 'x-atlas-csrf': boot.csrf },
      consent: { ...user, 'x-atlas-tenant': '', 'x-atlas-subj': /^[0-9a-f]{32}$/ },
      erase: { ...user, 'x-atlas-subj': /^[0-9a-f]{32}$/ },
      export: { ...user, 'x-atlas-subj': /^[0-9a-f]{32}$/ },
      transcribe: { ...user, 'x-atlas-idp': 'e30' },
      trigger: { 'x-atlas-user': 'pm-system', 'x-atlas-role': 'system', 'x-atlas-email': '', 'x-atlas-idp': 'e30', 'x-atlas-tenant': TID, 'x-atlas-tenant-enforced': '1' },
      push: { 'x-atlas-user': 'dna-push', 'x-atlas-role': 'system', 'x-atlas-email': '', 'x-atlas-idp': 'e30', 'x-atlas-tenant': TID, 'x-atlas-tenant-enforced': '1' },
      cron: { 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system', 'x-atlas-tenant': '', 'x-atlas-tenant-enforced': '0' },
    };
    for (const row of rows) {
      assert.equal(row.calls.length > 0, true, row.label + ' made no durable object fetch');
      if (row.label === 'erase' || row.label === 'export') {
        const limit = row.calls.find(call => call.path === '/api/limit');
        const privacy = row.calls.find(call => call.path.startsWith('/api/privacy/'));
        assert.ok(limit, row.label + ' limit');
        assert.equal(atlasOf(limit.request).size, 0, row.label + ' limit copies no x-atlas header');
        assertAtlas(atlasOf(privacy.request), expect[row.label], row.label);
      } else {
        assert.equal(row.calls.length, 1, row.label);
        assertAtlas(atlasOf(row.calls[0].request), expect[row.label], row.label);
      }
    }
  });

  test('a CJK email in the verified token is not a 500 on library', async () => {
    await assertHandled(CJK, 'library');
  });
  test('a CJK email in the verified token is not a 500 on voice', async () => {
    await assertHandled(CJK, 'voice');
  });
  test('a CJK email in the verified token is not a 500 on consent', async () => {
    await assertHandled(CJK, 'consent');
  });
  test('a CJK email in the verified token is not a 500 on erase', async () => {
    await assertHandled(CJK, 'erase');
  });
  test('a CJK email in the verified token is not a 500 on memory', async () => {
    await assertHandled(CJK, 'memory');
  });

  test('a CJK email in the verified token still loads the page and bootstrap', async () => {
    const token = await sign(privateKey, { email: CJK });
    const live = env({ INTERVIEW: binding([], 'interview'), LIBRARY: binding([], 'library') });
    const home = await handle(requestFor(token, '/'), live, PAGE);
    const homeText = await home.text();
    assert.equal(home.status, 200);
    assert.equal(homeText.includes('Something went wrong.'), false);
    assert.match(homeText, /PAGE-MARKER-G13/);
    const boot = await handle(requestFor(token, '/api/bootstrap'), live, PAGE);
    const body = await boot.json();
    assert.equal(boot.status, 200);
    assert.equal(typeof body.csrf, 'string');
    assert.equal(body.csrf.length, 64);
  });

  test('a Latin-1 email in the verified token is forwarded', async () => {
    for (const email of [LATIN, LATIN_LAST]) {
      const calls = [];
      const token = await sign(privateKey, { email });
      const live = env({ LIBRARY: binding(calls, 'library') });
      const res = await handle(requestFor(token, '/api/library'), live, PAGE);
      const text = await res.text();
      assert.equal(res.status, 200, email);
      assert.equal(text.includes('Something went wrong.'), false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].request.headers.get('x-atlas-user'), email);
      assert.equal(calls[0].request.headers.get('x-atlas-email'), email);
    }
  });
});

async function assertHandled(email, path) {
  const calls = [];
  const token = await sign(privateKey, { email });
  const live = env({ INTERVIEW: binding(calls, 'interview'), LIBRARY: binding(calls, 'library') });
  const boot = await (await handle(requestFor(token, '/api/bootstrap'), live, PAGE)).json();
  let res;
  if (path === 'library') res = await handle(requestFor(token, '/api/library'), live, PAGE);
  if (path === 'memory') res = await handle(requestFor(token, '/api/memory'), live, PAGE);
  if (path === 'voice') res = await handle(requestFor(token, '/api/voice', { headers: { Upgrade: 'websocket', Origin: ORIGIN } }), live, PAGE);
  if (path === 'consent') res = await handle(requestFor(token, '/api/consent', { method: 'POST', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json' }, body: '{}' }), live, PAGE);
  if (path === 'erase') res = await handle(requestFor(token, '/api/me/erase', { method: 'POST', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json' }, body: '{"confirmed":true}' }), live, PAGE);
  const text = await res.text();
  assert.equal(res.status, 400, path);
  assert.equal(text.includes(email), false, path);
  assert.equal(text.includes('用户'), false, path);
  assert.equal(text.includes('Something went wrong.'), false, path);
  assert.match(text, /forwarded/);
}
