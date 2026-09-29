// F4.3 Teams bot endpoint, BUILT, NOT CONNECTED (WOW_SPEC §F4.8 acceptance 4, 5, 7; §F4.9). Real RSA keys from
// crypto.subtle; fake OpenID metadata, JWKS (with endorsements), token and connector fetchers. No network, ever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { teamsStatus, teamsClient, verifyBotActivity, interviewCard, messageCard, resetBotKeyCache, OPENID_URL, BOT_ISSUER } from '../src/teams.js';
import { teamsRoutes, TAB_CSP, eventOf } from '../src/teams-routes.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';

const ORIGIN = 'https://atlas.example', JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const TID = '11111111-2222-3333-4444-555555555555', OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', BOTID = '22222222-3333-4444-5555-666666666666';
const ENV = { ORIGIN, TEAMS_ENABLED: '1', TEAMS_APP_ID: '33333333-4444-5555-6666-777777777777', TEAMS_BOT_APP_ID: BOTID, TEAMS_TENANT_ID: TID };
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const T0 = Date.parse('2026-09-29T08:00:00Z');
const enc = new TextEncoder(), b64u = b => Buffer.from(b).toString('base64url');

const pair = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const KEY = await pair(), ROGUE = await pair();
const jwk = async (k, kid, endorsements = ['msteams']) => ({ ...(await crypto.subtle.exportKey('jwk', k.publicKey)), kid, endorsements, use: 'sig' });
const KEYS = [await jwk(KEY, 'k1'), await jwk(ROGUE, 'webchat-only', ['webchat'])];
async function sign(payload, { key = KEY, kid = 'k1', alg = 'RS256' } = {}) {
  const input = b64u(JSON.stringify({ alg, kid, typ: 'JWT' })) + '.' + b64u(JSON.stringify(payload));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, enc.encode(input)));
}
const claims = (extra = {}) => ({ iss: BOT_ISSUER, aud: BOTID, exp: T0 / 1000 + 600, nbf: T0 / 1000 - 10, serviceurl: SERVICE, ...extra });
const activity = (extra = {}) => ({ type: 'message', id: 'act-1', channelId: 'msteams', serviceUrl: SERVICE, text: 'stop',
  from: { id: '29:alex', aadObjectId: OID, name: 'Alex' }, recipient: { id: '28:' + BOTID }, conversation: { id: 'a:conv-alex', conversationType: 'personal', tenantId: TID },
  channelData: { tenant: { id: TID } }, ...extra });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function botFetcher(keys = KEYS) {
  const f = async url => { f.calls.push(String(url)); return String(url) === OPENID_URL ? json({ issuer: BOT_ISSUER, jwks_uri: JWKS_URL }) : String(url) === JWKS_URL ? json({ keys }) : json({}, 404); };
  f.calls = [];
  return f;
}
const request = (token, body) => new Request(ORIGIN + '/api/teams/messages', { method: 'POST', headers: token === null ? {} : { Authorization: 'Bearer ' + token }, body });
async function verify({ payload = claims(), act = activity(), env = ENV, fetcher = botFetcher(), now = T0, opts = {}, body } = {}) {
  const text = body ?? JSON.stringify(act);
  return verifyBotActivity(request(await sign(payload, opts), text), text, env, fetcher, { now });
}

test('verifyBotActivity: a valid Bot Framework token for a Teams activity to this bot in this tenant is accepted', async () => {
  resetBotKeyCache();
  const r = await verify();
  assert.deepEqual([r.ok, r.status, r.activity.id, r.claims.aud], [true, 200, 'act-1', BOTID]);
  assert.equal((await verify({ payload: claims({ exp: T0 / 1000 - 299 }) })).ok, true, '300 s skew on exp');
  assert.equal((await verify({ payload: claims({ nbf: T0 / 1000 + 299 }) })).ok, true, '300 s skew on nbf');
  assert.equal((await verify({ payload: claims({ aud: [BOTID, 'other'] }) })).ok, true);
  assert.equal((await verify({ act: activity({ channelData: {}, conversation: { id: 'c', conversationType: 'personal', tenantId: TID } }) })).ok, true, 'conversation.tenantId fallback');
});

test('verifyBotActivity: every rejection case of §F4.8 (401 token, 401 serviceUrl, 403 channel/endorsement/recipient/tenant, 413)', async () => {
  resetBotKeyCache();
  const code = async args => { const r = await verify(args); assert.equal(r.ok, false); return r.status; };
  assert.equal(await code({ payload: claims({ aud: 'someone-else' }) }), 401, 'wrong aud');
  assert.equal(await code({ payload: claims({ iss: 'https://sts.windows.net/' + TID + '/' }) }), 401, 'Entra first-party issuers are not accepted (Q5)');
  assert.equal(await code({ payload: claims({ iss: 'https://api.botframework.com/' }) }), 401, 'exact issuer only');
  assert.equal(await code({ payload: claims({ exp: T0 / 1000 - 301 }) }), 401, 'expired');
  assert.equal(await code({ payload: claims({ exp: undefined }) }), 401, 'exp required');
  assert.equal(await code({ payload: claims({ nbf: T0 / 1000 + 301 }) }), 401, 'not yet valid');
  assert.equal(await code({ opts: { key: ROGUE } }), 401, 'bad signature (signed by another key under kid k1)');
  assert.equal(await code({ opts: { alg: 'HS256' } }), 401, 'RS256 only');
  const text = JSON.stringify(activity());
  assert.equal((await verifyBotActivity(request(null, text), text, ENV, botFetcher(), { now: T0 })).status, 401, 'no bearer');
  assert.equal((await verifyBotActivity(request('a.b', text), text, ENV, botFetcher(), { now: T0 })).status, 401, 'malformed');
  assert.equal(await code({ payload: claims({ serviceurl: 'https://smba.trafficmanager.net/amer/' }) }), 401, 'serviceUrl claim mismatch');
  assert.equal(await code({ payload: claims({ serviceurl: undefined }) }), 401, 'serviceUrl claim missing');
  const evil = 'https://evil.example/teams/';
  assert.equal(await code({ payload: claims({ serviceurl: evil }), act: activity({ serviceUrl: evil }) }), 401, 'host not on the allow-list');
  assert.equal((await verify({ payload: claims({ serviceurl: evil }), act: activity({ serviceUrl: evil }), env: { ...ENV, TEAMS_SERVICE_HOSTS: 'evil.example' } })).ok, true, 'the allow-list is extendable by config');
  assert.equal(await code({ act: activity({ channelId: 'webchat' }) }), 403, 'msteams channel only');
  assert.equal(await code({ opts: { key: ROGUE, kid: 'webchat-only' } }), 403, 'a key without the msteams endorsement');
  assert.equal(await code({ act: activity({ recipient: { id: '28:another-bot' } }) }), 403, 'recipient must be 28:<botId>');
  assert.equal(await code({ act: activity({ channelData: { tenant: { id: '99999999-2222-3333-4444-555555555555' } } }) }), 403, 'wrong tenant');
  const big = JSON.stringify(activity({ text: 'x'.repeat(262200) }));
  assert.equal((await verify({ body: big })).status, 413);
  assert.equal((await verify({ body: '{nope' })).status, 400);
  assert.equal((await verify({ env: { ...ENV, TEAMS_BOT_APP_ID: '' } })).status, 503);
});

test('JWKS cache: 24 h, and an unknown kid refetches at most once per 5 minutes; no keys at all gives 503', async () => {
  resetBotKeyCache();
  const f = botFetcher();
  assert.equal((await verify({ fetcher: f })).ok, true);
  assert.deepEqual(f.calls, [OPENID_URL, JWKS_URL]);
  assert.equal((await verify({ fetcher: f, now: T0 + 60e3 })).ok, true); assert.equal(f.calls.length, 2, 'cached');
  assert.equal((await verify({ fetcher: f, now: T0 + 6 * 60e3, opts: { kid: 'unknown-1' } })).status, 401);
  assert.equal(f.calls.length, 4, 'one refetch for an unknown kid');
  for (const [i, dt] of [[2, 7], [3, 9], [4, 10.9]]) assert.equal((await verify({ fetcher: f, now: T0 + dt * 60e3, opts: { kid: 'unknown-' + i } })).status, 401);
  assert.equal(f.calls.length, 4, 'no second refetch within 5 minutes, whatever the kid');
  await verify({ fetcher: f, now: T0 + 11.1 * 60e3, opts: { kid: 'unknown-5' } });
  assert.equal(f.calls.length, 6, 'the next refetch after 5 minutes');
  assert.equal((await verify({ fetcher: f, now: T0 + 12 * 60e3 })).ok, true); assert.equal(f.calls.length, 6, 'known kid: no fetch');
  assert.equal((await verify({ fetcher: f, now: T0 + 25 * 3600e3, payload: claims({ exp: (T0 + 25 * 3600e3) / 1000 + 60 }) })).ok, true);
  assert.equal(f.calls.length, 8, 'refreshed after 24 h');
  resetBotKeyCache();
  const down = async url => { down.n = (down.n || 0) + 1; throw new Error('offline ' + url); };
  assert.equal((await verify({ fetcher: down })).status, 503);
  assert.equal((await verify({ fetcher: down, now: T0 + 60e3 })).status, 503); assert.equal(down.n, 1, 'a failing fetch is throttled too');
  resetBotKeyCache();
  const badHost = async url => String(url) === OPENID_URL ? json({ jwks_uri: 'https://evil.example/keys' }) : json({ keys: KEYS });
  assert.equal((await verify({ fetcher: badHost })).status, 503, 'the JWKS must come from botframework.com');
});

test('teamsStatus: connected only with TEAMS_ENABLED=1, every id and the bot secret', () => {
  assert.equal(teamsStatus({}), 'BLOCKED_EXTERNAL');
  assert.equal(teamsStatus(ENV), 'BLOCKED_EXTERNAL', 'no secret');
  assert.equal(teamsStatus({ ...ENV, TEAMS_BOT_SECRET: 's' }), 'connected');
  for (const k of ['TEAMS_APP_ID', 'TEAMS_BOT_APP_ID', 'TEAMS_TENANT_ID']) assert.equal(teamsStatus({ ...ENV, TEAMS_BOT_SECRET: 's', [k]: '' }), 'BLOCKED_EXTERNAL', k);
  assert.equal(teamsStatus({ ...ENV, TEAMS_BOT_SECRET: 's', TEAMS_ENABLED: 'true' }), 'BLOCKED_EXTERNAL');
});

test('interviewCard: Adaptive Card 1.5, OpenUrl to #invitation/<id> within 2,048 characters, Execute verbs carry only the outreach id', () => {
  const id = 'a'.repeat(32), card = interviewCard({ invitationId: id, outreachId: 'o1', projectRef: 'PRJ-9', approverName: 'rev@mantu.com', origin: ORIGIN });
  assert.deepEqual([card.type, card.version, card.body[0].text], ['AdaptiveCard', '1.5', "12 minutes while it's fresh?"]);
  assert.deepEqual(card.actions, [{ type: 'Action.OpenUrl', title: 'Start now', url: `${ORIGIN}/#invitation/${id}` },
    { type: 'Action.Execute', title: 'Tomorrow', verb: 'snooze', data: { outreachId: 'o1' } }, { type: 'Action.Execute', title: 'Not for this project', verb: 'decline', data: { outreachId: 'o1' } }]);
  assert.match(JSON.stringify(card.body), /PRJ-9/);
  const long = interviewCard({ invitationId: id, outreachId: 'o1', origin: 'https://' + 'x'.repeat(2040) + '.example' });
  assert.ok(long.actions.every(a => !a.url || a.url.length <= 2048), 'never a link over 2,048 characters');
  assert.deepEqual(long.actions.map(a => a.type), ['Action.Execute', 'Action.Execute']);
  assert.equal(interviewCard({ invitationId: '../etc', outreachId: 'o', origin: ORIGIN }).actions[0].url, ORIGIN + '/', 'only a 32-hex id reaches the hash');
  assert.equal(interviewCard({ invitationId: id, origin: 'javascript:alert(1)' }).actions[0].type, 'Action.Execute', 'no link without an http(s) origin');
  assert.equal(interviewCard({ projectRef: 'x'.repeat(300) }).body[1].text.length < 200, true, 'bounded text');
  assert.deepEqual(messageCard({ title: 'T', text: 'x', url: 'javascript:alert(1)' }).actions, undefined);
});

test('teamsClient: null unless connected; tenant token cached until exp - 300 s; retries 429/412/502/504 at most twice', async () => {
  assert.equal(teamsClient(ENV), null);
  const env = { ...ENV, TEAMS_BOT_SECRET: 'secret-value' }, log = [], slept = [];
  let clock = T0, sendStatus = [200];
  const fetcher = async (url, init = {}) => {
    log.push({ url: String(url), init });
    if (String(url).startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'tok-' + log.length, expires_in: 3600, token_type: 'Bearer' });
    const s = sendStatus.shift() ?? 200;
    return s === 200 ? json({ id: 'sent-1' }) : json({ error: { code: s === 403 ? 'MessageWritesBlocked' : 'Busy' } }, s, s === 429 ? { 'Retry-After': '2' } : {});
  };
  const c = teamsClient(env, fetcher, { now: () => clock, sleep: async ms => { slept.push(ms); } });
  const ref = { serviceUrl: SERVICE, conversationId: 'a:conv-alex' };
  assert.deepEqual(await c.send(ref, { type: 'message' }), { id: 'sent-1' });
  assert.equal(log[0].url, `https://login.microsoftonline.com/${TID}/oauth2/v2.0/token`);
  const form = new URLSearchParams(log[0].init.body);
  assert.deepEqual([form.get('grant_type'), form.get('client_id'), form.get('client_secret'), form.get('scope')], ['client_credentials', BOTID, 'secret-value', 'https://api.botframework.com/.default']);
  assert.equal(log[1].url, SERVICE + 'v3/conversations/a%3Aconv-alex/activities');
  assert.equal(log[1].init.headers.Authorization, 'Bearer tok-1'); assert.equal(log[1].init.redirect, 'manual');
  await c.send(ref, { type: 'message' });
  assert.equal(log.filter(x => x.url.includes('login.microsoftonline.com')).length, 1, 'token cached');
  clock = T0 + 3301e3;
  await c.send(ref, { type: 'message' });
  assert.equal(log.filter(x => x.url.includes('login.microsoftonline.com')).length, 2, 'refreshed after exp - 300 s');
  log.length = 0; sendStatus = [429, 502, 200];
  assert.deepEqual(await c.send(ref, { type: 'message' }), { id: 'sent-1' });
  assert.equal(log.length, 3); assert.deepEqual(slept, [2000, 1000], 'Retry-After honoured, then backoff');
  log.length = 0; sendStatus = [504, 412, 429, 200];
  await assert.rejects(c.send(ref, { type: 'message' }), e => e.status === 429);
  assert.equal(log.length, 3, 'at most two retries');
  log.length = 0; sendStatus = [500];
  await assert.rejects(c.send(ref, { type: 'message' }), e => e.status === 500); assert.equal(log.length, 1, '500 is not retried');
  sendStatus = [403];
  await assert.rejects(c.send(ref, { type: 'message' }), e => e.status === 403 && e.code === 'MessageWritesBlocked');
  log.length = 0;
  await assert.rejects(c.send({ serviceUrl: 'https://evil.example/', conversationId: 'x' }, {}), e => e.status === 400);
  await assert.rejects(c.send({ serviceUrl: 'http://smba.trafficmanager.net/', conversationId: 'x' }, {}), e => e.status === 400);
  assert.equal(log.length, 0, 'a disallowed serviceUrl is refused before any request');
});

// ---- teamsRoutes: the pre-Access endpoint and the launcher.
function stack(env = ENV) {
  const lib = new Library(memorySql(), { now: () => new Date(T0).toISOString() }), seen = [];
  const LIBRARY = { idFromName: n => n, get: () => ({ fetch: async r => { seen.push({ path: new URL(r.url).pathname, user: r.headers.get('x-atlas-user'), role: r.headers.get('x-atlas-role') }); return libraryRoutes(r, lib, { env: { ORIGIN } }); } }) };
  return { lib, seen, env: { ...env, LIBRARY } };
}
const live = () => claims({ exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) - 10 }); // teamsRoutes verifies with the real clock
const post = async (env, act, fetcher = botFetcher(), payload = live()) => teamsRoutes(new Request(ORIGIN + '/api/teams/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + await sign(payload) }, body: JSON.stringify(act) }), env, {}, { fetcher });
const SECURE = r => { assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.ok(r.headers.get('content-security-policy')); };

test('teamsRoutes: 503 BLOCKED_EXTERNAL unless TEAMS_ENABLED=1 and the three ids are set; nothing is read or forwarded', async () => {
  const { env, seen } = stack();
  for (const bad of [{}, { ...env, TEAMS_ENABLED: '0' }, { ...env, TEAMS_APP_ID: '' }, { ...env, TEAMS_BOT_APP_ID: '' }, { ...env, TEAMS_TENANT_ID: '' }]) {
    for (const r of [await teamsRoutes(new Request(ORIGIN + '/api/teams/messages', { method: 'POST', body: '{}' }), bad), await teamsRoutes(new Request(ORIGIN + '/teams/tab'), bad)]) {
      assert.equal(r.status, 503); SECURE(r);
      const b = await r.json(); assert.equal(b.status, 'BLOCKED_EXTERNAL'); assert.ok(b.reason && b.needs.includes('TEAMS_ENABLED=1'));
    }
  }
  assert.equal(seen.length, 0);
});

test('teamsRoutes messages: verified events reach the LibraryStore as teams-event (system, teams-bot); duplicates are processed once', async () => {
  resetBotKeyCache();
  const { env, seen, lib } = stack();
  const bad = await teamsRoutes(new Request(ORIGIN + '/api/teams/messages', { method: 'POST', headers: { Authorization: 'Bearer x.y.z' }, body: '{}' }), env, {}, { fetcher: botFetcher() });
  assert.equal(bad.status, 401); SECURE(bad); assert.equal(seen.length, 0);
  const installAct = activity({ type: 'installationUpdate', action: 'add', id: 'inst-1', text: undefined });
  const r = await post(env, installAct);
  assert.deepEqual([r.status, await r.json()], [200, {}]); SECURE(r);
  assert.deepEqual(seen, [{ path: '/api/library/teams-event', user: 'teams-bot', role: 'system' }]);
  assert.deepEqual(lib.rows('SELECT subject, conversation_id, service_url, email, status FROM teams_conversations'),
    [{ subject: `${TID}:${OID}`, conversation_id: 'a:conv-alex', service_url: SERVICE, email: '', status: 'active' }], 'no secret: no member lookup, no email');
  await post(env, installAct);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM teams_seen')[0].n, 1, 'duplicate activity processed once');
  const stop = await post(env, activity({ id: 'stop-1', text: '<at>ATLAS</at> Stop ' }));
  assert.equal(stop.status, 200); assert.equal(lib.rows('SELECT status FROM teams_conversations')[0].status, 'stopped');
  const before = seen.length;
  for (const a of [activity({ id: 'm2', text: 'help' }), activity({ id: 'g1', conversation: { id: 'g', conversationType: 'groupChat', tenantId: TID } }), activity({ id: 'e1', type: 'event' })]) {
    const x = await post(env, a); assert.deepEqual([x.status, await x.json()], [200, {}]);
  }
  assert.equal(seen.length, before, 'help, group chats and other activities are not forwarded; the bot never replies');
  // With the bot secret, install looks the member up (routing email only), through the fake connector.
  resetBotKeyCache();
  const s2 = stack({ ...ENV, TEAMS_BOT_SECRET: 's' }), f = botFetcher(), connector = async (url, init) => String(url).startsWith('https://login.microsoftonline.com/')
    ? json({ access_token: 't', expires_in: 3600 }) : String(url) === SERVICE + 'v3/conversations/a%3Aconv-alex/members/29%3Aalex' ? json({ email: 'Alex@Mantu.com', userPrincipalName: 'alex@mantu.com' }) : f(url, init);
  await post(s2.env, installAct, connector);
  assert.equal(s2.lib.rows('SELECT email FROM teams_conversations')[0].email, 'alex@mantu.com');
});

test('teamsRoutes invoke: the card action is answered in the HTTP 200 invoke response; others get "belongs to someone else"', async () => {
  resetBotKeyCache();
  const { env, lib } = stack();
  await post(env, activity({ type: 'installationUpdate', action: 'add', id: 'inst-1' }));
  const inv = lib.invite('pm-system', { email: 'alex@mantu.com', reason: 'project_end', projectId: 'PRJ-9', slot: '2026-10-01T09:30' });
  lib.sql.exec(`INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, reason, payload, aad_object_id, created_at) VALUES ('o1', 'interview_invite', ?, 'teams', 'alex@mantu.com', 'sent', '', '{"preview":{"title":"PRJ-9"}}', ?, 'x')`, inv.id, OID);
  const invoke = (id, extra = {}) => activity({ type: 'invoke', name: 'adaptiveCard/action', id, text: undefined, value: { action: { type: 'Action.Execute', verb: 'snooze', data: { outreachId: 'o1' } } }, ...extra });
  const other = await post(env, invoke('i1', { from: { id: '29:kim', aadObjectId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff' } }));
  const ob = await other.json();
  assert.deepEqual([other.status, ob.statusCode, ob.type, ob.value.body[0].text], [200, 200, 'application/vnd.microsoft.card.adaptive', 'This card belongs to someone else.']);
  assert.equal(lib.rows('SELECT slot FROM invitations')[0].slot, '2026-10-01T09:30');
  const mine = await (await post(env, invoke('i2'))).json();
  assert.equal(mine.value.body[0].text, "12 minutes while it's fresh?");
  assert.equal(lib.rows('SELECT slot FROM invitations')[0].slot, '2026-10-02T09:30');
  const dup = await (await post(env, invoke('i2'))).json();
  assert.deepEqual([dup.statusCode, dup.value.body[0].text], [200, 'Already recorded.']);
  assert.equal(lib.rows('SELECT slot FROM invitations')[0].slot, '2026-10-02T09:30', 'a retried invoke changes nothing');
  assert.equal(eventOf(invoke('i3'), ENV).subject, `${TID}:${OID}`);
});

test('teamsRoutes tab: the launcher with its route-specific CSP when TeamsJS is vendored; 503 "TeamsJS not vendored" otherwise', async () => {
  const js = 'window.microsoftTeams={app:{initialize:function(){return Promise.resolve()},openLink:function(){return Promise.resolve()}}};';
  const r = await teamsRoutes(new Request(ORIGIN + '/teams/tab'), ENV, {}, { teamsJs: js });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('content-security-policy'), TAB_CSP);
  assert.match(TAB_CSP, /frame-ancestors https:\/\/teams\.microsoft\.com https:\/\/\*\.teams\.microsoft\.com https:\/\/\*\.cloud\.microsoft$/);
  assert.match(TAB_CSP, /^default-src 'none'; script-src 'unsafe-inline';/);
  assert.equal(r.headers.get('x-frame-options'), null);
  const html = await r.text();
  assert.doesNotMatch(html, /<script[^>]+src|fetch\(|XMLHttpRequest|\/api\//, 'no external script and no API call');
  assert.ok(html.includes(js)); assert.match(html, /Open ATLAS/); assert.match(html, /microsoftTeams\.app\.initialize\(\)/); assert.match(html, /app\.openLink\(target\)/);
  assert.ok(html.includes(JSON.stringify(ORIGIN + '/')));
  const none = await teamsRoutes(new Request(ORIGIN + '/teams/tab'), ENV, {}, { teamsJs: '' });
  assert.equal(none.status, 503); SECURE(none);
  const b = await none.json(); assert.deepEqual([b.error, b.status], ['TeamsJS not vendored', 'BLOCKED_EXTERNAL']);
  assert.equal((await teamsRoutes(new Request(ORIGIN + '/teams/other'), ENV)).status, 404);
});

test('vendored TeamsJS: @microsoft/teams-js 2.57.0 embedded byte for byte (pinned SHA-256); the launcher serves it inline', async () => {
  const { TEAMS_JS, TEAMS_JS_VERSION, TEAMS_JS_SHA256 } = await import('../teams/vendor/teams-js.mjs');
  assert.equal(TEAMS_JS_VERSION, '2.57.0');
  assert.equal(TEAMS_JS_SHA256, 'ee3403839e47f1338e6f6f8becdd4456ced589eca5a909b8e58ce31ff78cf068');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(TEAMS_JS)))].map(b => b.toString(16).padStart(2, '0')).join('');
  assert.equal(digest, TEAMS_JS_SHA256, 'the embedded string is the pinned file');
  assert.doesNotMatch(TEAMS_JS, /<\/script|<!--/i, 'safe to inline');
  const r = await teamsRoutes(new Request(ORIGIN + '/teams/tab'), ENV);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-security-policy'), TAB_CSP);
  const html = await r.text(), scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 2); assert.equal(scripts[0], TEAMS_JS);
  assert.doesNotMatch(scripts[1], /fetch\(|XMLHttpRequest|\/api\//, 'the launcher itself calls no API');
  assert.doesNotMatch(html, /<script[^>]+src/);
});
