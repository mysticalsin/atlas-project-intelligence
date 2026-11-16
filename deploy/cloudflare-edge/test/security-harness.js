// Shared by the B1 security tests: a real RS256 Access token (self-signed, key served by a stubbed certs endpoint), the Worker `handle`
// with a captured security log, and a signed-in "session" (token + the CSRF token /api/bootstrap issues for it).
import * as app from '../src/app.js';
const { handle } = app;
export const resetJwksCache = app.resetJwksCache || (() => {}); // (absent in pre-B1 code, so the regression tests can also run against it)

export const TEAM = 'team.cloudflareaccess.com', AUD = 'aud-123', ORIGIN = 'https://atlas.example.workers.dev';
export const b64u = b => Buffer.from(b).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
export const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
export const stubCerts = (fn = async () => new Response(JSON.stringify({ keys: [jwk] }))) => { globalThis.fetch = async (url, init) => { if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error('network refused: ' + url); return fn(url, init); }; };
stubCerts();
export async function jwt(claims = {}, header = { alg: 'RS256', kid: 'k1' }) {
  const now = Math.floor(Date.now() / 1000), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'user-abc', email: 'tony@example.com', exp: now + 600, iat: now, ...claims };
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}
export const ENV = { ORIGIN, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, CSRF_SECRET: 'test-secret', TALKER_MODEL: 'talker', TTS_VOICE: 'harmonia', DATA_MODE: 'production', LOG_SALT: 'synthetic-log-salt' };

// A Durable Object namespace stub: every call lands in `fn(request, name)`; `calls` records them.
export const ns = fn => { const calls = []; return { calls, idFromName: n => n, get: name => ({ fetch: async r => { calls.push({ name, request: r }); return fn ? fn(r, name) : new Response('{}', { headers: { 'Content-Type': 'application/json' } }); } }) }; };

// session(env, claims): signed-in person. go(path, { method, headers, body, csrf: false|string, origin: false|string }, envOverride) -> { res, logs }.
export async function session(env = ENV, claims = {}) {
  const token = await jwt(claims), logs = [];
  const sink = line => logs.push(JSON.parse(line));
  const go = async (path, { method = 'GET', headers = {}, body, csrf, origin, signed = true } = {}, e = env) => {
    const h = { ...(signed ? { 'cf-access-jwt-assertion': token } : {}), ...headers };
    if (method !== 'GET') { if (origin !== false) h.Origin = origin ?? ORIGIN; if (csrf !== false) h['X-Atlas-CSRF'] = csrf ?? me.csrf; }
    const res = await handle(new Request(ORIGIN + path, { method, headers: h, body, ...(body && typeof body === 'object' && !(body instanceof Uint8Array) && typeof body !== 'string' ? { duplex: 'half' } : {}) }), e, '<html></html>', { log: sink });
    return res;
  };
  const me = { token, logs, go, csrf: '' };
  me.csrf = (await (await go('/api/bootstrap')).json()).csrf;
  logs.length = 0;
  return me;
}
