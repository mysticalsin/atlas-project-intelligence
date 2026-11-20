// ATLAS-HROW10-IDENTITY-CHANGE-RESIDUAL
// Red until a bound Access identity that disagrees with the current JWT
// returns 409 IDENTITY_CHANGED before any Durable Object is opened.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-identity-change';
const ORIGIN = 'https://atlas.example.workers.dev';
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k-identity' };
globalThis.fetch = async url => {
  assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }));
};

async function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: now + 600,
    iat: now,
    ...claims,
  };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'k-identity' })) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}

const ADA = { sub: 'user-ada', email: 'ada@example.test' };
const BLAKE = { sub: 'user-blake', email: 'blake@example.test' };
const RENAMED = { sub: 'user-ada', email: 'ada.renamed@example.test' };
const MARKER = 'Blake journal marker';
const FAILURE = {
  status: 409,
  opened: [],
  error: 'The signed-in identity changed. Reload ATLAS and sign in again.',
  code: 'IDENTITY_CHANGED',
  marker: false,
};

function binder(payload) {
  const opened = [];
  const binding = {
    idFromName(name) { opened.push(String(name)); return name; },
    get() {
      return {
        fetch: async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
      };
    },
  };
  return { binding, opened };
}

function envFor(library, interview) {
  return {
    ORIGIN,
    ACCESS_AUD: AUD,
    ACCESS_TEAM_DOMAIN: TEAM,
    CSRF_SECRET: 'test-secret',
    LOG_SALT: 'synthetic-log-salt',
    ATLAS_TENANT_ISOLATION: 'local-synthetic',
    ATLAS_ADMIN_ROLES: 'ATLAS.Admin',
    ATLAS_PRESALES_ROLES: 'ATLAS.Presales,ATLAS.Publish',
    ATLAS_REVIEWER_ROLES: 'ATLAS.Reviewer,ATLAS.Review',
    LIBRARY: library,
    INTERVIEW: interview,
  };
}

async function tokenFor(who) {
  return jwt({ sub: who.sub, email: who.email });
}

async function established() {
  const token = await tokenFor(ADA);
  const res = await handle(new Request(ORIGIN + '/api/bootstrap', { headers: { 'cf-access-jwt-assertion': token } }), envFor(binder({}).binding, binder({}).binding), '');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.identity.name, ADA.email);
  assert.match(body.identity.subjectKey, /^[0-9a-f]{32}$/);
  return { token, subjectKey: body.identity.subjectKey, email: body.identity.name, csrf: body.csrf };
}

function boundHeaders(ada, extra = {}) {
  return {
    'X-Atlas-Bound-Subject': ada.subjectKey,
    'X-Atlas-Bound-Email': ada.email,
    ...extra,
  };
}

async function outcome(res, opened) {
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = {}; }
  return {
    status: res.status,
    opened: opened.slice(),
    error: body.error || '',
    code: body.code || '',
    marker: text.includes(MARKER),
  };
}

describe('access identity change, worker', { concurrency: false }, () => {
test('library GET with the other bound identity does not open a Durable Object', async () => {
  const ada = await established();
  const library = binder({ title: MARKER });
  const interview = binder({ title: MARKER });
  const res = await handle(new Request(ORIGIN + '/api/library/journey', {
    headers: { 'cf-access-jwt-assertion': await tokenFor(BLAKE), ...boundHeaders(ada) },
  }), envFor(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
});

test('library GET with only the email changed does not open a Durable Object', async () => {
  const ada = await established();
  const library = binder({ title: MARKER });
  const interview = binder({ title: MARKER });
  const res = await handle(new Request(ORIGIN + '/api/library/journey', {
    headers: { 'cf-access-jwt-assertion': await tokenFor(RENAMED), ...boundHeaders(ada) },
  }), envFor(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
});

test('library GET with only the subject changed does not open a Durable Object', async () => {
  const ada = await established();
  const library = binder({ title: MARKER });
  const interview = binder({ title: MARKER });
  const res = await handle(new Request(ORIGIN + '/api/library/journey', {
    headers: {
      'cf-access-jwt-assertion': await tokenFor({ sub: BLAKE.sub, email: ADA.email }),
      ...boundHeaders(ada),
    },
  }), envFor(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
});

test('voice upgrade with the other bound subject does not open the interview object', async () => {
  const ada = await established();
  const library = binder({ title: MARKER });
  const interview = binder({ title: MARKER });
  const res = await handle(new Request(ORIGIN + '/api/voice', {
    headers: {
      'cf-access-jwt-assertion': await tokenFor(BLAKE),
      Upgrade: 'websocket',
      Origin: ORIGIN,
      'Sec-WebSocket-Protocol': 'atlas-bound-' + ada.subjectKey,
    },
  }), envFor(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, interview.opened), FAILURE);
});

test('privacy delete with the new csrf and the old bound identity does not open the library', async () => {
  // Access mode without a tid:oid subject is refused here as "A verified tenant is required"
  // before the library. That 403 is not this residual. Entra-shaped Access tokens carry a
  // verified tid, so today's handler accepts B's csrf and opens the library.
  const tid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const entraEnv = (library, interview) => ({
    ...envFor(library, interview),
    ATLAS_TENANT_ISOLATION: 'enforced',
    IDENTITY_SOURCE: 'entra',
    ENTRA_TENANTS: tid,
  });
  const entraToken = (email, oid) => jwt({ sub: 'cf-' + oid, email, custom: { tid, oid } });
  const adaToken = await entraToken('ada@example.test', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const blakeToken = await entraToken('blake@example.test', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const adaBoot = await (await handle(new Request(ORIGIN + '/api/bootstrap', {
    headers: { 'cf-access-jwt-assertion': adaToken },
  }), entraEnv(binder({}).binding, binder({}).binding), '')).json();
  const blakeBoot = await (await handle(new Request(ORIGIN + '/api/bootstrap', {
    headers: { 'cf-access-jwt-assertion': blakeToken },
  }), entraEnv(binder({}).binding, binder({}).binding), '')).json();
  assert.equal(adaBoot.identity.mode, 'entra');
  assert.match(adaBoot.identity.subjectKey, /^[0-9a-f]{32}$/);
  assert.notEqual(adaBoot.identity.subjectKey, blakeBoot.identity.subjectKey);
  const library = binder({ note: MARKER, outcomes: [{ store: 'journey', removed: 1 }] });
  const interview = binder({});
  const res = await handle(new Request(ORIGIN + '/api/library/privacy/delete', {
    method: 'POST',
    body: '{}',
    headers: {
      'cf-access-jwt-assertion': blakeToken,
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-Atlas-CSRF': blakeBoot.csrf,
      'X-Atlas-Bound-Subject': adaBoot.identity.subjectKey,
      'X-Atlas-Bound-Email': adaBoot.identity.name,
    },
  }), entraEnv(library.binding, interview.binding), '');
  assert.deepEqual(await outcome(res, library.opened.concat(interview.opened)), FAILURE);
});
});
