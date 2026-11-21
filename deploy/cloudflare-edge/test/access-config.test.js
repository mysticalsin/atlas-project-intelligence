// Access configuration fails closed. A placeholder is not a deployment, and a dev identity is not a fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, verifyAccess } from '../src/app.js';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-123';
const ORIGIN = 'https://atlas.example.workers.dev';
const PLACEHOLDER_TEAM = 'team.example.test';
const PLACEHOLDER_AUD = 'replace-me';
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k-access-config' };
let fetched = 0;
globalThis.fetch = async () => {
  fetched += 1;
  return new Response(JSON.stringify({ keys: [jwk] }));
};

async function jwt(aud, team) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: [aud], iss: `https://${team}`, sub: 'user-abc', email: 'owner@example.test', exp: now + 600, iat: now };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'k-access-config' })) + '.' + b64u(JSON.stringify(body));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input));
  return input + '.' + b64u(sig);
}

function env(extra = {}) {
  return { ORIGIN, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, CSRF_SECRET: 'test-secret', LOG_SALT: 'synthetic-log-salt', ...extra };
}

test('placeholder or missing Access config fails closed and does not fetch certs', async () => {
  const token = await jwt(PLACEHOLDER_AUD, PLACEHOLDER_TEAM);
  const placeholder = env({ ACCESS_AUD: PLACEHOLDER_AUD, ACCESS_TEAM_DOMAIN: PLACEHOLDER_TEAM });
  fetched = 0;
  assert.equal(await verifyAccess(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': token } }), placeholder), null);
  assert.equal(fetched, 0, 'a placeholder team must not be contacted');
  for (const broken of [env({ ACCESS_AUD: '' }), env({ ACCESS_TEAM_DOMAIN: '' }), env({ ACCESS_AUD: '   ' }), env({ ACCESS_TEAM_DOMAIN: '   ' })]) {
    assert.equal(await verifyAccess(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': token } }), broken), null);
  }
  const page = '<script id="atlas-runtime" type="application/json">{}</script></body>';
  const denied = await handle(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': token } }), placeholder, page);
  assert.equal(denied.status, 401);
  assert.match(await denied.text(), /Sign in to use ATLAS/);
  const dev = { ...placeholder, ATLAS_DEV_IDENTITY: '1', ATLAS_TENANT_ISOLATION: 'local-synthetic' };
  assert.equal((await handle(new Request(ORIGIN + '/api/bootstrap', { headers: { 'cf-access-jwt-assertion': token } }), dev, page)).status, 401);
  assert.equal((await handle(new Request(ORIGIN + '/api/bootstrap', { headers: { 'cf-access-jwt-assertion': token } }), { ...dev, DATA_MODE: 'production' }, page)).status, 503);
});

test('a configured non-placeholder audience still verifies', async () => {
  const who = await verifyAccess(new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': await jwt(AUD, TEAM) } }), env());
  assert.equal(who && who.sub, 'user-abc');
  assert.equal(who.email, 'owner@example.test');
});
