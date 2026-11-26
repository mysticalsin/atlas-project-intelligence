// A Teams service URL is a base. A query or a fragment is not part of that base.
// Appending the activities path must not land in the query or the fragment.
// Synthetic hosts only. No network, no Bot Framework call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { teamsClient, verifyBotActivity, resetBotKeyCache, OPENID_URL, BOT_ISSUER } from '../src/teams.js';

const TID = '11111111-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BOTID = '22222222-3333-4444-5555-666666666666';
const APPID = '33333333-4444-5555-6666-777777777777';
const ENV = { TEAMS_APP_ID: APPID, TEAMS_BOT_APP_ID: BOTID, TEAMS_TENANT_ID: TID, TEAMS_BOT_SECRET: 'synthetic-secret' };
const HOST = 'https://smba.trafficmanager.net/emea';
const T0 = Date.parse('2026-09-29T08:00:00Z');
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const enc = new TextEncoder();
const b64u = bytes => Buffer.from(bytes).toString('base64url');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client() {
  const log = [];
  const fetcher = async (url) => {
    log.push(String(url));
    if (String(url).startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'synthetic-token', expires_in: 3600 });
    return json({ id: 'sent-1' });
  };
  return { log, api: teamsClient(ENV, fetcher, { now: () => T0, sleep: async () => {} }) };
}

test('a plain service URL posts to the activities path', async () => {
  const { log, api } = client();
  const sent = await api.send({ serviceUrl: HOST, conversationId: 'a:conv-synthetic' }, { type: 'message' });
  assert.equal(sent.id, 'sent-1');
  assert.equal(log[1], HOST + '/v3/conversations/a%3Aconv-synthetic/activities');
});

test('a query or a fragment does not receive the activities path', async () => {
  for (const serviceUrl of [HOST + '?x=1', HOST + '#frag', HOST + '?', HOST + '#', HOST + '/?x=1']) {
    const { log, api } = client();
    await assert.rejects(
      api.send({ serviceUrl, conversationId: 'a:conv-synthetic' }, { type: 'message' }),
      error => error.status === 400,
      serviceUrl,
    );
    assert.deepEqual(log, [], serviceUrl);
  }
});

test('an activity whose service URL has a query is not accepted', async () => {
  resetBotKeyCache();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', endorsements: ['msteams'], use: 'sig' };
  const serviceUrl = HOST + '?x=1';
  const payload = { iss: BOT_ISSUER, aud: BOTID, exp: T0 / 1000 + 600, nbf: T0 / 1000 - 10, serviceurl: serviceUrl };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })) + '.' + b64u(JSON.stringify(payload));
  const token = input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(input)));
  const activity = {
    type: 'message', id: 'act-1', channelId: 'msteams', serviceUrl, text: 'stop',
    from: { id: '29:alex', aadObjectId: OID }, recipient: { id: '28:' + BOTID },
    conversation: { id: 'a:conv-synthetic', conversationType: 'personal', tenantId: TID },
    channelData: { tenant: { id: TID } },
  };
  const text = JSON.stringify(activity);
  const fetcher = async (url) => String(url) === OPENID_URL ? json({ issuer: BOT_ISSUER, jwks_uri: JWKS_URL }) : json({ keys: [jwk] });
  const request = new Request('https://atlas.example/api/teams/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: text });
  const result = await verifyBotActivity(request, text, ENV, fetcher, { now: T0 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});
