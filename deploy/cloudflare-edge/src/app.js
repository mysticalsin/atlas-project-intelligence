// ATLAS edge application logic (Worker routes, Access verification, Workers AI adapters). Platform-free for Node tests.
// Identity comes ONLY from a verified Cloudflare Access JWT (fail closed). Speech and models run on
// Workers AI through the AI binding, so no provider key exists in this code or in the browser.
import { CHAT_TOOLS, SPEAKING_LIMIT_S } from './policy.generated.js';
import { Session, MAX_SECONDS } from './session.js';
import { wav, to16k } from './speech.js';
import { classify, projectState } from './classify.js';
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
import { cspMode, htmlCspHeaders, inlineScriptHashes, runtimeBlock, withoutMetaCsp, PAGE_SCRIPT_HASHES } from './csp.js';
import { RETENTION } from './policy.generated.js';
import { baseSecurityHeaders, DATA_CSP, secure } from './security-headers.js';
import { aiOff, assertAiOn, blockedSubject, externalOff, inboundOff, readOnly, securityFlags, AI_OFF_MESSAGE, BLOCKED_MESSAGE, EXTERNAL_OFF_MESSAGE, INBOUND_OFF_MESSAGE, INTERVIEW_PAUSED_MESSAGE, READ_ONLY_MESSAGE } from './kill-switches.js';
import { limitOf } from './ratelimit.js';
import { announceFlags, ipHash, requestLog, secEvent } from './security-log.js';
import { boundedBytes, boundedText } from './bounded.js';
import { cspReport } from './csp-report.js';
import { renderNoticeHtml } from './privacy.js';
import { timingSafe } from './timing-safe.js';
import { auditKey } from './audit-chain.js';

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

function csrfOk(header, csrf) {
  const a = String(header || ''), b = String(csrf || '');
  if (!a || a.length !== b.length) return false;
  return timingSafe(a, b);
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}

function connectOrigin(env) {
  return String(env.ORIGIN || '').replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
}
function headers(env, extra = {}) {
  return { ...baseSecurityHeaders(), 'Content-Security-Policy': DATA_CSP, ...extra };
}
const json = (env, body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: headers(env, { 'Content-Type': 'application/json', ...extra }) });
const VOICE_PAGE = { scriptBlob: true, workerBlob: true, mediaBlob: true, fontSelf: true, trustedTypes: 'atlas-html', connectSelf: true };
const QUIET_PAGE = { connectSelf: false, scriptBlob: false, imgSrc: false, fontSelf: false, workerBlob: false, mediaBlob: false, trustedTypes: 'none', formAction: "'none'" };
async function htmlResponse(env, body, opts = {}) {
  const { hashes = null, reportOnlyStrip = false, connect = '', ...caps } = opts;
  const use = hashes || await inlineScriptHashes(body);
  const policy = htmlCspHeaders(env, { hashes: use, connect, ...caps });
  const upgrade = String(env.ORIGIN || '').startsWith('https:') ? '; upgrade-insecure-requests' : '';
  if (policy['Content-Security-Policy']) policy['Content-Security-Policy'] += upgrade;
  const html = reportOnlyStrip && cspMode(env) === 'report-only' ? withoutMetaCsp(body) : body;
  return new Response(html, { headers: headers(env, { 'Content-Type': 'text/html; charset=utf-8', ...policy }) });
}
async function consumeLimit(env, slog, name, checks) {
  const unavailable = () => json(env, { error: 'The request could not be limited, so it was not run.', code: 'LIMIT_UNAVAILABLE' }, 503);
  if (!env.INTERVIEW) return unavailable();
  try {
    const res = await env.INTERVIEW.get(env.INTERVIEW.idFromName(String(name))).fetch(new Request('https://atlas.internal/api/limit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checks }) }));
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const retry = Number(j.retryAfter || res.headers.get('retry-after') || 1);
      const bucket = checks[0]?.bucket || 'limit';
      slog.log('rate_limited', 'RATE:' + String(bucket).toUpperCase().replace(/-/g, '_'), 429, { bucket });
      return json(env, { error: 'Too many requests. Please wait a little and try again.', retryAfter: retry }, 429, { 'Retry-After': String(retry) });
    }
    if (!res.ok) return unavailable();
    return null;
  } catch { return unavailable(); }
}
async function subjectPseudonym(env, sub) {
  if (env.LOG_SALT) return (await hmac(env.LOG_SALT, sub)).slice(0, 32);
  if (String(env.DATA_MODE || '').toLowerCase() === 'production') return null;
  if (env.CSRF_SECRET) return (await hmac('subject-v1:' + env.CSRF_SECRET, sub)).slice(0, 32);
  return '';
}
const NOT_COVERED = [
  { store: 'interview-checkpoint', exported: false, erased: false, reason: 'The Interview Durable Object was not opened. Its checkpoint was not exported or erased.' },
  { store: 'interview-consent', exported: false, erased: false, reason: 'Consent state on the Interview object was not exported or erased.' },
  { store: 'interview-memory', exported: false, erased: false, reason: 'Private memory on the Interview object was not exported or erased.' },
];
// Spoken Ask audio: 0.1 s to 32 s of 16-bit mono PCM at 24 kHz (the UI records at most 30 s).
const AUDIO_MIN = 4800, AUDIO_MAX = 1536000;
const HOUR_MS = 36e5;

// Early check before LIBRARY.get for the cron and both bearer ingresses. The Library constructor is the
// refusal for every other open. This stays so those three paths do not construct the object.
function rejectUnkeyedAudit(env) {
  if (auditKey(env) != null) return null;
  return json(env, { error: 'LOG_SALT is not set.', code: 'LOG_SALT' }, 503);
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

const noopLog = { log() {}, identify() {}, async flush() {} };
// flagsOf: the bootstrap feature flags (tests pass flags with D1 approved to exercise /api/transcribe before it flips).
export async function handle(request, env, page, opts = {}) {
  const slog = opts.log ? requestLog(request, env, opts.log) : noopLog;
  if (opts.log) await announceFlags(env, securityFlags(env), opts.log);
  try { return secure(await route(request, env, page, { waitUntil: opts.waitUntil || (p => p), flagsOf: opts.flagsOf || flags, slog })); }
  catch (e) {
    if (e?.status === 503 && e?.code === 'LOG_SALT') return secure(json(env, { error: e.message, code: 'LOG_SALT' }, 503));
    return secure(new Response('Something went wrong.', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  }
  finally { await slog.flush(); }
}
async function route(request, env, page, { waitUntil, flagsOf, slog }) {
  {
    const url = new URL(request.url);
    if (!env.ORIGIN || url.origin !== env.ORIGIN) return new Response('Host is not the configured ATLAS origin.', { status: 403, headers: headers(env) });
    if (!env.CSRF_SECRET) return new Response('Deployment is not configured (CSRF_SECRET).', { status: 500, headers: headers(env) });
    if (url.pathname === '/api/csp-report' && request.method === 'POST') {
      const hashed = await ipHash(env, request.headers.get('cf-connecting-ip') || '');
      if (hashed == null) return json(env, { error: 'Deployment is not configured (LOG_SALT).', code: 'LOG_SALT' }, 503);
      const name = 'csp:' + (hashed || 'anon');
      return cspReport(request, slog, (bucket, max, windowMs) => consumeLimit(env, slog, name, [{ bucket, max, windowMs }]));
    }
    const mutating = (request.method !== 'GET' && request.method !== 'HEAD') || request.headers.get('Upgrade') === 'websocket';
    if (readOnly(env) && mutating) { slog.log('kill_switch', 'READ_ONLY', 503); return json(env, { error: READ_ONLY_MESSAGE, code: 'READ_ONLY' }, 503, { 'Retry-After': '300' }); }
    const inboundPath = (url.pathname === '/api/triggers' && request.method === 'POST') || (url.pathname === '/api/directory/push' && request.method === 'POST') || (url.pathname === '/api/teams/messages' && request.method === 'POST') || (url.pathname === '/teams/tab' && request.method === 'GET');
    if (inboundOff(env) && inboundPath) { slog.log('inbound_off', 'INBOUND_OFF', 503); return json(env, { error: INBOUND_OFF_MESSAGE, code: 'INBOUND_OFF' }, 503); }
    // Before triggers, directory push, voice, memory, or the library. A production flag must not
    // disable tenant checks or turn on the local persona switch.
    const demoConflict = productionDemoConflict(env);
    if (demoConflict && url.pathname.startsWith('/api/')) return json(env, demoConflict, 503);
    // Project-management system trigger: its own bearer secret (Access bypass on this path only; see docs/INTEGRATIONS.md).
    if (url.pathname === '/api/triggers' && request.method === 'POST') {
      const secret = env.TRIGGER_SECRET || '', given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!secret || !env.LIBRARY || given.length !== secret.length || !timingSafe(given, secret)) { slog.log('bearer_fail', 'BEARER_INVALID', 401); return json(env, { error: 'Unauthorized.' }, 401); }
      if (Number(request.headers.get('Content-Length') || 0) > 16384) { slog.log('body_too_large', 'BODY_TOO_LARGE', 413); return json(env, { error: 'Request too large.' }, 413); }
      const raw = await request.text();
      const scope = systemScope(env);
      if (!scope.ok) return json(env, scope.body, scope.status);
      if (callerNamedTenant(request, raw).some(t => t !== scope.tenant)) return json(env, { error: 'A system ingress uses only the configured tenant. The tenant on this request was not accepted.' }, 403);
      const unkeyed = rejectUnkeyedAudit(env);
      if (unkeyed) return unkeyed;
      const fwd = new Request(new URL('/api/library/trigger', request.url), { method: 'POST', body: raw, headers: systemForwardHeaders('pm-system', scope) });
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(fwd);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // DNA push (WOW_ZERO_CONFIG §5.4): the same pattern as /api/triggers, with its own bearer secret (Access bypass on
    // this path only). Production deployments only; forwarded as role `system` to the directory import (source dna).
    if (url.pathname === '/api/directory/push' && request.method === 'POST') {
      const secret = env.DIRECTORY_PUSH_SECRET || '', given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!secret || !env.LIBRARY || given.length !== secret.length || !timingSafe(given, secret)) { slog.log('bearer_fail', 'BEARER_INVALID', 401); return json(env, { error: 'Unauthorized.' }, 401); }
      const push = pushConfig(env);
      if (push.status !== 'on') return json(env, { error: 'DNA push is not connected.', ...push }, 503);
      const bytes = Number(request.headers.get('Content-Length') || 0) > 262144 ? null : await boundedBytes(request, 262144);
      if (!bytes) return json(env, { error: 'Request too large.' }, 413);
      const scope = systemScope(env);
      if (!scope.ok) return json(env, scope.body, scope.status);
      if (callerNamedTenant(request, bytes).some(t => t !== scope.tenant)) return json(env, { error: 'A system ingress uses only the configured tenant. The tenant on this request was not accepted.' }, 403);
      const unkeyed = rejectUnkeyedAudit(env);
      if (unkeyed) return unkeyed;
      const fwd = new Request(new URL('/api/library/directory/import', request.url), { method: 'POST', body: bytes, headers: systemForwardHeaders('dna-push', scope) });
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(fwd);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // Teams bot endpoint and launcher tab (pre-Access, like /api/triggers): exactly these two; every other
    // /api/teams/* path falls through to the signed-in handling. BLOCKED_EXTERNAL until Teams is connected.
    if ((url.pathname === '/api/teams/messages' && request.method === 'POST') || (url.pathname === '/teams/tab' && request.method === 'GET')) return teamsRoutes(request, env, { waitUntil });
    // Identity comes from the verified Access token only. ?as= and &idp= are not read here.
    let who = null;
    try { who = await verifyAccess(request, env); } catch { who = null; }
    if (!who) { slog.log('authn_fail', 'ACCESS_JWT_MISSING', 401); return new Response('Sign in to use ATLAS.', { status: 401, headers: headers(env) }); }
    // Access email only: an Entra deployment must grant admin through an app role, never a username fallback.
    const elevated = elevatedRole(env, who);
    const admin = elevated === 'admin';
    // Elevated roles come from the verified token (or ATLAS_ADMIN_SUBJECTS). ADMIN_EMAILS and REVIEWER_EMAILS do not grant them.
    // External confirmers remain an explicit server email allow-list, and only when no elevated role matched.
    const role = elevated || (env.IDENTITY_SOURCE === 'entra' ? 'user' : (inList(who.email, env.EXTERNAL_EMAILS) ? 'external' : 'user'));
    const tenant = tenantOf(who);
    const tenantFlag = tenantEnforced(env) ? '1' : '0';
    const csrf = await hmac(env.CSRF_SECRET, who.sub), subjectKey = await subjectPseudonym(env, who.sub);
    if (subjectKey === null) return json(env, { error: 'This deployment cannot record a subject pseudonym until LOG_SALT is set.', code: 'LOG_SALT' }, 503);
    slog.identify(subjectKey, role);
    if (blockedSubject(env, subjectKey)) { slog.log('subject_blocked', 'BLOCKED', 403); return json(env, { error: BLOCKED_MESSAGE, code: 'BLOCKED' }, 403); }
    if (externalOff(env) && (role === 'external' || url.pathname === '/confirm' || url.pathname.startsWith('/api/library/confirmations'))) {
      slog.log('kill_switch', 'EXTERNAL_OFF', 403); return json(env, { error: EXTERNAL_OFF_MESSAGE, code: 'EXTERNAL_OFF' }, 403);
    }
    const sameOrigin = request.headers.get('Origin') === env.ORIGIN;
    const csrfHeader = request.headers.get('X-Atlas-CSRF');
    const sessionGuard = () => {
      if (!sameOrigin) { slog.log('origin_fail', 'ORIGIN_MISMATCH', 403); return json(env, { error: 'Invalid request origin or session token.' }, 403); }
      if (!csrfHeader) { slog.log('csrf_fail', 'CSRF_MISSING', 403); return json(env, { error: 'Invalid request origin or session token.' }, 403); }
      if (!csrfOk(csrfHeader, csrf)) { slog.log('csrf_fail', 'CSRF_MISMATCH', 403); return json(env, { error: 'Invalid request origin or session token.' }, 403); }
      return null;
    };
    async function spend(bucket, max) {
      // The counter lives on who.sub, not the tenant-scoped interview object. It stores counts only, never story content.
      // A missing binding or a Durable Object error refuses the request. It does not run it.
      return consumeLimit(env, slog, who.sub, [{ bucket, max, windowMs: HOUR_MS }]);
    }
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
      if (!(url.pathname === '/confirm' && request.method === 'GET') && !url.pathname.startsWith('/api/library/confirmations/')) { slog.log('external_denied', 'EXTERNAL_ROLE_PATH', 403); return json(env, { error: 'Not available to external confirmers.' }, 403); }
    }
    // Links that survive an interactive sign-in (§3.9): /go/start, /go/{gap,invitation,bid,library,confirm}/<32 hex>.
    // Anything else under /go/ goes home. The ids are random, non-secret and grant nothing without sign-in (a recorded
    // deviation from WOW rule 7); no token ever goes in a path, and nothing here logs the path.
    if (request.method === 'GET' && url.pathname === '/go/signed-in') return htmlResponse(env, SIGNED_IN_HTML, { hashes: await inlineScriptHashes(SIGNED_IN_HTML), ...QUIET_PAGE, enforceStrict: true });
    if (request.method === 'GET' && url.pathname.startsWith('/go/')) {
      const m = /^\/go\/(?:(start)|(gap|invitation|bid|library|confirm)\/([a-f0-9]{32}))$/.exec(url.pathname);
      const to = !m ? '/' : m[1] ? '/#start' : m[2] === 'confirm' ? '/confirm#' + m[3] : '/#' + m[2] + '/' + m[3];
      return new Response(null, { status: 302, headers: headers(env, { Location: to }) });
    }
    if (url.pathname === '/confirm' && request.method === 'GET') return htmlResponse(env, CONFIRM_HTML, { hashes: await inlineScriptHashes(CONFIRM_HTML), ...QUIET_PAGE, connectSelf: true, enforceStrict: true });
    if (url.pathname === '/privacy' && request.method === 'GET') {
      const notice = renderNoticeHtml(RETENTION);
      return htmlResponse(env, notice, { hashes: await inlineScriptHashes(notice), ...QUIET_PAGE, reportOnlyStrip: true, enforceStrict: true });
    }
    if (url.pathname === '/' && request.method === 'GET') {
      const block = runtimeBlock({ subjectKey, authMode: identity.mode, name: who.email });
      let body = page.replace(/<script id="atlas-runtime" type="application\/json">[\s\S]*?<\/script>/, block)
        .replace("connect-src 'self';", "connect-src 'self' " + connectOrigin(env) + ';');
      const end = body.lastIndexOf('</body>'); // the page embeds an earlier '</body>' inside a script string
      // The test banner stays until Tony sets DATA_MODE=production on an approved deployment (WOW_ZERO_CONFIG §0.7, §11).
      if (env.DATA_MODE !== 'production' && end >= 0) body = body.slice(0, end) + '<div style="position:fixed;left:12px;bottom:10px;z-index:99;font:11px/1.4 Arial;letter-spacing:.06em;color:#A9A9BC;background:#15151cdd;border:1px solid #2a2a36;border-radius:14px;padding:4px 10px">TEST DEPLOYMENT · SYNTHETIC DATA ONLY</div>' + body.slice(end);
      return htmlResponse(env, body, { hashes: PAGE_SCRIPT_HASHES, connect: connectOrigin(env), reportOnlyStrip: true, ...VOICE_PAGE });
    }
    if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
      // One voice for everyone, advertised only as 'atlas': the real voice and provider stay server-side.
      return json(env, { provider: 'workers', providerLabel: 'ATLAS voice', protocol: 'atlas-personaplex-pcm-v1', csrf,
        identity, model: 'ATLAS conversational voice', admin,
        voices: ['atlas'], defaultVoice: 'atlas', captureRequired: true, codecAvailable: true, busy: false, capacity: 1, maxSeconds: MAX_SECONDS, speakingSeconds: SPEAKING_LIMIT_S,
        memory: memoryConfigured(env), wiki: false, jev: !!env.TYPESAFE_API_KEY, jevClassify: !!env.TYPESAFE_API_KEY, library: !!env.LIBRARY, libraryRole: role, sheet: true, transcription: true, structuredNotes: true, liveLedger: true, playbackAck: true,
        ...(readOnly(env) ? { readOnly: true } : {}), ...(aiOff(env) ? { aiOff: true } : {}),
        readiness: env.DATA_MODE === 'production' ? 'production' : 'edge-deployment-test-data-only', privilege: privilegeReadiness(env), email: mail, features: flagsOf(env) });
    }
    if (url.pathname === '/api/consent' && request.method === 'POST') {
      const refused = sessionGuard(); if (refused) return refused;
      const scope = continuityScope(env, who.sub, tenant);
      if (!scope.ok) return json(env, { error: 'A verified tenant is required.' }, 403);
      if (!env.INTERVIEW) return json(env, { error: 'The interview store is not configured on this deployment.' }, 404);
      const fwd = new Request('https://atlas.internal/api/consent', { method: 'POST', body: await request.text(), headers: { 'content-type': 'application/json', 'x-atlas-user': libraryUser, 'x-atlas-role': role, 'x-atlas-email': mail, 'x-atlas-tenant': scope.tenant, 'x-atlas-tenant-enforced': tenantFlag, 'x-atlas-subj': subjectKey } });
      const res = await env.INTERVIEW.get(env.INTERVIEW.idFromName(scope.objectName)).fetch(fwd);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    if ((url.pathname === '/api/me/erase' && request.method === 'POST') || (url.pathname === '/api/me/export' && request.method === 'GET')) {
      if (!TENANT_ID.test(tenant)) return json(env, { error: 'A verified tenant is required.' }, 403);
      const refused = sessionGuard(); if (refused) return refused;
      if (!env.LIBRARY) return json(env, { error: 'The reference library is not configured on this deployment.' }, 404);
      const action = url.pathname.endsWith('/erase') ? 'erase' : 'export';
      let eraseBody;
      if (action === 'erase') {
        eraseBody = await request.text();
        let confirmed = false;
        try { confirmed = JSON.parse(eraseBody).confirmed === true; } catch { confirmed = false; }
        if (!confirmed) return json(env, { error: 'Erasure needs the confirmation the Worker checks.' }, 400);
      }
      const limited = await spend(action === 'erase' ? 'me-erase' : 'me-export', action === 'erase' ? 3 : 5);
      if (limited) return limited;
      const fwd = new Request('https://atlas.internal/api/privacy/' + action, { method: request.method, headers: { 'content-type': 'application/json', 'x-atlas-user': libraryUser, 'x-atlas-role': role, 'x-atlas-email': mail, 'x-atlas-tenant': tenant, 'x-atlas-tenant-enforced': tenantFlag, 'x-atlas-subj': subjectKey }, body: action === 'erase' ? eraseBody : undefined });
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(fwd);
      let payload = {};
      try { payload = await res.json(); } catch { payload = {}; }
      if (!res.ok) return json(env, payload, res.status);
      if (action === 'erase') return json(env, { ...payload, complete: false, erased: false, libraryErased: payload.erased === true, notCovered: NOT_COVERED });
      return json(env, { ...payload, complete: false, notCovered: NOT_COVERED });
    }
    if (url.pathname === '/api/voice') {
      if (aiOff(env)) return json(env, { error: INTERVIEW_PAUSED_MESSAGE, code: 'AI_OFF' }, 503);
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade.', { status: 426, headers: headers(env) });
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
      if (aiOff(env)) return json(env, { error: AI_OFF_MESSAGE, code: 'AI_OFF' }, 503);
      const refused = sessionGuard(); if (refused) return refused;
      const sheetPath = url.pathname.slice('/api/sheet/'.length);
      if (!['ingest', 'draft', 'visuals'].includes(sheetPath)) return json(env, { error: 'Not found.' }, 404);
      const sheetCap = 12 * 1024 * 1024;
      if (Number(request.headers.get('Content-Length') || 0) > sheetCap) { slog.log('body_too_large', 'BODY_TOO_LARGE', 413); return json(env, { error: 'The file is larger than 10 MB.' }, 413); }
      const sheetBytes = await boundedBytes(request, sheetCap);
      if (!sheetBytes) { slog.log('body_too_large', 'BODY_TOO_LARGE', 413); return json(env, { error: 'The file is larger than 10 MB.' }, 413); }
      if (sheetPath === 'ingest') {
        if (!sheetBytes.length) return json(env, { error: 'The file is empty.' }, 400);
      } else {
        try { JSON.parse(new TextDecoder().decode(sheetBytes)); } catch { return json(env, { error: 'Invalid JSON.' }, 400); }
      }
      const limited = await spend('sheet', limitOf(env, 'SHEET_HOUR')); if (limited) return limited;
      const sheetHeaders = new Headers(request.headers); sheetHeaders.delete('content-length');
      const sheetRequest = new Request(request.url, { method: 'POST', headers: sheetHeaders, body: sheetBytes });
      // PDF metadata (author, producer, title) is never extracted (D2, WOW_ZERO_CONFIG §4): text only.
      const ai = workersAI(env), res = await sheetRoutes(sheetRequest, sheetPath, { complete: (m, n) => ai.complete(m, n),
        toMarkdown: f => env.AI.toMarkdown(f, { conversionOptions: { pdf: { metadata: false } } }) });
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/memory' || url.pathname.startsWith('/api/memory/')) {
      if (request.method !== 'GET') { const refused = sessionGuard(); if (refused) return refused; }
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
      if (request.method !== 'GET') { const refused = sessionGuard(); if (refused) return refused; }
      if (Number(request.headers.get('Content-Length') || 0) > 262144) { slog.log('body_too_large', 'BODY_TOO_LARGE', 413); return json(env, { error: 'Request too large.' }, 413); }
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
      if (res.status === 403) slog.log('access_denied', 'FORBIDDEN', 403);
      if (res.status === 429) slog.log('rate_limited', 'RATE_LIMITED', 429);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    // Spoken Ask (F6): transcription of one short question. Off while SPOKEN_ASK_APPROVED (D1) is false; then each
    // request needs the consent prompt's header, and `always` a consent stored in the person's profile. Stores nothing;
    // the log line carries numbers only.
    if (url.pathname === '/api/transcribe' && request.method === 'POST' && flagsOf(env).spokenAsk) {
      if (aiOff(env)) return json(env, { error: AI_OFF_MESSAGE, code: 'AI_OFF' }, 503);
      const refused = sessionGuard(); if (refused) return refused;
      // Auth and consent before the limiter. A missing consent is 403 even when the limiter cannot be reached.
      const consent = /^spoken-ask-v1;\s*(once|always)$/.exec((request.headers.get('X-Atlas-Consent') || '').trim());
      if (!consent || (consent[1] === 'always' && !await storedSpokenAsk(env, { libraryUser, role, mail, tenant, tenantFlag }))) return json(env, { error: 'Voice questions need your consent first.' }, 403);
      if ((request.headers.get('Content-Type') || '').replace(/\s+/g, '').toLowerCase() !== 'audio/l16;rate=24000') return json(env, { error: 'Send 16-bit mono PCM at 24 kHz (audio/L16;rate=24000).' }, 415);
      if (Number(request.headers.get('Content-Length') || 0) > AUDIO_MAX) return json(env, { error: 'The recording is longer than 30 seconds.' }, 413);
      const pcm = await boundedBytes(request, AUDIO_MAX);
      if (!pcm) return json(env, { error: 'The recording is longer than 30 seconds.' }, 413);
      if (pcm.length < AUDIO_MIN || pcm.length % 2) return json(env, { error: 'The recording is too short or is not 16-bit audio.' }, 400);
      const limited = await spend('transcribe', limitOf(env, 'TRANSCRIBE_HOUR')); if (limited) return limited;
      const t0 = Date.now(), metric = values => console.log(JSON.stringify({ atlas_metric: 'transcribe', ms: Date.now() - t0, bytes: pcm.length, ...values }));
      let out;
      try { out = await workersAI(env).transcribe(pcm); } catch { metric({ failed: 1 }); return json(env, { error: 'Transcription failed. Type the question instead.' }, 502); }
      metric({});
      return json(env, { text: String(out?.text || '').slice(0, 600), language: out?.language || null });
    }
    if (url.pathname === '/api/jev/classify' && request.method === 'POST') {
      if (aiOff(env)) return json(env, { error: AI_OFF_MESSAGE, code: 'AI_OFF' }, 503);
      const refused = sessionGuard(); if (refused) return refused;
      if (Number(request.headers.get('Content-Length') || 0) > 65536) return json(env, { error: 'Project too large to score.' }, 413);
      const raw = await boundedText(request, 65536);
      if (raw == null) return json(env, { error: 'Project too large to score.' }, 413);
      let project;
      try { project = JSON.parse(raw).project; } catch { return json(env, { error: 'Invalid JSON.' }, 400); }
      try { projectState(project); } catch (e) { return json(env, { error: e.message }, e.status || 400); }
      const limited = await spend('classify', limitOf(env, 'CLASSIFY_HOUR')); if (limited) return limited;
      try { return json(env, await classify(env, project)); }
      catch (e) { return e.status ? json(env, { error: e.message }, e.status) : json(env, { error: 'Scoring is unavailable right now. Try again shortly.' }, 502); }
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
  if (!env.LIBRARY || productionDemoConflict(env) || rejectUnkeyedAudit(env)) return;
  const enforced = tenantEnforced(env);
  const tenant = String(env.ATLAS_SYSTEM_TENANT || '').trim().toLowerCase();
  if (enforced && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) return;
  const headers = { 'Content-Type': 'application/json', 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system', 'x-atlas-tenant': enforced ? tenant : '', 'x-atlas-tenant-enforced': enforced ? '1' : '0' };
  const post = path => env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(new Request('https://atlas.internal' + path, { method: 'POST', body: '{}', headers }));
  if (readOnly(env)) {
    ctx.waitUntil((async () => {
      await secEvent(env, 'kill_switch', { reason: 'READ_ONLY', route: '/api/library/verify-chain', method: 'POST', status: 200 });
      await post('/api/library/verify-chain');
    })());
    return;
  }
  ctx.waitUntil(post('/api/library/scan-stale'));
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

export function workersAI(env) {
  const bytesOf = async r => r instanceof Uint8Array ? r : r instanceof ArrayBuffer ? new Uint8Array(r)
    : r instanceof ReadableStream || r instanceof Response ? new Uint8Array(await new Response(r.body ?? r).arrayBuffer())
    : r?.audio ? Uint8Array.from(atob(r.audio), c => c.charCodeAt(0)) : new Uint8Array(0);
  return {
    // Automatic language detection (Nova-3 "multi"): returns the text and the utterance's language.
    async transcribe(pcm) {
      assertAiOn(env);
      const r = await env.AI.run(env.STT_MODEL, { audio: { body: new Blob([wav(pcm)]).stream(), contentType: 'audio/wav' }, smart_format: true, punctuate: true, language: env.STT_LANGUAGE || 'multi' });
      return { text: r?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '', language: detectedLanguage(r) };
    },
    // Semantic end-of-turn (Pipecat smart-turn v2): has the consultant finished, or only paused? Last 8 s at 16 kHz.
    // Sent as a base64 WAV string: the binding rejects the streamed {body, contentType} form for this model (AiError).
    async turnComplete(pcm) {
      assertAiOn(env);
      const tail = pcm.length > 8 * 48000 ? pcm.subarray(pcm.length - 8 * 48000) : pcm, bytes = wav(to16k(tail), 16000);
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await env.AI.run(env.TURN_MODEL || '@cf/pipecat-ai/smart-turn-v2', { audio: btoa(bin) });
      // No boolean verdict is no verdict (the session logs it as NoVerdict and uses the silence rule), never "unfinished".
      return typeof r?.is_complete === 'boolean' ? { complete: r.is_complete, probability: Number(r.probability) || 0 } : null;
    },
    speaks(lang) { return NATIVE_VOICES.includes(lang) || (!!env.ELEVENLABS_API_KEY && !!normalize(lang)); },
    async synthesize(text, speaker = 'atlas', lang = 'en') { // 'atlas' = the configured voice; the browser never sees its real name
      assertAiOn(env);
      if (lang !== 'en' && lang !== 'es' && env.ELEVENLABS_API_KEY) return elevenLabs(env, text, lang);
      const es = lang === 'es';
      const pcm = await bytesOf(await env.AI.run(es ? (env.TTS_MODEL_ES || '@cf/deepgram/aura-2-es') : env.TTS_MODEL, { text, speaker: es ? (env.TTS_VOICE_ES || 'celeste') : speaker === 'atlas' ? env.TTS_VOICE : speaker, encoding: 'linear16', container: 'none', sample_rate: 24000 }));
      return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
    },
    // Session affinity keeps one interview on the same model instance, so the cached prompt prefix is reused.
    async *chatStream(messages, { affinity } = {}) {
      assertAiOn(env);
      const stream = await env.AI.run(env.TALKER_MODEL, { messages, stream: true, max_tokens: 300, temperature: 0.7 }, affinity ? { extraHeaders: { 'x-session-affinity': affinity } } : undefined);
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
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
    },
    async complete(messages, maxTokens = 2500) {
      assertAiOn(env);
      return responseText(await runReasoning(env, { messages, temperature: 0.1, max_tokens: maxTokens }));
    },
    async embed(text) {
      assertAiOn(env);
      const r = await env.AI.run(env.EMBED_MODEL || '@cf/baai/bge-m3', { text: [String(text).slice(0, 8000)] });
      const v = r?.data?.[0];
      return Array.isArray(v) && v.length ? v : null;
    },
    async report(messages) {
      assertAiOn(env);
      return responseText(await runReasoning(env, { messages, temperature: 0.2, max_tokens: 3000 }));
    },
    async analyst(messages) {
      assertAiOn(env);
      return responseToolCalls(await runReasoning(env, { messages, tools: CHAT_TOOLS, tool_choice: 'auto', temperature: 0, max_tokens: 1500 }));
    },
  };
}
