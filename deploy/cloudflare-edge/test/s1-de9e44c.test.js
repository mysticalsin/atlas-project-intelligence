// Cursor delta of de9e44c7. These fail on that tree.
// A production library must refuse before any business write when the audit key is null.
// A Teams install must not keep teams rows when the audit write returns 503.
// The Durable Object path must reject an id that is not 64 hex characters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as store from '../src/library-store.js';
import * as outreach from '../src/outreach.js';
import { BOT_ISSUER, OPENID_URL, resetBotKeyCache } from '../src/teams.js';
import { memorySql } from './sqlite.js';
import { auditKey } from '../src/audit-chain.js';
import { session, ENV, ORIGIN } from './security-harness.js';

const EMAIL = 'ada@example.test';
const STAMP = '2026-11-17T00:00:00.000Z';
const SALT = 'synthetic-log-salt';
const TID = '11111111-1111-4111-8111-111111111111';
const OID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAMS_TID = '11111111-2222-4333-8444-555555555555';
const TEAMS_OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const BOT = '22222222-3333-4444-5555-666666666666';
const APP = '33333333-4444-5555-6666-777777777777';
const ATLAS_TENANT = '99999999-9999-4999-8999-999999999999';
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const DO_ID = 'ab'.repeat(32);
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const MAIN_COLS = ['seq', 'id', 'actor', 'action', 'at', 'detail'];
const enc = new TextEncoder();
const b64u = bytes => Buffer.from(bytes).toString('base64url');

function columns(sql) {
  return sql.exec("SELECT name FROM pragma_table_info('audit')").toArray().map(row => row.name);
}
function mainShaped(sql, count = 0) {
  assert.deepEqual(columns(sql), MAIN_COLS);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n, count);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit_anchor'").toArray()[0].n, 0);
}
function countOf(sql, table) {
  const present = sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray()[0].n;
  if (!present) return 0;
  return sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n;
}
function prodEnv(sql, extra = {}) {
  const env = {
    ...ENV, ...extra, DATA_MODE: 'production', IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: TID,
  };
  delete env.LOG_SALT;
  env.LIBRARY = {
    idFromName: name => name,
    get() {
      const lib = new Library(sql, { now: () => STAMP, auditKey: auditKey(env), transactionSync: fn => sql.transactionSync(fn) });
      return { fetch: request => libraryRoutes(request, lib, { env }) };
    },
  };
  return env;
}
const story = {
  localId: 'northwind',
  reference: {
    title: 'Northwind queue pilot', stage: 'Pilot', sector: 'Insurance',
    consultant: { name: 'Ada Example', role: 'Consultant' },
    client: { name: 'Northwind Mutual', location: 'Example City', contact: 'Operations' },
    details: { projectId: 'SYN-1', country: 'Exampleland', consultants: [] },
    answers: ['A fictional insurer had a slow queue.', 'Ada rebuilt one routing step.', 'The team kept a manual fallback.', 'The queue was shorter on a sample dashboard.', 'Sample dashboard export.', 'Similar fictional service desks.'],
    validation: { manager: { name: 'Sam Example', email: 'manager@example.test' }, managerStaff: false },
  },
};

async function signed(sql) {
  const env = prodEnv(sql);
  const me = await session(env, { sub: `${TID}:${OID}`, email: EMAIL, custom: { tid: TID, oid: OID, roles: [] } });
  return { env, me };
}

test('a signed-in library write in production without LOG_SALT is 503 and writes no business row', async () => {
  const sql = memorySql();
  sql.exec(MAIN);
  assert.equal(auditKey({ DATA_MODE: 'production' }), null);
  const { env, me } = await signed(sql);
  const res = await me.go('/api/library', { method: 'POST', body: JSON.stringify(story), headers: { 'content-type': 'application/json' } }, env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'LOG_SALT');
  assert.throws(() => new Library(sql, { now: () => STAMP, auditKey: null, transactionSync: fn => sql.transactionSync(fn) }), err => err.status === 503);
  assert.equal(countOf(sql, 'refs'), 0);
  mainShaped(sql, 0);
});

test('a signed-in erase in production without LOG_SALT is 503 and writes no business row', async () => {
  const sql = memorySql();
  sql.exec(MAIN);
  const { env, me } = await signed(sql);
  const res = await me.go('/api/me/erase', { method: 'POST', body: '{"confirmed":true}', headers: { 'content-type': 'application/json' } }, env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'LOG_SALT');
  assert.throws(() => new Library(sql, { now: () => STAMP, auditKey: auditKey(env) }), err => err.status === 503);
  assert.equal(countOf(sql, 'erasure_log'), 0);
  assert.equal(countOf(sql, 'refs'), 0);
  mainShaped(sql, 0);
});

test('spoken-ask consent in production without LOG_SALT is 503 and writes no profile row', async () => {
  const sql = memorySql();
  sql.exec(MAIN);
  const { env, me } = await signed(sql);
  const res = await me.go('/api/library/profile/consent', {
    method: 'POST', body: JSON.stringify({ kind: 'spokenAsk', version: 1, granted: true }), headers: { 'content-type': 'application/json' },
  }, env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'LOG_SALT');
  assert.throws(() => new Library(sql, { now: () => STAMP, auditKey: null }), err => err.status === 503);
  assert.equal(countOf(sql, 'profiles'), 0);
  mainShaped(sql, 0);
});

test('a Teams install in production without LOG_SALT is 503, writes no teams row, and a retry stays 503', async () => {
  const sql = memorySql();
  sql.exec(MAIN);
  const env = prodEnv(sql, {
    TEAMS_APP_ID: APP, TEAMS_BOT_APP_ID: BOT, TEAMS_TENANT_ID: TEAMS_TID, TEAMS_BOT_SECRET: 'bot-secret',
    ATLAS_SYSTEM_TENANT: ATLAS_TENANT,
  });
  const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', key.publicKey)), kid: 'k1', endorsements: ['msteams'], use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: BOT_ISSUER, aud: BOT, exp: now + 600, nbf: now - 10, serviceurl: SERVICE };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })) + '.' + b64u(JSON.stringify(claims));
  const token = input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, enc.encode(input)));
  const activity = {
    type: 'installationUpdate', action: 'add', id: 'inst-null-key', channelId: 'msteams', serviceUrl: SERVICE,
    from: { id: '29:ada', aadObjectId: TEAMS_OID, name: 'Ada' }, recipient: { id: '28:' + BOT },
    conversation: { id: 'a:conv-ada', conversationType: 'personal', tenantId: TEAMS_TID },
    channelData: { tenant: { id: TEAMS_TID } },
  };
  const prev = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    if (u === OPENID_URL) return Response.json({ issuer: BOT_ISSUER, jwks_uri: JWKS_URL });
    if (u === JWKS_URL) return Response.json({ keys: [jwk] });
    return prev(url);
  };
  resetBotKeyCache();
  try {
    const post = () => handle(new Request(ORIGIN + '/api/teams/messages', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(activity),
    }), env, '');
    const first = await post();
    assert.equal(first.status, 503);
    assert.equal((await first.json()).code, 'LOG_SALT');
    assert.equal(countOf(sql, 'teams_seen'), 0);
    assert.equal(countOf(sql, 'teams_conversations'), 0);
    const again = await post();
    assert.equal(again.status, 503);
    assert.equal((await again.json()).code, 'LOG_SALT');
    assert.equal(countOf(sql, 'teams_seen'), 0);
    assert.equal(countOf(sql, 'teams_conversations'), 0);
    mainShaped(sql, 0);
  } finally {
    globalThis.fetch = prev;
    resetBotKeyCache();
  }
});

test('a Teams install whose audit write returns 503 rolls the teams rows back', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP, auditKey: SALT });
  lib.log = () => { const err = new Error('LOG_SALT is not set.'); err.status = 503; throw err; };
  const event = {
    kind: 'install', activityId: 'act-rollback', tenantId: TEAMS_TID, aadObjectId: TEAMS_OID,
    serviceUrl: SERVICE, conversationId: 'a:conv-ada', teamsUserId: '29:ada', email: '',
  };
  await assert.rejects(
    () => outreach.system({ lib, user: { email: 'teams-bot', role: 'system', tenant: '', tenantEnforced: false }, body: event }),
    err => err.status === 403 && err.message === 'A verified tenant is required.',
  );
  assert.equal(countOf(sql, 'teams_seen'), 0);
  assert.equal(countOf(sql, 'teams_conversations'), 0);
  await assert.rejects(
    () => outreach.system({ lib, user: { email: 'teams-bot', role: 'system', tenant: ATLAS_TENANT, tenantEnforced: false }, body: { ...event, activityId: 'act-rollback-tenant' } }),
    err => err.status === 503,
  );
  assert.equal(countOf(sql, 'teams_seen'), 0);
  assert.equal(countOf(sql, 'teams_conversations'), 0);
});

test('the Durable Object path rejects String(undefined), null and an empty id before storage', () => {
  const open = store.openDurableLibrary;
  assert.equal(typeof open, 'function');
  const storage = {
    sql: { exec() { throw new Error('storage was opened'); } },
    transactionSync() { throw new Error('storage was opened'); },
  };
  for (const id of [String(undefined), 'null', '']) {
    assert.throws(() => open({ id, storage }, { DATA_MODE: 'production', LOG_SALT: SALT }, { auditKey: SALT }), /64/);
  }
  const sql = memorySql();
  sql.exec(MAIN);
  let calls = 0;
  const counting = {
    exec(...args) { calls += 1; return sql.exec(...args); },
    transactionSync(fn) { calls += 1; return sql.transactionSync(fn); },
  };
  assert.throws(
    () => open({ id: DO_ID, storage: { sql: counting, transactionSync: fn => counting.transactionSync(fn) } }, { DATA_MODE: 'production' }, { now: () => STAMP, auditKey: null }),
    err => err.status === 503,
  );
  assert.equal(calls, 0);
  mainShaped(sql, 0);
  const opened = open(
    { id: DO_ID, storage: { sql, transactionSync: fn => sql.transactionSync(fn) } },
    { DATA_MODE: 'production', LOG_SALT: SALT },
    { now: () => STAMP, auditKey: SALT },
  );
  assert.equal(opened.dbId, DO_ID);
});
