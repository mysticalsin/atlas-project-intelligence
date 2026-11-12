// ATLAS edge application logic (Worker routes, Access verification, Workers AI adapters). Platform-free for Node tests.
// Identity comes ONLY from a verified Cloudflare Access JWT (fail closed). Speech and models run on
// Workers AI through the AI binding, so no provider key exists in this code or in the browser.
import { CHAT_TOOLS, SPEAKING_LIMIT_S } from './policy.generated.js';
import { Session, MAX_SECONDS } from './session.js';
import { wav, to16k } from './speech.js';
import { classify } from './classify.js';
import { bankId, memoryConfigured } from './memory.js';
import { sheetRoutes } from './sheet.js';
import { detectedLanguage, NATIVE_VOICES, normalize } from './languages.js';
import { email as validEmail, inList } from './util.js';
import { flags } from './features.js';
import { teamsRoutes } from './teams-routes.js';
import { CONFIRM_HTML } from './confirm-page.js';
import { nameClaims, pushConfig } from './profile.js';
import { elevatedRole, privilegeReadiness, productionDemoConflict, TENANT_ID, tenantEnforced, tenantOf, tokenRoles } from './authz.js';
import { acceptedSubjectDelete } from './library-routes.js';
import { paid, elevenLabsUrl, utf8Length, analystCall, LIMITS, generationTokens, inputTokenCeiling, capPcm, capText, markdownPlan, ledgerMode } from './meter.js';
import { usageFrom } from './usage.js';
import { httpBudget } from './budget-stop.js';
import { audioMs } from './units.js';
import { ledgerAccessOk, spendRoute } from './spend-route.js';

const enc = new TextEncoder();
// One voice for everyone: @cf/deepgram/aura-2-en "harmonia" (Deepgram: empathetic, clear, calm, confident).
// Transcription is part of the interview; consent covers it and reuse of reviewed notes for future projects.
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const toB64url = s => { let bin = ''; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
let certs = { at: 0, keys: [] };

export async function verifyAccess(request, env, fetcher = fetch) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(h))), payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (header.alg !== 'RS256') return null;
  if (Date.now() - certs.at > 600000 || !certs.keys.some(k => k.kid === header.kid)) {
    try {
      const r = await fetcher(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
      const keys = r.ok ? (await r.json()).keys : null;
      if (Array.isArray(keys) && keys.length) certs = { at: Date.now(), keys };
    } catch { /* keep the previous keys; a bad directory must not replace a good cache or authenticate anyone */ }
  }
  const jwk = certs.keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), enc.encode(h + '.' + p))) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud], now = Date.now() / 1000;
  if (!aud.includes(env.ACCESS_AUD) || payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60) || !payload.sub) return null;
  const roles = tokenRoles({ roles: Array.isArray(payload.custom?.roles) ? payload.custom.roles : [] });
  return entraIdentity(payload, env) ?? (env.IDENTITY_SOURCE === 'entra' ? null : { sub: payload.sub, email: payload.email || 'Access service identity', roles });
}

// Microsoft Entra ID (Windows / Microsoft 365 sign-in) through Cloudflare Access. BUILT, NOT ENABLED:
// active only when IDENTITY_SOURCE='entra'. Access must be configured with the Entra connector and to pass
// the OIDC claims `tid` and `oid` (see entra/README.md). The person's key is `tid:oid`, the same scheme as
// the Python gateway's Entra mode, so private continuity maps 1:1. Only allow-listed tenants are admitted.
export function entraIdentity(payload, env) {
  if (env.IDENTITY_SOURCE !== 'entra') return null;
  const c = payload.custom || {}, tenants = String(env.ENTRA_TENANTS || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(c.tid || '') || !uuid.test(c.oid || '') || !tenants.includes(c.tid.toLowerCase())) return null;
  const roles = Array.isArray(c.roles) ? c.roles.filter(r => typeof r === 'string') : [];
  if (env.ENTRA_REQUIRED_ROLE && !roles.includes(env.ENTRA_REQUIRED_ROLE)) return null;
  return { sub: `${c.tid.toLowerCase()}:${c.oid.toLowerCase()}`, email: payload.email || c.preferred_username || 'Microsoft account', roles };
}

// Sign-in name claims (WOW_ZERO_CONFIG §5.5): name, given_name and family_name from the Access JWT `custom` object,
// each at most 100 characters (name composed from the other two when absent). Called only AFTER verifyAccess has
// accepted this same token, whose return value stays unchanged. Absent claims give {} (PIN sign-in today).
export function signinClaims(request) {
  try { return nameClaims(JSON.parse(new TextDecoder().decode(b64url((request.headers.get('cf-access-jwt-assertion') || '').split('.')[1] || ''))).custom); }
  catch { return {}; }
}

// The re-sign-in landing page (§3.7): opened in a popup, it tells the waiting tab and closes. No data, no token.
export const SIGNED_IN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATLAS</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15151c;color:#e8e8f0;font:15px/1.5 Arial,sans-serif;padding:16px;box-sizing:border-box}</style></head>
<body><p>You're signed in. This window closes by itself.</p>
<script>try{new BroadcastChannel('atlas-auth').postMessage('ok')}catch(e){}setTimeout(function(){window.close()},400)</script></body></html>`;

function timingSafe(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function csrfOk(header, csrf) {
  const a = String(header || ''), b = String(csrf || '');
  if (!a || a.length !== b.length) return false;
  return timingSafe(a, b);
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}

function headers(env, extra = {}) {
  const ws = env.ORIGIN.replace('https://', 'wss://');
  return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; connect-src 'self' ${ws}; img-src data: blob:; font-src 'self'; worker-src blob:; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'${String(env.ORIGIN || '').startsWith('https:') ? '; upgrade-insecure-requests' : ''}`,
    ...extra };
}
const json = (env, body, status = 200) => new Response(JSON.stringify(body), { status, headers: headers(env, { 'Content-Type': 'application/json' }) });
// Spoken Ask audio: 0.1 s to 32 s of 16-bit mono PCM at 24 kHz (the UI records at most 30 s).
const AUDIO_MIN = 4800, AUDIO_MAX = 1536000;
// Reads at most `max` bytes of a request body; null as soon as it is longer (the declared length can be absent or wrong).
async function boundedBytes(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// The cron and the two bearer ingresses share one configured tenant. A caller header or JSON
// field is never the tenant. When isolation is on, a missing or malformed ATLAS_SYSTEM_TENANT
// stops the request before the durable object. The local demo stays on the blank sandbox.
function systemScope(env) {
  const enforced = tenantEnforced(env);
  const tenant = String(env.ATLAS_SYSTEM_TENANT || '').trim().toLowerCase();
  if (!enforced) return { ok: true, tenant: '', flag: '0' };
  if (!TENANT_ID.test(tenant)) return { ok: false, status: 503, body: { error: 'ATLAS_SYSTEM_TENANT is missing or not a verified tenant id. This ingress will not run, and no tenant was taken from the request.' } };
  return { ok: true, tenant, flag: '1' };
}
function callerNamedTenant(request, raw) {
  const named = [];
  const header = String(request.headers.get('x-atlas-tenant') || '').trim().toLowerCase();
  if (header) named.push(header);
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.tenant === 'string' && parsed.tenant.trim()) named.push(parsed.tenant.trim().toLowerCase());
  } catch { /* not JSON: there is no tenant field to accept */ }
  return named;
}
function continuityScope(env, sub, tenant) {
  if (!tenantEnforced(env)) return { ok: true, objectName: String(sub), tenant: '' };
  const tid = String(tenant || '').trim().toLowerCase();
  if (!TENANT_ID.test(tid)) return { ok: false };
  return { ok: true, objectName: `${tid}:${sub}`, tenant: tid };
}
function systemForwardHeaders(user, scope) {
  return { 'Content-Type': 'application/json', 'x-atlas-user': user, 'x-atlas-role': 'system', 'x-atlas-email': '', 'x-atlas-idp': 'e30', 'x-atlas-tenant': scope.tenant, 'x-atlas-tenant-enforced': scope.flag };
}

// flagsOf: the bootstrap feature flags (tests pass flags with D1 approved to exercise /api/transcribe before it flips).
export async function handle(request, env, page, { waitUntil = p => p, flagsOf = flags } = {}) {
  {
    const url = new URL(request.url);
    if (!env.ORIGIN || url.origin !== env.ORIGIN) return new Response('Host is not the configured ATLAS origin.', { status: 403 });
    if (!env.CSRF_SECRET) return new Response('Deployment is not configured (CSRF_SECRET).', { status: 500 });
    // Before triggers, directory push, voice, memory, or the library. A production flag must not
    // disable tenant checks or turn on the local persona switch.
    const demoConflict = productionDemoConflict(env);
    if (demoConflict && url.pathname.startsWith('/api/')) return json(env, demoConflict, 503);
    // Project-management system trigger: its own bearer secret (Access bypass on this path only; see docs/INTEGRATIONS.md).
    if (url.pathname === '/api/triggers' && request.method === 'POST') {
      const secret = env.TRIGGER_SECRET || '', given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!secret || !env.LIBRARY || given.length !== secret.length || !timingSafe(given, secret)) return json(env, { error: 'Unauthorized.' }, 401);
      if (Number(request.headers.get('Content-Length') || 0) > 16384) return json(env, { error: 'Request too large.' }, 413);
      const raw = await request.text();
      const scope = systemScope(env);
      if (!scope.ok) return json(env, scope.body, scope.status);
      if (callerNamedTenant(request, raw).some(t => t !== scope.tenant)) return json(env, { error: 'A system ingress uses only the configured tenant. The tenant on this request was not accepted.' }, 403);
      const fwd = new Request(new URL('/api/library/trigger', request.url), { method: 'POST', body: raw, headers: systemForwardHeaders('pm-system', scope) });
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(fwd);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // DNA push (WOW_ZERO_CONFIG §5.4): the same pattern as /api/triggers, with its own bearer secret (Access bypass on
    // this path only). Production deployments only; forwarded as role `system` to the directory import (source dna).
    if (url.pathname === '/api/directory/push' && request.method === 'POST') {
      const secret = env.DIRECTORY_PUSH_SECRET || '', given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!secret || !env.LIBRARY || given.length !== secret.length || !timingSafe(given, secret)) return json(env, { error: 'Unauthorized.' }, 401);
      const push = pushConfig(env);
      if (push.status !== 'on') return json(env, { error: 'DNA push is not connected.', ...push }, 503);
      const bytes = Number(request.headers.get('Content-Length') || 0) > 262144 ? null : await boundedBytes(request, 262144);
      if (!bytes) return json(env, { error: 'Request too large.' }, 413);
      const scope = systemScope(env);
      if (!scope.ok) return json(env, scope.body, scope.status);
      if (callerNamedTenant(request, bytes).some(t => t !== scope.tenant)) return json(env, { error: 'A system ingress uses only the configured tenant. The tenant on this request was not accepted.' }, 403);
      const fwd = new Request(new URL('/api/library/directory/import', request.url), { method: 'POST', body: bytes, headers: systemForwardHeaders('dna-push', scope) });
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(fwd);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // Teams bot endpoint and launcher tab (pre-Access, like /api/triggers): exactly these two; every other
    // /api/teams/* path falls through to the signed-in handling. BLOCKED_EXTERNAL until Teams is connected.
    if ((url.pathname === '/api/teams/messages' && request.method === 'POST') || (url.pathname === '/teams/tab' && request.method === 'GET')) return teamsRoutes(request, env, { waitUntil });
    if (url.pathname === '/api/ledger/reserve' || url.pathname === '/api/ledger/settle' || url.pathname === '/api/ledger/record') {
      // Cloudflare Access is in front of this host when ACCESS_AUD is set. The bearer is the existing
      // ATLAS_LEDGER_TOKEN. A service token, when the operator has already issued one, is the existing
      // Access client id and secret. This route does not mint a second token. A live Access check is not run here.
      if (env.ACCESS_AUD && !(await ledgerAccessOk(request, env, verifyAccess))) {
        return new Response('Sign in to use ATLAS.', { status: 401, headers: headers(env) });
      }
      const spent = await spendRoute(request, env);
      if (spent) return spent;
    }
    // Identity comes from the verified Access token only. ?as= and &idp= are not read here.
    let who = null;
    try { who = await verifyAccess(request, env); } catch { who = null; }
    if (!who) return new Response('Sign in to use ATLAS.', { status: 401, headers: headers(env) });
    // Access email only: an Entra deployment must grant admin through an app role, never a username fallback.
    const elevated = elevatedRole(env, who);
    const admin = elevated === 'admin';
    // Elevated roles come from the verified token (or ATLAS_ADMIN_SUBJECTS). ADMIN_EMAILS and REVIEWER_EMAILS do not grant them.
    // External confirmers remain an explicit server email allow-list, and only when no elevated role matched.
    const role = elevated || (env.IDENTITY_SOURCE === 'entra' ? 'user' : (inList(who.email, env.EXTERNAL_EMAILS) ? 'external' : 'user'));
    const tenant = tenantOf(who);
    const tenantFlag = tenantEnforced(env) ? '1' : '0';
    const csrf = await hmac(env.CSRF_SECRET, who.sub), subjectKey = (await hmac('atlas-subject', who.sub)).slice(0, 32);
    // Forwarded identity: the library identity (Entra: stable tid:oid; Access: the verified email) and the verified
    // email when it is a valid address (else empty). Always overwritten on every forward.
    const libraryUser = String(env.IDENTITY_SOURCE === 'entra' ? who.sub : who.email || who.sub).toLowerCase(), mail = validEmail(who.email);
    const identity = { name: who.email, mode: env.IDENTITY_SOURCE === 'entra' ? 'entra' : 'access', subjectKey };
    if (role === 'external') {
      // External confirmers (F3) reach only /confirm, a reduced bootstrap and /api/library/confirmations/*.
      if (url.pathname === '/' && request.method === 'GET') return new Response(null, { status: 303, headers: headers(env, { Location: '/confirm' }) });
      if (url.pathname === '/api/bootstrap' && request.method === 'GET') return json(env, { csrf, identity, email: mail, libraryRole: 'external', features: { claims: flagsOf(env).claims } });
      if (request.method === 'GET') { // a confirmation link (WOW_ZERO_CONFIG §3.9) also reaches an external confirmer
        const m = /^\/go\/confirm\/([a-f0-9]{32})$/.exec(url.pathname);
        if (m) return new Response(null, { status: 302, headers: headers(env, { Location: '/confirm#' + m[1] }) });
      }
      if (!(url.pathname === '/confirm' && request.method === 'GET') && !url.pathname.startsWith('/api/library/confirmations/')) return json(env, { error: 'Not available to external confirmers.' }, 403);
    }
    // Links that survive an interactive sign-in (§3.9): /go/start, /go/{gap,invitation,bid,library,confirm}/<32 hex>.
    // Anything else under /go/ goes home. The ids are random, non-secret and grant nothing without sign-in (a recorded
    // deviation from WOW rule 7); no token ever goes in a path, and nothing here logs the path.
    if (request.method === 'GET' && url.pathname === '/go/signed-in') return new Response(SIGNED_IN_HTML, { headers: headers(env, { 'Content-Type': 'text/html; charset=utf-8' }) });
    if (request.method === 'GET' && url.pathname.startsWith('/go/')) {
      const m = /^\/go\/(?:(start)|(gap|invitation|bid|library|confirm)\/([a-f0-9]{32}))$/.exec(url.pathname);
      const to = !m ? '/' : m[1] ? '/#start' : m[2] === 'confirm' ? '/confirm#' + m[3] : '/#' + m[2] + '/' + m[3];
      return new Response(null, { status: 302, headers: headers(env, { Location: to }) });
    }
    if (url.pathname === '/confirm' && request.method === 'GET') return new Response(CONFIRM_HTML, { headers: headers(env, { 'Content-Type': 'text/html; charset=utf-8' }) });
    if (url.pathname === '/' && request.method === 'GET') {
      const runtime = JSON.stringify({ subjectKey, authMode: 'access', name: who.email }).replace(/</g, '\\u003c');
      let body = page.replace('/* SERVER_RUNTIME */', 'window.ATLAS_RUNTIME=' + runtime + ';')
        .replace("connect-src 'self';", "connect-src 'self' " + env.ORIGIN.replace('https://', 'wss://') + ';');
      const end = body.lastIndexOf('</body>'); // the page embeds an earlier '</body>' inside a script string
      // The test banner stays until Tony sets DATA_MODE=production on an approved deployment (WOW_ZERO_CONFIG §0.7, §11).
      if (env.DATA_MODE !== 'production') body = body.slice(0, end) + '<div style="position:fixed;left:12px;bottom:10px;z-index:99;font:11px/1.4 Arial;letter-spacing:.06em;color:#A9A9BC;background:#15151cdd;border:1px solid #2a2a36;border-radius:14px;padding:4px 10px">TEST DEPLOYMENT · SYNTHETIC DATA ONLY</div>' + body.slice(end);
      return new Response(body, { headers: headers(env, { 'Content-Type': 'text/html; charset=utf-8' }) });
    }
    if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
      // One voice for everyone, advertised only as 'atlas': the real voice and provider stay server-side.
      return json(env, { provider: 'workers', providerLabel: 'ATLAS voice', protocol: 'atlas-personaplex-pcm-v1', csrf,
        identity, model: 'ATLAS conversational voice', admin,
        voices: ['atlas'], defaultVoice: 'atlas', captureRequired: true, codecAvailable: true, busy: false, capacity: 1, maxSeconds: MAX_SECONDS, speakingSeconds: SPEAKING_LIMIT_S,
        memory: memoryConfigured(env), wiki: false, jev: !!env.TYPESAFE_API_KEY, jevClassify: !!env.TYPESAFE_API_KEY, library: !!env.LIBRARY, libraryRole: role, sheet: true, transcription: true, structuredNotes: true, liveLedger: true, playbackAck: true,
        readiness: env.DATA_MODE === 'production' ? 'production' : 'edge-deployment-test-data-only', privilege: privilegeReadiness(env), email: mail, features: flagsOf(env) });
    }
    if (url.pathname === '/api/voice') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade.', { status: 426 });
      if (request.headers.get('Origin') !== env.ORIGIN) return new Response('Invalid voice origin', { status: 403 });
      const forward = new Request(request, { headers: new Headers(request.headers) });
      forward.headers.set('x-atlas-admin', admin ? '1' : '0'); // always overwritten: a browser can never claim admin
      forward.headers.set('x-atlas-user', libraryUser); forward.headers.set('x-atlas-role', role); forward.headers.set('x-atlas-email', mail); forward.headers.set('x-atlas-tenant', tenant); forward.headers.set('x-atlas-tenant-enforced', tenantFlag);
      const scope = continuityScope(env, who.sub, tenant);
      if (!scope.ok) return json(env, { error: 'A verified tenant is required before this interview can open. The subject-only object was not read.' }, 403);
      forward.headers.set('x-atlas-bank', await bankId(env, who.sub, scope.tenant)); // server-derived; the browser never picks a bank
      forward.headers.set('x-atlas-csrf', csrf); // set by the Worker only; the DO is not reachable otherwise
      return env.INTERVIEW.get(env.INTERVIEW.idFromName(scope.objectName)).fetch(forward);
    }
    if (url.pathname.startsWith('/api/sheet/') && request.method === 'POST') {
      if (request.headers.get('Origin') !== env.ORIGIN || !csrfOk(request.headers.get('X-Atlas-CSRF'), csrf)) return json(env, { error: 'Invalid request origin or session token.' }, 403);
      if (Number(request.headers.get('Content-Length') || 0) > 12 * 1024 * 1024) return json(env, { error: 'The file is larger than 10 MB.' }, 413);
      // PDF metadata (author, producer, title) is never extracted (D2, WOW_ZERO_CONFIG §4): text only.
      const ai = workersAI(env), res = await sheetRoutes(request, url.pathname.slice('/api/sheet/'.length), { complete: (m, spec) => ai.complete(m, spec),
        toMarkdown: async f => {
          const one = Array.isArray(f) ? f[0] : f;
          const buf = one?.blob && typeof one.blob.arrayBuffer === 'function' ? new Uint8Array(await one.blob.arrayBuffer()) : new Uint8Array(0);
          const plan = markdownPlan(buf, one?.name || '', one?.blob?.type || one?.type || '');
          // Off has no paid upstream, so the local stand-in may describe an image. Enforce and observe never call detr-resnet-50.
          if (!plan.ok && plan.code === 'unpriced_model' && ledgerMode(env) === 'off') return paid(env).toMarkdown(() => ({ kind: 'markdown', media: 'image', files: 1 }), one, { conversionOptions: { pdf: { metadata: false } } });
          if (!plan.ok) throw Object.assign(new Error(plan.error), { status: plan.status || 413, code: plan.code });
          return paid(env).toMarkdown(() => ({ kind: 'markdown', files: plan.estimate.files, media: plan.estimate.media }), one, { conversionOptions: { pdf: { metadata: false } } });
        } });
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/memory' || url.pathname.startsWith('/api/memory/')) {
      if (request.method !== 'GET' && (request.headers.get('Origin') !== env.ORIGIN || !csrfOk(request.headers.get('X-Atlas-CSRF'), csrf))) return json(env, { error: 'Invalid request origin or session token.' }, 403);
      if (Number(request.headers.get('Content-Length') || 0) > 131072) return json(env, { error: 'Request too large.' }, 413);
      const forward = new Request(request, { headers: new Headers(request.headers) });
      const scope = continuityScope(env, who.sub, tenant);
      if (!scope.ok) return json(env, { error: 'A verified tenant is required before memory can open. The subject-only bank was not read.' }, 403);
      forward.headers.set('x-atlas-bank', await bankId(env, who.sub, scope.tenant)); forward.headers.set('x-atlas-role', role); forward.headers.set('x-atlas-tenant', tenant); forward.headers.set('x-atlas-tenant-enforced', tenantFlag);
      const res = await env.INTERVIEW.get(env.INTERVIEW.idFromName(scope.objectName)).fetch(forward);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/library' || url.pathname.startsWith('/api/library/')) {
      if (!env.LIBRARY) return json(env, { error: 'The reference library is not configured on this deployment.' }, 404);
      if (request.method !== 'GET' && (request.headers.get('Origin') !== env.ORIGIN || !csrfOk(request.headers.get('X-Atlas-CSRF'), csrf))) return json(env, { error: 'Invalid request origin or session token.' }, 403);
      if (Number(request.headers.get('Content-Length') || 0) > 262144) return json(env, { error: 'Request too large.' }, 413);
      // The declared length can be absent or wrong: read at most 256 KiB of the body actually sent, then forward it.
      const bodyless = request.method === 'GET' || request.method === 'HEAD', bytes = bodyless ? null : await boundedBytes(request, 262144);
      if (!bodyless && !bytes) return json(env, { error: 'Request too large.' }, 413);
      if (acceptedSubjectDelete(request.method, url.pathname) && !TENANT_ID.test(tenant)) {
        return json(env, { error: 'A verified tenant is required.' }, 403);
      }
      const fwdHeaders = new Headers(request.headers); fwdHeaders.delete('content-length');
      const forward = new Request(request.url, { method: request.method, headers: fwdHeaders, body: bodyless ? undefined : bytes });
      // Entra: the stable tid:oid is the library identity (emails can change); Access: the verified email.
      forward.headers.set('x-atlas-user', libraryUser); forward.headers.set('x-atlas-role', role); forward.headers.set('x-atlas-email', mail); forward.headers.set('x-atlas-tenant', tenant); forward.headers.set('x-atlas-tenant-enforced', tenantFlag);
      forward.headers.set('x-atlas-idp', toB64url(JSON.stringify(signinClaims(request)))); // always overwritten ('e30' = {}): never from the browser
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(forward);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // Spoken Ask (F6): transcription of one short question. Off while SPOKEN_ASK_APPROVED (D1) is false; then each
    // request needs the consent prompt's header, and `always` a consent stored in the person's profile. Stores nothing;
    // the log line carries numbers only.
    if (url.pathname === '/api/transcribe' && request.method === 'POST' && flagsOf(env).spokenAsk) {
      if (request.headers.get('Origin') !== env.ORIGIN || !csrfOk(request.headers.get('X-Atlas-CSRF'), csrf)) return json(env, { error: 'Invalid request origin or session token.' }, 403);
      // A UI gate: it proves the page showed the prompt, not that the person agreed; `always` is checked server-side.
      const consent = /^spoken-ask-v1;\s*(once|always)$/.exec((request.headers.get('X-Atlas-Consent') || '').trim());
      if (!consent || (consent[1] === 'always' && !await storedSpokenAsk(env, { libraryUser, role, mail, tenant, tenantFlag }))) return json(env, { error: 'Voice questions need your consent first.' }, 403);
      if ((request.headers.get('Content-Type') || '').replace(/\s+/g, '').toLowerCase() !== 'audio/l16;rate=24000') return json(env, { error: 'Send 16-bit mono PCM at 24 kHz (audio/L16;rate=24000).' }, 415);
      const pcm = Number(request.headers.get('Content-Length') || 0) > AUDIO_MAX ? null : await boundedBytes(request, AUDIO_MAX);
      if (!pcm) return json(env, { error: 'The recording is longer than 30 seconds.' }, 413);
      if (pcm.length < AUDIO_MIN || pcm.length % 2) return json(env, { error: 'The recording is too short or is not 16-bit audio.' }, 400);
      const t0 = Date.now(), metric = values => console.log(JSON.stringify({ atlas_metric: 'transcribe', ms: Date.now() - t0, bytes: pcm.length, ...values }));
      let out;
      try { out = await workersAI(env).transcribe(pcm); }
      catch (e) {
        metric({ failed: 1 });
        const stopped = httpBudget(e);
        if (stopped) return json(env, stopped.body, stopped.status);
        return json(env, { error: 'Transcription failed. Type the question instead.' }, 502);
      }
      metric({});
      return json(env, { text: String(out?.text || '').slice(0, 600), language: out?.language || null });
    }
    if (url.pathname === '/api/jev/classify' && request.method === 'POST') {
      if (request.headers.get('Origin') !== env.ORIGIN || !csrfOk(request.headers.get('X-Atlas-CSRF'), csrf)) return json(env, { error: 'Invalid request origin or session token.' }, 403);
      if (Number(request.headers.get('Content-Length') || 0) > 65536) return json(env, { error: 'Project too large to score.' }, 413);
      const raw = await request.text();
      if (raw.length > 65536) return json(env, { error: 'Project too large to score.' }, 413);
      let project;
      try { project = JSON.parse(raw).project; } catch { return json(env, { error: 'Invalid JSON.' }, 400); }
      try { return json(env, await classify(env, project)); }
      catch (e) {
        const stopped = httpBudget(e);
        if (stopped) return json(env, stopped.body, stopped.status);
        return e.status ? json(env, { error: e.message }, e.status) : json(env, { error: 'Scoring is unavailable right now. Try again shortly.' }, 502);
      }
    }
    if (url.pathname === '/api/test-voice' && env.TEST_VOICE === '1' && request.method === 'GET') {
      // Test-only (off unless TEST_VOICE=1, and still behind Access): synthesizes a scripted consultant line
      // with a different voice so an automated browser can speak into a virtual microphone.
      const text = (url.searchParams.get('text') || '').slice(0, 300), speaker = url.searchParams.get('speaker') || 'orion';
      if (!text || !/^[a-z]+$/.test(speaker)) return json(env, { error: 'text and speaker required' }, 400);
      const pcm = await workersAI(env).synthesize(text, speaker);
      return new Response(pcm, { headers: headers(env, { 'Content-Type': 'audio/L16;rate=24000' }) });
    }
    // A browser navigation to an unknown page (an old /ATLAS_Voice.html link, say) goes home; API paths keep their JSON 404.
    if (request.method === 'GET' && !url.pathname.startsWith('/api/')
      && (request.headers.get('Sec-Fetch-Mode') === 'navigate' || /text\/html/.test(request.headers.get('Accept') || ''))) return new Response(null, { status: 302, headers: headers(env, { Location: '/' }) });
    return json(env, { error: 'This feature is not available in this deployment.' }, 404);
  }
}

// D1 "Always allow for me": the consent stored in the person's own profile (LibraryStore), read with the verified
// identity only. Anything but a stored version-1 consent (not READY, revoked, unreachable) counts as no consent.
async function storedSpokenAsk(env, { libraryUser, role, mail, tenant, tenantFlag }) {
  if (!env.LIBRARY) return false;
  try {
    const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(new Request('https://atlas.internal/api/library/profile/consents',
      { headers: { 'x-atlas-user': libraryUser, 'x-atlas-role': role, 'x-atlas-email': mail, 'x-atlas-tenant': tenant || '', 'x-atlas-tenant-enforced': tenantFlag || '0', 'x-atlas-idp': 'e30' } }));
    return res.ok && (await res.json())?.spokenAsk?.version === 1;
  } catch { return false; }
}

// Daily cron (worker.js delegates here so Node tests cover it): references not updated for six months get an
// update invitation for their owner, plus the feature modules' daily housekeeping. Nothing is ever sent.
export async function scheduled(controller, env, ctx) {
  if (!env.LIBRARY || productionDemoConflict(env)) return;
  const enforced = tenantEnforced(env);
  const tenant = String(env.ATLAS_SYSTEM_TENANT || '').trim().toLowerCase();
  if (enforced && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) return;
  const req = new Request('https://atlas.internal/api/library/scan-stale', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system', 'x-atlas-tenant': enforced ? tenant : '', 'x-atlas-tenant-enforced': enforced ? '1' : '0' } });
  ctx.waitUntil(env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(req));
}

// Workers AI adapters. Tolerant of both OpenAI-shaped and native response shapes.
// gpt-oss through the binding may answer in Chat Completions or Responses API shape; accept both (and the legacy shape).
export function responseText(r) {
  if (typeof r?.choices?.[0]?.message?.content === 'string') return r.choices[0].message.content;
  if (Array.isArray(r?.output)) return r.output.filter(o => o?.type === 'message').flatMap(o => Array.isArray(o.content) ? o.content : [])
    .filter(c => c?.type === 'output_text' && typeof c.text === 'string').map(c => c.text).join('');
  return typeof r?.output_text === 'string' ? r.output_text : typeof r?.response === 'string' ? r.response : '';
}
export function responseToolCalls(r) {
  const args = a => typeof a === 'string' ? a : JSON.stringify(a || {});
  const chat = r?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(chat)) return chat.map((c, i) => ({ id: c.id || 'call-' + i, name: c.function?.name, arguments: args(c.function?.arguments) }));
  if (Array.isArray(r?.output)) return r.output.filter(o => o?.type === 'function_call').map((c, i) => ({ id: c.call_id || c.id || 'call-' + i, name: c.name, arguments: args(c.arguments) }));
  return (r?.tool_calls || []).map((c, i) => ({ id: c.id || 'call-' + i, name: c.name, arguments: args(c.arguments) }));
}
// Low reasoning effort keeps the hidden reasoning from eating the output budget. Each attempt reserves on its
// own. A ledger refusal is not a rejected field and is not retried.
async function runReasoning(env, input, spec) {
  const cap = generationTokens(spec);
  const sent = { ...input, max_tokens: cap };
  const estimate = () => ({ kind: 'analyst', model: env.ANALYST_MODEL,
    inputTokens: inputTokenCeiling(utf8Length(JSON.stringify(sent))), outputTokens: cap });
  return analystCall(env, estimate, sent);
}

// ElevenLabs Flash v2.5 (32 languages) as raw 24 kHz PCM, the same format as Aura. Optional: ELEVENLABS_API_KEY.
async function elevenLabs(env, text, lang, fetcher = fetch) {
  const spoken = capText(text, LIMITS.tts.maxChars);
  const voice = encodeURIComponent(env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM');
  const r = await paid(env).fetch(() => ({ kind: 'tts', provider: 'elevenlabs', chars: utf8Length(spoken) }), fetcher, elevenLabsUrl(voice), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: spoken, model_id: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5', language_code: lang }) });
  if (!r.ok) throw new Error('ElevenLabs HTTP ' + r.status);
  const pcm = new Uint8Array(await r.arrayBuffer());
  return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
}

export function workersAI(env) {
  const bytesOf = async r => r instanceof Uint8Array ? r : r instanceof ArrayBuffer ? new Uint8Array(r)
    : r instanceof ReadableStream || r instanceof Response ? new Uint8Array(await new Response(r.body ?? r).arrayBuffer())
    : r?.audio ? Uint8Array.from(atob(r.audio), c => c.charCodeAt(0)) : new Uint8Array(0);
  const meter = paid(env);
  return {
    // Automatic language detection (Nova-3 "multi"): returns the text and the utterance's language.
    async transcribe(pcm) {
      const audio = capPcm(pcm, LIMITS.stt.maxAudioMs);
      const r = await meter.run(() => ({ kind: 'stt', model: env.STT_MODEL, audioMs: audioMs(audio) }), env.STT_MODEL, { audio: { body: new Blob([wav(audio)]).stream(), contentType: 'audio/wav' }, smart_format: true, punctuate: true, language: env.STT_LANGUAGE || 'multi' });
      return { text: r?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '', language: detectedLanguage(r) };
    },
    // Semantic end-of-turn (Pipecat smart-turn v2): has the consultant finished, or only paused? Last 8 s at 16 kHz.
    // Sent as a base64 WAV string: the binding rejects the streamed {body, contentType} form for this model (AiError).
    async turnComplete(pcm) {
      const tail = capPcm(pcm, LIMITS.turn.maxAudioMs), bytes = wav(to16k(tail), 16000);
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const model = env.TURN_MODEL || '@cf/pipecat-ai/smart-turn-v2', r = await meter.run(() => ({ kind: 'turn', model, audioMs: audioMs(tail) }), model, { audio: btoa(bin) });
      // No boolean verdict is no verdict (the session logs it as NoVerdict and uses the silence rule), never "unfinished".
      return typeof r?.is_complete === 'boolean' ? { complete: r.is_complete, probability: Number(r.probability) || 0 } : null;
    },
    speaks(lang) { return NATIVE_VOICES.includes(lang) || (!!env.ELEVENLABS_API_KEY && !!normalize(lang)); },
    async synthesize(text, speaker = 'atlas', lang = 'en') { // 'atlas' = the configured voice; the browser never sees its real name
      const spoken = capText(text, LIMITS.tts.maxChars);
      if (lang !== 'en' && lang !== 'es' && env.ELEVENLABS_API_KEY) return elevenLabs(env, spoken, lang);
      const es = lang === 'es', model = es ? (env.TTS_MODEL_ES || '@cf/deepgram/aura-2-es') : env.TTS_MODEL;
      const pcm = await bytesOf(await meter.run(() => ({ kind: 'tts', model, lang: es ? 'es' : 'en', chars: utf8Length(spoken) }), model, { text: spoken, speaker: es ? (env.TTS_VOICE_ES || 'celeste') : speaker === 'atlas' ? env.TTS_VOICE : speaker, encoding: 'linear16', container: 'none', sample_rate: 24000 }));
      return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
    },
    // Session affinity keeps one interview on the same model instance, so the cached prompt prefix is reused.
    async *chatStream(messages, { affinity } = {}) {
      const cap = generationTokens(LIMITS.talker);
      const body = { messages, stream: true, max_tokens: cap, temperature: 0.7 };
      const held = await meter.hold(() => ({ kind: 'talker', model: env.TALKER_MODEL, inputTokens: inputTokenCeiling(utf8Length(JSON.stringify(body))), outputTokens: cap }));
      let usage = null;
      let failed = null;
      let accepted = 0;
      try {
        const stream = await held.run(env.TALKER_MODEL, body, affinity ? { extraHeaders: { 'x-session-affinity': affinity } } : undefined);
        const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        const stop = async () => { try { await reader.cancel(); } catch { /* the provider is already closed */ } };
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let cut;
            while ((cut = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, cut).trim(); buffer = buffer.slice(cut + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') return;
              try {
                const j = JSON.parse(payload);
                const found = usageFrom(j);
                if (found) usage = found;
                const d = j.response ?? j.choices?.[0]?.delta?.content;
                if (!d) continue;
                const room = cap - accepted;
                if (room <= 0) { await stop(); return; }
                const piece = d.length > room ? d.slice(0, room) : d;
                accepted += piece.length;
                yield piece;
                if (accepted >= cap) { await stop(); return; }
              } catch { /* keep-alive or partial */ }
            }
          }
        } finally {
          try { reader.releaseLock(); } catch { /* already released */ }
        }
      } catch (e) {
        failed = e;
        throw e;
      } finally {
        try { await held.finish(failed ? { error: failed.name || 'Error' } : (usage ? { usage } : {})); }
        catch (settleError) { if (!failed) throw settleError; }
      }
    },
    async complete(messages, spec = LIMITS.analystComplete) {
      const chosen = spec && typeof spec === 'object' && spec.maxTokens ? spec : LIMITS.analystComplete;
      return responseText(await runReasoning(env, { messages, temperature: 0.1 }, chosen));
    },
    async embed(text) {
      const model = env.EMBED_MODEL || '@cf/baai/bge-m3', input = capText(text, LIMITS.embed.maxChars);
      const r = await meter.run(() => ({ kind: 'embed', model, inputTokens: inputTokenCeiling(utf8Length(input)) }), model, { text: [input] });
      const v = r?.data?.[0];
      return Array.isArray(v) && v.length ? v : null;
    },
    async report(messages) {
      return responseText(await runReasoning(env, { messages, temperature: 0.2 }, LIMITS.analystReport));
    },
    async analyst(messages) {
      return responseToolCalls(await runReasoning(env, { messages, tools: CHAT_TOOLS, tool_choice: 'auto', temperature: 0 }, LIMITS.analyst));
    },
  };
}
