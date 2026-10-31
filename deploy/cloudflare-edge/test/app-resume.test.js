// Agent Brain v2.1 T10: the Worker side of resume. The bootstrap says whether the REQUESTING person has a resumable interview ({sessionId, savedAt,
// expiresAt}, never content), asked of their own Interview Durable Object only; "Start over" deletes it (Origin + CSRF). The Durable Object is a fake
// namespace with one storage per name, as the real one has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { CheckpointStore, checkpointRoutes } from '../src/checkpoint.js';
import { FakeStorage } from './reconnect-harness.js';

const TEAM = 'team.cloudflareaccess.com', AUD = 'aud-123', ORIGIN = 'https://atlas.example.workers.dev';
const b64u = b => Buffer.from(b).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
async function jwt(claims = {}) {
  const now = Math.floor(Date.now() / 1000), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'user-abc', email: 'tony@example.com', exp: now + 600, iat: now, ...claims };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' })) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}
const BASE = { ORIGIN, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, CSRF_SECRET: 'test-secret', TALKER_MODEL: 'talker', TTS_VOICE: 'harmonia' };
const ID = 'ab'.repeat(16), SECRET = 'my interview content must never reach the bootstrap';

// One Durable Object per name, each with its own storage, serving the checkpoint routes under the forwarded identity.
function namespace() {
  const stores = new Map(), seen = [];
  const storage = name => { if (!stores.has(name)) stores.set(name, new FakeStorage()); return stores.get(name); };
  return { stores, seen, storage, idFromName: n => n, get: name => ({ fetch: r => { seen.push({ name, user: r.headers.get('x-atlas-user'), path: new URL(r.url).pathname }); return checkpointRoutes(r, { storage: storage(name) }); } }) };
}
const as = (claims, path = '/api/bootstrap', init = {}) => jwt(claims).then(t => new Request(ORIGIN + path, { ...init, headers: { 'cf-access-jwt-assertion': t, ...(init.headers || {}) } }));
const save = (ns, name, owner) => new CheckpointStore(ns.storage(name), { owner }).save({ version: 1, sessionId: ID, secret: SECRET });
const boot = async (env, claims, init) => (await handle(await as(claims, '/api/bootstrap', init), env, '')).json();

test('bootstrap: resumable is the requester\'s own interview, as {sessionId, savedAt, expiresAt} only', async () => {
  const ns = namespace(), env = { ...BASE, INTERVIEW: ns };
  assert.equal((await boot(env, {})).resumable, null, 'nothing stored');
  await save(ns, 'user-abc', 'tony@example.com');
  const b = await boot(env, {});
  assert.deepEqual(Object.keys(b.resumable).sort(), ['expiresAt', 'savedAt', 'sessionId']); assert.equal(b.resumable.sessionId, ID);
  assert.equal(b.resumable.expiresAt - b.resumable.savedAt, 24 * 3600 * 1000);
  assert.ok(!JSON.stringify(b).includes(SECRET), 'never content');
  assert.deepEqual(ns.seen.at(-1), { name: 'user-abc', user: 'tony@example.com', path: '/api/checkpoint' });
});

test('another person\'s bootstrap never sees it: their own Durable Object is asked, under their own verified identity', async () => {
  const ns = namespace(), env = { ...BASE, INTERVIEW: ns };
  await save(ns, 'user-abc', 'tony@example.com');
  const b = await boot(env, { sub: 'user-xyz', email: 'other@example.com' }, { headers: { 'x-atlas-user': 'tony@example.com', 'x-atlas-bank': 'x' } });
  assert.equal(b.resumable, null);
  assert.deepEqual(ns.seen.at(-1), { name: 'user-xyz', user: 'other@example.com', path: '/api/checkpoint' }, 'a browser header cannot choose the identity');
  // even a request routed to the wrong Durable Object finds nothing: the owner recorded with the checkpoint must match
  const wrong = await checkpointRoutes(new Request('https://x/api/checkpoint', { headers: { 'x-atlas-user': 'other@example.com' } }), { storage: ns.storage('user-abc') });
  assert.deepEqual(await wrong.json(), { resumable: null });
});

test('Start over: Origin and CSRF are required, only the caller\'s own checkpoint is deleted', async () => {
  const ns = namespace(), env = { ...BASE, INTERVIEW: ns };
  await save(ns, 'user-abc', 'tony@example.com'); await save(ns, 'user-xyz', 'other@example.com');
  const csrf = (await boot(env, {})).csrf, url = '/api/checkpoint/discard';
  const post = (claims, headers) => as(claims, url, { method: 'POST', headers }).then(r => handle(r, env, ''));
  assert.equal((await post({}, {})).status, 403);
  assert.equal((await post({}, { Origin: ORIGIN })).status, 403, 'CSRF missing');
  assert.equal((await post({}, { Origin: 'https://evil.example', 'X-Atlas-CSRF': csrf })).status, 403);
  assert.ok((await boot(env, {})).resumable, 'refused requests deleted nothing');
  const own = await post({}, { Origin: ORIGIN, 'X-Atlas-CSRF': csrf }); assert.equal(own.status, 200); assert.deepEqual(await own.json(), { discarded: true });
  assert.equal((await boot(env, {})).resumable, null);
  assert.ok((await boot(env, { sub: 'user-xyz', email: 'other@example.com' })).resumable, 'the other person\'s is untouched');
  const get = await handle(await as({}, url), env, ''); assert.notEqual(get.status, 200, 'GET is not a discard');
});

test('ATLAS_CHECKPOINT=off, no namespace, a failing or a hanging Durable Object: the bootstrap still answers, with nothing to resume', async () => {
  const ns = namespace(); await save(ns, 'user-abc', 'tony@example.com');
  assert.equal((await boot({ ...BASE, INTERVIEW: ns, ATLAS_CHECKPOINT: 'off' }, {})).resumable, null); assert.equal(ns.seen.length, 0, 'off: the Durable Object is not even asked');
  assert.equal((await boot({ ...BASE }, {})).resumable, null);
  const broken = { idFromName: n => n, get: () => ({ fetch: () => { throw new Error('boom'); } }) };
  assert.equal((await boot({ ...BASE, INTERVIEW: broken }, {})).resumable, null);
  const garbage = { idFromName: n => n, get: () => ({ fetch: async () => new Response('not json') }) };
  assert.equal((await boot({ ...BASE, INTERVIEW: garbage }, {})).resumable, null);
  const hang = { idFromName: n => n, get: () => ({ fetch: () => new Promise(() => {}) }) }, t0 = Date.now();
  assert.equal((await boot({ ...BASE, INTERVIEW: hang }, {})).resumable, null); assert.ok(Date.now() - t0 < 4000, 'bounded wait');
});

test('external confirmers get no resumable field and no Durable Object call', async () => {
  const ns = namespace(), env = { ...BASE, INTERVIEW: ns, EXTERNAL_EMAILS: 'ext@example.com' };
  const b = await boot(env, { email: 'ext@example.com' }); assert.equal(b.libraryRole, 'external'); assert.ok(!('resumable' in b)); assert.equal(ns.seen.length, 0);
});
