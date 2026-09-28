// Local, offline run of the edge Worker for demos and browser tests: the real handle() and the real library
// logic (node:sqlite), a local signing key standing in for Cloudflare Access, a switchable test user and a
// stand-in review/recommendation model. No network, no Cloudflare account, loopback only. Never deploy this file.
//   node dev/local-edge.mjs [port]      then open http://127.0.0.1:8787/?as=you@mantu.com
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
async function token(email) {
  const now = Math.floor(Date.now() / 1000), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'local:' + email, email, exp: now + 3600, iat: now };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'local' })) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
}
const model = fakeModel();
const lib = new Library(memorySql(), { complete: model.complete, embed: model.embed, model: 'local stand-in' });
const pending = new Set(), stores = new Map();
const storeFor = id => { if (!stores.has(id)) { const m = new Map(); stores.set(id, { get: async k => m.get(k), put: async (k, v) => m.set(k, v) }); } return stores.get(id); };
const env = { ORIGIN, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CSRF_SECRET: 'local-only', TALKER_MODEL: 'local', TTS_VOICE: 'local',
  TRIGGER_SECRET: process.env.TRIGGER_SECRET || 'local-trigger-secret',
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || 'tony.walteur@gmail.com', REVIEWER_EMAILS: process.env.REVIEWER_EMAILS || 'reviewer@mantu.com',
  HINDSIGHT_URL: HS, HINDSIGHT_API_KEY: 'local-hindsight-key',
  INTERVIEW: { idFromName: n => n, get: id => ({ fetch: r => memoryRoutes(r, { storage: storeFor(id), hs, env }) }) },
  LIBRARY: { idFromName: n => n, get: () => ({ fetch: r => libraryRoutes(r, lib, { waitUntil: p => { pending.add(p); p.finally(() => pending.delete(p)); } }) }) } };

const hs = hindsight(env);
http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/__settle') { await Promise.allSettled([...pending]); res.end('ok'); return; } // test hook: wait for background reviews
  const as = url.searchParams.get('as') || /(?:^|;\s*)dev_as=([^;]+)/.exec(req.headers.cookie || '')?.[1] || 'consultant@mantu.com';
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('cf-access-jwt-assertion', await token(decodeURIComponent(as)));
  const request = new Request(url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const response = await handle(request, env, page);
  const out = {}; response.headers.forEach((v, k) => { out[k] = v; });
  if (url.searchParams.get('as')) out['set-cookie'] = `dev_as=${encodeURIComponent(url.searchParams.get('as'))}; Path=/; SameSite=Strict`;
  res.writeHead(response.status, out); res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => console.log(`ATLAS local edge on ${ORIGIN}  (switch user with ?as=email)`));
