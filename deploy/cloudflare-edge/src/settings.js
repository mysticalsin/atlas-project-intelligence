// Admin settings (v2.2 V2): the voice provider, the ElevenLabs key an admin pastes into Settings, and the voice and model to use.
//
// What is stored and where. The LibraryStore holds a `settings` table (library.js). Two rows: `voice` (plain JSON, no secret: the admin's choice, voice id and name, model, and the
// tier and character counts ElevenLabs reported when the key was checked) and `elevenlabs_key` (the key, sealed: AES-GCM-256 under an HKDF-SHA256 key derived from the Worker secret
// SETTINGS_KEY, info `atlas-settings`, a fresh random 12-byte IV for every write, additional data `atlas-settings:v1:elevenlabs`, and a `kid` that names the secret it was sealed under so
// SETTINGS_KEY can be rotated: put the old value in SETTINGS_KEY_PREVIOUS while it is rotated, then save the key again). The plaintext key exists only inside this file's functions and
// in the 60 second cache of `voiceConfig`; it is never logged, never in a response, never in an audit row, never in an export. The browser can only ever write it.
//
// Who may reach it. The browser-facing routes are /api/admin/voice* (admin only, Origin and CSRF on every state change, no-store, bounded bodies, per-person rate limits, refused under
// ATLAS_READ_ONLY by the Worker and under ATLAS_AI_OFF here because every one of them but the status read calls ElevenLabs or Workers AI). The LibraryStore side is /api/settings*, which
// the Worker never forwards from a browser: only an admin (through the routes above) or the Worker's own code (role `system`, a read) reaches it, like /api/privacy/*.
//
// The contract for the voice engine (V1): `voiceConfig(env, library)` -> { provider, elevenlabs?, source, choice }. `provider` says who speaks English and Spanish. `elevenlabs` (the key,
// voice id and model) is present whenever a key can be used, so the engine may also use it for the languages the Cloudflare voices cannot say (the "auto" choice). An explicit
// "Workers AI" choice carries no `elevenlabs` at all.
import * as ks from './kill-switches.js';
import { boundedBytes } from './bounded.js';
import { wav } from './speech.js';
import { obj, fail } from './util.js';

const enc = new TextEncoder(), dec = new TextDecoder();
export const EL_BASE = 'https://api.elevenlabs.io';
export const PROVIDERS = Object.freeze(['auto', 'aura', 'elevenlabs']);
// Flash v2.5 is the live-conversation model (research: ~100 ms, 32 languages). Multilingual v2 is the slower, richer alternative. Others are not offered (v3 is not for real time;
// turbo v2.5 is deprecated; v4 is unverified on the streaming socket).
export const ELEVENLABS_MODELS = Object.freeze([
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5: fastest, 32 languages (recommended for conversation)' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2: richer, a little slower, 29 languages' }]);
export const DEFAULT_MODEL = 'eleven_flash_v2_5', DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';
export const VOICE_ID_RE = /^[A-Za-z0-9]{10,40}$/; // the id goes into an upstream URL path: letters and digits only, so no `/`, `..`, `?` or `#` can ever reach it
export const API_KEY_RE = /^[\x21-\x7e]{8,200}$/; // printable, no space: it becomes a header value
export const TEST_PHRASE = 'Hello, I am ATLAS. This is how I will sound when we talk about your projects.';
const NAME_VOICE = 'voice', NAME_KEY = 'elevenlabs_key', SETTING_NAMES = [NAME_VOICE, NAME_KEY];
const SETTINGS_KEY_MIN = 32, CACHE_MS = 60000;
const HOUR = 36e5;
const INTERNAL = { 'Content-Type': 'application/json', 'x-atlas-user': 'atlas-interview', 'x-atlas-role': 'system' };

// ---------------------------------------------------------------- the seal
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const toB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const aadOf = name => enc.encode('atlas-settings:v1:' + name);

// 'ok' | 'off' (ATLAS_SETTINGS_KEYS=off: stored keys are ignored) | 'missing' | 'weak' (shorter than 32 characters: refused, a short secret is no secret).
export function settingsKeyState(env) {
  if (/^(off|0|false|no)$/i.test(String(env?.ATLAS_SETTINGS_KEYS ?? '').trim())) return 'off';
  const s = String(env?.SETTINGS_KEY ?? '');
  return !s ? 'missing' : s.length < SETTINGS_KEY_MIN ? 'weak' : 'ok';
}
async function material(secret) {
  const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const params = info => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('atlas-settings-salt-v1'), info: enc.encode(info) });
  const key = await crypto.subtle.deriveKey(params('atlas-settings'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const kid = hex(await crypto.subtle.deriveBits(params('atlas-settings:kid'), ikm, 48)); // names the secret, reveals nothing usable about it
  return { key, kid };
}
// Seals `plaintext` under SETTINGS_KEY. Returns the record to store: { v, kid, iv, ct } (all text, nothing recoverable without the secret and the name).
export async function seal(env, plaintext, name = 'elevenlabs') {
  if (settingsKeyState(env) !== 'ok') throw Object.assign(new Error('Keys cannot be stored on this deployment.'), { code: 'SETTINGS_KEY_UNAVAILABLE' });
  const { key, kid } = await material(String(env.SETTINGS_KEY));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(name) }, key, enc.encode(String(plaintext))));
  return { v: 1, kid, iv: toB64(iv), ct: toB64(ct) };
}
// The plaintext, or null: a record sealed under a secret this deployment no longer has, a changed record, a different name (AAD) or a malformed one all give null, never an error text.
export async function open(env, record, name = 'elevenlabs') {
  try {
    if (settingsKeyState(env) !== 'ok' || !record || record.v !== 1 || !/^[0-9a-f]{12}$/.test(record.kid) || typeof record.iv !== 'string' || typeof record.ct !== 'string' || record.ct.length > 2048) return null;
    const iv = fromB64(record.iv);
    if (iv.length !== 12) return null;
    const secrets = [env.SETTINGS_KEY, ...String(env.SETTINGS_KEY_PREVIOUS || '').split(',')].map(s => String(s || '').trim()).filter(s => s.length >= SETTINGS_KEY_MIN);
    for (const secret of secrets) {
      const { key, kid } = await material(secret);
      if (kid !== record.kid) continue;
      try { return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aadOf(name) }, key, fromB64(record.ct))); } catch { /* wrong AAD or a changed record */ }
    }
  } catch { /* malformed */ }
  return null;
}
export async function currentKid(env) { return settingsKeyState(env) === 'ok' ? (await material(String(env.SETTINGS_KEY))).kid : ''; }

// ---------------------------------------------------------------- reading the stored choice
const parse = text => { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
const clip = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, n) : '';
const count = v => Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Math.trunc(Number(v)), 1e12) : null;
const when = v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(v || '')) ? String(v).slice(0, 30) : '';
// `reader(path)` answers a Response from the LibraryStore (the Worker's own request helper, or a Durable Object stub made below).
const stubReader = (env, library) => {
  const stub = library && typeof library.fetch === 'function' ? library : env?.LIBRARY?.get?.(env.LIBRARY.idFromName('global'));
  return stub ? (path, init = {}) => stub.fetch(new Request('https://atlas.internal' + path, { method: 'GET', ...init, headers: INTERNAL })) : null;
};
async function stored(reader) {
  if (!reader) return { voice: null, keyRow: null };
  const r = await reader('/api/settings');
  if (!r.ok) throw new Error('settings ' + r.status);
  const rows = (await r.json())?.settings || {};
  return { voice: parse(rows[NAME_VOICE]?.value), keyRow: parse(rows[NAME_KEY]?.value), updatedAt: when(rows[NAME_VOICE]?.updatedAt) };
}

// Resolves the effective configuration from the stored rows and the environment (pure but for the decrypt). Returns { config, status } and no other secret.
async function resolve(env, rows) {
  const state = settingsKeyState(env), ignoreStored = state === 'off';
  const voice = ignoreStored ? null : rows.voice, keyRow = ignoreStored ? null : rows.keyRow;
  const storedKey = keyRow ? await open(env, keyRow, 'elevenlabs') : null;
  const envKey = String(env?.ELEVENLABS_API_KEY || '').trim();
  const apiKey = storedKey || (API_KEY_RE.test(envKey) ? envKey : '');
  const keySource = storedKey ? 'settings' : apiKey ? 'env' : 'none';
  const storedChoice = PROVIDERS.includes(voice?.choice) ? voice.choice : null;
  const envChoice = PROVIDERS.includes(String(env?.ELEVENLABS_PROVIDER || '').toLowerCase()) ? String(env.ELEVENLABS_PROVIDER).toLowerCase() : 'auto';
  const choice = storedChoice || envChoice;
  const voiceId = [voice?.voiceId, env?.ELEVENLABS_VOICE_ID].find(v => VOICE_ID_RE.test(String(v || ''))) || DEFAULT_VOICE;
  const modelId = [voice?.modelId, env?.ELEVENLABS_MODEL].find(m => ELEVENLABS_MODELS.some(x => x.id === m)) || DEFAULT_MODEL;
  const source = storedChoice || storedKey ? 'settings' : apiKey ? 'env' : 'none';
  let provider = 'aura', elevenlabs;
  if (choice !== 'aura' && apiKey) { elevenlabs = { apiKey, voiceId, modelId }; if (choice === 'elevenlabs') provider = 'elevenlabs'; }
  const config = Object.freeze({ provider, ...(elevenlabs ? { elevenlabs: Object.freeze(elevenlabs) } : {}), source, choice });
  const status = Object.freeze({
    storable: state === 'ok', storableReason: { ok: 'OK', off: 'SETTINGS_KEYS_OFF', missing: 'SETTINGS_KEY_MISSING', weak: 'SETTINGS_KEY_WEAK' }[state],
    choice, provider, source, keySource,
    keyStored: !!keyRow && !ignoreStored, keyReadable: !!storedKey, keyEnv: !!envKey, keyAvailable: !!apiKey,
    validatedAt: when(voice?.validatedAt), tier: clip(voice?.tier, 30), subscriptionStatus: clip(voice?.subscriptionStatus, 20),
    charactersUsed: count(voice?.charactersUsed), charactersLimit: count(voice?.charactersLimit),
    voiceId, voiceName: clip(voice?.voiceName, 80), modelId, models: ELEVENLABS_MODELS,
    fallback: provider === 'elevenlabs' ? 'If ElevenLabs cannot answer, ATLAS speaks that sentence with Workers AI (English and Spanish only; other languages appear as text).' : '' });
  return { config, status, apiKey }; // apiKey: for this file's own routes (the voice list, the test), whatever the choice; never in `config` unless the choice uses it, never in `status`
}

const cache = new WeakMap(); // env -> { library, at, value }: the decrypted key lives here for at most 60 s, in this isolate's memory only
export function resetVoiceCache(env) { if (env && typeof env === 'object') cache.delete(env); }
async function loaded(env, library, { reader = null, now = Date.now(), fresh = false } = {}) {
  const hit = cache.get(env);
  if (!fresh && hit && hit.library === library && now - hit.at < CACHE_MS) return hit.value;
  let value;
  try { value = await resolve(env, await stored(reader || stubReader(env, library))); }
  catch { value = await resolve(env, { voice: null, keyRow: null }); value.unavailable = true; } // an unreachable store is "nothing stored": the environment still works, and nothing is cached
  if (!value.unavailable && env && typeof env === 'object') cache.set(env, { library, at: now, value });
  return value;
}
// The voice engine's contract. Never throws.
export async function voiceConfig(env, library = null, opts = {}) { return (await loaded(env, library, opts)).config; }
// What an admin may see: no key, no part of one.
export async function voiceStatus(env, library = null, opts = {}) { return (await loaded(env, library, opts)).status; }

// ---------------------------------------------------------------- ElevenLabs, narrow and bounded
const upstream = (path, apiKey, { method = 'GET', params = {}, body, timeout = 5000, fetcher = (...a) => globalThis.fetch(...a) } = {}) => {
  const url = new URL(EL_BASE + path); // `path` is one of the fixed templates below; a voice id has passed VOICE_ID_RE before it gets here
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return fetcher(url.href, { method, redirect: 'manual', signal: AbortSignal.timeout(timeout),
    headers: { 'xi-api-key': apiKey, Accept: method === 'GET' ? 'application/json' : '*/*', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
};
const drop = r => { try { r.body?.cancel?.().catch(() => {}); } catch { /* nothing to drop */ } };
const rejected = r => r.status === 401 || r.status === 403;
// 'ok' (the key listed voices) | 'invalid' (401/403) | 'unavailable' (anything else: nothing is decided). Tier and counts only when /v1/user answers (a scoped key may not reach it).
export async function validateKey(apiKey, opts = {}) {
  let r;
  try { r = await upstream('/v2/voices', apiKey, { params: { page_size: 1 }, ...opts }); } catch { return { state: 'unavailable' }; }
  drop(r);
  if (rejected(r)) return { state: 'invalid' };
  if (!r.ok) return { state: 'unavailable' };
  const out = { state: 'ok' };
  try {
    const u = await upstream('/v1/user', apiKey, opts);
    if (u.ok) { const s = (await u.json())?.subscription || {}; Object.assign(out, { tier: clip(s.tier, 30).replace(/[^A-Za-z0-9_ -]/g, ''), charactersUsed: count(s.character_count), charactersLimit: count(s.character_limit), subscriptionStatus: clip(s.status, 20) }); } else drop(u);
  } catch { /* the user endpoint is optional */ }
  return out;
}
const label = v => clip(v, 24);
export async function listVoices(apiKey, { search = '', pageToken = '' } = {}, opts = {}) {
  const params = { page_size: 100 }, q = clip(String(search).replace(/[^\p{L}\p{N} .'_-]/gu, ''), 60);
  if (q) params.search = q;
  if (/^[A-Za-z0-9_=.-]{1,200}$/.test(pageToken)) params.next_page_token = pageToken;
  const r = await upstream('/v2/voices', apiKey, { params, timeout: 8000, ...opts });
  if (!r.ok) { drop(r); throw Object.assign(new Error('voices ' + r.status), { status: r.status }); }
  const data = await r.json();
  const voices = (Array.isArray(data?.voices) ? data.voices : []).slice(0, 100).filter(v => VOICE_ID_RE.test(String(v?.voice_id || ''))).map(v => ({
    id: v.voice_id, name: clip(v.name, 60) || 'Unnamed voice', category: label(v.category),
    labels: ['accent', 'gender', 'age', 'descriptive', 'use_case'].map(k => label(v.labels?.[k])).filter(Boolean),
    languages: [...new Set((Array.isArray(v.verified_languages) ? v.verified_languages : []).slice(0, 12).map(l => clip(l?.language, 8)).filter(Boolean))].slice(0, 6) }));
  return { voices, nextToken: data?.has_more && /^[A-Za-z0-9_=.-]{1,200}$/.test(String(data.next_page_token || '')) ? data.next_page_token : null };
}
async function pcmOf(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (x && typeof x[Symbol.asyncIterator] === 'function') {
    const parts = []; let n = 0;
    for await (const c of x) { const u = c instanceof Uint8Array ? c : new Uint8Array(c); parts.push(u); n += u.length; }
    const out = new Uint8Array(n); let at = 0;
    for (const u of parts) { out.set(u, at); at += u.length; }
    return out;
  }
  if (x && typeof x.arrayBuffer === 'function') return new Uint8Array(await x.arrayBuffer());
  return new Uint8Array(0);
}
export async function elevenlabsSpeech(apiKey, { voiceId, modelId, text = TEST_PHRASE }, opts = {}) {
  if (!VOICE_ID_RE.test(voiceId)) throw Object.assign(new Error('voice id'), { status: 400 });
  const r = await upstream('/v1/text-to-speech/' + voiceId, apiKey, { method: 'POST', params: { output_format: 'pcm_24000' }, body: { text, model_id: modelId, language_code: 'en' }, timeout: 15000, ...opts });
  if (!r.ok) { drop(r); throw Object.assign(new Error('speech ' + r.status), { status: r.status }); }
  const pcm = new Uint8Array(await r.arrayBuffer());
  if (!pcm.length || pcm.length > 2_000_000) throw Object.assign(new Error('speech length'), { status: 502 });
  return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
}

// ---------------------------------------------------------------- the LibraryStore side: /api/settings*
// Only an admin (relayed by the Worker's own routes) and the Worker's own code (role `system`, reads) get here; everyone else is told it does not exist.
const AUDIT_ACTION = /^voice\.[a-z_]{3,30}$/, AUDIT_DETAIL = /^[A-Za-z0-9 =_.;:,()-]{0,160}$/;
export async function internalRoutes(ctx) {
  const { lib, user, method, url, body } = ctx, path = url.pathname.replace(/^\/api\/settings\/?/, '').split('/').filter(Boolean);
  if (!['admin', 'system'].includes(user.role)) throw fail(404, 'Not found.');
  if (method === 'GET' && !path.length) return { body: { settings: lib.getSettings() } };
  if (user.role !== 'admin' || method !== 'POST') throw fail(404, 'Not found.');
  const b = obj(body), audit = obj(b.audit), act = AUDIT_ACTION.test(audit.action || '') ? audit.action : '';
  const note = () => { if (act) lib.log('settings', user.email, act, AUDIT_DETAIL.test(audit.detail || '') ? audit.detail : ''); };
  if (path[0] === 'put' && path.length === 1) {
    if (!SETTING_NAMES.includes(b.name) || typeof b.value !== 'string' || b.value.length > 4096) throw fail(400, 'Not a setting.');
    lib.putSetting(b.name, b.value, { keyId: typeof b.keyId === 'string' && /^[0-9a-f]{12}$/.test(b.keyId) ? b.keyId : null, by: user.subj || '' }); note();
    return { body: { ok: true } };
  }
  if (path[0] === 'delete' && path.length === 1) {
    if (!SETTING_NAMES.includes(b.name)) throw fail(400, 'Not a setting.');
    lib.deleteSetting(b.name); note();
    return { body: { ok: true } };
  }
  if (path[0] === 'audit' && path.length === 1) { note(); return { body: { ok: true } }; }
  throw fail(404, 'Not found.');
}

// ---------------------------------------------------------------- the Worker side: /api/admin/voice*
const LIMITS = { 'voice-key': [10, HOUR], 'voice-set': [60, HOUR], 'voice-voices': [60, HOUR], 'voice-test': [20, HOUR] };
const SUBS = { 'GET ': null, 'PUT ': 'voice-set', 'PUT /key': 'voice-key', 'DELETE /key': 'voice-key', 'GET /voices': 'voice-voices', 'POST /test': 'voice-test' };
const UPSTREAM = new Set(['PUT /key', 'GET /voices', 'POST /test']); // the routes that call ElevenLabs or Workers AI: switched off with ATLAS_AI_OFF
const WORDS = { KEY_INVALID: 'ElevenLabs did not accept that key. Check that it is complete and that it may list voices (the “Voices: read” permission). Nothing was saved.',
  UPSTREAM_UNAVAILABLE: 'ElevenLabs could not be reached to check the key, so nothing was saved. Try again in a moment.',
  NO_KEY: 'Add an ElevenLabs key first.', TEST_FAILED: 'The voice could not be generated. Nothing was changed.' };

// ctx: { request, env, url, role, sec, csrfRefusal(), limited(bucket, max, windowMs), libraryOf(path, init), actor, json(body, status), headers(extra), synthesize(text) }
export async function voiceAdminRoutes(ctx) {
  const { request, env, url, role, sec, json } = ctx, sub = url.pathname.slice('/api/admin/voice'.length), key = request.method + ' ' + sub;
  if (role !== 'admin') { sec.log('access_denied', 'ADMIN_ONLY', 403); return json({ error: 'Only an ATLAS admin can change the voice settings.' }, 403); }
  if (!(key in SUBS)) return json({ error: 'Not found.' }, 404);
  const noStore = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: ctx.headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }) });
  const refuse = (status, code, extra = {}) => noStore({ code, ...extra, error: extra.error || WORDS[code] || 'That did not work.' }, status);
  if (request.method !== 'GET') { const bad = ctx.csrfRefusal(); if (bad) return bad; }
  if (UPSTREAM.has(key) && ks.aiOff(env)) { sec.log('kill_switch', 'AI_OFF', 503); return noStore({ error: ks.AI_OFF_MESSAGE, code: 'AI_OFF' }, 503); }
  const bucket = SUBS[key];
  if (bucket) { const slow = await ctx.limited(bucket, ...LIMITS[bucket]); if (slow) return slow; }
  const reader = (path, init) => ctx.libraryOf(path, init);
  const write = async (path, payload) => { const r = await reader(path, { method: 'POST', body: JSON.stringify(payload) }); if (!r.ok) throw new Error('store ' + r.status); };
  const status = async (fresh = true) => (await loaded(env, null, { reader, fresh })).status;
  const read = async max => { const raw = await boundedBytes(request, max); if (raw === null) return { tooLarge: true }; try { return { value: obj(JSON.parse(dec.decode(raw) || '{}')) }; } catch { return { invalid: true }; } };
  const body = async max => { const b = await read(max); return b.tooLarge ? { fail: noStore({ error: 'Request too large.' }, 413) } : b.invalid ? { fail: noStore({ error: 'Invalid JSON.' }, 400) } : b; };
  const current = async () => (await stored(reader)).voice || {};
  const keyNow = async () => (await loaded(env, null, { reader, fresh: true })).apiKey;
  const done = async (extra = {}) => { resetVoiceCache(env); return noStore({ ok: true, ...extra, voice: await status() }); };
  try {
    if (key === 'GET ') return noStore({ voice: await status() });

    if (key === 'PUT /key') {
      const b = await body(2048); if (b.fail) return b.fail;
      const state = settingsKeyState(env);
      if (state !== 'ok') return refuse(409, state === 'off' ? 'SETTINGS_KEYS_OFF' : 'SETTINGS_KEY_MISSING', { error: state === 'off' ? 'Stored keys are switched off on this deployment (ATLAS_SETTINGS_KEYS).' : 'This deployment cannot store keys yet: the SETTINGS_KEY secret is ' + (state === 'weak' ? 'too short' : 'not set') + '. A key set by the operator in the Worker environment still works.' });
      const apiKey = typeof b.value.key === 'string' ? b.value.key.trim() : '';
      if (!API_KEY_RE.test(apiKey)) return refuse(400, 'KEY_INVALID');
      const check = await validateKey(apiKey);
      if (check.state === 'invalid') {
        sec.log('voice_settings', 'KEY_INVALID', 400); await write('/api/settings/audit', { audit: { action: 'voice.key_invalid', detail: 'status refused' } }).catch(() => {});
        return refuse(400, 'KEY_INVALID');
      }
      if (check.state !== 'ok') { sec.log('voice_settings', 'KEY_UNVERIFIED', 502); return refuse(502, 'UPSTREAM_UNAVAILABLE'); }
      const sealed = await seal(env, apiKey, 'elevenlabs'), prev = await current();
      await write('/api/settings/put', { name: NAME_KEY, value: JSON.stringify(sealed), keyId: sealed.kid, audit: { action: 'voice.key_set', detail: `validated; tier ${check.tier || 'unknown'}` } });
      await write('/api/settings/put', { name: NAME_VOICE, value: JSON.stringify({ ...prev, choice: PROVIDERS.includes(prev.choice) ? prev.choice : 'auto', validatedAt: new Date().toISOString(), tier: check.tier || '', subscriptionStatus: check.subscriptionStatus || '', charactersUsed: check.charactersUsed ?? null, charactersLimit: check.charactersLimit ?? null }) });
      sec.log('voice_settings', 'KEY_SET', 200);
      return done();
    }

    if (key === 'DELETE /key') {
      const prev = await current();
      await write('/api/settings/delete', { name: NAME_KEY, audit: { action: 'voice.key_removed', detail: 'stored key removed' } });
      const envKeyStays = API_KEY_RE.test(String(env.ELEVENLABS_API_KEY || '').trim()); // a stored ElevenLabs choice with no key left anywhere goes back to Automatic; with an operator key it keeps working
      if (Object.keys(prev).length) await write('/api/settings/put', { name: NAME_VOICE, value: JSON.stringify({ ...prev, ...(prev.choice === 'elevenlabs' && !envKeyStays ? { choice: 'auto' } : {}), validatedAt: '', tier: '', subscriptionStatus: '', charactersUsed: null, charactersLimit: null }) });
      sec.log('voice_settings', 'KEY_REMOVED', 200);
      return done();
    }

    if (key === 'PUT ') {
      const b = await body(4096); if (b.fail) return b.fail;
      const v = b.value, changes = {};
      if (v.choice !== undefined) { if (!PROVIDERS.includes(v.choice)) return refuse(400, 'BAD_CHOICE', { error: 'Choose Auto, Workers AI or ElevenLabs.' }); changes.choice = v.choice; }
      if (v.voiceId !== undefined) { if (typeof v.voiceId !== 'string' || !VOICE_ID_RE.test(v.voiceId)) return refuse(400, 'BAD_VOICE', { error: 'That is not a voice id.' }); changes.voiceId = v.voiceId; changes.voiceName = clip(v.voiceName, 80); }
      if (v.modelId !== undefined) { if (!ELEVENLABS_MODELS.some(m => m.id === v.modelId)) return refuse(400, 'BAD_MODEL', { error: 'That model is not offered.' }); changes.modelId = v.modelId; }
      if (!Object.keys(changes).length) return refuse(400, 'NOTHING', { error: 'Nothing to change.' });
      if (changes.choice === 'elevenlabs' && !(await keyNow())) return refuse(409, 'NO_KEY');
      const prev = await current(), changedChoice = changes.choice !== undefined && changes.choice !== prev.choice;
      await write('/api/settings/put', { name: NAME_VOICE, value: JSON.stringify({ ...prev, ...changes }), audit: { action: changedChoice ? 'voice.provider_changed' : 'voice.settings_changed', detail: `provider ${changes.choice || prev.choice || 'auto'}; model ${changes.modelId || prev.modelId || DEFAULT_MODEL}` } });
      sec.log('voice_settings', changedChoice ? 'PROVIDER_CHANGED' : 'VOICE_CHANGED', 200);
      return done();
    }

    if (key === 'GET /voices') {
      const apiKey = await keyNow();
      if (!apiKey) return refuse(409, 'NO_KEY');
      try { return noStore(await listVoices(apiKey, { search: url.searchParams.get('search') || '', pageToken: url.searchParams.get('page') || '' })); }
      catch (e) { return refuse(502, 'VOICES_FAILED', { error: e.status === 401 || e.status === 403 ? 'ElevenLabs refused the stored key. Save a new key.' : 'The voice list could not be loaded right now.' }); }
    }

    if (key === 'POST /test') {
      const b = await body(1024); if (b.fail) return b.fail;
      const cfg = await loaded(env, null, { reader, fresh: true }), s = cfg.status, v = b.value;
      const provider = v.provider === undefined ? (s.provider === 'elevenlabs' ? 'elevenlabs' : 'aura') : v.provider;
      if (provider !== 'aura' && provider !== 'elevenlabs') return refuse(400, 'BAD_CHOICE', { error: 'Test Workers AI or ElevenLabs.' });
      const voiceId = v.voiceId === undefined ? s.voiceId : v.voiceId, modelId = v.modelId === undefined ? s.modelId : v.modelId;
      if (provider === 'elevenlabs' && (typeof voiceId !== 'string' || !VOICE_ID_RE.test(voiceId))) return refuse(400, 'BAD_VOICE', { error: 'That is not a voice id.' });
      if (provider === 'elevenlabs' && !ELEVENLABS_MODELS.some(m => m.id === modelId)) return refuse(400, 'BAD_MODEL', { error: 'That model is not offered.' });
      let pcm;
      try {
        if (provider === 'elevenlabs') { const apiKey = cfg.apiKey; if (!apiKey) return refuse(409, 'NO_KEY'); pcm = await elevenlabsSpeech(apiKey, { voiceId, modelId }); }
        else pcm = await pcmOf(await ctx.synthesize(TEST_PHRASE));
      } catch (e) { return refuse(502, 'TEST_FAILED', { error: e.status === 401 || e.status === 403 ? 'ElevenLabs refused the key. Save a new key.' : e.status === 429 ? 'ElevenLabs asked ATLAS to slow down. Try again in a minute.' : WORDS.TEST_FAILED }); }
      if (!pcm?.length) return refuse(502, 'TEST_FAILED');
      return new Response(wav(pcm, 24000), { headers: ctx.headers({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Atlas-Provider': provider }) });
    }
  } catch { return noStore({ error: 'That did not work. Nothing was changed.', code: 'FAILED' }, 500); }
  return json({ error: 'Not found.' }, 404);
}
