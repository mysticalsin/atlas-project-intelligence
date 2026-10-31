// ATLAS edge application logic (Worker routes, Access verification, Workers AI adapters). Platform-free for Node tests.
// Identity comes ONLY from a verified Cloudflare Access JWT (fail closed). Speech and models run on
// Workers AI through the AI binding, so no provider key exists in this code or in the browser.
import { CHAT_TOOLS, SPEAKING_LIMIT_S } from './policy.generated.js';
import { Session, MAX_SECONDS, sessionFlags } from './session.js';
import { wav, to16k } from './speech.js';
import { classify } from './classify.js';
import { bankId, bankSecretStatus, BANK_SECRET_MESSAGE } from './memory.js';
import { secure, baseSecurityHeaders, DATA_CSP } from './security-headers.js';
import { PAGE_SCRIPT_HASHES, RUNTIME_BLOCK, REPORT_PATH, htmlCspHeaders, inlineScriptHashes, runtimeBlock, withoutMetaCsp, cspMode } from './csp.js';
import { cspReport } from './csp-report.js';
import { boundedBytes } from './bounded.js';
import { requestLog, announceFlags } from './security-log.js';
import * as ks from './kill-switches.js';
import { limitOf, HOUR, retryAfterHeaders } from './ratelimit.js';
import { sheetRoutes } from './sheet.js';
import { detectedLanguage, NATIVE_VOICES, ELEVENLABS_LANGUAGES, languageList } from './languages.js';
import { sttWords } from './asr.js';
import { email as validEmail, inList } from './util.js';
import { flags } from './features.js';
import { teamsRoutes } from './teams-routes.js';
import { CONFIRM_HTML } from './confirm-page.js';
import { nameClaims, pushConfig } from './profile.js';
import { checkpointEnabled } from './checkpoint.js';
import { connectionsView } from './connectors.js';
import * as privacy from './privacy.js';
import { RETENTION } from './policy.generated.js';

const enc = new TextEncoder();
const ERASE_TOKEN_MS = 10 * 60 * 1000; // the confirmation of "Delete my data" is good for ten minutes, for this sign-in only
export const TALKER_MAX_TOKENS = 160; // one or two spoken sentences; the reply guard cuts at 45 words anyway (override: env TALKER_MAX_TOKENS)
// One voice for everyone: @cf/deepgram/aura-2-en "harmonia" (Deepgram: empathetic, clear, calm, confident).
// Transcription is part of the interview; consent covers it and reuse of reviewed notes for future projects.
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const toB64url = s => { let bin = ''; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
// Access signing keys (blue review G11), cached per team domain. A fetch has a 3 s timeout and must answer 200 with a key list.
// An unknown `kid` may refetch at most once per minute (a token with a random kid cannot make the Worker hammer the identity
// provider); a failed fetch backs off 5 s, 10 s, ... up to 5 min while the last good keys keep serving for up to an hour.
const JWKS_TTL = 600000, JWKS_MIN_REFETCH = 60000, JWKS_STALE_MAX = 3600000, JWKS_TIMEOUT = 3000;
const jwks = new Map();
export function resetJwksCache() { jwks.clear(); }
async function signingKey(env, kid, fetcher) {
  const domain = String(env.ACCESS_TEAM_DOMAIN), now = Date.now();
  const c = jwks.get(domain) || { at: 0, keys: [], tried: 0, fails: 0, inflight: null };
  jwks.set(domain, c);
  const fresh = now - c.at <= JWKS_TTL, known = c.keys.some(k => k.kid === kid);
  const wait = c.fails ? Math.min(300000, 5000 * 2 ** (c.fails - 1)) : fresh ? JWKS_MIN_REFETCH : 0;
  if ((!fresh || !known) && (!c.tried || now - c.tried >= wait) && !c.inflight) {
    c.tried = now;
    c.inflight = (async () => {
      try {
        const r = await fetcher(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(Math.min(10000, Math.max(50, Number(env.ACCESS_JWKS_TIMEOUT_MS) || JWKS_TIMEOUT))) });
        if (!r.ok) throw new Error('certs ' + r.status);
        const keys = (await r.json())?.keys;
        if (!Array.isArray(keys)) throw new Error('certs shape');
        c.keys = keys; c.at = Date.now(); c.fails = 0;
      } catch { c.fails++; if (Date.now() - c.at > JWKS_STALE_MAX) c.keys = []; } finally { c.inflight = null; }
    })();
  }
  if (c.inflight) await c.inflight;
  return c.keys.find(k => k.kid === kid) || null;
}

export async function verifyAccess(request, env, fetcher = fetch) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(h))), payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (header.alg !== 'RS256') return null;
  const jwk = await signingKey(env, header.kid, fetcher);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), enc.encode(h + '.' + p))) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud], now = Date.now() / 1000;
  if (!aud.includes(env.ACCESS_AUD) || payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60) || (payload.iat && payload.iat > now + 60) || !payload.sub) return null;
  return entraIdentity(payload, env) ?? (env.IDENTITY_SOURCE === 'entra' ? null : { sub: payload.sub, email: payload.email || 'Access service identity' });
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

// The issue time (`iat`, whole seconds) of the Access token just verified by verifyAccess: the CSRF token binds to it, so it dies with the session.
export function accessIssuedAt(request) {
  try { const iat = Number(JSON.parse(new TextDecoder().decode(b64url((request.headers.get('cf-access-jwt-assertion') || '').split('.')[1] || ''))).iat); return Number.isFinite(iat) ? Math.trunc(iat) : 0; }
  catch { return 0; }
}

// The re-sign-in landing page (§3.7): opened in a popup, it tells the waiting tab and closes. No data, no token.
export const SIGNED_IN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATLAS</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15151c;color:#e8e8f0;font:15px/1.5 Arial,sans-serif;padding:16px;box-sizing:border-box}</style></head>
<body><p>You're signed in. This window closes by itself.</p>
<script>try{new BroadcastChannel('atlas-auth').postMessage('ok')}catch(e){}setTimeout(function(){window.close()},400)</script></body></html>`;

// Constant-time for equal lengths; unequal lengths are never equal (both secrets here have a fixed, public length).
function timingSafe(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}

// Headers of a data response (JSON, text, redirect): the locked-down data policy. HTML responses use htmlHeaders instead (csp.js).
function headers(env, extra = {}) {
  return { ...baseSecurityHeaders(), 'Content-Security-Policy': DATA_CSP, ...extra };
}
// Headers of an HTML response: the one strict policy builder (csp.js) with the hashes of that page's own inline scripts.
function htmlHeaders(env, hashes, extra = {}) {
  return { ...baseSecurityHeaders(), ...htmlCspHeaders(env, { hashes, connect: env.ORIGIN.replace('https://', 'wss://') }), 'Content-Type': 'text/html; charset=utf-8', ...extra };
}
const readOnly503 = env => new Response(JSON.stringify({ error: ks.READ_ONLY_MESSAGE, code: 'READ_ONLY' }), { status: 503, headers: headers(env, { 'Content-Type': 'application/json', 'Retry-After': '300' }) });
const json = (env, body, status = 200) => new Response(JSON.stringify(body), { status, headers: headers(env, { 'Content-Type': 'application/json' }) });
// Spoken Ask audio: 0.1 s to 32 s of 16-bit mono PCM at 24 kHz (the UI records at most 30 s).
const AUDIO_MIN = 4800, AUDIO_MAX = 1536000;
// flagsOf: the bootstrap feature flags (tests pass flags with D1 approved to exercise /api/transcribe before it flips).
// The CSRF token (blue review G4): HMAC(CSRF_SECRET, sub | iat), so it is tied to the Access session that issued it and a new sign-in
// gives a new token. The page gets it from /api/bootstrap and sends it back as X-Atlas-CSRF (the WebSocket start carries it too).
// Rollback if Access turned out to re-mint the application token while a page is open (a new `iat` would then stale the page's token until it reloads):
// ATLAS_CSRF_BIND=sub binds to the person only, as before. Default: bound to the sign-in.
const csrfToken = (env, sub, iat) => hmac(env.CSRF_SECRET, String(env.ATLAS_CSRF_BIND || '').toLowerCase() === 'sub' ? sub : sub + '|' + iat);
function safeEqual(a, b) { return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafe(a, b); }
// Origin then token, both checked on every state-changing HTTP route; a refusal is logged with its own reason code and no value.
function csrfRefusal(request, env, csrf, sec) {
  const origin = request.headers.get('Origin');
  if (origin !== env.ORIGIN) { sec.log('origin_fail', origin ? 'ORIGIN_MISMATCH' : 'ORIGIN_MISSING', 403); return json(env, { error: 'Invalid request origin or session token.' }, 403); }
  const given = request.headers.get('X-Atlas-CSRF');
  if (!safeEqual(given || '', csrf)) { sec.log('csrf_fail', given ? 'CSRF_MISMATCH' : 'CSRF_MISSING', 403); return json(env, { error: 'Invalid request origin or session token.' }, 403); }
  return null;
}

// Every entry header the Worker itself sets for the Durable Objects. A browser must never supply one: all but the two it legitimately
// sends (the CSRF token and the spoken-ask consent) are removed before anything reads the request (blue review G9).
const INBOUND_ATLAS = /^x-atlas-(?!csrf$|consent$)/i;
function withoutSpoofedHeaders(request) {
  const bad = [...request.headers.keys()].filter(k => INBOUND_ATLAS.test(k));
  if (!bad.length) return { request, n: 0 };
  const h = new Headers(request.headers);
  for (const k of bad) h.delete(k);
  return { request: new Request(request, { headers: h }), n: bad.length };
}

// The Worker entry. Order matters: spoofed headers go first, the route runs, then EVERY response (early refusals and Teams included)
// gets the security headers, and any 401/403/413/429 that no site logged specifically is logged once, with route template and pseudonym only.
export async function handle(request, env, page, opts = {}) {
  const sec = requestLog(request, env, opts.log);
  const cleaned = withoutSpoofedHeaders(request);
  if (cleaned.n) sec.log('header_spoof', 'X_ATLAS_STRIPPED', undefined, { n: cleaned.n });
  let res;
  try { res = await route(cleaned.request, env, page, opts, sec); }
  catch { sec.log('internal_error', 'EXCEPTION', 500); res = new Response(JSON.stringify({ error: 'Something went wrong. Nothing was changed.' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  catchAll(sec, request, res);
  await sec.flush();
  return secure(res);
}
const INBOUND_PATHS = ['/api/triggers', '/api/directory/push', '/api/teams/messages', '/teams/tab'];
function catchAll(sec, request, res) {
  if (sec.logged) return;
  const path = new URL(request.url).pathname;
  if (res.status === 401) sec.log(INBOUND_PATHS.includes(path) ? 'bearer_fail' : 'authn_fail', 'UNAUTHENTICATED', 401);
  else if (res.status === 403) sec.log('access_denied', 'FORBIDDEN', 403);
  else if (res.status === 413) sec.log('body_too_large', 'TOO_LARGE', 413);
  else if (res.status === 429) sec.log('rate_limited', 'RATE:UPSTREAM', 429);
}

async function route(request, env, page, { waitUntil = p => p, flagsOf = flags } = {}, sec) {
  {
    const url = new URL(request.url);
    if (!env.ORIGIN || url.origin !== env.ORIGIN) return new Response('Host is not the configured ATLAS origin.', { status: 403 });
    if (!env.CSRF_SECRET) return new Response('Deployment is not configured (CSRF_SECRET).', { status: 500 });
    // Kill switches (kill-switches.js), cheapest first: they apply before any secret or identity is looked at.
    const inbound = ((url.pathname === '/api/triggers' || url.pathname === '/api/directory/push' || url.pathname === '/api/teams/messages') && request.method === 'POST') || (url.pathname === '/teams/tab' && request.method === 'GET');
    await announceFlags(env, ks.activeSwitches(env), sec.write);
    if (inbound && ks.inboundOff(env)) { sec.log('inbound_off', 'INBOUND_OFF', 503); return json(env, { error: ks.INBOUND_OFF_MESSAGE, code: 'INBOUND_OFF' }, 503); }
    if (request.method !== 'GET' && request.method !== 'HEAD' && ks.readOnly(env)) { sec.log('kill_switch', 'READ_ONLY', 503); return readOnly503(env); }
    // Project-management system trigger: its own bearer secret (Access bypass on this path only; see docs/INTEGRATIONS.md).
    if (url.pathname === '/api/triggers' && request.method === 'POST') {
      const secret = env.TRIGGER_SECRET || '', given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!secret || !env.LIBRARY || given.length !== secret.length || !timingSafe(given, secret)) { sec.log('bearer_fail', 'BEARER_INVALID', 401); return json(env, { error: 'Unauthorized.' }, 401); }
      const trigger = await boundedBytes(request, 16384); // streamed and capped: a body with no Content-Length is cut off at the limit
      if (trigger === null) return json(env, { error: 'Request too large.' }, 413);
      const fwd = new Request(new URL('/api/library/trigger', request.url), { method: 'POST', body: trigger, headers: { 'Content-Type': 'application/json', 'x-atlas-user': 'pm-system', 'x-atlas-role': 'system' } });
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(fwd);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // DNA push (WOW_ZERO_CONFIG §5.4): the same pattern as /api/triggers, with its own bearer secret (Access bypass on
    // this path only). Production deployments only; forwarded as role `system` to the directory import (source dna).
    if (url.pathname === '/api/directory/push' && request.method === 'POST') {
      const secret = env.DIRECTORY_PUSH_SECRET || '', given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!secret || !env.LIBRARY || given.length !== secret.length || !timingSafe(given, secret)) { sec.log('bearer_fail', 'BEARER_INVALID', 401); return json(env, { error: 'Unauthorized.' }, 401); }
      const push = pushConfig(env);
      if (push.status !== 'on') return json(env, { error: 'DNA push is not connected.', ...push }, 503);
      const bytes = await boundedBytes(request, 262144);
      if (!bytes) return json(env, { error: 'Request too large.' }, 413);
      const fwd = new Request(new URL('/api/library/directory/import', request.url), { method: 'POST', body: bytes,
        headers: { 'Content-Type': 'application/json', 'x-atlas-user': 'dna-push', 'x-atlas-role': 'system', 'x-atlas-email': '', 'x-atlas-idp': 'e30' } });
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(fwd);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // Teams bot endpoint and launcher tab (pre-Access, like /api/triggers): exactly these two; every other
    // /api/teams/* path falls through to the signed-in handling. BLOCKED_EXTERNAL until Teams is connected.
    if ((url.pathname === '/api/teams/messages' && request.method === 'POST') || (url.pathname === '/teams/tab' && request.method === 'GET')) return teamsRoutes(request, env, { waitUntil });
    let who = null;
    try { who = await verifyAccess(request, env); } catch { who = null; }
    if (!who) { sec.log('authn_fail', request.headers.get('cf-access-jwt-assertion') ? 'ACCESS_JWT_INVALID' : 'ACCESS_JWT_MISSING', 401); return new Response('Sign in to use ATLAS.', { status: 401, headers: headers(env) }); }
    // Access email only: an Entra deployment must grant admin through an app role, never a username fallback.
    const listed = (names, e) => (names || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(String(e || '').toLowerCase());
    const admin = env.IDENTITY_SOURCE !== 'entra' && (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(String(who.email || '').toLowerCase());
    // Library role. Entra: app roles only (never a username fallback); Access: verified email lists, then 'external'
    // only for an email explicitly listed in EXTERNAL_EMAILS (never by domain), else 'user'.
    const role = env.IDENTITY_SOURCE === 'entra' ? (who.roles?.includes('ATLAS.Admin') ? 'admin' : who.roles?.includes('ATLAS.Reviewer') ? 'reviewer' : 'user')
      : admin ? 'admin' : listed(env.REVIEWER_EMAILS, who.email) ? 'reviewer' : inList(who.email, env.EXTERNAL_EMAILS) ? 'external' : 'user';
    const csrf = await csrfToken(env, who.sub, accessIssuedAt(request)), subjectKey = (await hmac('atlas-subject', who.sub)).slice(0, 32);
    sec.identify(subjectKey, role);
    if (ks.blockedSubject(env, subjectKey)) { sec.log('subject_blocked', 'BLOCKED_SUBJECT', 403); return json(env, { error: ks.BLOCKED_MESSAGE, code: 'BLOCKED' }, 403); }
    // Forwarded identity: the library identity (Entra: stable tid:oid; Access: the verified email) and the verified
    // email when it is a valid address (else empty). Always overwritten on every forward.
    const libraryUser = String(env.IDENTITY_SOURCE === 'entra' ? who.sub : who.email || who.sub).toLowerCase(), mail = validEmail(who.email);
    const identity = { name: who.email, mode: env.IDENTITY_SOURCE === 'entra' ? 'entra' : 'access', subjectKey };
    if (ks.externalOff(env) && (role === 'external' || url.pathname === '/confirm' || url.pathname.startsWith('/api/library/confirmations/') || url.pathname.startsWith('/go/confirm/'))) {
      sec.log('kill_switch', 'EXTERNAL_OFF', 403); return json(env, { error: ks.EXTERNAL_OFF_MESSAGE, code: 'EXTERNAL_OFF' }, 403);
    }
    if (role === 'external') {
      // External confirmers (F3) reach only /confirm, a reduced bootstrap and /api/library/confirmations/*.
      if (url.pathname === '/' && request.method === 'GET') return new Response(null, { status: 303, headers: headers(env, { Location: '/confirm' }) });
      if (url.pathname === '/api/bootstrap' && request.method === 'GET') return json(env, { csrf, identity, email: mail, libraryRole: 'external', features: { claims: flagsOf(env).claims } });
      if (request.method === 'GET') { // a confirmation link (WOW_ZERO_CONFIG §3.9) also reaches an external confirmer
        const m = /^\/go\/confirm\/([a-f0-9]{32})$/.exec(url.pathname);
        if (m) return new Response(null, { status: 302, headers: headers(env, { Location: '/confirm#' + m[1] }) });
      }
      if (!(url.pathname === '/confirm' && request.method === 'GET') && !(url.pathname === '/privacy' && request.method === 'GET') && !url.pathname.startsWith('/api/library/confirmations/')) { sec.log('external_denied', 'EXTERNAL_ROLE_PATH', 403); return json(env, { error: 'Not available to external confirmers.' }, 403); }
    }
    // Links that survive an interactive sign-in (§3.9): /go/start, /go/{gap,invitation,bid,library,confirm}/<32 hex>.
    // Anything else under /go/ goes home. The ids are random, non-secret and grant nothing without sign-in (a recorded
    // deviation from WOW rule 7); no token ever goes in a path, and nothing here logs the path.
    if (request.method === 'GET' && url.pathname === '/go/signed-in') return new Response(SIGNED_IN_HTML, { headers: htmlHeaders(env, await inlineScriptHashes(SIGNED_IN_HTML)) });
    if (request.method === 'GET' && url.pathname.startsWith('/go/')) {
      const m = /^\/go\/(?:(start)|(gap|invitation|bid|library|confirm)\/([a-f0-9]{32}))$/.exec(url.pathname);
      const to = !m ? '/' : m[1] ? '/#start' : m[2] === 'confirm' ? '/confirm#' + m[3] : '/#' + m[2] + '/' + m[3];
      return new Response(null, { status: 302, headers: headers(env, { Location: to }) });
    }
    // The privacy notice (G2): everyone signed in reads it, external confirmers too (it is where they learn what is done with their answers). No script, no data.
    if (url.pathname === '/privacy' && request.method === 'GET') return new Response(privacy.renderNoticeHtml(RETENTION), { headers: htmlHeaders(env, []) });
    if (url.pathname === '/confirm' && request.method === 'GET') return new Response(CONFIRM_HTML, { headers: htmlHeaders(env, await inlineScriptHashes(CONFIRM_HTML)) });
    if (url.pathname === '/' && request.method === 'GET') {
      // The person's facts go in as a JSON data block, never as script (csp.js runtimeBlock), through a function replacer: a string one would expand "$'" and "$&" found in the email.
      let body = page.replace(RUNTIME_BLOCK, () => runtimeBlock({ subjectKey, authMode: 'access', name: who.email }))
        .replace("connect-src 'self';", "connect-src 'self' " + env.ORIGIN.replace('https://', 'wss://') + ';');
      if (cspMode(env) === 'report-only') body = withoutMetaCsp(body); // the page's own <meta> policy would enforce what the header only reports
      // The test banner stays until Tony sets DATA_MODE=production on an approved deployment (WOW_ZERO_CONFIG §0.7, §11). It says this is a test deployment awaiting the DPO's sign-off and links the
      // privacy notice; it never claims that only synthetic data is used (real interviews run here) and it is not where any privacy control lives (G2). It sits in the normal flow at the top of
      // the page (a 28px strip styled by the page's own CSS), never fixed over the controls (v2.2 F2). The body tag carries a class, so it is found by its end.
      if (env.DATA_MODE !== 'production') { const strip = '<div class="env-strip" role="note">TEST DEPLOYMENT · DPO sign-off pending · <a href="/privacy" target="_blank" rel="noopener">Privacy notice</a></div>'; body = /<body[^>]*>/.test(body) ? body.replace(/(<body[^>]*>)/, m => m + strip) : strip + body; }
      return new Response(body, { headers: htmlHeaders(env, PAGE_SCRIPT_HASHES) });
    }
    // Resumable interview (checkpoint.js): asked of the requesting person's OWN Interview Durable Object only, under the identity just verified, and
    // answered with {sessionId, savedAt, expiresAt} or null: never any content. Any failure or a slow answer is "nothing to resume".
    const interviewOf = (path, init = {}) => {
      const fwd = new Request(new URL(path, request.url), { ...init, headers: { 'Content-Type': 'application/json', 'x-atlas-user': libraryUser, 'x-atlas-role': role, 'x-atlas-email': mail, 'x-atlas-subj': subjectKey, ...(init.headers || {}) } });
      return env.INTERVIEW.get(env.INTERVIEW.idFromName(who.sub)).fetch(fwd);
    };
    // The same, for the shared library's internal privacy surface (privacy-routes.js): the verified identity and the pseudonymous subject key, never from the browser.
    const libraryOf = (path, init = {}) => env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(new Request(new URL(path, request.url), { method: 'GET', ...init,
      headers: { 'Content-Type': 'application/json', 'x-atlas-user': libraryUser, 'x-atlas-role': role, 'x-atlas-email': mail, 'x-atlas-subj': subjectKey, 'x-atlas-idp': 'e30' } }));
    // Per-person persistent rate limit (ratelimit.js, in the person's own Interview Durable Object). A refusal is a 429 with Retry-After; if the limiter
    // itself is unreachable the request goes ahead (a cost cap must not become an outage) and nothing is lost but the count.
    const limited = async (name, max, windowMs) => {
      if (!env.INTERVIEW) return null;
      let res;
      try { res = await interviewOf('/api/limit', { method: 'POST', body: JSON.stringify({ checks: [{ bucket: name, max, windowMs }] }) }); } catch { return null; }
      if (res.status !== 429) return null;
      const retryAfter = Math.max(1, Number((await res.json().catch(() => ({}))).retryAfter) || 60);
      sec.log('rate_limited', 'RATE:' + name.toUpperCase(), 429, { bucket: name });
      return new Response(JSON.stringify({ error: 'Too many requests for now. Please wait a little and try again.', retryAfter }), { status: 429, headers: headers(env, retryAfterHeaders(retryAfter)) });
    };
    const paused = (message, code = 'AI_OFF') => new Response(JSON.stringify({ error: message, code }), { status: 503, headers: headers(env, { 'Content-Type': 'application/json', 'Retry-After': '300' }) });
    // CSP violation reports (csp-report.js): sent by the browser itself, so no CSRF token; bounded, rate-limited and logged as directive + blocked origin only.
    if (url.pathname === REPORT_PATH && request.method === 'POST') return cspReport(request, sec, limited);
    if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
      // The person's own object answers both questions in ONE call: whether an interview can be resumed, and the consent state in force (G2). Asked only while checkpoints are on; a failure or a slow answer is "nothing to resume, state unknown".
      let resumable = null, consent = null;
      if (env.INTERVIEW && checkpointEnabled(env) && role !== 'external') {
        let timer;
        try { const r = await Promise.race([interviewOf('/api/checkpoint').then(r => r.json()), new Promise(r => { timer = setTimeout(() => r(null), 1500); })]); resumable = r?.resumable || null; consent = r?.consent || null; }
        catch { resumable = null; consent = null; } finally { clearTimeout(timer); }
      }
      // One voice for everyone, advertised only as 'atlas': the real voice and provider stay server-side.
      return json(env, { provider: 'workers', providerLabel: 'ATLAS voice', protocol: 'atlas-personaplex-pcm-v1', csrf,
        identity, model: 'ATLAS conversational voice', admin,
        voices: ['atlas'], defaultVoice: 'atlas', captureRequired: true, codecAvailable: true, busy: false, capacity: 1, maxSeconds: MAX_SECONDS, speakingSeconds: SPEAKING_LIMIT_S,
        memory: !!env.HINDSIGHT_API_KEY && bankSecretStatus(env) !== 'missing', wiki: false, jev: !!env.TYPESAFE_API_KEY, jevClassify: !!env.TYPESAFE_API_KEY && !ks.aiOff(env), library: !!env.LIBRARY, libraryRole: role, sheet: true, transcription: true, structuredNotes: true, liveLedger: true, playbackAck: true, textMode: true, languages: languageList(workersAI(env).speaks),
        readiness: env.DATA_MODE === 'production' ? 'production' : 'edge-deployment-test-data-only', email: mail, features: flagsOf(env), resumable,
        // G2: the consent wording and which toggles are required, and the person's consent state in force (what they last chose; memory is off until they turn it on).
        privacy: privacy.bootstrapView(), consent: consent ? { purposes: Object.fromEntries(Object.entries(consent.purposes || {}).map(([k, v]) => [k, v?.granted === true])), blocked: consent.blocked || {} } : null,
        ...(ks.readOnly(env) ? { readOnly: true } : {}), ...(ks.aiOff(env) ? { aiOff: true } : {}) });
    }
    // The admin Connections panel (v2.2 F2): read-only readiness of every connection in the framework, booleans and names only. Admins only; never any secret, URL or token value.
    if (url.pathname === '/api/connections/status' && request.method === 'GET') {
      if (role !== 'admin') { sec.log('access_denied', 'ADMIN_ONLY', 403); return json(env, { error: 'Only an ATLAS admin can see the connections.' }, 403); }
      return new Response(JSON.stringify(connectionsView(env)), { headers: headers(env, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }) });
    }
    if (url.pathname === '/api/voice') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade.', { status: 426 });
      if (request.headers.get('Origin') !== env.ORIGIN) { sec.log('origin_fail', request.headers.get('Origin') ? 'ORIGIN_MISMATCH' : 'ORIGIN_MISSING', 403); return new Response('Invalid voice origin', { status: 403 }); }
      // A new interview is a mutation and a model call: the read-only and AI-off switches refuse it politely, before the Durable Object is touched.
      if (ks.readOnly(env)) { sec.log('kill_switch', 'READ_ONLY', 503); return readOnly503(env); }
      if (ks.aiOff(env)) { sec.log('kill_switch', 'AI_OFF', 503); return paused(ks.INTERVIEW_PAUSED_MESSAGE); }
      const forward = new Request(request, { headers: new Headers(request.headers) });
      forward.headers.set('x-atlas-admin', admin ? '1' : '0'); // always overwritten: a browser can never claim admin
      forward.headers.set('x-atlas-user', libraryUser); forward.headers.set('x-atlas-role', role); forward.headers.set('x-atlas-email', mail); // always overwritten
      forward.headers.set('x-atlas-bank', bankSecretStatus(env) === 'missing' ? '' : await bankId(env, who.sub)); // server-derived; the browser never picks a bank; no secret, no memory
      forward.headers.set('x-atlas-csrf', csrf); // set by the Worker only; the DO is not reachable otherwise
      forward.headers.set('x-atlas-subj', subjectKey); // the pseudonym the Durable Object logs with (never an identity)
      return env.INTERVIEW.get(env.INTERVIEW.idFromName(who.sub)).fetch(forward);
    }
    // "Start over" on the resume prompt: delete the stored interview now (its own Durable Object, same identity).
    if (url.pathname === '/api/checkpoint/discard' && request.method === 'POST') {
      { const bad = csrfRefusal(request, env, csrf, sec); if (bad) return bad; }
      if (!env.INTERVIEW) return json(env, { discarded: false });
      const res = await interviewOf('/api/checkpoint/discard', { method: 'POST' });
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // ---- Consent and data subject rights (G2). The browser-facing side of privacy.js, subject-rights.js and me-routes.js; identity is the verified sign-in only. ----
    // Changing a choice outside an interview (withdrawing the saved-interview or memory choice, acknowledging the notice): state and receipt, all or nothing, in the person's own object.
    if (url.pathname === '/api/consent' && request.method === 'POST') {
      { const bad = csrfRefusal(request, env, csrf, sec); if (bad) return bad; }
      if (!env.INTERVIEW) return json(env, { error: 'Consent choices are not available here.' }, 404);
      { const slow = await limited('consent', 60, HOUR); if (slow) return slow; }
      const raw = await boundedBytes(request, 4096);
      if (raw === null) return json(env, { error: 'Request too large.' }, 413);
      const res = await interviewOf('/api/consent', { method: 'POST', body: raw, headers: { 'x-atlas-bank': '' } });
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // "Download my data": one machine-readable JSON file, built from the library (what the shared library holds about the person) and the person's own object (the saved
    // interview, private memory, consent state). Rate limited in the library; every build leaves a numbers-only security event and an id-free audit row.
    if (url.pathname === '/api/me/export' && request.method === 'GET') {
      if (!env.INTERVIEW) return json(env, { error: 'Export is not available here.' }, 404);
      const lib = env.LIBRARY ? await libraryOf('/api/privacy/export') : null;
      if (lib && lib.status === 429) return new Response(lib.body, { status: 429, headers: headers(env, { 'Content-Type': 'application/json', 'Retry-After': lib.headers.get('Retry-After') || '3600' }) });
      if (lib && !lib.ok) return json(env, { error: 'Your data could not be collected right now. Nothing was changed.' }, 502);
      const mine = await interviewOf('/api/me/export', { headers: { 'x-atlas-bank': bankSecretStatus(env) === 'missing' ? '' : await bankId(env, who.sub) } });
      if (!mine.ok) return json(env, { error: 'Your data could not be collected right now. Nothing was changed.' }, 502);
      const out = { schema: 'atlas.my-data.v1', exportedAt: new Date().toISOString(), privacyNoticeVersion: privacy.NOTICE_VERSION, library: lib ? await lib.json() : null, interview: await mine.json(),
        note: 'Everything ATLAS can find about you. Audio is never stored. Platform backups, provider-side logs and the DNA directory are outside this file.' };
      return new Response(JSON.stringify(out, null, 2), { headers: headers(env, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="atlas-my-data.json"', 'Cache-Control': 'no-store' }) });
    }
    // "Delete my data": two steps. The first answers with what will and will not happen and a short-lived confirmation token tied to this sign-in; the second (with the token)
    // erases. Origin and CSRF as for every state change. Approved or published material is flagged for the DPO instead of being silently deleted.
    if (url.pathname === '/api/me/erase' && request.method === 'POST') {
      { const bad = csrfRefusal(request, env, csrf, sec); if (bad) return bad; }
      if (!env.INTERVIEW) return json(env, { error: 'Erasure is not available here.' }, 404);
      const raw = await boundedBytes(request, 2048);
      if (raw === null) return json(env, { error: 'Request too large.' }, 413);
      let b = {}; try { b = JSON.parse(new TextDecoder().decode(raw) || '{}'); } catch { return json(env, { error: 'Invalid JSON.' }, 400); }
      if (typeof b?.confirm !== 'string') {
        const exp = Date.now() + ERASE_TOKEN_MS;
        sec.log('privacy_erase', 'CONFIRM_ISSUED', 200);
        return json(env, { confirmToken: exp + '.' + (await hmac(env.CSRF_SECRET, 'erase|' + who.sub + '|' + exp)), expiresInSeconds: ERASE_TOKEN_MS / 1000,
          willHappen: ['Your drafts, references, interview notes and evidence statements are replaced by empty markers.', 'Your saved interview and your private memory are deleted.', 'Your profile, invitations and messages about you are deleted.', 'Your name is removed from the audit trail.'],
          kept: ['Approved evidence, published references and bids are flagged for the DPO to review before deletion (they may already be used in a bid).', 'The record that you made consent choices (no content).', 'Platform backups can hold a copy for a short period.'] });
      }
      const [exp, mac] = b.confirm.split('.');
      if (!(Number(exp) > Date.now()) || !safeEqual(mac || '', await hmac(env.CSRF_SECRET, 'erase|' + who.sub + '|' + exp))) { sec.log('privacy_erase', 'CONFIRM_INVALID', 403); return json(env, { error: 'The confirmation expired or does not belong to this sign-in. Start again.' }, 403); }
      const lib = env.LIBRARY ? await libraryOf('/api/privacy/erase', { method: 'POST', body: JSON.stringify({ confirmed: true }) }) : null;
      if (lib && lib.status === 429) return new Response(lib.body, { status: 429, headers: headers(env, { 'Content-Type': 'application/json', 'Retry-After': lib.headers.get('Retry-After') || '3600' }) });
      const mine = await interviewOf('/api/me/erase', { method: 'POST', headers: { 'x-atlas-bank': bankSecretStatus(env) === 'missing' ? '' : await bankId(env, who.sub) } }).then(r => r.json()).catch(() => null);
      const library = lib && lib.ok ? await lib.json() : null, complete = (!env.LIBRARY || !!library) && !!mine?.complete;
      return json(env, { complete, library, interview: mine, ...(complete ? {} : { retry: 'Part of the erasure did not finish. Nothing already erased comes back; choose Delete my data again to finish.' }) });
    }
    // The person's own privacy state: consent in force, restriction and objection flags. POST sets the flags (restricted, objectScoring, objectMatching, objectMemory); memory is blocked at once.
    if (url.pathname === '/api/me/privacy') {
      if (!env.INTERVIEW) return json(env, { error: 'Not available here.' }, 404);
      if (request.method === 'POST') { const bad = csrfRefusal(request, env, csrf, sec); if (bad) return bad; }
      else if (request.method !== 'GET') return json(env, { error: 'Not found.' }, 404);
      if (request.method === 'GET') {
        const [consent, flags] = await Promise.all([interviewOf('/api/consent').then(r => r.json()).catch(() => null), env.LIBRARY ? libraryOf('/api/privacy/flags').then(r => r.json()).catch(() => null) : null]);
        return json(env, { noticeVersion: privacy.NOTICE_VERSION, consent: consent && { purposes: Object.fromEntries(Object.entries(consent.purposes || {}).map(([k, v]) => [k, v?.granted === true])), blocked: consent.blocked || {} }, flags });
      }
      { const slow = await limited('privacy', 60, HOUR); if (slow) return slow; }
      const raw = await boundedBytes(request, 2048);
      if (raw === null) return json(env, { error: 'Request too large.' }, 413);
      if (!env.LIBRARY) return json(env, { error: 'Flags are not available here.' }, 404);
      const set = await libraryOf('/api/privacy/flags', { method: 'POST', body: raw });
      if (!set.ok) return new Response(set.body, { status: set.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
      const flags = await set.json();
      await interviewOf('/api/consent/block', { method: 'POST', body: JSON.stringify({ memory: flags.restricted || flags.objectMemory }), headers: { 'x-atlas-bank': '' } }).catch(() => null);
      return json(env, { flags });
    }
    if (url.pathname.startsWith('/api/sheet/') && request.method === 'POST') {
      { const bad = csrfRefusal(request, env, csrf, sec); if (bad) return bad; }
      if (ks.aiOff(env)) { sec.log('kill_switch', 'AI_OFF', 503); return paused(ks.AI_OFF_MESSAGE); }
      if (Number(request.headers.get('Content-Length') || 0) > 12 * 1024 * 1024) return json(env, { error: 'The file is larger than 10 MB.' }, 413);
      { const slow = await limited('sheet', limitOf(env, 'SHEET_HOUR'), HOUR); if (slow) return slow; }
      // The body itself is read in sheet.js with a streaming cap (a chunked upload has no Content-Length to trust).
      // PDF metadata (author, producer, title) is never extracted (D2, WOW_ZERO_CONFIG §4): text only.
      const ai = workersAI(env), res = await sheetRoutes(request, url.pathname.slice('/api/sheet/'.length), { complete: (m, n) => ai.complete(m, n),
        toMarkdown: f => env.AI.toMarkdown(f, { conversionOptions: { pdf: { metadata: false } } }) });
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/memory' || url.pathname.startsWith('/api/memory/')) {
      if (request.method !== 'GET') { const bad = csrfRefusal(request, env, csrf, sec); if (bad) return bad; }
      if (bankSecretStatus(env) === 'missing') return json(env, { error: BANK_SECRET_MESSAGE, code: 'BANK_SECRET_REQUIRED' }, 503); // fail closed: no memory without a stable bank secret
      const bodyless = request.method === 'GET' || request.method === 'HEAD', mem = bodyless ? null : await boundedBytes(request, 131072);
      if (!bodyless && mem === null) return json(env, { error: 'Request too large.' }, 413);
      const memHeaders = new Headers(request.headers); memHeaders.delete('content-length');
      const forward = new Request(request.url, { method: request.method, headers: memHeaders, body: bodyless ? undefined : mem });
      forward.headers.set('x-atlas-bank', await bankId(env, who.sub)); forward.headers.set('x-atlas-role', role); // always overwritten
      forward.headers.set('x-atlas-user', libraryUser); forward.headers.set('x-atlas-email', mail); forward.headers.set('x-atlas-subj', subjectKey); // memory choices leave receipts under the verified identity
      const res = await env.INTERVIEW.get(env.INTERVIEW.idFromName(who.sub)).fetch(forward);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/library' || url.pathname.startsWith('/api/library/')) {
      if (!env.LIBRARY) return json(env, { error: 'The reference library is not configured on this deployment.' }, 404);
      if (request.method !== 'GET') { const bad = csrfRefusal(request, env, csrf, sec); if (bad) return bad; }
      if (Number(request.headers.get('Content-Length') || 0) > 262144) return json(env, { error: 'Request too large.' }, 413);
      // The declared length can be absent or wrong: read at most 256 KiB of the body actually sent, then forward it.
      const bodyless = request.method === 'GET' || request.method === 'HEAD', bytes = bodyless ? null : await boundedBytes(request, 262144);
      if (!bodyless && !bytes) return json(env, { error: 'Request too large.' }, 413);
      const fwdHeaders = new Headers(request.headers); fwdHeaders.delete('content-length');
      const forward = new Request(request.url, { method: request.method, headers: fwdHeaders, body: bodyless ? undefined : bytes });
      // Entra: the stable tid:oid is the library identity (emails can change); Access: the verified email.
      forward.headers.set('x-atlas-user', libraryUser); forward.headers.set('x-atlas-role', role); forward.headers.set('x-atlas-email', mail); // always overwritten
      forward.headers.set('x-atlas-idp', toB64url(JSON.stringify(signinClaims(request)))); // always overwritten ('e30' = {}): never from the browser
      forward.headers.set('x-atlas-subj', subjectKey); // the pseudonym receipts and rate limits are keyed by (always overwritten)
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(forward);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // Spoken Ask (F6): transcription of one short question. Off while SPOKEN_ASK_APPROVED (D1) is false; then each
    // request needs the consent prompt's header, and `always` a consent stored in the person's profile. Stores nothing;
    // the log line carries numbers only.
    if (url.pathname === '/api/transcribe' && request.method === 'POST' && flagsOf(env).spokenAsk) {
      { const bad = csrfRefusal(request, env, csrf, sec); if (bad) return bad; }
      if (ks.aiOff(env)) { sec.log('kill_switch', 'AI_OFF', 503); return paused(ks.AI_OFF_MESSAGE); }
      { const slow = await limited('transcribe', limitOf(env, 'TRANSCRIBE_HOUR'), HOUR); if (slow) return slow; }
      // A UI gate: it proves the page showed the prompt, not that the person agreed; `always` is checked server-side.
      const consent = /^spoken-ask-v1;\s*(once|always)$/.exec((request.headers.get('X-Atlas-Consent') || '').trim());
      if (!consent || (consent[1] === 'always' && !await storedSpokenAsk(env, { libraryUser, role, mail }))) return json(env, { error: 'Voice questions need your consent first.' }, 403);
      if ((request.headers.get('Content-Type') || '').replace(/\s+/g, '').toLowerCase() !== 'audio/l16;rate=24000') return json(env, { error: 'Send 16-bit mono PCM at 24 kHz (audio/L16;rate=24000).' }, 415);
      const pcm = Number(request.headers.get('Content-Length') || 0) > AUDIO_MAX ? null : await boundedBytes(request, AUDIO_MAX);
      if (!pcm) return json(env, { error: 'The recording is longer than 30 seconds.' }, 413);
      if (pcm.length < AUDIO_MIN || pcm.length % 2) return json(env, { error: 'The recording is too short or is not 16-bit audio.' }, 400);
      const t0 = Date.now(), metric = values => console.log(JSON.stringify({ atlas_metric: 'transcribe', ms: Date.now() - t0, bytes: pcm.length, ...values }));
      let out;
      try { out = await workersAI(env).transcribe(pcm); } catch { metric({ failed: 1 }); return json(env, { error: 'Transcription failed. Type the question instead.' }, 502); }
      metric({});
      return json(env, { text: String(out?.text || '').slice(0, 600), language: out?.language || null });
    }
    if (url.pathname === '/api/jev/classify' && request.method === 'POST') {
      { const bad = csrfRefusal(request, env, csrf, sec); if (bad) return bad; }
      if (ks.aiOff(env)) { sec.log('kill_switch', 'AI_OFF', 503); return paused(ks.AI_OFF_MESSAGE); }
      if (Number(request.headers.get('Content-Length') || 0) > 65536) return json(env, { error: 'Project too large to score.' }, 413);
      { const slow = await limited('classify', limitOf(env, 'CLASSIFY_HOUR'), HOUR); if (slow) return slow; }
      const raw = await boundedBytes(request, 65536); // streamed and capped (the declared length may be absent)
      if (raw === null) return json(env, { error: 'Project too large to score.' }, 413);
      let project;
      try { project = JSON.parse(new TextDecoder().decode(raw)).project; } catch { return json(env, { error: 'Invalid JSON.' }, 400); }
      try { return json(env, await classify(env, project)); }
      catch (e) { return e.status ? json(env, { error: e.message }, e.status) : json(env, { error: 'Scoring is unavailable right now. Try again shortly.' }, 502); }
    }
    if (url.pathname === '/api/test-voice' && env.TEST_VOICE === '1' && request.method === 'GET') {
      if (ks.aiOff(env)) { sec.log('kill_switch', 'AI_OFF', 503); return paused(ks.AI_OFF_MESSAGE); }
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
async function storedSpokenAsk(env, { libraryUser, role, mail }) {
  if (!env.LIBRARY) return false;
  try {
    const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(new Request('https://atlas.internal/api/library/profile/consents',
      { headers: { 'x-atlas-user': libraryUser, 'x-atlas-role': role, 'x-atlas-email': mail, 'x-atlas-idp': 'e30' } }));
    return res.ok && (await res.json())?.spokenAsk?.version === 1;
  } catch { return false; }
}

// Daily cron (worker.js delegates here so Node tests cover it): references not updated for six months get an
// update invitation for their owner, plus the feature modules' daily housekeeping. Nothing is ever sent.
export async function scheduled(controller, env, ctx) {
  if (!env.LIBRARY) return;
  const req = new Request('https://atlas.internal/api/library/scan-stale', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system' } });
  ctx.waitUntil(env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(req)); // the LibraryStore also verifies its audit chain on this call (worker.js)
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
// Low reasoning effort keeps the hidden reasoning from eating the output budget; retried without it if the binding rejects the field.
async function runReasoning(env, input) {
  try { return await env.AI.run(env.ANALYST_MODEL, { ...input, reasoning: { effort: 'low' } }); }
  catch { return env.AI.run(env.ANALYST_MODEL, input); }
}

// ElevenLabs Flash v2.5 (32 languages) as raw 24 kHz PCM, the same format as Aura. Optional: ELEVENLABS_API_KEY.
async function elevenLabs(env, text, lang, fetcher = fetch) {
  const voice = encodeURIComponent(env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM');
  const r = await fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_24000`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5', language_code: lang }) });
  if (!r.ok) throw new Error('ElevenLabs HTTP ' + r.status);
  const pcm = new Uint8Array(await r.arrayBuffer());
  return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
}

// With ATLAS_AI_OFF every model call (Workers AI, ElevenLabs, scoring) fails closed with a 503-coded error before it leaves the Worker.
export function workersAI(env) { return ks.aiOff(env) ? pausedAI(buildWorkersAI(env)) : buildWorkersAI(env); }
function pausedAI(ai) {
  const stop = () => { throw Object.assign(new Error('AI is switched off by the operator.'), { status: 503, code: 'AI_OFF' }); };
  return Object.fromEntries(Object.entries(ai).map(([k, v]) => [k, typeof v !== 'function' || k === 'speaks' ? v : k === 'chatStream' ? async function* () { stop(); } : async () => stop()]));
}
function buildWorkersAI(env) {
  const bytesOf = async r => r instanceof Uint8Array ? r : r instanceof ArrayBuffer ? new Uint8Array(r)
    : r instanceof ReadableStream || r instanceof Response ? new Uint8Array(await new Response(r.body ?? r).arrayBuffer())
    : r?.audio ? Uint8Array.from(atob(r.audio), c => c.charCodeAt(0)) : new Uint8Array(0);
  return {
    flags: sessionFlags(env), // ATLAS_SELECTOR, ATLAS_REPLY_GUARD, ATLAS_ACKS, ANALYST_WAIT_MS, SPECULATIVE_STT: read by the Session
    // Automatic language detection (Nova-3 "multi"): returns the text and the utterance's language. opts.language: a language the consultant locked in the UI, asked of the
    // recogniser alone (a monolingual request, the way to reach a language "multi" does not cover); if that request fails the automatic one is made instead.
    async transcribe(pcm, opts) {
      const run = language => env.AI.run(env.STT_MODEL, { audio: { body: new Blob([wav(pcm)]).stream(), contentType: 'audio/wav' }, smart_format: true, punctuate: true, language });
      const lock = /^[a-z]{2,3}$/.test(opts?.language || '') ? opts.language : null, auto = env.STT_LANGUAGE || 'multi';
      let r;
      try { r = await run(lock || auto); } catch (e) { if (!lock) throw e; r = await run(auto); }
      // words [{w, c, s, e}] (word, confidence, start, end in seconds; at most 400) feed the uncertain-span check (asr.js); none when the model sent none.
      const words = sttWords(r);
      return { text: r?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '', language: detectedLanguage(r), ...(words.length ? { words } : {}) };
    },
    // Semantic end-of-turn (Pipecat smart-turn v2): has the consultant finished, or only paused? Last 8 s at 16 kHz.
    // Sent as a base64 WAV string: the binding rejects the streamed {body, contentType} form for this model (AiError).
    async turnComplete(pcm) {
      const tail = pcm.length > 8 * 48000 ? pcm.subarray(pcm.length - 8 * 48000) : pcm, bytes = wav(to16k(tail), 16000);
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await env.AI.run(env.TURN_MODEL || '@cf/pipecat-ai/smart-turn-v2', { audio: btoa(bin) });
      // No boolean verdict is no verdict (the session logs it as NoVerdict and uses the silence rule), never "unfinished".
      return typeof r?.is_complete === 'boolean' ? { complete: r.is_complete, probability: Number(r.probability) || 0 } : null;
    },
    speaks(lang) { return NATIVE_VOICES.includes(lang) || (!!env.ELEVENLABS_API_KEY && ELEVENLABS_LANGUAGES.includes(lang)); }, // a voice that can say it: Aura-2 (en, es) or the configured ElevenLabs voice; else the reply is text
    async synthesize(text, speaker = 'atlas', lang = 'en') { // 'atlas' = the configured voice; the browser never sees its real name
      if (lang !== 'en' && lang !== 'es' && env.ELEVENLABS_API_KEY) return elevenLabs(env, text, lang);
      const es = lang === 'es';
      const pcm = await bytesOf(await env.AI.run(es ? (env.TTS_MODEL_ES || '@cf/deepgram/aura-2-es') : env.TTS_MODEL, { text, speaker: es ? (env.TTS_VOICE_ES || 'celeste') : speaker === 'atlas' ? env.TTS_VOICE : speaker, encoding: 'linear16', container: 'none', sample_rate: 24000 }));
      return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
    },
    // Session affinity keeps one interview on the same model instance, so the cached prompt prefix is reused.
    // A spoken reply is one or two sentences: TALKER_MAX_TOKENS (default 160, was 300) bounds it. When the caller stops reading (the
    // reply guard has what it needs) the generator's return() cancels the model stream, so no tokens are generated for nothing.
    async *chatStream(messages, { affinity } = {}) {
      const maxTokens = Math.floor(Number(env.TALKER_MAX_TOKENS)) > 0 ? Math.floor(Number(env.TALKER_MAX_TOKENS)) : TALKER_MAX_TOKENS;
      const stream = await env.AI.run(env.TALKER_MODEL, { messages, stream: true, max_tokens: maxTokens, temperature: 0.7 }, affinity ? { extraHeaders: { 'x-session-affinity': affinity } } : undefined);
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let cut;
          while ((cut = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, cut).trim(); buffer = buffer.slice(cut + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') return;
            try { const j = JSON.parse(payload), d = j.response ?? j.choices?.[0]?.delta?.content; if (d) yield d; } catch { /* keep-alive or partial */ }
          }
        }
      } finally { reader.cancel().catch(() => {}); }
    },
    async complete(messages, maxTokens = 2500) {
      return responseText(await runReasoning(env, { messages, temperature: 0.1, max_tokens: maxTokens }));
    },
    async embed(text) {
      const r = await env.AI.run(env.EMBED_MODEL || '@cf/baai/bge-m3', { text: [String(text).slice(0, 8000)] });
      const v = r?.data?.[0];
      return Array.isArray(v) && v.length ? v : null;
    },
    async report(messages) {
      return responseText(await runReasoning(env, { messages, temperature: 0.2, max_tokens: 3000 }));
    },
    async analyst(messages) {
      return responseToolCalls(await runReasoning(env, { messages, tools: CHAT_TOOLS, tool_choice: 'auto', temperature: 0, max_tokens: 1500 }));
    },
  };
}
