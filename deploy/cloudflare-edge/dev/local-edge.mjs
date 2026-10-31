// Local, offline run of the edge Worker for demos and browser tests: the real handle() and the real library
// logic (node:sqlite), a local signing key standing in for Cloudflare Access, a switchable test user and a
// stand-in review/recommendation model. No network, no Cloudflare account, loopback only. Never deploy this file.
// D1: it also serves the voice WebSocket (/api/voice) on a minimal RFC 6455 server (dev/local-ws.mjs), bridged to the REAL
// Interview Durable Object class (src/worker.js, which runs the real Session) on an in-memory Durable Object stand-in
// (dev/local-do.mjs), with offline fake models (dev/fake-interviewer.mjs): a typed interview runs end to end, from the consent
// to the read-back card, a private draft and Submit for review. Speech recognition and voices do not exist offline: use "Type
// instead". See docs/LOCAL_DEMO.md.
//   node dev/local-edge.mjs [port]      then open http://127.0.0.1:8787/?as=you@mantu.com
//   Dev only: &idp={"name":"Jane Doe","given_name":"Jane"} (URL-encoded JSON) puts custom claims into the local token,
//   as Access does with Entra name claims (WOW_ZERO_CONFIG §5.5); remembered like ?as=, and an empty &idp= clears it.
//   ATLAS_ADAPTERS=mock passes through (the evidence workflow's mock destinations); /__evidence_draft?as=you@mantu.com (POST notes) files the owner-only draft a
//   confirmed read-back would, for tests/humane_browser.py. Nothing else here is new.
//   FAKE_TYPESAFE=1 node dev/local-edge.mjs: JEV runs against the local fake TypeSafe (dev/fake-typesafe.mjs, model id
//   fake-jev-local) with a local key; /__typesafe_mode?m=ok|down|unsure switches it. Without FAKE_TYPESAFE there is no
//   key, and every request to api.typesafe.ai is refused: a local run never reaches a paid provider.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { handle } from '../src/app.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from '../test/sqlite.js';
import { fakeModel } from './fake-model.mjs';
import { fakeHindsight } from './fake-hindsight.mjs';
import { fakeTypesafe } from './fake-typesafe.mjs';
import { storyRater } from '../src/rating.js';
import { postDraftFromInterview } from '../src/evidence.js';
import { installRuntime, upgradeHandler } from './local-ws.mjs';
import { hookWorkerImports, localNamespace, LocalStorage } from './local-do.mjs';
import { fakeTalker, fakeAnalyst } from './fake-interviewer.mjs';
installRuntime(); hookWorkerImports();
const { Interview } = await import('../src/worker.js'); // the real Interview Durable Object (and so the real Session)

const PORT = Number(process.argv[2] || 8787), ORIGIN = `http://127.0.0.1:${PORT}`, TEAM = 'local.invalid', AUD = 'local-aud';
const page = readFileSync(new URL('../src/atlas.html', import.meta.url), 'utf8');
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'local' };
const realFetch = globalThis.fetch;
const HS = 'https://hindsight.local.invalid', fakeHs = fakeHindsight();
const TYPESAFE = 'https://api.typesafe.ai/', FAKE_TYPESAFE = process.env.FAKE_TYPESAFE === '1', fakeTs = FAKE_TYPESAFE ? fakeTypesafe({ key: 'local-fake-key' }) : null;
globalThis.fetch = async (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
  if (u.startsWith(HS)) return fakeHs(url, init);
  if (u.startsWith(TYPESAFE)) { if (fakeTs) return fakeTs(u, init); throw new TypeError('Local run: api.typesafe.ai is refused (set FAKE_TYPESAFE=1 for the local fake).'); }
  return realFetch(url, init);
};
const b64u = b => Buffer.from(b).toString('base64url');
// Like Access, one application token per sign-in: `iat` is fixed per person until a new sign-in (the CSRF token is bound to it, B1).
const issuedAt = new Map();
async function token(email, custom = null) {
  const now = Math.floor(Date.now() / 1000), iat = issuedAt.get(email) ?? issuedAt.set(email, now).get(email), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'local:' + email, email, exp: now + 3600, iat, ...(custom ? { custom } : {}) };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'local' })) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}
const model = fakeModel(), model_complete = m => model.complete(m);
const pending = new Set(), libraryStorage = new LocalStorage(() => {}); // the LibraryStore's key-value storage (per-person rate limits on the library routes, as in worker.js)
const waitUntil = p => { const q = Promise.resolve(p); pending.add(q); q.finally(() => pending.delete(q)).catch(() => {}); };
// Opt-in feature vars pass through from the shell when set (never defaulted here): WOW_SPEC §5, WOW_ZERO_CONFIG §4.
// DATA_MODE stays unset (test mode) unless the shell sets it; the DNA variables never have a local default.
const passthrough = Object.fromEntries(['EXTERNAL_EMAILS', 'CLIENT_CONFIRM', 'IDENTITY_SOURCE', 'DATA_MODE', 'DNA_PROFILE_URL', 'DNA_AUTH_HEADER', 'DNA_FIELD_MAP', 'DNA_API_KEY',
  'DIRECTORY_PUSH_SECRET', 'ATLAS_ADAPTERS', 'ATLAS_CSP', 'RL_INTERVIEW_HOUR', 'RL_INTERVIEW_DAY'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
// The interview's offline models: the talker streams like Workers AI (server-sent events), speech recognition hears nothing, voices are silent.
const sse = text => new ReadableStream({ start(c) { const e = new TextEncoder(); for (const w of text.match(/\S+\s*/g) || []) c.enqueue(e.encode(`data: ${JSON.stringify({ response: w })}\n\n`)); c.enqueue(e.encode('data: [DONE]\n\n')); c.close(); } });
const env = { ORIGIN, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CSRF_SECRET: 'local-only', TALKER_MODEL: 'local', TTS_VOICE: 'local', STT_MODEL: 'local-stt', TTS_MODEL: 'local-tts',
  TRIGGER_SECRET: process.env.TRIGGER_SECRET || 'local-trigger-secret', ANALYST_MODEL: 'local-analyst',
  // Stand-ins for the Workers AI binding: toMarkdown (documents and image descriptions) and chat completions.
  AI: { toMarkdown: async f => { const t = f.blob.type || ''; return t.startsWith('image/') ? { format: 'markdown', data: 'A diagram showing the project phases and approach' } : { format: 'markdown', data: new TextDecoder().decode(await f.blob.arrayBuffer()) }; },
    run: async (model, input) => {
      if (model === env.TALKER_MODEL && input.stream) return sse(fakeTalker(input.messages)); // the interview's talker
      if (model === env.ANALYST_MODEL && input.tools) return fakeAnalyst(input.messages); // the interview's analyst (record_details)
      if (/smart-turn/.test(model)) return { is_complete: true, probability: 1 };
      if (input.audio) return { results: { channels: [{ alternatives: [{ transcript: '' }] }] } }; // no speech recognition offline
      if (input.text && input.speaker) return new Uint8Array(24000); // no voice offline: half a second of silence
      return { choices: [{ message: { content: await model_complete(input.messages) } }] };
    } },
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || 'tony.walteur@gmail.com', REVIEWER_EMAILS: process.env.REVIEWER_EMAILS || 'reviewer@mantu.com',
  HINDSIGHT_URL: HS, HINDSIGHT_API_KEY: 'local-hindsight-key', HINDSIGHT_BANK_SECRET: 'local-only-bank-secret', // (B1: memory needs a bank secret)
  LIBRARY: { idFromName: n => n, get: () => ({ fetch: r => libraryRoutes(r, lib, { waitUntil, env, storage: libraryStorage }) }) }, ...passthrough,
  ...(FAKE_TYPESAFE ? { TYPESAFE_API_KEY: 'local-fake-key' } : {}) }; // bootstrap then reports jev: true
// The Library as worker.js builds it: with a story rater, which is only available when the environment has a key.
const lib = new Library(memorySql(), { complete: model.complete, embed: model.embed, model: 'local stand-in', services: { teams: null }, rater: storyRater(env, (u, i) => globalThis.fetch(u, i)) });

env.INTERVIEW = localNamespace(Interview, env); // one live Interview object per person (keyed by the token subject, as the real Worker does)
// Test hook /__expire: the Access application token has expired. Like Access (WOW_ZERO_CONFIG §3.7, §13), requests then
// carry no token (the Worker answers 401) until the next top-level navigation, which is signed in again without a prompt.
let expired = false;
// The request as Cloudflare Access would deliver it: the person from ?as= (or the dev_as cookie), signed into the application token header.
async function signedRequest(req, url, body) {
  const as = url.searchParams.get('as') || /(?:^|;\s*)dev_as=([^;]+)/.exec(req.headers.cookie || '')?.[1] || 'consultant@mantu.com';
  const idpRaw = url.searchParams.has('idp') ? url.searchParams.get('idp') : decodeURIComponent(/(?:^|;\s*)dev_idp=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '');
  let custom = null; try { const c = JSON.parse(idpRaw || 'null'); custom = c && typeof c === 'object' && !Array.isArray(c) ? c : null; } catch { custom = null; }
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.delete('cf-access-jwt-assertion');
  if (!expired) headers.set('cf-access-jwt-assertion', await token(decodeURIComponent(as), custom));
  return new Request(url, { method: req.method, headers, body });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/__settle') { await Promise.allSettled([...pending]); res.end('ok'); return; } // test hook: wait for background reviews
  if (url.pathname === '/__evidence_draft' && req.method === 'POST') { // test hook (humane_browser.py): what the Interview DO posts when a read-back is confirmed (T11), under the identity given by ?as=
    const body = []; for await (const c of req) body.push(c);
    const who = decodeURIComponent(url.searchParams.get('as') || 'consultant@mantu.com').toLowerCase(), r = await postDraftFromInterview(env, { user: who, role: 'user', mail: who }, JSON.parse(Buffer.concat(body).toString() || '{}'));
    res.writeHead(r.status || 502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.body)); return;
  }
  if (url.pathname === '/__expire') { expired = true; res.end('ok'); return; }
  if (url.pathname === '/__typesafe_mode') { // test hook (FAKE_TYPESAFE only): ok | down (529) | unsure
    if (!fakeTs) { res.statusCode = 404; res.end('FAKE_TYPESAFE is off'); return; }
    try { fakeTs.setMode(url.searchParams.get('m') || ''); res.end(fakeTs.mode); } catch { res.statusCode = 400; res.end('mode must be ok, down or unsure'); }
    return;
  }
  if (expired && req.headers['sec-fetch-mode'] === 'navigate') { expired = false; issuedAt.clear(); } // the silent re-sign-in mints a new application token
  const chunks = []; for await (const c of req) chunks.push(c);
  const request = await signedRequest(req, url, chunks.length ? Buffer.concat(chunks) : undefined);
  const response = await handle(request, env, page, { waitUntil });
  const out = {}, cookies = []; response.headers.forEach((v, k) => { out[k] = v; });
  if (url.searchParams.get('as')) cookies.push(`dev_as=${encodeURIComponent(url.searchParams.get('as'))}; Path=/; SameSite=Strict`);
  if (url.searchParams.has('idp')) cookies.push(`dev_idp=${encodeURIComponent(url.searchParams.get('idp'))}; Path=/; SameSite=Strict`);
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(response.status, out); res.end(Buffer.from(await response.arrayBuffer()));
});
// The voice socket: the browser's /api/voice upgrade goes through the real handle() (identity, origin, kill switches, forwarding headers) to the person's Interview object.
server.on('upgrade', upgradeHandler(async req => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname !== '/api/voice') return new Response('Not found', { status: 404 });
  return handle(await signedRequest(req, url, undefined), env, page, { waitUntil });
}));
server.listen(PORT, '127.0.0.1', () => console.log(`ATLAS local edge on ${ORIGIN}  (switch user with ?as=email; offline fake models: typed interviews only, see docs/LOCAL_DEMO.md)`));
