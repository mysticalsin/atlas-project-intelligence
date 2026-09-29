// Local, offline run of the edge Worker for demos and browser tests: the real handle() and the real library
// logic (node:sqlite), a local signing key standing in for Cloudflare Access, a switchable test user and a
// stand-in review/recommendation model. No network, no Cloudflare account, loopback only. Never deploy this file.
//   node dev/local-edge.mjs [port]      then open http://127.0.0.1:8787/?as=you@mantu.com
//   Dev only: &idp={"name":"Jane Doe","given_name":"Jane"} (URL-encoded JSON) puts custom claims into the local token,
//   as Access does with Entra name claims (WOW_ZERO_CONFIG §5.5); remembered like ?as=, and an empty &idp= clears it.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { handle } from '../src/app.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from '../test/sqlite.js';
import { fakeModel } from './fake-model.mjs';
import { hindsight } from '../src/memory.js';
import { memoryRoutes } from '../src/memory-routes.js';
import { fakeHindsight } from './fake-hindsight.mjs';

const PORT = Number(process.argv[2] || 8787), ORIGIN = `http://127.0.0.1:${PORT}`, TEAM = 'local.invalid', AUD = 'local-aud';
const page = readFileSync(new URL('../src/atlas.html', import.meta.url), 'utf8');
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'local' };
const realFetch = globalThis.fetch;
const HS = 'https://hindsight.local.invalid', fakeHs = fakeHindsight();
globalThis.fetch = async (url, init) => String(url) === `https://${TEAM}/cdn-cgi/access/certs` ? new Response(JSON.stringify({ keys: [jwk] })) : String(url).startsWith(HS) ? fakeHs(url, init) : realFetch(url, init);
const b64u = b => Buffer.from(b).toString('base64url');
async function token(email, custom = null) {
  const now = Math.floor(Date.now() / 1000), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'local:' + email, email, exp: now + 3600, iat: now, ...(custom ? { custom } : {}) };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'local' })) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}
const model = fakeModel(), model_complete = m => model.complete(m);
const lib = new Library(memorySql(), { complete: model.complete, embed: model.embed, model: 'local stand-in', services: { teams: null } });
const pending = new Set(), stores = new Map();
const waitUntil = p => { const q = Promise.resolve(p); pending.add(q); q.finally(() => pending.delete(q)).catch(() => {}); };
// Opt-in feature vars pass through from the shell when set (never defaulted here): WOW_SPEC §5, WOW_ZERO_CONFIG §4.
// DATA_MODE stays unset (test mode) unless the shell sets it; the DNA variables never have a local default.
const passthrough = Object.fromEntries(['EXTERNAL_EMAILS', 'CLIENT_CONFIRM', 'IDENTITY_SOURCE', 'DATA_MODE', 'DNA_PROFILE_URL', 'DNA_AUTH_HEADER', 'DNA_FIELD_MAP', 'DNA_API_KEY',
  'DIRECTORY_PUSH_SECRET'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const storeFor = id => { if (!stores.has(id)) { const m = new Map(); stores.set(id, { get: async k => m.get(k), put: async (k, v) => m.set(k, v) }); } return stores.get(id); };
const env = { ORIGIN, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CSRF_SECRET: 'local-only', TALKER_MODEL: 'local', TTS_VOICE: 'local',
  TRIGGER_SECRET: process.env.TRIGGER_SECRET || 'local-trigger-secret', ANALYST_MODEL: 'local-analyst',
  // Stand-ins for the Workers AI binding: toMarkdown (documents and image descriptions) and chat completions.
  AI: { toMarkdown: async f => { const t = f.blob.type || ''; return t.startsWith('image/') ? { format: 'markdown', data: 'A diagram showing the project phases and approach' } : { format: 'markdown', data: new TextDecoder().decode(await f.blob.arrayBuffer()) }; },
    run: async (model, input) => ({ choices: [{ message: { content: await model_complete(input.messages) } }] }) },
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || 'tony.walteur@gmail.com', REVIEWER_EMAILS: process.env.REVIEWER_EMAILS || 'reviewer@mantu.com',
  HINDSIGHT_URL: HS, HINDSIGHT_API_KEY: 'local-hindsight-key',
  INTERVIEW: { idFromName: n => n, get: id => ({ fetch: r => memoryRoutes(r, { storage: storeFor(id), hs, env }) }) },
  LIBRARY: { idFromName: n => n, get: () => ({ fetch: r => libraryRoutes(r, lib, { waitUntil, env }) }) }, ...passthrough };

const hs = hindsight(env);
// Test hook /__expire: the Access application token has expired. Like Access (WOW_ZERO_CONFIG §3.7, §13), requests then
// carry no token (the Worker answers 401) until the next top-level navigation, which is signed in again without a prompt.
let expired = false;
http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/__settle') { await Promise.allSettled([...pending]); res.end('ok'); return; } // test hook: wait for background reviews
  if (url.pathname === '/__expire') { expired = true; res.end('ok'); return; }
  if (expired && req.headers['sec-fetch-mode'] === 'navigate') expired = false;
  const as = url.searchParams.get('as') || /(?:^|;\s*)dev_as=([^;]+)/.exec(req.headers.cookie || '')?.[1] || 'consultant@mantu.com';
  const idpRaw = url.searchParams.has('idp') ? url.searchParams.get('idp') : decodeURIComponent(/(?:^|;\s*)dev_idp=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '');
  let custom = null; try { const c = JSON.parse(idpRaw || 'null'); custom = c && typeof c === 'object' && !Array.isArray(c) ? c : null; } catch { custom = null; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.delete('cf-access-jwt-assertion');
  if (!expired) headers.set('cf-access-jwt-assertion', await token(decodeURIComponent(as), custom));
  const request = new Request(url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const response = await handle(request, env, page, { waitUntil });
  const out = {}, cookies = []; response.headers.forEach((v, k) => { out[k] = v; });
  if (url.searchParams.get('as')) cookies.push(`dev_as=${encodeURIComponent(url.searchParams.get('as'))}; Path=/; SameSite=Strict`);
  if (url.searchParams.has('idp')) cookies.push(`dev_idp=${encodeURIComponent(url.searchParams.get('idp'))}; Path=/; SameSite=Strict`);
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(response.status, out); res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => console.log(`ATLAS local edge on ${ORIGIN}  (switch user with ?as=email)`));
