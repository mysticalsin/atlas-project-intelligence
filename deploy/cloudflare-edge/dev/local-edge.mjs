// Local, offline run of the edge Worker for demos and browser tests: the real handle() and the real library
// logic (node:sqlite), a local signing key standing in for Cloudflare Access, a switchable test user and a
// stand-in review/recommendation model. No network, no Cloudflare account, loopback only. Never deploy this file.
//   node dev/local-edge.mjs [port]      then open http://127.0.0.1:8787/?as=you@mantu.com
//   Dev only: &idp={"name":"Jane Doe","given_name":"Jane"} (URL-encoded JSON) puts custom claims into the local token,
//   as Access does with Entra name claims (WOW_ZERO_CONFIG §5.5); remembered like ?as=, and an empty &idp= clears it.
//   FAKE_TYPESAFE=1 node dev/local-edge.mjs: JEV runs against the local fake TypeSafe (dev/fake-typesafe.mjs, model id
//   fake-jev-local) with a local key; /__typesafe_mode?m=ok|down|unsure switches it. Without FAKE_TYPESAFE there is no
//   key, and every request to api.typesafe.ai is refused: a local run never reaches a paid provider.
import http from 'node:http';
import { readCanonicalPage } from './page-guard.mjs';
import { handle } from '../src/app.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from '../test/sqlite.js';
import { fakeModel } from './fake-model.mjs';
import { hindsight } from '../src/memory.js';
import { memoryRoutes } from '../src/memory-routes.js';
import { fakeHindsight } from './fake-hindsight.mjs';
import { fakeTypesafe } from './fake-typesafe.mjs';
import { storyRater } from '../src/rating.js';
import { recordUsage } from '../src/telemetry.js';
import { saveJourney } from '../src/journey.js';
import { devIdentityEnabled } from '../src/authz.js';

const PORT = Number(process.argv[2] || 8787), ORIGIN = `http://127.0.0.1:${PORT}`, TEAM = 'local.invalid', AUD = 'local-aud';
const builtPage = new URL('../../../ATLAS_Voice.html', import.meta.url);
const vendoredPage = new URL('../src/atlas.html', import.meta.url);
const page = readCanonicalPage(vendoredPage, builtPage);
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
async function token(email, custom = null) {
  const now = Math.floor(Date.now() / 1000), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'local:' + email, email, exp: now + 3600, iat: now, ...(custom ? { custom } : {}) };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'local' })) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}
const model = fakeModel(), model_complete = m => model.complete(m);
const pending = new Set(), stores = new Map();
const waitUntil = p => { const q = Promise.resolve(p); pending.add(q); q.finally(() => pending.delete(q)).catch(() => {}); };
// Opt-in feature vars pass through from the shell when set (never defaulted here): WOW_SPEC §5, WOW_ZERO_CONFIG §4.
// DATA_MODE stays unset (test mode) unless the shell sets it. Do not set DATA_MODE=production here:
// this process also sets local-synthetic and ATLAS_DEV_IDENTITY, and the Worker refuses that combination.
const passthrough = Object.fromEntries(['EXTERNAL_EMAILS', 'CLIENT_CONFIRM', 'IDENTITY_SOURCE', 'DATA_MODE', 'DNA_PROFILE_URL', 'DNA_AUTH_HEADER', 'DNA_FIELD_MAP', 'DNA_API_KEY',
  'DIRECTORY_PUSH_SECRET'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const storeFor = id => { if (!stores.has(id)) { const m = new Map(); stores.set(id, { get: async k => m.get(k), put: async (k, v) => m.set(k, v) }); } return stores.get(id); };
const env = { ORIGIN, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CSRF_SECRET: 'local-only', TALKER_MODEL: 'local', TTS_VOICE: 'local',
  TRIGGER_SECRET: process.env.TRIGGER_SECRET || 'local-trigger-secret', ANALYST_MODEL: 'local-analyst',
  // Stand-ins for the Workers AI binding: toMarkdown (documents and image descriptions) and chat completions.
  AI: { toMarkdown: async f => { const t = f.blob.type || ''; return t.startsWith('image/') ? { format: 'markdown', data: 'A diagram showing the project phases and approach' } : { format: 'markdown', data: new TextDecoder().decode(await f.blob.arrayBuffer()) }; },
    run: async (model, input) => ({ choices: [{ message: { content: await model_complete(input.messages) } }] }) },
  ATLAS_TENANT_ISOLATION: 'local-synthetic', ATLAS_DEV_IDENTITY: '1',
  ATLAS_ADMIN_ROLES: 'ATLAS.Admin', ATLAS_PRESALES_ROLES: 'ATLAS.Presales,ATLAS.Publish', ATLAS_REVIEWER_ROLES: 'ATLAS.Reviewer,ATLAS.Review',
  HINDSIGHT_URL: HS, HINDSIGHT_API_KEY: 'local-hindsight-key', HINDSIGHT_OPT_IN: '1',
  ATLAS_TOKEN_RATE_IN: process.env.ATLAS_TOKEN_RATE_IN || '0.000002',
  ATLAS_TOKEN_RATE_OUT: process.env.ATLAS_TOKEN_RATE_OUT || '0.000008',
  ATLAS_COST_CURRENCY: process.env.ATLAS_COST_CURRENCY || 'USD',
  INTERVIEW: { idFromName: n => n, get: id => ({ fetch: r => memoryRoutes(r, { storage: storeFor(id), hs, env }) }) },
  LIBRARY: { idFromName: n => n, get: () => ({ fetch: r => libraryRoutes(r, lib, { waitUntil, env }) }) }, ...passthrough,
  ...(FAKE_TYPESAFE ? { TYPESAFE_API_KEY: 'local-fake-key' } : {}) }; // bootstrap then reports jev: true
// The Library as worker.js builds it: with a story rater, which is only available when the environment has a key.
const lib = new Library(memorySql(), { complete: model.complete, embed: model.embed, model: 'local stand-in', services: { teams: null }, rater: storyRater(env, (u, i) => globalThis.fetch(u, i)) });
const consultant = { email: 'consultant@example.test', role: 'user', tenant: '' };
const synthetic = { title: 'Northwind queue pilot', stage: 'Pilot', sector: 'Insurance', consultant: { name: 'Ada Example', role: 'Consultant' },
  client: { name: 'Northwind Mutual', location: 'Example City', contact: 'Operations' },
  details: { projectId: 'SYN-1', country: 'Exampleland', consultants: [] },
  answers: ['A fictional insurer had a slow queue.', 'Ada rebuilt one routing step.', 'The team kept a manual fallback.', 'The queue was shorter on a sample dashboard.', 'Sample dashboard export.', 'Similar fictional service desks.'],
  validation: { manager: { name: 'Sam Example', email: 'manager@example.test' }, managerStaff: false } };
const first = await lib.upsert(consultant, { localId: 'northwind', reference: synthetic });
lib.setState(lib.row(first.id), { ...lib.row(first.id).state, quality: { status: 'ready', score: 80, engine: 'rules' } }, 'seed', 'reviewed', 'synthetic');
lib.bindTrust({ email: 'seed', role: 'system' }, { owner: consultant.email, email: 'manager@example.test', source: 'directory', tenant: '', sandbox: true });
const second = await lib.upsert(consultant, { localId: 'admin-test', reference: { ...synthetic, title: 'Admin test copy' } });
lib.setState(lib.row(second.id), { ...lib.row(second.id).state, quality: { status: 'ready', score: 70, engine: 'rules' } }, 'seed', 'reviewed', 'synthetic');
await saveJourney(lib, consultant, { stage: 'project', fields: { title: { value: 'Northwind queue pilot', source: 'you', confirmed: true }, personalWork: { value: 'Ada rebuilt one routing step in this fictional pilot.', source: 'you', confirmed: true } }, confirmSkill: 'python', skillConfirmed: true, skillSource: 'you' });
await recordUsage(lib, consultant, { kind: 'usage', feature: 'voice', outcome: 'ok', latencyMs: 120, tokenStatus: 'actual', tokensIn: 30, tokensOut: 12, model: 'local-stand-in' });
await recordUsage(lib, consultant, { kind: 'usage', feature: 'journey', outcome: 'ok', tokenStatus: 'missing' });
await recordUsage(lib, { email: 'admin@example.test', role: 'admin' }, { kind: 'error', feature: 'voice', outcome: 'error', latencyMs: 800, errorClass: 'timeout', tokenStatus: 'unknown' });

const hs = hindsight(env);
// Test hook /__expire: the Access application token has expired. Like Access (WOW_ZERO_CONFIG §3.7, §13), requests then
// carry no token (the Worker answers 401) until the next top-level navigation, which is signed in again without a prompt.
let expired = false;
http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const helper = url.pathname === '/__settle' || url.pathname === '/__expire' || url.pathname === '/__trust' || url.pathname === '/__typesafe_mode';
  if (helper && (env.DATA_MODE === 'production' || env.ATLAS_TENANT_ISOLATION !== 'local-synthetic' || env.ATLAS_DEV_IDENTITY !== '1')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Synthetic helper routes run only when DATA_MODE is not production, ATLAS_TENANT_ISOLATION is local-synthetic, and ATLAS_DEV_IDENTITY is 1.' }));
    return;
  }
  if (url.pathname === '/__settle') { await Promise.allSettled([...pending]); res.end('ok'); return; } // test hook: wait for background reviews
  if (url.pathname === '/__expire') { expired = true; res.end('ok'); return; }
  if (url.pathname === '/__typesafe_mode') { // test hook (FAKE_TYPESAFE only): ok | down (529) | unsure
    if (!fakeTs) { res.statusCode = 404; res.end('FAKE_TYPESAFE is off'); return; }
    try { fakeTs.setMode(url.searchParams.get('m') || ''); res.end(fakeTs.mode); } catch { res.statusCode = 400; res.end('mode must be ok, down or unsure'); }
    return;
  }
  if (expired && req.headers['sec-fetch-mode'] === 'navigate') expired = false;
  const devIdentity = devIdentityEnabled(env);
  if (!devIdentity && (url.searchParams.has('as') || url.searchParams.has('idp'))) { res.writeHead(403); res.end('Development identity overrides are off.'); return; }
  const as = devIdentity ? (url.searchParams.get('as') || /(?:^|;\s*)dev_as=([^;]+)/.exec(req.headers.cookie || '')?.[1] || 'consultant@example.test') : 'consultant@example.test';
  const idpRaw = devIdentity ? (url.searchParams.has('idp') ? url.searchParams.get('idp') : decodeURIComponent(/(?:^|;\s*)dev_idp=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '')) : '';
  let custom = null; try { const c = JSON.parse(idpRaw || 'null'); custom = c && typeof c === 'object' && !Array.isArray(c) ? c : null; } catch { custom = null; }
  const chunks = []; for await (const c of req) chunks.push(c);
  if (url.pathname === '/__trust' && req.method === 'POST') {
    if (!devIdentity) { res.writeHead(403); res.end('Development identity overrides are off.'); return; }
    try {
      const spec = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      lib.bindTrust({ email: 'seed', role: 'system' }, { owner: spec.owner, email: spec.email, source: spec.source === 'staffing' ? 'staffing' : 'directory', tenant: '', sandbox: true });
      res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
    } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message || 'refused' })); }
    return;
  }
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
