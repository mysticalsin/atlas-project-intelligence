// v2.2 V2: the admin Voice settings. The ElevenLabs key is sealed in the LibraryStore, written by an admin only, never shown back; the routes are admin only with Origin and CSRF; the voice
// engine reads the effective choice through voiceConfig. ElevenLabs is never called for real: a fake fetch stands in (and refuses every other host).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV, ORIGIN, session, ns } from './security-harness.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { exportMine } from '../src/subject-rights.js';
import { memorySql } from './sqlite.js';
import * as S from '../src/settings.js';

const KEY = 'xi-TESTKEY-9d8c7b6a5f4e3d2c1b0a', BAD = 'xi-WRONGKEY-0000000000000000', SECRET = 'a-settings-secret-of-at-least-32-characters!';
const VOICE = 'EXAVITQu4vr4xnSDxMaL', VOICE2 = 'pNInz6obpgDQGcFmaJgB';
const realFetch = globalThis.fetch;

// A fake ElevenLabs. `calls` records every request (url, method, headers, body); a request to any other host is refused so nothing can leave the test.
function fakeEleven({ goodKeys = [KEY], user = true, voices = null, fail = null } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host !== 'api.elevenlabs.io') return realFetch(url, init);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: u, method: init.method || 'GET', headers, body: init.body ? JSON.parse(init.body) : null, redirect: init.redirect, hasSignal: !!init.signal });
    if (fail) return fail(u, init);
    if (!goodKeys.includes(headers['xi-api-key'])) return new Response(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'echo ' + headers['xi-api-key'] } }), { status: 401 });
    if (u.pathname === '/v2/voices') return new Response(JSON.stringify(voices || { voices: [
      { voice_id: VOICE, name: 'Sarah', category: 'premade', labels: { accent: 'american', gender: 'female', age: 'young', use_case: 'conversational' }, preview_url: 'https://storage.example/p.mp3', verified_languages: [{ language: 'en' }, { language: 'es' }] },
      { voice_id: '../v1/user', name: 'Evil path', category: 'x' }, { voice_id: VOICE2, name: 'Adam <b>bold</b>', category: 'premade', labels: {} }], has_more: true, next_page_token: 'tok_123' }));
    if (u.pathname === '/v1/user') return user ? new Response(JSON.stringify({ subscription: { tier: 'creator', character_count: 1200, character_limit: 100000, status: 'active' }, xi_api_key: 'should-not-pass' })) : new Response('{}', { status: 401 });
    if (/^\/v1\/text-to-speech\/[A-Za-z0-9]+$/.test(u.pathname)) return new Response(new Uint8Array(9600), { headers: { 'Content-Type': 'audio/pcm' } });
    return new Response('{}', { status: 404 });
  };
  return calls;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

// One world: the Worker (handle) over a real Library (node:sqlite) and a stub for each person's Interview object that applies the rate limits it is asked to.
function world(extra = {}, { limits = {} } = {}) {
  const lib = new Library(memorySql()), counts = new Map(), stubCalls = { n: 0 };
  const LIBRARY = { calls: [], idFromName: n => n, get() { return { fetch: async r => { LIBRARY.calls.push(r); stubCalls.n++; return libraryRoutes(r, lib, { env: world.env }); } }; } };
  const INTERVIEW = ns(async r => {
    const p = new URL(r.url).pathname;
    if (p === '/api/limit') { const { checks } = await r.json(); for (const c of checks) { const n = (counts.get(c.bucket) || 0) + 1; counts.set(c.bucket, n); if (n > (limits[c.bucket] ?? 1e9)) return new Response(JSON.stringify({ retryAfter: 42 }), { status: 429 }); } return new Response('{}'); }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
  const env = { ...ENV, ADMIN_EMAILS: 'tony@example.com', LIBRARY, INTERVIEW, SETTINGS_KEY: SECRET, TTS_MODEL: 'tts', TTS_VOICE: 'v', AI: { run: async () => new Uint8Array(9600) }, ...extra };
  world.env = env;
  return { env, lib, LIBRARY, stubCalls };
}
const put = (me, path, body, o = {}) => me.go(path, { method: 'PUT', body: JSON.stringify(body), ...o });
const post = (me, path, body, o = {}) => me.go(path, { method: 'POST', body: JSON.stringify(body), ...o });
const saveKey = (me, key = KEY) => put(me, '/api/admin/voice/key', { key });
const everything = async (lib, me, extra = []) => JSON.stringify([lib.rows('SELECT * FROM audit'), me.logs, extra]); // every audit row, every security-log line, and what the caller adds

// ------------------------------------------------------------------ the seal
test('V2 seal: AES-GCM round trip; a fresh IV every time; nothing readable in the record; a different name (AAD), a changed record or a missing secret opens nothing', async () => {
  const env = { SETTINGS_KEY: SECRET }, a = await S.seal(env, KEY), b = await S.seal(env, KEY);
  assert.equal(a.v, 1); assert.match(a.kid, /^[0-9a-f]{12}$/); assert.notEqual(a.iv, b.iv, 'a random IV per write'); assert.notEqual(a.ct, b.ct);
  assert.ok(!JSON.stringify(a).includes(KEY) && !JSON.stringify(a).includes('TESTKEY'));
  assert.equal(await S.open(env, a), KEY); assert.equal(await S.open(env, b), KEY);
  assert.equal(await S.open(env, a, 'openai'), null, 'the additional data binds the record to its name: atlas-settings:v1:elevenlabs');
  assert.equal(new TextDecoder().decode(S.aadOf('elevenlabs')), 'atlas-settings:v1:elevenlabs');
  const flipped = { ...a, ct: a.ct.slice(0, -4) + (a.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') }; assert.equal(await S.open(env, flipped), null, 'a changed record fails the authentication tag');
  assert.equal(await S.open(env, { ...a, iv: b.iv }), null); assert.equal(await S.open({ SETTINGS_KEY: SECRET + 'x' }, a), null, 'a different secret');
  assert.equal(await S.open(env, null), null); assert.equal(await S.open(env, { ...a, v: 2 }), null); assert.equal(await S.open(env, { ...a, kid: 'zz' }), null);
  await assert.rejects(S.seal({}, KEY), /cannot be stored/); await assert.rejects(S.seal({ SETTINGS_KEY: 'short' }, KEY), /cannot be stored/);
  assert.equal(S.settingsKeyState({ SETTINGS_KEY: 'short' }), 'weak'); assert.equal(S.settingsKeyState({}), 'missing'); assert.equal(S.settingsKeyState({ SETTINGS_KEY: SECRET, ATLAS_SETTINGS_KEYS: 'off' }), 'off'); assert.equal(S.settingsKeyState(env), 'ok');
});

test('V2 seal rotation: a record sealed under the old secret opens while it is named in SETTINGS_KEY_PREVIOUS, not otherwise; the kid names the secret and a new write uses the new one', async () => {
  const OLD = 'the-old-settings-secret-also-32-chars-long!!', now = { SETTINGS_KEY: SECRET }, old = { SETTINGS_KEY: OLD };
  const sealed = await S.seal(old, KEY), kidOld = await S.currentKid(old), kidNew = await S.currentKid(now);
  assert.equal(sealed.kid, kidOld); assert.notEqual(kidOld, kidNew);
  assert.equal(await S.open(now, sealed), null, 'rotated without the previous value: unreadable, never a wrong answer');
  assert.equal(await S.open({ ...now, SETTINGS_KEY_PREVIOUS: 'unrelated-secret-of-more-than-32-characters, ' + OLD }, sealed), KEY);
  assert.equal((await S.seal(now, KEY)).kid, kidNew);
});

// ------------------------------------------------------------------ the routes
test('V2 routes: every route answers a non-admin 403 (logged as a code), a signed-out caller 401; the LibraryStore settings are not reachable from a browser at all', async () => {
  const calls = fakeEleven(), { env } = world({ ADMIN_EMAILS: 'someone-else@example.com' }), me = await session(env);
  const all = [['GET', '/api/admin/voice'], ['PUT', '/api/admin/voice'], ['PUT', '/api/admin/voice/key'], ['DELETE', '/api/admin/voice/key'], ['GET', '/api/admin/voice/voices'], ['POST', '/api/admin/voice/test'], ['GET', '/api/admin/voice/anything'], ['POST', '/api/admin/voice/key']];
  for (const [method, path] of all) {
    const res = await me.go(path, { method, ...(method === 'GET' ? {} : { body: JSON.stringify({ key: KEY, choice: 'aura' }) }) });
    assert.equal(res.status, 403, method + ' ' + path); const text = await res.text(); assert.ok(!text.includes(KEY) && !/voice_id|keyStored|elevenlabs_key/.test(text));
    assert.equal((await me.go(path, { method, signed: false, csrf: false })).status, 401, 'signed out: ' + method + ' ' + path);
  }
  assert.ok(me.logs.filter(l => l.event === 'access_denied' && l.reason === 'ADMIN_ONLY').length >= all.length);
  assert.equal(calls.length, 0, 'nothing reached ElevenLabs');
  const admin = await session(world().env);
  for (const path of ['/api/settings', '/api/settings/voice', '/api/library/settings', '/api/settings/put']) { const r = await admin.go(path); assert.notEqual(r.status, 200, path); assert.ok(!(await r.text()).includes('"settings"'), path); }
  assert.equal((await admin.go('/api/settings/put', { method: 'POST', body: JSON.stringify({ name: 'elevenlabs_key', value: 'x' }) })).status < 400, false, 'a browser cannot write the store directly');
});

test('V2 routes: Origin and the CSRF token are required on every state change; nothing is stored or called without them', async () => {
  const calls = fakeEleven(), { env, lib } = world(), me = await session(env);
  const writes = [['PUT', '/api/admin/voice', { choice: 'aura' }], ['PUT', '/api/admin/voice/key', { key: KEY }], ['DELETE', '/api/admin/voice/key', {}], ['POST', '/api/admin/voice/test', {}]];
  for (const [method, path, body] of writes) {
    assert.equal((await me.go(path, { method, body: JSON.stringify(body), csrf: false })).status, 403, 'no token: ' + path);
    assert.equal((await me.go(path, { method, body: JSON.stringify(body), csrf: 'wrong' })).status, 403, 'wrong token: ' + path);
    assert.equal((await me.go(path, { method, body: JSON.stringify(body), origin: 'https://evil.example' })).status, 403, 'wrong origin: ' + path);
    assert.equal((await me.go(path, { method, body: JSON.stringify(body), origin: false })).status, 403, 'no origin: ' + path);
  }
  assert.ok(me.logs.some(l => l.event === 'csrf_fail') && me.logs.some(l => l.event === 'origin_fail'));
  assert.equal(calls.length, 0); assert.deepEqual(lib.getSettings(), {}, 'nothing stored');
});

test('V2 key: an invalid key is refused and not stored; a valid one is checked with GET /v2/voices?page_size=1 (5 s, redirect manual), stored sealed, and never shown, logged, audited or exported', async () => {
  const calls = fakeEleven(), { env, lib } = world(), me = await session(env), consoleLines = [], log = console.log; console.log = (...a) => { consoleLines.push(a.join(' ')); };
  const seen = [];
  try {
    const bad = await saveKey(me, BAD); seen.push(await bad.clone().text());
    assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'KEY_INVALID');
    assert.deepEqual(lib.getSettings(), {}, 'an invalid key is not stored'); assert.ok(!JSON.stringify(me.logs).includes(BAD));
    assert.ok(me.logs.some(l => l.event === 'voice_settings' && l.reason === 'KEY_INVALID' && l.status === 400));
    assert.ok(lib.rows('SELECT action FROM audit').some(r => r.action === 'voice.key_invalid'));
    for (const junk of ['short', 'has space in it 12345', 'x'.repeat(300), '', 123, null]) assert.equal((await put(me, '/api/admin/voice/key', { key: junk })).status, 400, String(junk).slice(0, 10));
    assert.equal(calls.filter(c => c.headers['xi-api-key'] !== BAD).length, 0, 'a malformed key never leaves the Worker');

    calls.length = 0;
    const ok = await saveKey(me); const okText = await ok.text(); seen.push(okText);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
    const first = calls[0]; assert.equal(first.url.href, 'https://api.elevenlabs.io/v2/voices?page_size=1'); assert.equal(first.redirect, 'manual'); assert.ok(first.hasSignal, 'a timeout'); assert.equal(first.headers['xi-api-key'], KEY);
    assert.equal(calls[1].url.pathname, '/v1/user', 'then the optional tier and characters');
    const v = JSON.parse(okText).voice; assert.equal(v.keyStored, true); assert.equal(v.keyReadable, true); assert.equal(v.tier, 'creator'); assert.equal(v.charactersLimit, 100000); assert.match(v.validatedAt, /^\d{4}-/); assert.equal(v.choice, 'auto');
    assert.ok(!('apiKey' in v) && !okText.includes(KEY) && !okText.includes('should-not-pass'));
    const rows = lib.getSettings(); assert.ok(rows.elevenlabs_key && rows.voice); assert.ok(!rows.elevenlabs_key.value.includes(KEY) && !rows.voice.value.includes(KEY)); assert.equal(rows.elevenlabs_key.keyId, JSON.parse(rows.elevenlabs_key.value).kid);
    assert.equal(JSON.stringify(rows).includes('TESTKEY'), false);

    for (const [method, path, body] of [['GET', '/api/admin/voice'], ['GET', '/api/admin/voice/voices'], ['PUT', '/api/admin/voice', { choice: 'elevenlabs', voiceId: VOICE, voiceName: 'Sarah', modelId: 'eleven_flash_v2_5' }], ['GET', '/api/admin/voice'], ['POST', '/api/admin/voice/test', {}]]) {
      const r = await me.go(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); seen.push(r.headers.get('content-type') + ' ' + (r.headers.get('content-type')?.includes('audio') ? '(audio)' : await r.text()));
    }
    const exported = JSON.stringify(exportMine(lib, { email: 'tony@example.com', role: 'admin', mail: 'tony@example.com' }, 'ab'.repeat(16)));
    const dump = await everything(lib, me, [seen, exported, consoleLines]);
    assert.ok(!dump.includes(KEY), 'the key appears in no response, log line, audit row or export'); assert.ok(!dump.includes('TESTKEY') && !dump.includes('9d8c7b6a5f4e3d2c1b0a'));
    assert.ok(!seen.join('').includes(BAD));
    const audit = lib.rows('SELECT actor, action, detail FROM audit WHERE action LIKE ?', 'voice.%'); assert.deepEqual(audit.map(a => a.action).sort(), ['voice.key_invalid', 'voice.key_set', 'voice.provider_changed']);
    assert.ok(audit.every(a => !a.detail.includes(VOICE)), 'audit rows carry no values'); assert.ok(me.logs.some(l => l.event === 'voice_settings' && l.reason === 'KEY_SET'));
    assert.ok(me.logs.some(l => l.event === 'voice_settings' && l.reason === 'PROVIDER_CHANGED'));
  } finally { console.log = log; }
});

test('V2 key: an unreachable or erroring ElevenLabs decides nothing: 502, nothing stored; without SETTINGS_KEY (or with it off) a key cannot be stored and the status says why', async () => {
  fakeEleven({ fail: () => new Response('boom', { status: 503 }) }); const w = world(), me = await session(w.env);
  const r = await saveKey(me); assert.equal(r.status, 502); assert.equal((await r.json()).code, 'UPSTREAM_UNAVAILABLE'); assert.deepEqual(w.lib.getSettings(), {});
  fakeEleven({ fail: () => { throw new Error('network down ' + KEY); } }); const r2 = await saveKey(me); assert.equal(r2.status, 502); assert.ok(!(await r2.text()).includes(KEY));
  fakeEleven({ fail: () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }) }); assert.equal((await saveKey(me)).status, 502, 'a redirect is never followed or trusted');
  for (const [extra, code] of [[{ SETTINGS_KEY: '' }, 'SETTINGS_KEY_MISSING'], [{ SETTINGS_KEY: 'short' }, 'SETTINGS_KEY_MISSING'], [{ ATLAS_SETTINGS_KEYS: 'off' }, 'SETTINGS_KEYS_OFF']]) {
    const calls = fakeEleven(), w2 = world({ ...extra, ELEVENLABS_API_KEY: 'env-key-0123456789' }), m2 = await session(w2.env), res = await saveKey(m2);
    assert.equal(res.status, 409); assert.equal((await res.json()).code, code); assert.equal(calls.length, 0); assert.deepEqual(w2.lib.getSettings(), {});
    const st = (await (await m2.go('/api/admin/voice')).json()).voice; assert.equal(st.storable, false); assert.equal(st.keyEnv, true); assert.equal(st.keyAvailable, true, 'the key set by the operator still works');
  }
});

test('V2 settings PUT: provider, voice and model are validated; a voice id that could reach another path or host is refused; elevenlabs needs a key; audit rows carry no values', async () => {
  const calls = fakeEleven(), { env, lib } = world(), me = await session(env);
  assert.equal((await put(me, '/api/admin/voice', { choice: 'elevenlabs' })).status, 409, 'no key yet');
  assert.equal((await saveKey(me)).status, 200); calls.length = 0;
  const evil = ['../v1/user', 'a/b/c/d/e/f/g/h', 'abc', 'x'.repeat(41), 'abcdefghij?x=1', 'abcdefghij#frag', 'abcdefghi%2F..', 'abcdefghij ', '', 'abcdéfghij', '..', 123, null, ['EXAVITQu4vr4xnSDxMaL'], { id: VOICE }];
  for (const id of evil) assert.equal((await put(me, '/api/admin/voice', { voiceId: id })).status, 400, 'voice id ' + JSON.stringify(id));
  for (const id of evil) assert.equal((await post(me, '/api/admin/voice/test', { provider: 'elevenlabs', voiceId: id })).status, 400, 'test voice id ' + JSON.stringify(id));
  for (const bad of [{ choice: 'both' }, { choice: '' }, { modelId: 'eleven_v4_turbo' }, { modelId: '../x' }, {}, { choice: ['aura'] }]) assert.equal((await put(me, '/api/admin/voice', bad)).status, 400, JSON.stringify(bad));
  assert.equal(calls.length, 0, 'a refused id never became a request'); assert.equal((await put(me, '/api/admin/voice', { voiceId: VOICE }, { csrf: false })).status, 403);
  const ok = await put(me, '/api/admin/voice', { choice: 'elevenlabs', voiceId: VOICE, voiceName: 'Sar\u0000ah‮', modelId: 'eleven_multilingual_v2' }); assert.equal(ok.status, 200);
  const v = (await ok.json()).voice; assert.deepEqual([v.choice, v.provider, v.voiceId, v.voiceName, v.modelId, v.source], ['elevenlabs', 'elevenlabs', VOICE, 'Sarah', 'eleven_multilingual_v2', 'settings']);
  assert.equal((await put(me, '/api/admin/voice', { choice: 'aura' })).status, 200); assert.equal((await (await me.go('/api/admin/voice')).json()).voice.provider, 'aura');
  const audit = lib.rows('SELECT action, detail FROM audit WHERE action LIKE ?', 'voice.%'); assert.ok(audit.filter(a => a.action === 'voice.provider_changed').length >= 2); assert.ok(audit.every(a => !a.detail.includes(VOICE) && !a.detail.includes('Sarah')));
  assert.ok(me.logs.some(l => l.event === 'voice_settings' && l.reason === 'PROVIDER_CHANGED'));
  assert.equal((await put(me, '/api/admin/voice', { choice: 'aura' }, { body: 'x'.repeat(5000) })).status, 413);
});

test('V2 remove: DELETE removes the stored key and what was learned from it; the engine falls back; the audit row and the security event carry no value; removing twice is harmless', async () => {
  fakeEleven(); const { env, lib } = world(), me = await session(env); await saveKey(me); await put(me, '/api/admin/voice', { choice: 'elevenlabs', voiceId: VOICE });
  assert.equal((await S.voiceConfig(env, null, { now: 1 })).provider, 'elevenlabs');
  const r = await me.go('/api/admin/voice/key', { method: 'DELETE' }); assert.equal(r.status, 200); const v = (await r.json()).voice;
  assert.deepEqual([v.keyStored, v.keyAvailable, v.validatedAt, v.tier, v.provider], [false, false, '', '', 'aura']); assert.ok(!('elevenlabs_key' in lib.getSettings()));
  assert.equal((await S.voiceConfig(env, null, { now: 2, fresh: true })).provider, 'aura'); assert.equal((await me.go('/api/admin/voice/key', { method: 'DELETE' })).status, 200);
  assert.ok(lib.rows('SELECT action FROM audit').some(a => a.action === 'voice.key_removed')); assert.ok(me.logs.some(l => l.event === 'voice_settings' && l.reason === 'KEY_REMOVED'));
});

test('V2 voices: the picker list is proxied from the account with the stored key, mapped to a few safe fields (a bad id is dropped, no preview url, no raw upstream body); a search is sanitised; no key is a clear 409', async () => {
  const calls = fakeEleven(), { env } = world(), me = await session(env);
  assert.equal((await me.go('/api/admin/voice/voices')).status, 409);
  await saveKey(me); calls.length = 0;
  const r = await me.go('/api/admin/voice/voices?search=' + encodeURIComponent('Sar<ah>&x=1 "') + '&page=tok_123'); assert.equal(r.status, 200); const text = await r.text(), j = JSON.parse(text);
  assert.deepEqual(j.voices.map(v => v.id), [VOICE, VOICE2]); assert.deepEqual(j.voices[0], { id: VOICE, name: 'Sarah', category: 'premade', labels: ['american', 'female', 'young', 'conversational'], languages: ['en', 'es'] });
  assert.equal(j.voices[1].name, 'Adam <b>bold</b>', 'text, escaped by the page when it is shown'); assert.equal(j.nextToken, 'tok_123');
  assert.ok(!text.includes('preview_url') && !text.includes('storage.example') && !text.includes(KEY));
  const u = calls[0].url; assert.equal(u.origin + u.pathname, 'https://api.elevenlabs.io/v2/voices'); assert.equal(u.searchParams.get('page_size'), '100'); assert.equal(u.searchParams.get('search'), 'Sarahx1'); assert.equal(u.searchParams.get('next_page_token'), 'tok_123'); assert.equal(u.searchParams.get('x'), null);
  assert.equal((await me.go('/api/admin/voice/voices?page=' + encodeURIComponent('../../x'))).status, 200); assert.equal(calls.at(-1).url.searchParams.get('next_page_token'), null, 'a malformed page token is dropped');
  fakeEleven({ goodKeys: [] }); const bad = await me.go('/api/admin/voice/voices'); assert.equal(bad.status, 502); assert.ok(!(await bad.text()).includes('invalid_api_key'), 'the upstream body is never echoed');
});

test('V2 test voice: a fixed phrase through the chosen provider, returned as audio the page plays from a blob; the page cannot change the text; failures are plain and carry no upstream text', async () => {
  const calls = fakeEleven(), { env } = world(), me = await session(env);
  let r = await post(me, '/api/admin/voice/test', { text: 'EVIL TEXT' }); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/wav'); assert.equal(r.headers.get('x-atlas-provider'), 'aura'); assert.equal(r.headers.get('cache-control'), 'no-store');
  let bytes = new Uint8Array(await r.arrayBuffer()); assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF'); assert.equal(bytes.length, 44 + 9600); assert.equal(calls.length, 0, 'Workers AI, not ElevenLabs');
  assert.equal((await post(me, '/api/admin/voice/test', { provider: 'elevenlabs' })).status, 409, 'no key');
  await saveKey(me); await put(me, '/api/admin/voice', { choice: 'elevenlabs', voiceId: VOICE, modelId: 'eleven_flash_v2_5' }); calls.length = 0;
  r = await post(me, '/api/admin/voice/test', { text: 'EVIL TEXT', provider: 'elevenlabs', voiceId: VOICE2 }); assert.equal(r.status, 200); assert.equal(r.headers.get('x-atlas-provider'), 'elevenlabs');
  bytes = new Uint8Array(await r.arrayBuffer()); assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF'); assert.ok(!Buffer.from(bytes).includes(KEY));
  const c = calls[0]; assert.equal(c.url.pathname, '/v1/text-to-speech/' + VOICE2); assert.equal(c.url.searchParams.get('output_format'), 'pcm_24000'); assert.equal(c.body.text, S.TEST_PHRASE); assert.equal(c.body.model_id, 'eleven_flash_v2_5'); assert.equal(c.redirect, 'manual'); assert.equal(c.headers['xi-api-key'], KEY);
  r = await post(me, '/api/admin/voice/test', {}); assert.equal(r.headers.get('x-atlas-provider'), 'elevenlabs', 'the effective choice when none is named'); assert.equal(calls.at(-1).url.pathname, '/v1/text-to-speech/' + VOICE);
  fakeEleven({ fail: () => new Response(JSON.stringify({ detail: 'secret upstream ' + KEY }), { status: 429 }) }); r = await post(me, '/api/admin/voice/test', {}); assert.equal(r.status, 502); const t = await r.text(); assert.ok(!t.includes('secret upstream') && !t.includes(KEY)); assert.match(t, /slow down/);
  fakeEleven({ fail: () => new Response('x', { status: 500 }) }); r = await post(me, '/api/admin/voice/test', { provider: 'aura' }); assert.equal(r.status, 200, 'the Workers AI test does not depend on ElevenLabs');
  const deadAi = world({ AI: { run: async () => { throw new Error('binding down'); } } }), m2 = await session(deadAi.env); assert.equal((await post(m2, '/api/admin/voice/test', {})).status, 502);
});

test('V2 kill switches and limits: refused under ATLAS_READ_ONLY (reads still work), the three upstream routes stop under ATLAS_AI_OFF, and every route is rate limited with Retry-After', async () => {
  const calls = fakeEleven(), ro = world({ ATLAS_READ_ONLY: '1' }), me = await session(ro.env);
  for (const [method, path] of [['PUT', '/api/admin/voice'], ['PUT', '/api/admin/voice/key'], ['DELETE', '/api/admin/voice/key'], ['POST', '/api/admin/voice/test']]) {
    const res = await me.go(path, { method, body: JSON.stringify({ key: KEY, choice: 'aura' }) }); assert.equal(res.status, 503, path); assert.equal((await res.json()).code, 'READ_ONLY');
  }
  assert.equal((await me.go('/api/admin/voice')).status, 200); assert.equal(calls.length, 0); assert.deepEqual(ro.lib.getSettings(), {});
  const off = world({ ATLAS_AI_OFF: '1' }), m2 = await session(off.env);
  for (const [method, path, body] of [['PUT', '/api/admin/voice/key', { key: KEY }], ['GET', '/api/admin/voice/voices'], ['POST', '/api/admin/voice/test', {}]]) {
    const res = await m2.go(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.equal(res.status, 503, path); assert.equal((await res.json()).code, 'AI_OFF');
  }
  assert.equal(calls.length, 0, 'nothing left the Worker'); assert.equal((await m2.go('/api/admin/voice')).status, 200, 'the status read needs no model');
  const lim = world({}, { limits: { 'voice-test': 3, 'voice-key': 2, 'voice-set': 2, 'voice-voices': 1 } }), m3 = await session(lim.env); fakeEleven();
  for (let i = 0; i < 3; i++) assert.equal((await post(m3, '/api/admin/voice/test', {})).status, 200);
  const slow = await post(m3, '/api/admin/voice/test', {}); assert.equal(slow.status, 429); assert.equal(slow.headers.get('retry-after'), '42'); assert.ok(m3.logs.some(l => l.event === 'rate_limited' && l.bucket === 'voice-test'));
  await saveKey(m3); await saveKey(m3); assert.equal((await saveKey(m3)).status, 429, 'key attempts are limited, so the endpoint cannot be used to guess keys');
  await put(m3, '/api/admin/voice', { choice: 'aura' }); await put(m3, '/api/admin/voice', { choice: 'auto' }); assert.equal((await put(m3, '/api/admin/voice', { choice: 'aura' })).status, 429);
  await m3.go('/api/admin/voice/voices'); assert.equal((await m3.go('/api/admin/voice/voices')).status, 429);
});

test('V2 bootstrap and status: the admin status has no key and no part of one, whatever the source; an environment key is reported as a yes/no', async () => {
  fakeEleven(); const { env } = world({ ELEVENLABS_API_KEY: 'env-secret-key-ABCDEFGH' }), me = await session(env);
  const text = await (await me.go('/api/admin/voice')).text(), v = JSON.parse(text).voice;
  assert.equal(v.keyEnv, true); assert.equal(v.keyStored, false); assert.equal(v.keySource, 'env'); assert.equal(v.keyAvailable, true);
  assert.ok(!text.includes('env-secret-key') && !text.includes('ABCDEFGH')); assert.deepEqual(v.models.map(m => m.id), ['eleven_flash_v2_5', 'eleven_multilingual_v2']); assert.equal(v.storable, true); assert.equal(v.storableReason, 'OK');
  assert.equal(JSON.stringify(await S.voiceStatus(env, null, { fresh: true })).includes('ABCDEFGH'), false);
});

// ------------------------------------------------------------------ the contract for the voice engine
test('V2 voiceConfig: stored admin choice, then the environment, then Aura; ATLAS_SETTINGS_KEYS=off ignores the stored key; an unreadable stored key falls back; 60 second cache', async () => {
  fakeEleven(); const w = world(), me = await session(w.env), stub = w.LIBRARY.get();
  const cfg = (env, o = {}) => S.voiceConfig(env, stub, { fresh: true, ...o });
  // nothing at all
  assert.deepEqual({ ...(await cfg({ ...w.env, LIBRARY: undefined })) }, { provider: 'aura', source: 'none', choice: 'auto' });
  // environment only: the key is available to the engine (auto: other languages), English stays Aura unless the operator says ELEVENLABS_PROVIDER=elevenlabs
  const envOnly = { ...w.env, ELEVENLABS_API_KEY: 'env-key-0123456789', ELEVENLABS_VOICE_ID: VOICE2, ELEVENLABS_MODEL: 'eleven_multilingual_v2' };
  assert.deepEqual({ ...(await cfg(envOnly)), elevenlabs: { ...(await cfg(envOnly)).elevenlabs } }, { provider: 'aura', elevenlabs: { apiKey: 'env-key-0123456789', voiceId: VOICE2, modelId: 'eleven_multilingual_v2' }, source: 'env', choice: 'auto' });
  assert.equal((await cfg({ ...envOnly, ELEVENLABS_PROVIDER: 'elevenlabs' })).provider, 'elevenlabs'); assert.equal((await cfg({ ...envOnly, ELEVENLABS_PROVIDER: 'aura' })).elevenlabs, undefined);
  assert.equal((await cfg({ ...envOnly, ELEVENLABS_VOICE_ID: '../x', ELEVENLABS_MODEL: 'nope' })).elevenlabs.voiceId, S.DEFAULT_VOICE, 'a bad environment voice id or model is replaced by the default');
  // stored key, auto: provider aura with the key available (the engine may use it for other languages)
  await saveKey(me); let c = await cfg(w.env); assert.deepEqual([c.provider, c.source, c.choice, c.elevenlabs.apiKey, c.elevenlabs.voiceId, c.elevenlabs.modelId], ['aura', 'settings', 'auto', KEY, S.DEFAULT_VOICE, S.DEFAULT_MODEL]);
  // stored choice wins over the environment, voice and model from the store
  await put(me, '/api/admin/voice', { choice: 'elevenlabs', voiceId: VOICE, modelId: 'eleven_flash_v2_5' });
  c = await cfg({ ...w.env, ELEVENLABS_API_KEY: 'env-key-0123456789', ELEVENLABS_VOICE_ID: VOICE2 }); assert.deepEqual([c.provider, c.source, c.elevenlabs.apiKey, c.elevenlabs.voiceId], ['elevenlabs', 'settings', KEY, VOICE]);
  await put(me, '/api/admin/voice', { choice: 'aura' }); c = await cfg({ ...w.env, ELEVENLABS_API_KEY: 'env-key-0123456789' }); assert.deepEqual([c.provider, c.source, c.elevenlabs], ['aura', 'settings', undefined], 'an explicit Workers AI choice carries no ElevenLabs at all');
  await put(me, '/api/admin/voice', { choice: 'elevenlabs' });
  // the stored key is ignored when switched off, and when it cannot be read (SETTINGS_KEY rotated away)
  c = await cfg({ ...w.env, ATLAS_SETTINGS_KEYS: 'off', ELEVENLABS_API_KEY: 'env-key-0123456789' }); assert.deepEqual([c.provider, c.source, c.elevenlabs.apiKey], ['aura', 'env', 'env-key-0123456789']);
  c = await cfg({ ...w.env, SETTINGS_KEY: 'a-different-new-secret-with-32-characters!!' }); assert.deepEqual([c.provider, c.source], ['aura', 'settings']); assert.equal(c.elevenlabs, undefined);
  assert.equal((await S.voiceStatus({ ...w.env, SETTINGS_KEY: 'a-different-new-secret-with-32-characters!!' }, stub, { fresh: true })).keyReadable, false);
  c = await cfg({ ...w.env, SETTINGS_KEY: 'a-different-new-secret-with-32-characters!!', SETTINGS_KEY_PREVIOUS: SECRET }); assert.equal(c.provider, 'elevenlabs', 'rotation: readable while the previous secret is named');
  // a store that cannot be reached is "nothing stored"; the environment still works
  const dead = { fetch: async () => { throw new Error('down'); } }; c = await S.voiceConfig({ ...w.env, ELEVENLABS_API_KEY: 'env-key-0123456789' }, dead, { fresh: true }); assert.deepEqual([c.provider, c.source], ['aura', 'env']);
  // the 60 second cache: no second read inside the minute, a read after it; a refreshed answer changes with the store
  const e2 = { ...w.env }, before = w.stubCalls.n; await S.voiceConfig(e2, stub, { now: 1000 }); await S.voiceConfig(e2, stub, { now: 30000 }); assert.equal(w.stubCalls.n, before + 1);
  await S.voiceConfig(e2, stub, { now: 61001 }); assert.equal(w.stubCalls.n, before + 2); S.resetVoiceCache(e2); await S.voiceConfig(e2, stub, { now: 61002 }); assert.equal(w.stubCalls.n, before + 3);
  // the Worker's own routes keep the cache honest: a save is visible at once in the same isolate
  const c1 = await S.voiceConfig(w.env, stub); assert.equal(c1.provider, 'elevenlabs'); await put(me, '/api/admin/voice', { choice: 'aura' }); assert.equal((await S.voiceConfig(w.env, stub)).provider, 'aura');
});

test('V2 voiceConfig never throws and never returns a value another caller can mutate', async () => {
  const w = world(), frozen = await S.voiceConfig({ ...w.env, ELEVENLABS_API_KEY: 'env-key-0123456789' }, null, { fresh: true });
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.elevenlabs)); assert.equal((await S.voiceConfig({}, null)).provider, 'aura'); assert.equal((await S.voiceConfig(undefined, null)).provider, 'aura');
});

test('V2 LibraryStore: the stored rows survive a restart of the Library over the same database, the settings table is additive, and erasing a person does not touch it', async () => {
  fakeEleven(); const w = world(), me = await session(w.env); await saveKey(me);
  const again = new Library(w.lib.sql); assert.ok(again.getSettings().elevenlabs_key, 'same database, new Library');
  assert.ok(again.rows('SELECT updated_by FROM settings').every(r => !r.updated_by.includes('@')), 'the writer is a pseudonym, never an email');
});
