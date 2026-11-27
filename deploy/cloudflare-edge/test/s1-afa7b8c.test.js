// Cursor delta of afa7b8ce. These fail on that tree.
// A staffing row with no inner log, a directory part, a Teams stop, a hidden dismiss,
// and a Teams send must not survive a broken chain. A truncated chain is unverified.
// A production Teams message with no LOG_SALT returns JSON 503 before LIBRARY.get.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { verifyDaily } from '../src/audit-chain.js';
import * as outreach from '../src/outreach.js';
import * as profile from '../src/profile.js';
import { handle } from '../src/app.js';
import { BOT_ISSUER, OPENID_URL, resetBotKeyCache } from '../src/teams.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OWNER = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
const BEA = { email: 'bea@example.test', mail: 'bea@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
const REV = { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer', tenant: '', tenantEnforced: false };
const ADMIN = { email: 'ada@example.test', mail: 'ada@example.test', role: 'admin', tenant: '', tenantEnforced: false };
const HEADER = 'project_id,consultant_email,manager_email,manager_name,project_title,end_date';
const BATCH = 'ab'.repeat(16);
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const ORIGIN = 'https://atlas.example';
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const BOT = '22222222-3333-4444-5555-666666666666';
const APP = '33333333-4444-5555-6666-777777777777';
const TEAMS_TID = '11111111-2222-4333-8444-555555555555';
const ATLAS_TENANT = '99999999-9999-4999-8999-999999999999';
const enc = new TextEncoder();
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const REF = () => ({
  title: 'Claims triage alias', stage: 'Production', sector: 'Insurance',
  consultant: { name: 'Ada', role: 'Data engineer' },
  client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', start: '2024-03', end: '2024-11', teamSize: 6, teamRoles: ['Data engineer'], technologies: ['Python'], deliverables: ['Routing model'], serviceLines: ['Data & AI'], consultants: [], links: [] },
  answers: ['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.', 'I designed and built the routing model and ran the pilot with two teams.',
    'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.', 'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
    'Operations dashboard export v3, before and after quarters.', 'Any insurer or service desk with manual routing and a measurable queue would benefit.'],
  validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: false },
});

function open(extra = {}) {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP, auditKey: SALT, ...extra });
  return { sql, lib };
}
function n(lib, table, where = '', ...p) {
  if (!sqlOf(lib).exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray()[0]) return 0;
  return sqlOf(lib).exec(`SELECT COUNT(*) AS n FROM ${table}${where ? ' WHERE ' + where : ''}`, ...p).toArray()[0].n;
}
function tamper(lib) {
  sqlOf(lib).exec("UPDATE audit SET detail = detail || ' tampered' WHERE action != 'chain-start'");
}
function truncate(lib) {
  const daily = verifyDaily(sqlOf(lib), SALT, lib.dbId);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  sqlOf(lib).exec('DELETE FROM audit WHERE seq = (SELECT MAX(seq) FROM audit)');
}

test('an empty manager_email staffing row on a tampered chain leaves staffing count 0', async () => {
  const { lib } = open();
  await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  tamper(lib);
  await assert.rejects(() => outreach.routes({
    method: 'POST', parts: ['staffing', 'import'], user: REV, lib,
    body: { csv: `${HEADER}\nPRJ-9,ada@example.test,,,Pilot,2099-01-01\n` },
    url: new URL('https://atlas.example/api/library/staffing/import'),
  }), err => err.status === 409);
  assert.equal(n(lib, 'staffing'), 0);
});

test('a directory part on a tampered chain inserts nothing', async () => {
  const { lib } = open();
  await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  tamper(lib);
  await assert.rejects(() => profile.routes({
    method: 'POST', parts: ['directory', 'import'], user: ADMIN, lib, env: {},
    body: { batch: BATCH, part: 1, final: false, rows: [{ email: 'ada@example.com', name: 'Ada Example' }] },
  }), err => err.status === 409);
  assert.equal(n(lib, 'directory'), 0);
  assert.equal(n(lib, 'directory_imports'), 0);
});

test('MessageWritesBlocked on a tampered chain leaves the conversation active', async () => {
  const { lib } = open();
  const inv = lib.invite('atlas', { email: 'ada@example.test', reason: 'manual', projectId: 'PRJ-1', title: 'Pilot', source: 'test' });
  outreach.queue(lib, { kind: 'interview_invite', subjectId: inv.id, toEmail: 'ada@example.test', preview: { title: 'Pilot', text: 'A short interview.' } });
  const row = lib.rows("SELECT * FROM outreach WHERE channel = 'teams' AND subject_id = ?", inv.id)[0];
  sqlOf(lib).exec(`INSERT INTO teams_conversations (subject, aad_object_id, tenant_id, teams_user_id, conversation_id, service_url, email, status, updated_at)
    VALUES (?, ?, ?, '29:ada', 'a:conv', ?, 'ada@example.test', 'active', ?)`,
    `${TENANT}:${OID}`, OID, TENANT, SERVICE, STAMP);
  let sends = 0;
  lib.services = { teams: { async send() { sends += 1; throw Object.assign(new Error('Teams send: HTTP 403'), { status: 403, code: 'MessageWritesBlocked' }); } } };
  tamper(lib);
  await assert.rejects(() => outreach.routes({
    method: 'POST', parts: ['outreach', row.id], user: REV, lib,
    body: { action: 'approve' }, env: { ORIGIN }, url: new URL(ORIGIN + '/api/library/outreach/' + row.id),
  }), err => err.status === 409);
  assert.equal(lib.rows('SELECT status FROM teams_conversations')[0].status, 'active');
  assert.equal(lib.rows('SELECT status FROM outreach WHERE id = ?', row.id)[0].status, 'pending_approval');
  assert.equal(sends, 0);
});

test('a tail delete after verifyDaily marks the history unverified and the 409 code is TRUNCATED', async () => {
  const { lib } = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  lib.withdraw(OWNER, saved.id, { note: 'pause' });
  truncate(lib);
  const lines = lib.get(OWNER, saved.id).audit.filter(line => line.action !== 'chain-start');
  assert.ok(lines.length >= 1);
  assert.equal(lines.every(line => line.unverified === true), true);
  await assert.rejects(
    () => lib.upsert(OWNER, { id: saved.id, localId: 'p1', reference: { ...REF(), title: 'Revised after the gap' } }),
    err => err.status === 409 && err.code === 'TRUNCATED',
  );
});

test('a hidden-reference dismiss on a tampered chain stays open and writes no audit line', () => {
  const { lib } = open();
  return (async () => {
    const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
    const inv = lib.invite(OWNER.email, { email: 'bea@example.test', reason: 'manual', projectId: 'PRJ-9', title: 'Hidden', source: 'test', referenceId: saved.id, tenant: TENANT }, OWNER);
    assert.equal(lib.access(lib.row(saved.id), BEA), null);
    const before = n(lib, 'audit', "action = 'invitation dismiss'");
    tamper(lib);
    assert.throws(() => lib.updateInvitation(BEA, inv.id, { action: 'dismiss' }), err => err.status === 409);
    assert.equal(lib.rows('SELECT status FROM invitations WHERE id = ?', inv.id)[0].status, 'open');
    assert.equal(n(lib, 'audit', "action = 'invitation dismiss'"), before);
  })();
});

test('a Teams decline of a hidden reference on a tampered chain stays open', async () => {
  const { lib } = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  outreach.ensure(lib);
  sqlOf(lib).exec(`INSERT INTO invitations (id, email, project_id, title, reason, slot, reference_id, status, created_at, source, tenant)
    VALUES ('inv-hidden', 'bea@example.test', 'PRJ-9', 'Hidden', 'manual', '', ?, 'open', ?, 'test', '')`, saved.id, STAMP);
  sqlOf(lib).exec(`INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, reason, payload, aad_object_id, created_at, tenant, directory_tenant, conversation_id)
    VALUES ('out-hidden', 'interview_invite', 'inv-hidden', 'teams', 'bea@example.test', 'sent', '', '{}', ?, ?, '', ?, 'a:conv')`, OID, STAMP, TENANT);
  sqlOf(lib).exec(`INSERT INTO teams_conversations (subject, aad_object_id, tenant_id, teams_user_id, conversation_id, service_url, email, status, updated_at)
    VALUES (?, ?, ?, '29:bea', 'a:conv', ?, 'bea@example.test', 'active', ?)`, `${TENANT}:${OID}`, OID, TENANT, SERVICE, STAMP);
  tamper(lib);
  let statusCode = 200;
  try {
    await outreach.system({
      lib, user: { email: 'teams-bot', role: 'system', tenant: '', tenantEnforced: false }, env: { ORIGIN },
      body: { kind: 'action', activityId: 'dec-hidden', tenantId: TENANT, aadObjectId: OID, serviceUrl: SERVICE, conversationId: 'a:conv', teamsUserId: '29:bea', verb: 'decline', outreachId: 'out-hidden' },
    });
  } catch (err) { statusCode = err.status || 0; }
  const status = lib.rows("SELECT status FROM invitations WHERE id = 'inv-hidden'")[0].status;
  assert.equal(statusCode, 409, status);
  assert.equal(status, 'open');
  assert.equal(n(lib, 'teams_seen'), 0);
});

test('a production Teams message without LOG_SALT is JSON 503 before LIBRARY.get and writes nothing', async () => {
  const sql = memorySql();
  let gets = 0;
  const env = {
    ORIGIN, CSRF_SECRET: 'secret', DATA_MODE: 'production',
    TEAMS_APP_ID: APP, TEAMS_BOT_APP_ID: BOT, TEAMS_TENANT_ID: TEAMS_TID, TEAMS_BOT_SECRET: 'bot-secret',
    ATLAS_SYSTEM_TENANT: ATLAS_TENANT,
    LIBRARY: { idFromName: name => name, get() { gets += 1; return { fetch: () => Promise.resolve(new Response('{}', { status: 500 })) }; } },
  };
  const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', key.publicKey)), kid: 'k1', endorsements: ['msteams'], use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: BOT_ISSUER, aud: BOT, exp: now + 600, nbf: now - 10, serviceurl: SERVICE };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })) + '.' + b64u(JSON.stringify(claims));
  const token = input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, enc.encode(input)));
  const activity = {
    type: 'installationUpdate', action: 'add', id: 'inst-before-get', channelId: 'msteams', serviceUrl: SERVICE,
    from: { id: '29:ada', aadObjectId: OID, name: 'Ada' }, recipient: { id: '28:' + BOT },
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
    const res = await handle(new Request(ORIGIN + '/api/teams/messages', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(activity),
    }), env, '');
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.code, 'LOG_SALT');
    assert.equal(gets, 0);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit'").toArray()[0].n, 0);
  } finally {
    globalThis.fetch = prev;
    resetBotKeyCache();
  }
});

function teamsReady(lib) {
  const inv = lib.invite('atlas', { email: 'ada@example.test', reason: 'manual', projectId: 'PRJ-SEND', title: 'Pilot', source: 'test' });
  outreach.queue(lib, { kind: 'interview_invite', subjectId: inv.id, toEmail: 'ada@example.test', preview: { title: 'Pilot', text: 'A short interview.' } });
  const row = lib.rows("SELECT * FROM outreach WHERE channel = 'teams' AND subject_id = ?", inv.id)[0];
  sqlOf(lib).exec(`INSERT INTO teams_conversations (subject, aad_object_id, tenant_id, teams_user_id, conversation_id, service_url, email, status, updated_at)
    VALUES (?, ?, ?, '29:ada', 'a:send', ?, 'ada@example.test', 'active', ?)`,
    `${TENANT}:${OID}`, OID, TENANT, SERVICE, STAMP);
  return row;
}
function approve(lib, id, action = 'approve') {
  return outreach.routes({
    method: 'POST', parts: ['outreach', id], user: REV, lib, body: { action },
    env: { ORIGIN }, url: new URL(ORIGIN + '/api/library/outreach/' + id),
  });
}

test('a retry after a throw following teams.send does not send twice, and a stale claim stays sending until a reviewer releases it', async () => {
  const { lib } = open();
  const row = teamsReady(lib);
  let sends = 0;
  let boom = true;
  const orig = lib.log.bind(lib);
  lib.log = (...args) => {
    if (boom && args[2] === 'outreach sent') { boom = false; const err = new Error('The sent mark failed.'); err.status = 500; throw err; }
    return orig(...args);
  };
  lib.services = { teams: { async send() { sends += 1; return { id: 'activity-1' }; } } };
  await approve(lib, row.id).catch(err => err);
  assert.equal(sends, 1);
  assert.equal(lib.rows('SELECT status FROM outreach WHERE id = ?', row.id)[0].status, 'sending');
  await approve(lib, row.id).catch(err => err);
  assert.equal(sends, 1);
  assert.equal(lib.rows('SELECT status FROM outreach WHERE id = ?', row.id)[0].status, 'sending');
  const released = await approve(lib, row.id, 'release');
  assert.equal(released.body.item.status, 'failed');
  assert.equal(sends, 1);
  const again = await approve(lib, row.id);
  assert.equal(again.body.item.status, 'sent');
  assert.equal(sends, 2);
});

test('concurrent Teams retries send once', async () => {
  const sql = memorySql();
  let sends = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const teams = { async send() { sends += 1; await gate; return { id: 'activity-' + sends }; } };
  const first = new Library(sql, { now: () => STAMP, auditKey: SALT, services: { teams } });
  const row = teamsReady(first);
  const second = new Library(sql, { now: () => STAMP, auditKey: SALT, services: { teams } });
  const pending = Promise.allSettled([approve(first, row.id), approve(second, row.id)]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sends, 1);
  release();
  await pending;
  assert.equal(sends, 1);
  assert.equal(sql.exec('SELECT status FROM outreach WHERE id = ?', row.id).toArray()[0].status, 'sent');
});
