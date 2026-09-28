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
const ENV = { ORIGIN, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, CSRF_SECRET: 'test-secret', TALKER_MODEL: 'talker', TTS_VOICE: 'harmonia' };
const req = async (path, { token, headers = {}, host = ORIGIN } = {}) => new Request(host + path, { headers: { ...(token === undefined ? { 'cf-access-jwt-assertion': await jwt() } : token ? { 'cf-access-jwt-assertion': token } : {}), ...headers } });

test('Access JWT verification accepts only valid, correctly scoped tokens', async () => {
  const ok = await verifyAccess(await req('/'), ENV);
  assert.deepEqual(ok, { sub: 'user-abc', email: 'tony@example.com' });
  for (const bad of [await jwt({ aud: ['other'] }), await jwt({ exp: 1 }), await jwt({ iss: 'https://evil.example' }), await jwt({ sub: '' }),
    (await jwt()).slice(0, -4) + 'AAAA', await jwt({}, { alg: 'none', kid: 'k1' }), await jwt({}, { alg: 'RS256', kid: 'unknown' })])
    assert.equal(await verifyAccess(await req('/', { token: bad }), ENV), null);
  assert.equal(await verifyAccess(await req('/', { token: null }), ENV), null);
  assert.equal(await verifyAccess(await req('/'), { ...ENV, ACCESS_AUD: '' }), null);
});

test('routes fail closed and serve the real page with runtime + CSP', async () => {
  const page = "<meta http-equiv=x content=\"connect-src 'self';\"><script>/* SERVER_RUNTIME */</script></body>";
  assert.equal((await handle(await req('/', { token: null }), ENV, page)).status, 401);
  assert.equal((await handle(await req('/', { host: 'https://evil.example' }), ENV, page)).status, 403);
  assert.equal((await handle(await req('/'), { ...ENV, CSRF_SECRET: '' }, page)).status, 500);
  const r = await handle(await req('/'), ENV, page), html = await r.text();
  assert.equal(r.status, 200); assert.ok(html.includes('window.ATLAS_RUNTIME={"subjectKey"') && html.includes('"authMode":"access"'));
  assert.ok(html.includes("connect-src 'self' wss://atlas.example.workers.dev;") && html.includes('SYNTHETIC DATA ONLY'));
  assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'") && r.headers.get('cache-control') === 'no-store');
  const boot = await (await handle(await req('/api/bootstrap'), ENV, page)).json();
  assert.equal(boot.provider, 'workers'); assert.equal(boot.csrf.length, 64); assert.equal(boot.identity.mode, 'access');
  assert.equal((await handle(await req('/api/wiki'), ENV, page)).status, 404);
});

test('voice upgrade: origin enforced, CSRF injected by the Worker, one DO per person', async () => {
  let forwarded = null, name = null;
  const env = { ...ENV, INTERVIEW: { idFromName: n => { name = n; return 'id'; }, get: () => ({ fetch: r => { forwarded = r; return new Response('ok'); } }) } };
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

test('admin mode comes only from the verified sign-in email; a browser cannot claim it; no provider branding', async () => {
  let forwarded = null;
  const env = { ...ENV, ADMIN_EMAILS: 'Someone@x.com, TONY@example.com', INTERVIEW: { idFromName: () => 'id', get: () => ({ fetch: r => { forwarded = r; return new Response('ok'); } }) } };
  const voice = async (claims, headers = {}) => { forwarded = null; await handle(new Request(ORIGIN + '/api/voice', { headers: { 'cf-access-jwt-assertion': await jwt(claims), Upgrade: 'websocket', Origin: ORIGIN, ...headers } }), env, ''); return forwarded.headers.get('x-atlas-admin'); };
  assert.equal(await voice({}), '1');
  assert.equal(await voice({ email: 'other@example.com' }, { 'x-atlas-admin': '1' }), '0');
  assert.equal(await voice({}, {}), '1');
  assert.equal(await (async () => { forwarded = null; await handle(new Request(ORIGIN + '/api/voice', { headers: { 'cf-access-jwt-assertion': await jwt(), Upgrade: 'websocket', Origin: ORIGIN, 'x-atlas-admin': '1' } }), { ...env, ADMIN_EMAILS: '' }, ''); return forwarded.headers.get('x-atlas-admin'); })(), '0');
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
  const env = { ...ENV, REVIEWER_EMAILS: 'rev@example.com', LIBRARY: { idFromName: n => n, get: () => ({ fetch: r => { forwarded = r; return new Response('{"ok":true}'); } }) } };
  assert.equal((await handle(await req('/api/library'), ENV, '')).status, 404);
  await handle(await req('/api/library', { headers: { 'x-atlas-user': 'boss@example.com', 'x-atlas-role': 'admin' } }), env, '');
  assert.equal(forwarded.headers.get('x-atlas-user'), 'tony@example.com'); assert.equal(forwarded.headers.get('x-atlas-role'), 'user');
  const boot = await (await handle(await req('/api/bootstrap'), env, '')).json();
  const post = async headers => { forwarded = null; return handle(new Request(ORIGIN + '/api/library', { method: 'POST', body: '{}', headers: { 'cf-access-jwt-assertion': await jwt({ email: 'rev@example.com', sub: 'user-rev' }), Origin: ORIGIN, ...headers } }), env, ''); };
  assert.equal((await post({ 'X-Atlas-CSRF': 'wrong' })).status, 403); assert.equal(forwarded, null);
  assert.equal((await post({ 'X-Atlas-CSRF': boot.csrf })).status, 403, 'CSRF is bound to the signed-in subject');
  const revBoot = await (await handle(new Request(ORIGIN + '/api/bootstrap', { headers: { 'cf-access-jwt-assertion': await jwt({ email: 'rev@example.com', sub: 'user-rev' }) } }), env, '')).json();
  assert.equal((await post({ 'X-Atlas-CSRF': revBoot.csrf })).status, 200); assert.equal(forwarded.headers.get('x-atlas-role'), 'reviewer');
  assert.equal(revBoot.library, true);
  const TID = '11111111-2222-3333-4444-555555555555', OID = '99999999-8888-7777-6666-555555555555', entra = { ...env, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: TID, ADMIN_EMAILS: 'tony@example.com' };
  const asEntra = async roles => { forwarded = null; await handle(new Request(ORIGIN + '/api/library', { headers: { 'cf-access-jwt-assertion': await jwt({ custom: { tid: TID, oid: OID, roles } }) } }), entra, ''); return forwarded.headers; };
  const h1 = await asEntra([]); assert.equal(h1.get('x-atlas-role'), 'user', 'Entra: an email on ADMIN_EMAILS grants nothing'); assert.equal(h1.get('x-atlas-user'), `${TID}:${OID}`);
  assert.equal((await asEntra(['ATLAS.Reviewer'])).get('x-atlas-role'), 'reviewer'); assert.equal((await asEntra(['ATLAS.Admin'])).get('x-atlas-role'), 'admin');
});

test('PM trigger endpoint: bearer secret only (constant-time), system role only via the Worker; browsers cannot claim it', async () => {
  let forwarded = null;
  const env = { ...ENV, TRIGGER_SECRET: 's3cret-value', LIBRARY: { idFromName: n => n, get: () => ({ fetch: r => { forwarded = r; return new Response('{"id":"x"}', { status: 201 }); } }) } };
  const trig = (auth, e = env) => handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body: '{"email":"a@b.co","reason":"project_end"}', headers: auth ? { Authorization: auth } : {} }), e, '');
  assert.equal((await trig()).status, 401); assert.equal((await trig('Bearer wrong-value!')).status, 401); assert.equal((await trig('Bearer s3cret-value', { ...env, TRIGGER_SECRET: '' })).status, 401);
  assert.equal(forwarded, null);
  const ok = await trig('Bearer s3cret-value'); assert.equal(ok.status, 201);
  assert.equal(forwarded.headers.get('x-atlas-role'), 'system'); assert.equal(new URL(forwarded.url).pathname, '/api/library/trigger');
  forwarded = null;
  await handle(await req('/api/library/scan-stale', { headers: { 'x-atlas-role': 'system', 'x-atlas-user': 'atlas-cron' } }), env, '');
  assert.equal(forwarded.headers.get('x-atlas-role'), 'user'); assert.equal(forwarded.headers.get('x-atlas-user'), 'tony@example.com');
});


test('memory routes: forwarded to the person\'s own Durable Object with a server-derived bank; POST needs CSRF; bootstrap reports memory', async () => {
  let forwarded = null, name = null;
  const env = { ...ENV, HINDSIGHT_URL: 'https://hs.example', HINDSIGHT_API_KEY: 'k', INTERVIEW: { idFromName: n => { name = n; return n; }, get: () => ({ fetch: r => { forwarded = r; return new Response('{}'); } }) } };
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
