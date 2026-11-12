import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, verifyAccess, workersAI } from '../src/app.js';

const TEAM = 'team.cloudflareaccess.com', AUD = 'aud-123', ORIGIN = 'https://atlas.example.workers.dev';
const b64u = b => Buffer.from(b).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
globalThis.fetch = async url => { assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys: [jwk] })); };
async function jwt(claims = {}, header = { alg: 'RS256', kid: 'k1' }) {
  const now = Math.floor(Date.now() / 1000), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'user-abc', email: 'tony@example.com', exp: now + 600, iat: now, ...claims };
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}
const ENV = { ORIGIN, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, CSRF_SECRET: 'test-secret', TALKER_MODEL: 'talker', TTS_VOICE: 'harmonia',
  ATLAS_ADMIN_ROLES: 'ATLAS.Admin', ATLAS_PRESALES_ROLES: 'ATLAS.Presales,ATLAS.Publish', ATLAS_REVIEWER_ROLES: 'ATLAS.Reviewer,ATLAS.Review' };
const req = async (path, { token, headers = {}, host = ORIGIN } = {}) => new Request(host + path, { headers: { ...(token === undefined ? { 'cf-access-jwt-assertion': await jwt() } : token ? { 'cf-access-jwt-assertion': token } : {}), ...headers } });

test('Access JWT verification accepts only valid, correctly scoped tokens', async () => {
  const ok = await verifyAccess(await req('/'), ENV);
  assert.deepEqual(ok, { sub: 'user-abc', email: 'tony@example.com', roles: [] });
  for (const bad of [await jwt({ aud: ['other'] }), await jwt({ exp: 1 }), await jwt({ iss: 'https://evil.example' }), await jwt({ sub: '' }),
    (await jwt()).slice(0, -4) + 'AAAA', await jwt({}, { alg: 'none', kid: 'k1' }), await jwt({}, { alg: 'RS256', kid: 'unknown' })])
    assert.equal(await verifyAccess(await req('/', { token: bad }), ENV), null);
  assert.equal(await verifyAccess(await req('/', { token: null }), ENV), null);
  assert.equal(await verifyAccess(await req('/'), { ...ENV, ACCESS_AUD: '' }), null);
});

test('routes fail closed and serve the real page with runtime + CSP', async () => {
  const page = "<meta http-equiv=x content=\"connect-src 'self';\"><script id=\"atlas-runtime\" type=\"application/json\">{}</script><script>/* page */</script></body>";
  assert.equal((await handle(await req('/', { token: null }), ENV, page)).status, 401);
  assert.equal((await handle(await req('/', { host: 'https://evil.example' }), ENV, page)).status, 403);
  assert.equal((await handle(await req('/'), { ...ENV, CSRF_SECRET: '' }, page)).status, 500);
  const r = await handle(await req('/'), ENV, page), html = await r.text();
  assert.equal(r.status, 200); assert.equal(html.includes('window.ATLAS_RUNTIME='), false);
  const runtime = JSON.parse(/<script id="atlas-runtime" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(typeof runtime.subjectKey, 'string'); assert.ok(runtime.subjectKey.length > 0); assert.equal(runtime.authMode, 'access');
  assert.ok(html.includes("connect-src 'self' wss://atlas.example.workers.dev;") && html.includes('SYNTHETIC DATA ONLY'));
  assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'") && r.headers.get('cache-control') === 'no-store');
  const boot = await (await handle(await req('/api/bootstrap'), ENV, page)).json();
  assert.equal(boot.provider, 'workers'); assert.equal(boot.csrf.length, 64); assert.equal(boot.identity.mode, 'access');
  assert.equal((await handle(await req('/api/wiki'), ENV, page)).status, 404);
});

test('voice upgrade: origin enforced, CSRF injected by the Worker, one DO per person', async () => {
  let forwarded = null, name = null;
  const env = { ...ENV, ATLAS_TENANT_ISOLATION: 'local-synthetic', INTERVIEW: { idFromName: n => { name = n; return 'id'; }, get: () => ({ fetch: r => { forwarded = r; return new Response('ok'); } }) } };
  assert.equal((await handle(await req('/api/voice'), env, '')).status, 426);
  assert.equal((await handle(await req('/api/voice', { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }), env, '')).status, 403);
  const boot = await (await handle(await req('/api/bootstrap'), ENV, '')).json();
  await handle(await req('/api/voice', { headers: { Upgrade: 'websocket', Origin: ORIGIN, 'x-atlas-csrf': 'spoofed' } }), env, '');
  assert.equal(name, 'user-abc'); assert.equal(forwarded.headers.get('x-atlas-csrf'), boot.csrf);
});

test('Workers AI adapters parse both response shapes', async () => {
  const sse = ['data: {"response":"Hel"}\n\ndata: {"choi', 'ces":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'];
  const env = { STT_MODEL: 'stt', TTS_MODEL: 'tts', TTS_VOICE: 'asteria', TALKER_MODEL: 't', ANALYST_MODEL: 'a', AI: { async run(model, input) {
    if (model === 'stt') { assert.equal(input.audio.contentType, 'audio/wav'); const wavBytes = new Uint8Array(await new Response(input.audio.body).arrayBuffer()); assert.equal(String.fromCharCode(...wavBytes.slice(0, 4)), 'RIFF'); return { results: { channels: [{ alternatives: [{ transcript: 'hello there' }] }] } }; }
    if (model === 'tts') { assert.deepEqual(input, { text: 'Hi.', speaker: 'asteria', encoding: 'linear16', container: 'none', sample_rate: 24000 }); return new Response(new Uint8Array(5)).body; }
    if (model === 't') return new ReadableStream({ start(c) { for (const s of sse) c.enqueue(new TextEncoder().encode(s)); c.close(); } });
    return input.messages[0].content === 'native' ? { tool_calls: [{ name: 'record_details', arguments: { details: [] } }] }
      : { choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'record_details', arguments: '{"details":[]}' } }] } }] };
  } } };
  const ai = workersAI(env);
  assert.deepEqual(await ai.transcribe(new Uint8Array(4)), { text: 'hello there', language: null });
  assert.equal((await ai.synthesize('Hi.')).length, 4);
  const got = []; for await (const d of ai.chatStream([])) got.push(d); assert.deepEqual(got, ['Hel', 'lo']);
  assert.deepEqual(await ai.analyst([{ content: 'x' }]), [{ id: 'x', name: 'record_details', arguments: '{"details":[]}' }]);
  assert.deepEqual(await ai.analyst([{ content: 'native' }]), [{ id: 'call-0', name: 'record_details', arguments: '{"details":[]}' }]);
});

test('test-voice endpoint is off unless TEST_VOICE=1 and always behind Access', async () => {
  const env = { ...ENV, TTS_MODEL: 'tts', AI: { async run(model, input) { assert.equal(input.speaker, 'orion'); return new Uint8Array(8); } } };
  assert.equal((await handle(await req('/api/test-voice?text=hi'), env, '')).status, 404);
  assert.equal((await handle(await req('/api/test-voice?text=hi', { token: null }), { ...env, TEST_VOICE: '1' }, '')).status, 401);
  const r = await handle(await req('/api/test-voice?text=hi'), { ...env, TEST_VOICE: '1' }, '');
  assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, 8);
  assert.equal((await handle(await req('/api/test-voice?text=hi&speaker=../x'), { ...env, TEST_VOICE: '1' }, '')).status, 400);
});

test('Entra (Windows / Microsoft 365) identity path: off by default, strict when enabled', async () => {
  const { entraIdentity } = await import('../src/app.js');
  const T = '11111111-2222-3333-4444-555555555555', O = '66666666-7777-8888-9999-000000000000';
  const env = { ...ENV, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: T, ENTRA_REQUIRED_ROLE: 'ATLAS.Interview' };
  const tok = custom => jwt({ custom });
  // Off by default: the normal Access identity is used and no Entra claims are needed.
  assert.equal((await verifyAccess(await req('/'), ENV)).sub, 'user-abc');
  assert.equal(entraIdentity({ custom: { tid: T, oid: O } }, ENV), null);
  // Enabled: tenant allow-list, UUID claims and the app role are all required.
  const ok = await verifyAccess(await req('/', { token: await tok({ tid: T, oid: O, roles: ['ATLAS.Interview'] }) }), env);
  assert.deepEqual(ok, { sub: `${T}:${O}`, email: 'tony@example.com', roles: ['ATLAS.Interview'] });
  for (const custom of [{ tid: '99999999-2222-3333-4444-555555555555', oid: O, roles: ['ATLAS.Interview'] }, { tid: T, oid: 'x', roles: ['ATLAS.Interview'] }, { tid: T, oid: O, roles: [] }, {}])
    assert.equal(await verifyAccess(await req('/', { token: await tok(custom) }), env), null);
  const boot = await (await handle(await req('/api/bootstrap', { token: await tok({ tid: T, oid: O, roles: ['ATLAS.Interview'] }) }), env, '')).json();
  assert.equal(boot.identity.mode, 'entra');
});

test('one default voice and required transcription consent are advertised', async () => {
  const boot = await (await handle(await req('/api/bootstrap'), ENV, '')).json();
  assert.deepEqual(boot.voices, ['atlas']); assert.equal(boot.captureRequired, true); assert.ok(!('voicePreview' in boot));
  assert.equal((await handle(await req('/api/voice-preview?voice=athena'), ENV, '')).status, 404);
});

test('JEV classify route: needs CSRF + origin, refuses client fields, 503 without key', async () => {
  const boot = await (await handle(await req('/api/bootstrap'), ENV, '')).json();
  assert.equal(boot.jevClassify, false);
  const post = async (headers, body) => handle(new Request(ORIGIN + '/api/jev/classify', { method: 'POST', body: JSON.stringify(body),
    headers: { 'cf-access-jwt-assertion': await jwt(), Origin: ORIGIN, ...headers } }), ENV, '');
  const project = { title: 'x', role: '', sector: '', stage: 'Pilot', answers: ['a', '', '', '', '', ''] };
  assert.equal((await post({ 'X-Atlas-CSRF': 'wrong' }, { project })).status, 403);
  assert.equal((await post({ 'X-Atlas-CSRF': boot.csrf, Origin: 'https://evil.example' }, { project })).status, 403);
  assert.equal((await post({ 'X-Atlas-CSRF': boot.csrf }, { project })).status, 503);
  const withClient = await post({ 'X-Atlas-CSRF': boot.csrf }, { project: { ...project, client: { name: 'Contoso' } } });
  assert.equal(withClient.status, 400); assert.match((await withClient.json()).error, /confidential/);
  assert.equal((await post({ 'X-Atlas-CSRF': boot.csrf, 'Content-Length': '999999' }, { project })).status, 413);
});

test('admin mode comes only from a verified role or subject; a browser cannot claim it; no provider branding', async () => {
  let forwarded = null;
  const env = { ...ENV, ATLAS_TENANT_ISOLATION: 'local-synthetic', ATLAS_ADMIN_SUBJECTS: 'user-abc', INTERVIEW: { idFromName: () => 'id', get: () => ({ fetch: r => { forwarded = r; return new Response('ok'); } }) } };
  const voice = async (claims, headers = {}, e = env) => { forwarded = null; await handle(new Request(ORIGIN + '/api/voice', { headers: { 'cf-access-jwt-assertion': await jwt(claims), Upgrade: 'websocket', Origin: ORIGIN, ...headers } }), e, ''); return forwarded.headers.get('x-atlas-admin'); };
  assert.equal(await voice({}), '1');
  assert.equal(await voice({ email: 'other@example.com', sub: 'other' }, { 'x-atlas-admin': '1' }), '0');
  assert.equal(await voice({ custom: { roles: ['ATLAS.Admin'] }, sub: 'someone' }, {}), '1');
  assert.equal(await voice({ email: 'tony.walteur@gmail.com', sub: 'gmail' }, { 'x-atlas-admin': '1' }, { ...ENV, ATLAS_TENANT_ISOLATION: 'local-synthetic', ADMIN_EMAILS: 'tony.walteur@gmail.com', INTERVIEW: env.INTERVIEW }), '0');
  assert.equal(await (async () => { forwarded = null; await handle(new Request(ORIGIN + '/api/voice', { headers: { 'cf-access-jwt-assertion': await jwt(), Upgrade: 'websocket', Origin: ORIGIN, 'x-atlas-admin': '1' } }), { ...env, ATLAS_ADMIN_SUBJECTS: '', ATLAS_ADMIN_ROLES: '' }, ''); return forwarded.headers.get('x-atlas-admin'); })(), '0');
  const boot = await (await handle(await req('/api/bootstrap'), env, '')).json();
  assert.equal(boot.admin, true); assert.equal(boot.speakingSeconds, 600);
  const text = JSON.stringify(boot) + await (await handle(await req('/', { token: null }), env, '')).text();
  assert.doesNotMatch(text, /cloudflare|workers ai|harmonia/i);
});

import { responseText, responseToolCalls } from '../src/app.js';
test('analyst/report parsing accepts Chat Completions, Responses API and legacy shapes', () => {
  assert.equal(responseText({ choices: [{ message: { content: '{"a":1}' } }] }), '{"a":1}');
  assert.equal(responseText({ output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'hidden' }] }, { type: 'message', content: [{ type: 'output_text', text: '{"b"' }, { type: 'output_text', text: ':2}' }] }] }), '{"b":2}');
  assert.equal(responseText({ response: 'x' }), 'x'); assert.equal(responseText(null), '');
  assert.deepEqual(responseToolCalls({ output: [{ type: 'function_call', call_id: 'c1', name: 'record_details', arguments: '{"details":[]}' }] }), [{ id: 'c1', name: 'record_details', arguments: '{"details":[]}' }]);
  assert.deepEqual(responseToolCalls({ choices: [{ message: { tool_calls: [{ id: 't', function: { name: 'record_details', arguments: { details: [] } } }] } }] }), [{ id: 't', name: 'record_details', arguments: '{"details":[]}' }]);
  assert.deepEqual(responseToolCalls({ tool_calls: [{ name: 'record_details', arguments: {} }] }), [{ id: 'call-0', name: 'record_details', arguments: '{}' }]);
});
test('reasoning effort is sent, and dropped if the binding rejects it', async () => {
  const seen = [];
  const ai = workersAI({ ANALYST_MODEL: 'm', AI: { async run(model, input) { seen.push(input); if (input.reasoning) throw new Error('unknown field'); return { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }; } } });
  assert.equal(await ai.report([{ role: 'user', content: 'x' }]), 'ok');
  assert.deepEqual(seen.map(i => !!i.reasoning), [true, false]);
});

test('library routes: identity and role come only from the verified sign-in; POST needs CSRF + origin', async () => {
  let forwarded = null;
  const env = { ...ENV, LIBRARY: { idFromName: n => n, get: () => ({ fetch: r => { forwarded = r; return new Response('{"ok":true}'); } }) } };
  assert.equal((await handle(await req('/api/library'), ENV, '')).status, 404);
  await handle(await req('/api/library', { headers: { 'x-atlas-user': 'boss@example.com', 'x-atlas-role': 'admin' } }), env, '');
  assert.equal(forwarded.headers.get('x-atlas-user'), 'tony@example.com'); assert.equal(forwarded.headers.get('x-atlas-role'), 'user');
  const boot = await (await handle(await req('/api/bootstrap'), env, '')).json();
  const post = async headers => { forwarded = null; return handle(new Request(ORIGIN + '/api/library', { method: 'POST', body: '{}', headers: { 'cf-access-jwt-assertion': await jwt({ email: 'rev@example.com', sub: 'user-rev', custom: { roles: ['ATLAS.Reviewer'] } }), Origin: ORIGIN, ...headers } }), env, ''); };
  assert.equal((await post({ 'X-Atlas-CSRF': 'wrong' })).status, 403); assert.equal(forwarded, null);
  assert.equal((await post({ 'X-Atlas-CSRF': boot.csrf })).status, 403, 'CSRF is bound to the signed-in subject');
  const revBoot = await (await handle(new Request(ORIGIN + '/api/bootstrap', { headers: { 'cf-access-jwt-assertion': await jwt({ email: 'rev@example.com', sub: 'user-rev', custom: { roles: ['ATLAS.Reviewer'] } }) } }), env, '')).json();
  assert.equal((await post({ 'X-Atlas-CSRF': revBoot.csrf })).status, 200); assert.equal(forwarded.headers.get('x-atlas-role'), 'reviewer');
  assert.equal(revBoot.library, true);
  const TID = '11111111-2222-3333-4444-555555555555', OID = '99999999-8888-7777-6666-555555555555', entra = { ...env, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: TID, ADMIN_EMAILS: 'tony@example.com' };
  const asEntra = async roles => { forwarded = null; await handle(new Request(ORIGIN + '/api/library', { headers: { 'cf-access-jwt-assertion': await jwt({ custom: { tid: TID, oid: OID, roles } }) } }), entra, ''); return forwarded.headers; };
  const h1 = await asEntra([]); assert.equal(h1.get('x-atlas-role'), 'user', 'Entra: an email on ADMIN_EMAILS grants nothing'); assert.equal(h1.get('x-atlas-user'), `${TID}:${OID}`);
  assert.equal((await asEntra(['ATLAS.Reviewer'])).get('x-atlas-role'), 'reviewer'); assert.equal((await asEntra(['ATLAS.Admin'])).get('x-atlas-role'), 'admin');
});

test('PM trigger endpoint: bearer secret only (constant-time), system role only via the Worker; browsers cannot claim it', async () => {
  let forwarded = null;
  const tid = '11111111-1111-4111-8111-111111111111';
  const env = { ...ENV, TRIGGER_SECRET: 's3cret-value', ATLAS_SYSTEM_TENANT: tid, LIBRARY: { idFromName: n => n, get: () => ({ fetch: r => { forwarded = r; return new Response('{"id":"x"}', { status: 201 }); } }) } };
  const trig = (auth, e = env, extra = {}) => handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body: extra.body || '{"email":"a@b.co","reason":"project_end"}', headers: { ...(auth ? { Authorization: auth } : {}), ...(extra.headers || {}) } }), e, '');
  assert.equal((await trig()).status, 401); assert.equal((await trig('Bearer wrong-value!')).status, 401); assert.equal((await trig('Bearer s3cret-value', { ...env, TRIGGER_SECRET: '' })).status, 401);
  assert.equal((await trig('Bearer ' + tid)).status, 401, 'the tenant id is not a system token');
  assert.equal(forwarded, null);
  const ok = await trig('Bearer s3cret-value'); assert.equal(ok.status, 201);
  assert.equal(forwarded.headers.get('x-atlas-role'), 'system'); assert.equal(forwarded.headers.get('x-atlas-tenant'), tid); assert.equal(forwarded.headers.get('x-atlas-tenant-enforced'), '1');
  assert.equal(new URL(forwarded.url).pathname, '/api/library/trigger');
  forwarded = null;
  await handle(await req('/api/library/scan-stale', { headers: { 'x-atlas-role': 'system', 'x-atlas-user': 'atlas-cron' } }), env, '');
  assert.equal(forwarded.headers.get('x-atlas-role'), 'user'); assert.equal(forwarded.headers.get('x-atlas-user'), 'tony@example.com');
});


test('enforced voice and memory refuse a missing tenant and keep two tenants apart', async () => {
  let name = null;
  const env = { ...ENV, INTERVIEW: { idFromName: n => { name = n; return n; }, get: () => ({ fetch: () => new Response('ok') }) } };
  const denied = await handle(await req('/api/voice', { headers: { Upgrade: 'websocket', Origin: ORIGIN } }), env, '');
  assert.equal(denied.status, 403);
  assert.equal(name, null);
  const memoryDenied = await handle(await req('/api/memory'), env, '');
  assert.equal(memoryDenied.status, 403);
  assert.match((await memoryDenied.json()).error, /subject-only bank was not read/);
  const TID = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222', OID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const entra = { ...env, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: `${TID},${OTHER}` };
  const open = async tid => {
    name = null;
    const token = await jwt({ email: 'ada@example.com', sub: 'ignored', custom: { tid, oid: OID, roles: [] } });
    return { name, res: await handle(new Request(ORIGIN + '/api/voice', { headers: { 'cf-access-jwt-assertion': token, Upgrade: 'websocket', Origin: ORIGIN } }), entra, '') };
  };
  const first = await open(TID);
  assert.equal(first.res.status, 200);
  const firstName = name;
  const second = await open(OTHER);
  assert.equal(second.res.status, 200);
  assert.notEqual(name, firstName);
  assert.match(firstName, new RegExp('^' + TID + ':'));
  assert.match(name, new RegExp('^' + OTHER + ':'));
});

test('memory routes: forwarded to the person\'s own Durable Object with a server-derived bank; POST needs CSRF; bootstrap reports memory', async () => {
  let forwarded = null, name = null;
  const env = { ...ENV, ATLAS_TENANT_ISOLATION: 'local-synthetic', HINDSIGHT_URL: 'https://hs.example', HINDSIGHT_API_KEY: 'k', HINDSIGHT_OPT_IN: '1', INTERVIEW: { idFromName: n => { name = n; return n; }, get: () => ({ fetch: r => { forwarded = r; return new Response('{}'); } }) } };
  await handle(await req('/api/memory', { headers: { 'x-atlas-bank': 'someone-elses-bank' } }), env, '');
  assert.equal(name, 'user-abc'); assert.match(forwarded.headers.get('x-atlas-bank'), /^atlas-[0-9a-f]{40}$/); assert.notEqual(forwarded.headers.get('x-atlas-bank'), 'someone-elses-bank');
  const boot = await (await handle(await req('/api/bootstrap'), env, '')).json(); assert.equal(boot.memory, true);
  forwarded = null;
  const post = await handle(new Request(ORIGIN + '/api/memory/forget', { method: 'POST', body: '{"all":true}', headers: { 'cf-access-jwt-assertion': await jwt(), Origin: ORIGIN } }), env, '');
  assert.equal(post.status, 403); assert.equal(forwarded, null);
  const voiceEnv = { ...env, INTERVIEW: { idFromName: n => n, get: () => ({ fetch: r => { forwarded = r; return new Response('ok'); } }) } };
  await handle(await req('/api/voice', { headers: { Upgrade: 'websocket', Origin: ORIGIN, 'x-atlas-bank': 'fake' } }), voiceEnv, '');
  assert.match(forwarded.headers.get('x-atlas-bank'), /^atlas-[0-9a-f]{40}$/);
});

import { detectedLanguage, languageNote, normalize } from '../src/languages.js';
test('languages: automatic detection, native Spanish voice, ElevenLabs for the rest, honest fallback without it', async () => {
  const seen = [];
  const env = { STT_MODEL: 'stt', TTS_MODEL: 'tts', TTS_VOICE: 'harmonia', AI: { async run(model, input) { seen.push([model, input]);
    if (model === 'stt') return { results: { channels: [{ alternatives: [{ transcript: 'Nous avons réduit le délai', languages: ['fr'] }] }] } };
    return new Response(new Uint8Array(6)).body; } } };
  const ai = workersAI(env);
  assert.deepEqual(await ai.transcribe(new Uint8Array(4)), { text: 'Nous avons réduit le délai', language: 'fr' });
  assert.equal(seen[0][1].language, 'multi');
  await ai.synthesize('Hola.', 'atlas', 'es'); assert.equal(seen.at(-1)[0], '@cf/deepgram/aura-2-es'); assert.equal(seen.at(-1)[1].speaker, 'celeste');
  await ai.synthesize('Hi.', 'atlas', 'en'); assert.deepEqual([seen.at(-1)[0], seen.at(-1)[1].speaker], ['tts', 'harmonia']);
  assert.deepEqual(['en', 'es', 'fr', 'pt'].map(l => ai.speaks(l)), [true, true, false, false]);
  const withEleven = workersAI({ ...env, ELEVENLABS_API_KEY: 'k' });
  assert.deepEqual(['fr', 'pt', 'de', 'xx'].map(l => withEleven.speaks(l)), [true, true, true, false]);
  assert.equal(detectedLanguage({ results: { channels: [{ alternatives: [{ words: [{ language: 'pt' }, { language: 'pt' }, { language: 'en' }] }] }] } }), 'pt');
  assert.equal(detectedLanguage({}), null); assert.equal(normalize('pt-BR'), 'pt'); assert.equal(normalize('zz'), null);
  assert.match(languageNote('fr', 'fr'), /Reply only in natural French/);
  assert.match(languageNote('pt', 'en'), /can only speak English right now\. Reply in English\..*understand Portuguese/);
});

// ---- T1-S0 additions (WOW_SPEC §2.2, §2.5, §2.6, §F1.10). No earlier assertion in this file changed. ----
import { scheduled } from '../src/app.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
const FEATURE_KEYS = ['bids', 'ask', 'spokenAsk', 'wins', 'customerJev', 'pdfBriefs', 'gaps', 'gapInterview', 'claims', 'clientConfirm', 'outreach', 'staffing', 'teams', 'phone', 'profile'];
const capture = () => { const c = { req: null, body: null }; c.stub = { idFromName: n => n, get: () => ({ fetch: async r => { c.req = r; c.body = r.body ? await r.text() : null; return new Response('{"ok":true}'); } }) }; return c; };
const signed = async (path, claims = {}, init = {}) => new Request(ORIGIN + path, { ...init, headers: { 'cf-access-jwt-assertion': await jwt(claims), ...(init.headers || {}) } });

test('T1-S0 bootstrap: verified email and every feature flag, conservative by default; existing keys unchanged', async () => {
  const boot = await (await handle(await req('/api/bootstrap'), ENV, '')).json();
  assert.deepEqual(Object.keys(boot).slice(0, -2), ['provider', 'providerLabel', 'protocol', 'csrf', 'identity', 'model', 'admin', 'voices', 'defaultVoice', 'captureRequired', 'codecAvailable', 'busy', 'capacity',
    'maxSeconds', 'speakingSeconds', 'memory', 'wiki', 'jev', 'jevClassify', 'library', 'libraryRole', 'sheet', 'transcription', 'structuredNotes', 'liveLedger', 'playbackAck', 'readiness', 'privilege']);
  assert.equal(boot.email, 'tony@example.com'); assert.deepEqual(Object.keys(boot.features), FEATURE_KEYS);
  // D1 is the SPOKEN_ASK_APPROVED code constant (features.test.js pins its value): spoken Ask follows Ask when it is set.
  assert.equal(boot.features.spokenAsk, SPOKEN_ASK_APPROVED && boot.features.ask); assert.equal(boot.features.teams, 'BLOCKED_EXTERNAL'); assert.equal(boot.features.phone, 'BLOCKED_EXTERNAL');
  // WOW_ZERO_CONFIG D1: SPOKEN_ASK is no longer a variable; spoken Ask follows SPOKEN_ASK_APPROVED (a code constant).
  for (const v of ['0', '1']) {
    const spoken = await (await handle(await req('/api/bootstrap'), { ...ENV, SPOKEN_ASK: v }, '')).json();
    assert.equal(spoken.features.spokenAsk, boot.features.spokenAsk, 'the removed SPOKEN_ASK variable changes nothing');
  }
  const service = await (await handle(await signed('/api/bootstrap', { email: undefined }), ENV, '')).json();
  assert.equal(service.email, '', 'a service identity has no email'); assert.equal(service.identity.name, 'Access service identity');
});

test('T1-S0 library forward: x-atlas-email set and a spoofed one overwritten; raw body bounded even without Content-Length', async () => {
  const c = capture(), env = { ...ENV, LIBRARY: c.stub };
  await handle(await req('/api/library', { headers: { 'x-atlas-email': 'boss@example.com', 'x-atlas-user': 'boss@example.com' } }), env, '');
  assert.equal(c.req.headers.get('x-atlas-email'), 'tony@example.com'); assert.equal(c.req.headers.get('x-atlas-user'), 'tony@example.com'); assert.equal(c.body, null);
  const boot = await (await handle(await req('/api/bootstrap'), env, '')).json();
  const post = async (body, headers = {}) => { c.req = null; return handle(new Request(ORIGIN + '/api/library/recommend', { method: 'POST', body, headers: { 'cf-access-jwt-assertion': await jwt(), Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'Content-Type': 'application/json', ...headers } }), env, ''); };
  const ok = await post('{"query":"energy data director meeting"}');
  assert.equal(ok.status, 200); assert.equal(c.body, '{"query":"energy data director meeting"}'); assert.equal(new URL(c.req.url).pathname, '/api/library/recommend'); assert.equal(c.req.method, 'POST');
  const big = JSON.stringify({ query: 'x'.repeat(262200) });
  const r = await post(big); assert.equal(r.status, 413); assert.deepEqual(await r.json(), { error: 'Request too large.' }); assert.equal(c.req, null, 'never forwarded');
  assert.equal((await post('{}', { 'Content-Length': '999999' })).status, 413, 'the declared length is still checked first');
  // Review #16: a streamed body with no Content-Length is read only just past 256 KiB, not buffered whole.
  const CHUNK = 1 << 16, s = { pulled: 0 }, chunk = new Uint8Array(CHUNK).fill(120);
  const stream = new ReadableStream({ pull(ctl) { if (s.pulled >= 20 * (1 << 20)) return ctl.close(); s.pulled += CHUNK; ctl.enqueue(chunk); } });
  c.req = null;
  const long = await handle(new Request(ORIGIN + '/api/library/recommend', { method: 'POST', body: stream, duplex: 'half', headers: { 'cf-access-jwt-assertion': await jwt(), Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'Content-Type': 'application/json' } }), env, '');
  assert.equal(long.status, 413); assert.equal(c.req, null, 'never forwarded');
  assert.ok(s.pulled <= 262144 + 2 * CHUNK, `the read stops just past 256 KiB (${s.pulled} bytes pulled)`);
  const utf = '{"query":"Zoë Ålund meeting about énergie"}';
  assert.equal((await post(utf)).status, 200); assert.equal(c.body, utf, 'a bounded read forwards UTF-8 unchanged');
  const entra = { ...env, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: '11111111-2222-3333-4444-555555555555' };
  await handle(await signed('/api/library', { custom: { tid: '11111111-2222-3333-4444-555555555555', oid: '99999999-8888-7777-6666-555555555555', roles: [] } }), entra, '');
  assert.equal(c.req.headers.get('x-atlas-user'), '11111111-2222-3333-4444-555555555555:99999999-8888-7777-6666-555555555555'); assert.equal(c.req.headers.get('x-atlas-email'), 'tony@example.com');
});

test('T1-S0 /api/voice forward SETS x-atlas-user, x-atlas-role and x-atlas-email (a browser cannot spoof them)', async () => {
  let fwd = null; const env = { ...ENV, ATLAS_TENANT_ISOLATION: 'local-synthetic', INTERVIEW: { idFromName: n => n, get: () => ({ fetch: r => { fwd = r; return new Response('ok'); } }) } };
  const voice = async (claims, headers = {}) => { fwd = null; await handle(await signed('/api/voice', claims, { headers: { Upgrade: 'websocket', Origin: ORIGIN, ...headers } }), env, ''); return ['x-atlas-user', 'x-atlas-role', 'x-atlas-email'].map(h => fwd.headers.get(h)); };
  const spoof = { 'x-atlas-user': 'boss@example.com', 'x-atlas-role': 'admin', 'x-atlas-email': 'boss@example.com' };
  assert.deepEqual(await voice({}, spoof), ['tony@example.com', 'user', 'tony@example.com']);
  assert.deepEqual(await voice({ email: 'Rev@Example.com', custom: { roles: ['ATLAS.Reviewer'] } }, spoof), ['rev@example.com', 'reviewer', 'rev@example.com']);
  assert.deepEqual(await voice({ email: 'boss@example.com', custom: { roles: ['ATLAS.Admin'] } }), ['boss@example.com', 'admin', 'boss@example.com']);
  assert.deepEqual(await voice({ email: undefined }, spoof), ['access service identity', 'user', ''], 'no valid email: empty x-atlas-email');
});

test('T1-S0 external role: only explicitly listed emails; they reach /confirm, a reduced bootstrap and the confirmations API only', async () => {
  const c = capture(); let voiceHit = false;
  const env = { ...ENV, EXTERNAL_EMAILS: 'Client@Acme.example, other@x.example', REVIEWER_EMAILS: 'rev@acme.example', ADMIN_EMAILS: 'boss@acme.example', LIBRARY: c.stub,
    INTERVIEW: { idFromName: n => n, get: () => ({ fetch: () => { voiceHit = true; return new Response('ok'); } }) } };
  const ext = { email: 'client@acme.example', sub: 'ext-1' }, as = (path, init) => signed(path, ext, init);
  const boot = await (await handle(await as('/api/bootstrap'), env, '')).json();
  assert.deepEqual(Object.keys(boot), ['csrf', 'identity', 'email', 'libraryRole', 'features']);
  // Only the claims flag, whatever its value (it follows claims.READY, which T3 flips).
  assert.deepEqual([boot.libraryRole, boot.email, boot.features], ['external', 'client@acme.example', { claims: (await import('../src/features.js')).flags(env).claims }]); assert.equal(boot.csrf.length, 64);
  const home = await handle(await as('/'), env, 'PAGE'); assert.equal(home.status, 303); assert.equal(home.headers.get('location'), '/confirm'); assert.equal(await home.text(), '');
  const page = await handle(await as('/confirm'), env, 'PAGE'); assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
  for (const [path, init] of [['/api/library', {}], ['/api/library/bids', {}], ['/api/library/confirmations', {}], ['/api/memory', {}], ['/api/wiki', {}],
    ['/api/voice', { headers: { Upgrade: 'websocket', Origin: ORIGIN } }], ['/api/sheet/ingest', { method: 'POST', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf } }],
    ['/api/jev/classify', { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf } }]]) {
    c.req = null; const r = await handle(await as(path, init), env, '');
    assert.equal(r.status, 403, path); assert.deepEqual(await r.json(), { error: 'Not available to external confirmers.' }); assert.equal(c.req, null, path);
  }
  assert.equal(voiceHit, false);
  await handle(await as('/api/library/confirmations/inbox'), env, '');
  assert.deepEqual(['x-atlas-user', 'x-atlas-role', 'x-atlas-email'].map(h => c.req.headers.get(h)), ['client@acme.example', 'external', 'client@acme.example']);
  c.req = null; assert.equal((await handle(await as('/api/library/confirmations/r1', { method: 'POST', body: '{}', headers: { Origin: ORIGIN } }), env, '')).status, 403, 'still needs CSRF'); assert.equal(c.req, null);
  await handle(await as('/api/library/confirmations/r1', { method: 'POST', body: '{"decisions":[]}', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf } }), env, '');
  assert.equal(c.body, '{"decisions":[]}');
  // Only explicit listing makes someone external: any other domain stays a user; admin and reviewer lists come first.
  const roleOf = async email => (await (await handle(await signed('/api/bootstrap', { email }), env, '')).json()).libraryRole;
  assert.equal(await roleOf('consultant@othercorp.example'), 'user'); assert.equal(await roleOf('someone@acme.example'), 'user'); assert.equal(await roleOf('client@acme.example.evil'), 'user');
  assert.equal(await roleOf('rev@acme.example'), 'user', 'an email list does not grant reviewer');
  assert.equal(await roleOf('boss@acme.example'), 'user', 'an email list does not grant admin');
  const roleClaims = async (email, roles) => (await (await handle(await signed('/api/bootstrap', { email, custom: { roles } }), env, '')).json()).libraryRole;
  assert.equal(await roleClaims('rev@acme.example', ['ATLAS.Reviewer']), 'reviewer');
  assert.equal(await roleClaims('boss@acme.example', ['ATLAS.Admin']), 'admin');
  const both = { ...env, EXTERNAL_EMAILS: 'rev@acme.example,boss@acme.example' };
  assert.deepEqual([
    await (await handle(await signed('/api/bootstrap', { email: 'rev@acme.example', custom: { roles: ['ATLAS.Reviewer'] } }), both, '')).json(),
    await (await handle(await signed('/api/bootstrap', { email: 'boss@acme.example', custom: { roles: ['ATLAS.Admin'] } }), both, '')).json(),
  ].map(b => b.libraryRole), ['reviewer', 'admin']);
  const T = '11111111-2222-3333-4444-555555555555', O = '66666666-7777-8888-9999-000000000000';
  const entraBoot = await (await handle(await signed('/api/bootstrap', { email: 'client@acme.example', custom: { tid: T, oid: O, roles: [] } }), { ...env, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: T }, '')).json();
  assert.equal(entraBoot.libraryRole, 'user', 'Entra mode has no external role');
});

test('T1-S0 GET /confirm is served only after sign-in, with the standard headers and CSP', async () => {
  assert.equal((await handle(await req('/confirm', { token: null }), ENV, '')).status, 401);
  const home = await handle(await req('/'), ENV, '<html></body>'), r = await handle(await req('/confirm'), ENV, '');
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  for (const h of ['cache-control', 'x-content-type-options', 'referrer-policy', 'permissions-policy']) assert.equal(r.headers.get(h), home.headers.get(h), h);
  for (const policy of [r.headers.get('content-security-policy'), home.headers.get('content-security-policy')]) {
    assert.match(policy, /script-src-attr 'none'/); assert.match(policy, /frame-ancestors 'none'/);
    assert.equal(/script-src[^;]*unsafe-inline/.test(policy), false);
  }
  const html = await r.text(); assert.match(html, /^<!doctype html>/i); assert.doesNotMatch(html, /<script[^>]+src|https?:\/\//i);
});

// WOW_ZERO_CONFIG §4 (Z-S2): TEAMS_ENABLED is gone; Teams is on once the ids and the bot secret are all present.
test('T1-S0 Teams: with TEAMS_* set but no bot secret (TEAMS_ENABLED is not read), every main-host response is unchanged; the two pre-Access paths answer 503', async () => {
  const TEAMS = { TEAMS_ENABLED: '1', TEAMS_APP_ID: 'a', TEAMS_BOT_APP_ID: 'b', TEAMS_TENANT_ID: 't' };
  const stub = { idFromName: n => n, get: () => ({ fetch: async r => new Response(JSON.stringify({ path: new URL(r.url).pathname, user: r.headers.get('x-atlas-user'), role: r.headers.get('x-atlas-role'), mail: r.headers.get('x-atlas-email') }), { status: 200 }) }) };
  const base = { ...ENV, TRIGGER_SECRET: 'trig-secret', LIBRARY: stub, INTERVIEW: stub, HINDSIGHT_API_KEY: 'k' };
  const token = await jwt(), boot = await (await handle(await req('/api/bootstrap'), base, '')).json();
  const requests = () => [
    new Request(ORIGIN + '/', { headers: { 'cf-access-jwt-assertion': token } }), new Request(ORIGIN + '/api/bootstrap', { headers: { 'cf-access-jwt-assertion': token } }),
    new Request(ORIGIN + '/api/wiki', { headers: { 'cf-access-jwt-assertion': token } }), new Request(ORIGIN + '/api/library', { headers: { 'cf-access-jwt-assertion': token } }),
    new Request(ORIGIN + '/api/library', { method: 'POST', body: '{}', headers: { 'cf-access-jwt-assertion': token, Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf } }),
    new Request(ORIGIN + '/api/memory', { headers: { 'cf-access-jwt-assertion': token } }), new Request(ORIGIN + '/api/voice', { headers: { 'cf-access-jwt-assertion': token, Upgrade: 'websocket', Origin: ORIGIN } }),
    new Request(ORIGIN + '/api/triggers', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer trig-secret' } }), new Request(ORIGIN + '/api/teams/other', { headers: { 'cf-access-jwt-assertion': token } }),
    new Request(ORIGIN + '/api/teams/messages', { headers: { 'cf-access-jwt-assertion': token } }), new Request(ORIGIN + '/teams/tab', { method: 'POST', headers: { 'cf-access-jwt-assertion': token } }),
    new Request(ORIGIN + '/api/teams/other'), new Request(ORIGIN + '/confirm', { headers: { 'cf-access-jwt-assertion': token } })];
  const snap = async env => Promise.all(requests().map(async r => { const res = await handle(r, env, 'PAGE</body>'); return [res.status, [...res.headers].sort(), await res.text()]; }));
  assert.deepEqual(await snap({ ...base, ...TEAMS }), await snap(base));
  assert.deepEqual((await snap(base)).slice(8, 11).map(x => x[0]), [404, 404, 404], 'other /api/teams paths and methods stay behind Access');
  assert.equal((await snap(base))[11][0], 401);
  for (const env of [base, { ...base, ...TEAMS }, { ...base, ...TEAMS, TEAMS_ENABLED: '0' }]) {
    for (const r of [new Request(ORIGIN + '/api/teams/messages', { method: 'POST', body: '{}' }), new Request(ORIGIN + '/teams/tab')]) {
      const res = await handle(r, env, '');
      assert.equal(res.status, 503); const b = await res.json(); assert.equal(b.status, 'BLOCKED_EXTERNAL'); assert.ok(b.reason && Array.isArray(b.needs));
    }
  }
  // With the bot secret too, Teams is connected: the bot endpoint verifies its bearer token and the launcher answers.
  const on = { ...base, ...TEAMS, TEAMS_ENABLED: '0', TEAMS_BOT_SECRET: 's' };
  assert.equal((await handle(new Request(ORIGIN + '/api/teams/messages', { method: 'POST', body: '{}' }), on, '')).status, 401);
  assert.equal((await handle(new Request(ORIGIN + '/teams/tab'), on, '')).status, 200);
  assert.equal((await (await handle(await req('/api/bootstrap'), on, '')).json()).features.teams, 'connected');
});

test('T1-S0 scheduled(): the daily cron posts scan-stale to the LibraryStore as the system role; nothing without a library', async () => {
  const blocked = []; await scheduled({}, { ...ENV, LIBRARY: capture().stub }, { waitUntil: p => blocked.push(p) });
  assert.equal(blocked.length, 0, 'enforced deployment without ATLAS_SYSTEM_TENANT does not sweep every tenant');
  const c = capture(), waited = [];
  const tid = '11111111-1111-4111-8111-111111111111';
  await scheduled({}, { ...ENV, LIBRARY: c.stub, ATLAS_SYSTEM_TENANT: tid }, { waitUntil: p => waited.push(p) });
  await Promise.all(waited);
  assert.equal(waited.length, 1); assert.equal(c.req.method, 'POST'); assert.equal(new URL(c.req.url).pathname, '/api/library/scan-stale');
  assert.deepEqual([c.req.headers.get('x-atlas-user'), c.req.headers.get('x-atlas-role'), c.req.headers.get('x-atlas-tenant'), c.body], ['atlas-cron', 'system', tid, '{}']);
  const none = []; await scheduled({}, { ...ENV }, { waitUntil: p => none.push(p) }); assert.equal(none.length, 0);
  const lib = new Library(memorySql(), {}); let out = null;
  const real = { idFromName: n => n, get: () => ({ fetch: r => libraryRoutes(r, lib, { env: { ATLAS_TENANT_ISOLATION: 'local-synthetic' } }) }) };
  await scheduled({}, { ...ENV, LIBRARY: real, ATLAS_TENANT_ISOLATION: 'local-synthetic' }, { waitUntil: p => { out = p.then(r => r.json()); } });
  assert.deepEqual(await out, { invited: 0 });
});

// ---- T1 step 3 (WOW_SPEC §F6.2, §F6.4 #5): /api/transcribe, Spoken Ask. WOW_ZERO_CONFIG D1: off while
// SPOKEN_ASK_APPROVED is false (the SPOKEN_ASK variable is gone). `APPROVED` and `UNAPPROVED` pin the test seam either
// way, so these tests hold whatever the constant's value; `APPROVED` sends the consent prompt's header (`once`; the
// `always` path is tested below). ----
import { flags as featureFlags, readyOf, SPOKEN_ASK_APPROVED } from '../src/features.js';
const APPROVED = { flagsOf: env => featureFlags(env, readyOf, { spokenAskApproved: true }) };
const UNAPPROVED = { flagsOf: env => featureFlags(env, readyOf, { spokenAskApproved: false }) };
test('T1 /api/transcribe: 404 while D1 is not approved; Origin and CSRF; type and size limits; a numbers-only log; never for external confirmers', async () => {
  let fail = false; const runs = [];
  const AI = { async run(model, input) { runs.push([model, input.audio.contentType]); if (fail) throw new Error('stt down');
    return { results: { channels: [{ alternatives: [{ transcript: 'What did we do for Zebracorp? ' + 'x'.repeat(700), languages: ['en'] }] }] } }; } };
  const on = { ...ENV, STT_MODEL: 'stt', AI }, boot = await (await handle(await req('/api/bootstrap'), on, '', APPROVED)).json();
  const post = async (bytes, { headers = {}, env = on, claims = {}, method = 'POST', opts = APPROVED } = {}) => handle(new Request(ORIGIN + '/api/transcribe', { method, body: method === 'POST' ? bytes : undefined,
    headers: { 'cf-access-jwt-assertion': await jwt(claims), Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'Content-Type': 'audio/L16;rate=24000', 'X-Atlas-Consent': 'spoken-ask-v1; once', ...headers } }), env, '', opts);
  const logs = [], log = console.log; console.log = line => logs.push(line);
  try {
    for (const env of [on, { ...on, SPOKEN_ASK: '1' }]) {
      const r = await post(new Uint8Array(9600), { env, opts: UNAPPROVED }); assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: 'This feature is not available in this deployment.' });
    }
    assert.deepEqual(runs, [], 'nothing reaches speech-to-text while D1 is not approved');
    assert.equal(boot.features.spokenAsk, true, 'bootstrap advertises it only with D1 approved and Ask READY');
    const ok = await post(new Uint8Array(9600));
    assert.equal(ok.status, 200); const body = await ok.json();
    assert.equal(body.text.length, 600); assert.equal(body.language, 'en'); assert.deepEqual(runs, [['stt', 'audio/wav']]);
    assert.equal(logs.length, 1); const m = JSON.parse(logs[0]);
    assert.deepEqual(Object.keys(m), ['atlas_metric', 'ms', 'bytes']); assert.equal(m.atlas_metric, 'transcribe'); assert.equal(m.bytes, 9600); assert.equal(typeof m.ms, 'number');
    assert.equal((await post(new Uint8Array(9600), { headers: { 'Content-Type': 'audio/l16; rate=24000' } })).status, 200, 'case and spaces in the type are tolerated');
    for (const [bytes, opts, status] of [[new Uint8Array(9600), { headers: { 'X-Atlas-CSRF': 'forged' } }, 403], [new Uint8Array(9600), { headers: { Origin: 'https://evil.example' } }, 403],
      [new Uint8Array(9600), { headers: { 'Content-Type': 'audio/wav' } }, 415], [new Uint8Array(9600), { headers: { 'Content-Type': 'audio/L16;rate=16000' } }, 415],
      [new Uint8Array(1536002), {}, 413], [new Uint8Array(9600), { headers: { 'Content-Length': '1536001' } }, 413],
      [new Uint8Array(9601), {}, 400], [new Uint8Array(4798), {}, 400], [new Uint8Array(0), {}, 400]]) assert.equal((await post(bytes, opts)).status, status, `${bytes.length} ${JSON.stringify(opts)}`);
    assert.equal((await post(new Uint8Array(1536000))).status, 200, 'exactly the maximum is accepted');
    assert.equal((await post(null, { method: 'GET' })).status, 404);
    fail = true; logs.length = 0;
    const bad = await post(new Uint8Array(9600));
    assert.equal(bad.status, 502); assert.deepEqual(await bad.json(), { error: 'Transcription failed. Type the question instead.' });
    assert.deepEqual(Object.keys(JSON.parse(logs[0])), ['atlas_metric', 'ms', 'bytes', 'failed']);
    assert.doesNotMatch(logs.join('\n'), /Zebracorp|what did we/i, 'only numbers are logged');
    fail = false; runs.length = 0;
    const ext = await post(new Uint8Array(9600), { env: { ...on, EXTERNAL_EMAILS: 'client@acme.example' }, claims: { email: 'client@acme.example', sub: 'ext-1' } });
    assert.equal(ext.status, 403); assert.deepEqual(runs, [], 'an external confirmer never reaches speech-to-text');
  } finally { console.log = log; }
});

// ---- Track Z, step Z-S0 (WOW_ZERO_CONFIG §3.9, §5.4, §5.5, §6, §9). No earlier assertion below this line. ----
import { signinClaims, SIGNED_IN_HTML } from '../src/app.js';
const idpOf = r => JSON.parse(Buffer.from(r.headers.get('x-atlas-idp'), 'base64url').toString());

test('Z x-atlas-idp: always overwritten on every library forward, built only from the verified JWT custom claims; verifyAccess unchanged', async () => {
  const c = capture(), env = { ...ENV, LIBRARY: c.stub }, spoof = Buffer.from(JSON.stringify({ name: 'Boss Person' })).toString('base64url');
  await handle(await req('/api/library/profile', { headers: { 'x-atlas-idp': spoof } }), env, '');
  assert.equal(c.req.headers.get('x-atlas-idp'), 'e30', 'no claims (PIN sign-in): {} as e30; the browser value is gone');
  const claims = { custom: { name: 'Zoë  Lefèvre', given_name: 'Zoë', family_name: 'Lefèvre', roles: ['ATLAS.Admin'], tid: 't', groups: ['g'] } };
  await handle(await signed('/api/library/profile', claims, { headers: { 'x-atlas-idp': spoof } }), env, '');
  assert.deepEqual(idpOf(c.req), { name: 'Zoë Lefèvre', given_name: 'Zoë', family_name: 'Lefèvre' }, 'mapped name claims only');
  await handle(await signed('/api/library/people?email=a@b.co', { custom: { given_name: 'Ana', family_name: 'Ruiz' } }), env, '');
  assert.deepEqual(idpOf(c.req), { name: 'Ana Ruiz', given_name: 'Ana', family_name: 'Ruiz' }, 'name composed when absent');
  const boot = await (await handle(await signed('/api/bootstrap', claims), env, '')).json();
  await handle(await signed('/api/library/profile', claims, { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'x-atlas-idp': spoof } }), env, '');
  assert.deepEqual(idpOf(c.req), { name: 'Zoë Lefèvre', given_name: 'Zoë', family_name: 'Lefèvre' }, 'POST forwards too');
  assert.equal(idpOf({ headers: new Headers({ 'x-atlas-idp': 'e30' }) }).name, undefined);
  assert.deepEqual(await verifyAccess(await signed('/', claims), ENV), { sub: 'user-abc', email: 'tony@example.com', roles: ['ATLAS.Admin'] }, 'verified roles travel with the token; a spoofed header does not');
  assert.equal(signinClaims(await signed('/', { custom: { name: 'x'.repeat(300), given_name: 7 } })).name.length, 100);
  assert.deepEqual(signinClaims(new Request(ORIGIN)), {}); assert.deepEqual(signinClaims(new Request(ORIGIN, { headers: { 'cf-access-jwt-assertion': 'a.%%%.c' } })), {});
  const [h, , s] = (await jwt(claims)).split('.'), forged = [h, b64u(JSON.stringify({ ...claims, sub: 'user-abc', custom: { name: 'Forged' } })), s].join('.');
  c.req = null; assert.equal((await handle(await req('/api/library/profile', { token: forged }), env, '')).status, 401, 'claims are read only from a token Access verified'); assert.equal(c.req, null);
});

test('Z /go links: 302 to the page fragments after sign-in; /go/confirm also for an external confirmer; anything else under /go/ goes home', async () => {
  const id = '0123456789abcdef0123456789abcdef', loc = async (path, claims = {}, env = ENV) => { const r = await handle(await signed(path, claims), env, 'PAGE'); return [r.status, r.headers.get('location')]; };
  assert.deepEqual(await loc('/go/start'), [302, '/#start']);
  for (const kind of ['gap', 'invitation', 'bid', 'library']) assert.deepEqual(await loc(`/go/${kind}/${id}`), [302, `/#${kind}/${id}`], kind);
  assert.deepEqual(await loc('/go/confirm/' + id), [302, '/confirm#' + id]);
  for (const bad of ['/go/x', '/go/gap/' + id.toUpperCase(), '/go/gap/' + id.slice(1), '/go/gap/' + id + '/x', '/go/', '/go/start/x', '/go/confirm/xyz', '/go/library/../x'])
    assert.deepEqual(await loc(bad), [302, '/'], bad);
  const r = await handle(await req('/go/start'), ENV, 'PAGE');
  assert.equal(r.headers.get('cache-control'), 'no-store'); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await handle(await req('/go/start', { token: null }), ENV, 'PAGE')).status, 401, 'only after Access sign-in');
  assert.equal((await handle(new Request(ORIGIN + '/go/start', { method: 'POST', headers: { 'cf-access-jwt-assertion': await jwt() } }), ENV, '')).status, 404, 'GET only');
  const ext = { ...ENV, EXTERNAL_EMAILS: 'client@acme.example' }, as = { email: 'client@acme.example', sub: 'ext-1' };
  assert.deepEqual(await loc('/go/confirm/' + id, as, ext), [302, '/confirm#' + id], 'an external confirmer reaches a confirmation link');
  for (const path of ['/go/gap/' + id, '/go/start', '/go/library/' + id, '/go/signed-in', '/go/confirm/xyz']) {
    const x = await handle(await signed(path, as), ext, 'PAGE'); assert.equal(x.status, 403, path); assert.deepEqual(await x.json(), { error: 'Not available to external confirmers.' });
  }
});

test('Z /go/signed-in: a tiny page that tells the waiting tab over BroadcastChannel and closes; no token, no email, standard headers', async () => {
  const home = await handle(await req('/'), ENV, '<html></body>'), r = await handle(await req('/go/signed-in'), ENV, 'PAGE'), html = await r.text();
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8'); assert.equal(html, SIGNED_IN_HTML);
  assert.ok(html.includes("BroadcastChannel('atlas-auth')") && html.includes("postMessage('ok')") && html.includes("You're signed in. This window closes by itself."));
  const boot = await (await handle(await req('/api/bootstrap'), ENV, '')).json();
  for (const secret of ['tony@example.com', 'user-abc', boot.csrf, (await jwt()).slice(0, 20), 'ATLAS_RUNTIME']) assert.equal(html.includes(secret), false, secret);
  assert.doesNotMatch(html, /<script[^>]+src|https?:\/\//i);
  for (const h of ['cache-control', 'x-content-type-options', 'referrer-policy', 'permissions-policy']) assert.equal(r.headers.get(h), home.headers.get(h), h);
  for (const policy of [r.headers.get('content-security-policy'), home.headers.get('content-security-policy')]) {
    assert.match(policy, /script-src-attr 'none'/); assert.match(policy, /frame-ancestors 'none'/);
    assert.equal(/script-src[^;]*unsafe-inline/.test(policy), false);
  }
  assert.equal((await handle(await req('/go/signed-in', { token: null }), ENV, 'PAGE')).status, 401);
});

test('Z navigation fallback: an unknown page navigation goes home; API paths, non-navigations, the wrong host and no sign-in are unchanged', async () => {
  const nav = { 'Sec-Fetch-Mode': 'navigate' }, html = { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };
  for (const [path, headers] of [['/ATLAS_Voice.html', nav], ['/index.html', html], ['/some/old/page', nav]]) {
    const r = await handle(await req(path, { headers }), ENV, 'PAGE'); assert.deepEqual([r.status, r.headers.get('location')], [302, '/'], path);
  }
  for (const [path, headers] of [['/ATLAS_Voice.html', {}], ['/api/wiki', nav], ['/api/wiki', html], ['/favicon.ico', { Accept: 'image/*', 'Sec-Fetch-Mode': 'no-cors' }]]) {
    const r = await handle(await req(path, { headers }), ENV, 'PAGE'); assert.equal(r.status, 404, path); assert.deepEqual(await r.json(), { error: 'This feature is not available in this deployment.' });
  }
  assert.equal((await handle(new Request(ORIGIN + '/ATLAS_Voice.html', { method: 'POST', headers: { ...nav, 'cf-access-jwt-assertion': await jwt() } }), ENV, '')).status, 404, 'GET only');
  assert.equal((await handle(await req('/ATLAS_Voice.html', { headers: nav, host: 'https://evil.example' }), ENV, 'PAGE')).status, 403, 'the wrong host stays 403');
  assert.equal((await handle(await req('/ATLAS_Voice.html', { headers: nav, token: null }), ENV, 'PAGE')).status, 401, 'still behind Access');
});

test('Z /api/directory/push: bearer secret (constant-time), BLOCKED_EXTERNAL in test mode, forwarded as system in production; bounded body', async () => {
  const c = capture(), SECRET = 'push-secret-value', body = JSON.stringify({ batch: 'a'.repeat(32), part: 1, final: true, rows: [{ email: 'jane@example.com', name: 'Jane' }] });
  const tid = '11111111-1111-4111-8111-111111111111';
  const test_ = { ...ENV, LIBRARY: c.stub, DIRECTORY_PUSH_SECRET: SECRET }, prod = { ...test_, DATA_MODE: 'production', ATLAS_SYSTEM_TENANT: tid };
  const push = (auth, env, data = body, headers = {}) => handle(new Request(ORIGIN + '/api/directory/push', { method: 'POST', body: data, headers: { ...(auth ? { Authorization: auth } : {}), ...headers } }), env, '');
  for (const [auth, env] of [[null, test_], ['Bearer wrong-secret-value', prod], ['Bearer ' + SECRET, { ...prod, DIRECTORY_PUSH_SECRET: '' }], ['Bearer ' + SECRET, { ...prod, LIBRARY: undefined }], [SECRET + 'x', prod]]) {
    const r = await push(auth, env); assert.equal(r.status, 401, String(auth)); assert.deepEqual(await r.json(), { error: 'Unauthorized.' });
  }
  assert.equal(c.req, null);
  const blocked = await push('Bearer ' + SECRET, test_), b = await blocked.json();
  assert.equal(blocked.status, 503); assert.equal(b.status, 'BLOCKED_EXTERNAL'); assert.match(b.reason, /DATA_MODE/); assert.ok(b.needs.length); assert.equal(c.req, null, 'never forwarded in test mode');
  const ok = await push('Bearer ' + SECRET, prod, body, { 'x-atlas-role': 'admin', 'x-atlas-user': 'boss@example.com', 'x-atlas-idp': 'eyJuYW1lIjoiQm9zcyJ9', 'cf-access-jwt-assertion': 'x' });
  assert.equal(ok.status, 200); assert.equal(new URL(c.req.url).pathname, '/api/library/directory/import'); assert.equal(c.req.method, 'POST'); assert.equal(c.body, body);
  assert.deepEqual(['x-atlas-user', 'x-atlas-role', 'x-atlas-email', 'x-atlas-idp', 'x-atlas-tenant', 'x-atlas-tenant-enforced'].map(h => c.req.headers.get(h)), ['dna-push', 'system', '', 'e30', tid, '1'], 'identity and the configured tenant are set by the Worker only');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  c.req = null;
  assert.equal((await push('Bearer ' + SECRET, prod, JSON.stringify({ rows: 'x'.repeat(262200) }))).status, 413); assert.equal(c.req, null);
  assert.equal((await push('Bearer ' + SECRET, prod, '{}', { 'Content-Length': '999999' })).status, 413, 'the declared length is checked first');
  assert.equal((await handle(new Request(ORIGIN + '/api/directory/push', { headers: { Authorization: 'Bearer ' + SECRET } }), prod, '')).status, 401, 'GET is not the push: it falls through to Access');
});

test('system ingress uses only ATLAS_SYSTEM_TENANT: missing, malformed, mismatch and a tenant-shaped token never reach the library', async () => {
  const tid = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  let calls = 0;
  const stub = { idFromName: n => n, get: () => ({ fetch: () => { calls += 1; return new Response('{"id":"x"}', { status: 201 }); } }) };
  const base = { ...ENV, TRIGGER_SECRET: 's3cret-value', DIRECTORY_PUSH_SECRET: 'push-secret', DATA_MODE: 'production', LIBRARY: stub };
  const trigger = (env, { auth = 'Bearer s3cret-value', body = '{"email":"a@b.co","reason":"project_end"}', headers = {} } = {}) =>
    handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body, headers: { Authorization: auth, ...headers } }), env, '');
  const pushBody = JSON.stringify({ batch: 'a'.repeat(32), part: 1, final: true, rows: [{ email: 'jane@example.com', name: 'Jane' }] });
  const push = (env, { auth = 'Bearer push-secret', body = pushBody, headers = {} } = {}) =>
    handle(new Request(ORIGIN + '/api/directory/push', { method: 'POST', body, headers: { Authorization: auth, ...headers } }), env, '');
  for (const [name, env] of [['missing', base], ['malformed', { ...base, ATLAS_SYSTEM_TENANT: 'not-a-tenant' }]]) {
    const trig = await trigger(env), pushed = await push(env);
    assert.equal(trig.status, 503, name); assert.match((await trig.json()).error, /ATLAS_SYSTEM_TENANT/);
    assert.equal(pushed.status, 503, name); assert.match((await pushed.json()).error, /ATLAS_SYSTEM_TENANT/);
  }
  assert.equal(calls, 0, 'configuration errors do not call the library');
  const scoped = { ...base, ATLAS_SYSTEM_TENANT: tid };
  for (const extra of [{ body: JSON.stringify({ email: 'a@b.co', reason: 'project_end', tenant: other }) }, { headers: { 'x-atlas-tenant': other } }]) {
    const trig = await trigger(scoped, extra);
    assert.equal(trig.status, 403, JSON.stringify(extra)); assert.match((await trig.json()).error, /configured tenant/);
  }
  const pushed = await push(scoped, { headers: { 'x-atlas-tenant': other } });
  assert.equal(pushed.status, 403); assert.equal(calls, 0, 'a mismatched tenant does not call the library');
  const token = await trigger(scoped, { auth: 'Bearer ' + tid });
  assert.equal(token.status, 401); assert.equal(calls, 0, 'a tenant id is not a system token');
  const ok = await trigger(scoped, { body: JSON.stringify({ email: 'a@b.co', reason: 'project_end', tenant: tid.toUpperCase() }) });
  assert.equal(ok.status, 201); assert.equal(calls, 1, 'the configured tenant is the only one forwarded');
  const imported = await push(scoped);
  assert.equal(imported.status, 201); assert.equal(calls, 2);
});

test('Z DATA_MODE: the test banner and the readiness string follow it; nothing else changes', async () => {
  const page = "<meta http-equiv=x content=\"connect-src 'self';\"><script id=\"atlas-runtime\" type=\"application/json\">{}</script><script>/* page */</script></body>";
  for (const [env, banner, readiness] of [[ENV, true, 'edge-deployment-test-data-only'], [{ ...ENV, DATA_MODE: 'Production' }, true, 'edge-deployment-test-data-only'],
    [{ ...ENV, DATA_MODE: 'production' }, false, 'production']]) {
    const html = await (await handle(await req('/'), env, page)).text(), boot = await (await handle(await req('/api/bootstrap'), env, page)).json();
    assert.equal(html.includes('TEST DEPLOYMENT · SYNTHETIC DATA ONLY'), banner, JSON.stringify(env.DATA_MODE)); assert.equal(boot.readiness, readiness);
    const runtime = JSON.parse(/<script id="atlas-runtime" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(typeof runtime.subjectKey, 'string'); assert.ok(runtime.subjectKey.length > 0);
  }
});

test('Z /api/transcribe consent gate (D1): the prompt header on every request; `always` needs a stored consent read with the verified identity', async () => {
  const runs = [], AI = { async run(model) { runs.push(model); return { results: { channels: [{ alternatives: [{ transcript: 'a question' }] }] } }; } };
  let reply = () => new Response(JSON.stringify({ spokenAsk: null })), asked = null;
  const LIBRARY = { idFromName: n => n, get: () => ({ fetch: async r => { asked = r; return reply(); } }) };
  const env = { ...ENV, STT_MODEL: 'stt', AI, LIBRARY, ADMIN_EMAILS: '' }, boot = await (await handle(await req('/api/bootstrap'), env, '', APPROVED)).json();
  const post = async (consent, e = env) => handle(new Request(ORIGIN + '/api/transcribe', { method: 'POST', body: new Uint8Array(9600),
    headers: { 'cf-access-jwt-assertion': await jwt(), Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'Content-Type': 'audio/L16;rate=24000', ...(consent === null ? {} : { 'X-Atlas-Consent': consent }) } }), e, '', APPROVED);
  const log = console.log; console.log = () => {};
  try {
    for (const bad of [null, '', 'spoken-ask-v2; once', 'spoken-ask-v1; maybe', 'spoken-ask-v1', 'once', 'spoken-ask-v1; once; always']) {
      const r = await post(bad); assert.equal(r.status, 403, String(bad)); assert.deepEqual(await r.json(), { error: 'Voice questions need your consent first.' });
    }
    assert.deepEqual(runs, [], 'no consent header: nothing reaches speech-to-text');
    assert.equal((await post('spoken-ask-v1; once')).status, 200); assert.equal((await post('spoken-ask-v1;once')).status, 200); assert.equal(asked, null, '`once` needs no stored consent');
    const always = await post('spoken-ask-v1; always');
    assert.equal(always.status, 403, 'always without a stored consent');
    assert.equal(new URL(asked.url).pathname, '/api/library/profile/consents'); assert.equal(asked.method, 'GET');
    assert.deepEqual(['x-atlas-user', 'x-atlas-role', 'x-atlas-email'].map(h => asked.headers.get(h)), ['tony@example.com', 'user', 'tony@example.com'], 'the verified identity only');
    reply = () => new Response(JSON.stringify({ spokenAsk: { version: 1, at: '2026-09-29T00:00:00.000Z' } }));
    assert.equal((await post('spoken-ask-v1; always')).status, 200, 'a stored consent allows it');
    for (const [name, r] of [['not READY', () => new Response('{"error":"x"}', { status: 404 })], ['wrong version', () => new Response('{"spokenAsk":{"version":2}}')], ['store down', () => { throw new Error('down'); }], ['not JSON', () => new Response('nope')]]) {
      reply = r; assert.equal((await post('spoken-ask-v1; always')).status, 403, name);
    }
    assert.equal((await post('spoken-ask-v1; always', { ...env, LIBRARY: undefined })).status, 403, 'no library: no stored consent');
    assert.equal(runs.length, 3);
  } finally { console.log = log; }
});

// D1 end to end (Z-S2): "Always allow for me" is stored through the Worker's library forward in the person's own profile
// (real LibraryStore routes, real profile.js), and /api/transcribe reads it back with the verified identity before any
// speech-to-text. Another person's stored consent never counts; revoking stops it at once.
import * as profileModule from '../src/profile.js';
test('Z spoken Ask end to end: the stored "always" consent is the one the Worker checks; per person; revocable', async () => {
  const runs = [], AI = { async run(model) { runs.push(model); return { results: { channels: [{ alternatives: [{ transcript: 'which claims projects' }] }] } }; } };
  const lib = new Library(memorySql(), {}), LIBRARY = { idFromName: n => n, get: () => ({ fetch: r => libraryRoutes(r, lib, { env: {} }) }) };
  const tid = '11111111-1111-4111-8111-111111111111', tony = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kim = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const env = { ...ENV, STT_MODEL: 'stt', AI, LIBRARY, ADMIN_EMAILS: '', IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: tid };
  const as = async (email, oid, path, init = {}) => {
    const token = await jwt({ sub: 'ignored-' + email, email, custom: { tid, oid, roles: [] } }), boot = await (await handle(await req('/api/bootstrap', { token }), env, '', APPROVED)).json();
    return handle(new Request(ORIGIN + path, { ...init, headers: { 'cf-access-jwt-assertion': token, Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, ...(init.headers || {}) } }), env, '', APPROVED);
  };
  const consent = (email, oid, granted) => as(email, oid, '/api/library/profile/consent', { method: 'POST', body: JSON.stringify({ kind: 'spokenAsk', version: 1, granted }), headers: { 'Content-Type': 'application/json' } });
  const ask = (email, oid, kind) => as(email, oid, '/api/transcribe', { method: 'POST', body: new Uint8Array(9600), headers: { 'Content-Type': 'audio/L16;rate=24000', 'X-Atlas-Consent': 'spoken-ask-v1; ' + kind } });
  const log = console.log; console.log = () => {};
  try {
    if (!profileModule.READY) { assert.equal((await ask('tony@example.com', tony, 'always')).status, 403, 'no stored consent while the profile module is not READY'); return; }
    assert.equal((await ask('tony@example.com', tony, 'always')).status, 403, 'nothing stored yet');
    const granted = await consent('tony@example.com', tony, true);
    assert.equal(granted.status, 200); assert.equal((await granted.json()).consents.spokenAsk.version, 1);
    const ok = await ask('tony@example.com', tony, 'always');
    assert.equal(ok.status, 200); assert.equal((await ok.json()).text, 'which claims projects');
    assert.equal((await ask('kim@example.com', kim, 'always')).status, 403, "another person's consent never counts");
    assert.equal((await ask('kim@example.com', kim, 'once')).status, 200, '`once` needs the prompt only');
    assert.equal((await consent('tony@example.com', tony, false)).status, 200);
    assert.equal((await ask('tony@example.com', tony, 'always')).status, 403, 'revoked: asked again next time');
    assert.equal(runs.length, 2, 'speech-to-text ran only for the two consented requests');
    const stored = lib.rows('SELECT subject, tenant, consents FROM profiles ORDER BY subject');
    assert.deepEqual(stored.map(r => [r.subject, r.tenant, JSON.parse(r.consents).spokenAsk ?? null]), [[`${tid}:${tony}`, tid, null]], 'one profile row for this tenant and subject; nothing stored for kim');
  } finally { console.log = log; }
});

test('Z D2: PDF conversion for briefs and sheets runs without PDF metadata', async () => {
  const calls = [], env = { ...ENV, AI: { toMarkdown: async (f, o) => { calls.push([f.name, o]); return { format: 'markdown', data: 'Brief text' }; } } };
  const boot = await (await handle(await req('/api/bootstrap'), env, '')).json();
  const r = await handle(new Request(ORIGIN + '/api/sheet/ingest', { method: 'POST', body: new Uint8Array([37, 80, 68, 70]), headers: { 'cf-access-jwt-assertion': await jwt(), Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'Content-Type': 'application/pdf', 'x-file-name': 'brief.pdf' } }), env, '');
  assert.equal(r.status, 200); assert.equal((await r.json()).text, 'Brief text');
  assert.deepEqual(calls, [['brief.pdf', { conversionOptions: { pdf: { metadata: false } } }]]);
  assert.equal(boot.features.pdfBriefs, boot.features.bids, 'pdfBriefs follows bids (no PDF_BRIEFS variable)');
});

test('tenant and persona headers from the browser are overwritten; a custom tenant claim is not a tenant', async () => {
  let fwd = null;
  const stub = { idFromName: () => 'g', get: () => ({ fetch: r => { fwd = r; return new Response('{}'); } }) };
  const env = { ...ENV, LIBRARY: stub };
  const tid = '11111111-1111-4111-8111-111111111111', oid = '99999999-8888-4777-8666-555555555555';
  const spoof = { 'x-atlas-tenant': '22222222-2222-4222-8222-222222222222', 'x-atlas-tenant-enforced': '0', 'x-atlas-role': 'user', 'x-atlas-user': 'forged@evil.example', 'x-atlas-email': 'forged@evil.example' };
  await handle(await signed('/api/library', { custom: { tid, oid, roles: ['ATLAS.Admin'], tenant: 'forged-tenant' } }, { headers: spoof }), { ...env, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: tid }, '');
  assert.equal(fwd.headers.get('x-atlas-tenant'), tid);
  assert.equal(fwd.headers.get('x-atlas-tenant-enforced'), '1');
  assert.equal(fwd.headers.get('x-atlas-role'), 'admin');
  assert.equal(fwd.headers.get('x-atlas-user'), `${tid}:${oid}`);
  assert.notEqual(fwd.headers.get('x-atlas-email'), 'forged@evil.example');
  await handle(await signed('/api/library', { sub: 'user-abc', email: 'tony@example.com', custom: { roles: ['ATLAS.Admin'], tenant: tid } }, { headers: spoof }), env, '');
  assert.equal(fwd.headers.get('x-atlas-tenant'), '', 'an Access token has no tid, so a custom tenant claim is ignored');
  assert.equal(fwd.headers.get('x-atlas-tenant-enforced'), '1');
  await handle(await signed('/api/library'), { ...env, ATLAS_TENANT_ISOLATION: 'local-synthetic' }, '');
  assert.equal(fwd.headers.get('x-atlas-tenant-enforced'), '0');
  await handle(await signed('/api/library?as=boss@evil.example&idp=' + encodeURIComponent(JSON.stringify({ roles: ['ATLAS.Admin'], tenant: tid })), { sub: 'user-abc', email: 'tony@example.com' }), env, '');
  assert.equal(fwd.headers.get('x-atlas-user'), 'tony@example.com');
  assert.equal(fwd.headers.get('x-atlas-role'), 'user', 'a production query string cannot grant a role');
  assert.equal(fwd.headers.get('x-atlas-tenant'), '');
  const bare = { ...env }; delete bare.ATLAS_ADMIN_ROLES; delete bare.ATLAS_PRESALES_ROLES; delete bare.ATLAS_REVIEWER_ROLES;
  await handle(await signed('/api/library', { sub: 'user-abc', email: 'tony@example.com', custom: { roles: ['ATLAS.Admin', 'ATLAS.Presales', 'ATLAS.Reviewer'] } }), bare, '');
  assert.equal(fwd.headers.get('x-atlas-role'), 'user', 'missing role config grants nobody');
  const boot = await (await handle(await signed('/api/bootstrap'), bare, '')).json();
  assert.equal(boot.admin, false);
  assert.equal(boot.privilege.ok, false);
});

test('production refuses local-synthetic and demo identity before any library fetch', async () => {
  let fetches = 0;
  const stub = { idFromName: () => 'g', get: () => ({ fetch: () => { fetches += 1; return new Response('{"opened":true}'); } }) };
  const base = { ...ENV, LIBRARY: stub, INTERVIEW: stub };
  const synthetic = await handle(await signed('/api/library'), { ...base, DATA_MODE: 'production', ATLAS_TENANT_ISOLATION: 'local-synthetic' }, '');
  assert.equal(synthetic.status, 503);
  assert.match((await synthetic.json()).error, /local-synthetic/);
  const demo = await handle(await signed('/api/memory'), { ...base, DATA_MODE: 'production', ATLAS_DEV_IDENTITY: '1' }, '');
  assert.equal(demo.status, 503);
  assert.match((await demo.json()).error, /ATLAS_DEV_IDENTITY/);
  const both = await handle(await signed('/api/voice', { headers: { Upgrade: 'websocket' } }), { ...base, DATA_MODE: 'production', ATLAS_TENANT_ISOLATION: 'local-synthetic', ATLAS_DEV_IDENTITY: 'yes' }, '');
  assert.equal(both.status, 503);
  assert.equal(fetches, 0, 'the durable object is not asked');
  const trigger = await handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer secret' } }), { ...base, DATA_MODE: 'production', ATLAS_TENANT_ISOLATION: 'local-synthetic', TRIGGER_SECRET: 'secret' }, '');
  assert.equal(trigger.status, 503);
  assert.equal(fetches, 0);
  const local = await handle(await signed('/api/library'), { ...base, ATLAS_TENANT_ISOLATION: 'local-synthetic', ATLAS_DEV_IDENTITY: '1' }, '');
  assert.equal(local.status, 200);
  assert.equal(fetches, 1, 'the local demo, without DATA_MODE=production, still reaches the library');
});

test('accepted privacy and profile delete variants without a subject tenant do not call the library', async () => {
  let calls = 0;
  const stub = { idFromName() { calls += 1; return 'g'; }, get() { calls += 1; return { fetch() { calls += 1; return new Response('{}'); } }; } };
  const env = { ...ENV, LIBRARY: stub };
  const boot = await (await handle(await req('/api/bootstrap'), env, '')).json();
  const accepted = [
    '/api/library/privacy/delete', '/api/library/privacy/delete/', '/api/library/privacy//delete', '/api/library/privacy/delete//',
    '/api/library//privacy/delete', '/api/library/privacy/delete/anything', '/api/library/privacy/delete?x=1', '/api/library/privacy/delete/?x=1',
    '/api/library/privacy/./delete', '/api/library/privacy/%2e/delete', '/api/library/privacy/%2E/delete', '/api/library/privacy/delete/.',
    '/api/library/profile/delete', '/api/library/profile/delete/', '/api/library/profile//delete', '/api/library/profile/delete?x=1', '/api/library/./profile/delete',
  ];
  for (const path of accepted) {
    const res = await handle(await signed(path, {}, { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json', 'x-atlas-tenant': 'abcdefab-cdef-4abc-8def-0123456789ab' } }), env, '');
    assert.equal(res.status, 403, path);
    assert.match((await res.json()).error, /verified tenant/);
  }
  assert.equal(calls, 0);
  const other = await handle(await signed('/API/library/privacy/delete', {}, { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json' } }), env, '');
  assert.equal(other.status, 404);
  assert.equal(calls, 0);
});

test('a path the library does not treat as a subject delete still reaches the library', async () => {
  let calls = 0;
  const stub = { idFromName() { calls += 1; return 'g'; }, get() { calls += 1; return { fetch() { calls += 1; return new Response('{}', { status: 200 }); } }; } };
  const env = { ...ENV, LIBRARY: stub };
  const boot = await (await handle(await req('/api/bootstrap'), env, '')).json();
  const forwarded = [
    '/api/library/privacy%2Fdelete', '/api/library/%70rivacy/delete', '/api/library/privacy/%64elete',
    '/api/library/Privacy/Delete', '/api/library/profile/delete/extra', '/api/library/journey',
  ];
  for (const path of forwarded) {
    const before = calls;
    const res = await handle(await signed(path, {}, { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json', 'x-atlas-tenant': 'abcdefab-cdef-4abc-8def-0123456789ab' } }), env, '');
    assert.equal(res.status, 200, path);
    assert.equal(calls - before, 3, path);
  }
});

test('a verified subject tenant is forwarded for delete variants and a client tenant is not', async () => {
  const seen = [];
  const stub = { idFromName(name) { return name; }, get: () => ({ fetch: r => { seen.push(r); return new Response('{"complete":false}'); } }) };
  const tid = 'abcdefab-cdef-4abc-8def-0123456789ab', oid = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111', spoof = 'cccccccc-dddd-4eee-8fff-000000000001';
  const env = { ...ENV, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: tid, LIBRARY: stub };
  const boot = await (await handle(await signed('/api/bootstrap', { custom: { tid, oid, roles: [] } }), env, '')).json();
  for (const path of ['/api/library/privacy/delete/anything', '/api/library/profile//delete', '/api/library/privacy/delete/?kept=1']) {
    const res = await handle(await signed(path, { custom: { tid, oid, roles: [] } }, { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'X-Atlas-CSRF': boot.csrf, 'content-type': 'application/json', 'x-atlas-tenant': spoof } }), env, '');
    assert.equal(res.status, 200, path);
  }
  assert.deepEqual(seen.map(r => r.headers.get('x-atlas-tenant')), [tid, tid, tid]);
  assert.deepEqual(seen.map(r => r.headers.get('x-atlas-user')), [`${tid}:${oid}`, `${tid}:${oid}`, `${tid}:${oid}`]);
  assert.equal(seen.some(r => r.headers.get('x-atlas-tenant') === spoof), false);
});
