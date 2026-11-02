// Pseudonymous security-event log (blue review G2). One JSON line per event on the Worker log (`atlas_sec`), for a log sink or
// `wrangler tail`. It records WHAT happened and WHERE, never WHO: no email, name, token, path parameter, query string or
// request content ever reaches it. The person appears only as `subj` (the first 16 characters of the same HMAC subject key
// the page already holds, so an operator can put it into ATLAS_BLOCKED_SUBS) and the network address only as `ip_h`
// (a keyed hash). Fields outside the whitelist below are dropped, so a caller cannot leak by accident.
const enc = new TextEncoder();
export const EVENTS = Object.freeze(['authn_fail', 'csrf_fail', 'origin_fail', 'external_denied', 'bearer_fail', 'access_denied', 'rate_limited', 'body_too_large',
  'header_spoof', 'kill_switch', 'subject_blocked', 'flag_state', 'audit_chain_break', 'audit_chain_ok', 'internal_error', 'inbound_off', 'privacy_export', 'privacy_erase', 'privacy_flags', 'consent_change', 'csp_violation', 'voice_settings']);
const FIELDS = ['route', 'method', 'status', 'reason', 'subj', 'role', 'ip_h', 'colo', 'ray', 'n', 'bucket', 'head', 'prev', 'directive', 'blocked'];

// '/api/library/<32 hex>/validate' -> '/api/library/:id/validate'. Only short lower-case words survive; everything else (ids,
// e-mail addresses, encoded text) becomes ':id', and at most six segments are kept. The query string is never read.
export function routeTemplate(pathname) {
  const segs = String(pathname || '').split('?')[0].split('/').filter(Boolean).slice(0, 6);
  return '/' + segs.map(s => (/^[a-z][a-z-]{0,23}$/.test(s) ? s : ':id')).join('/');
}
const code = v => (/^[A-Z0-9_:.-]{1,48}$/.test(String(v ?? '')) ? String(v) : 'UNSPECIFIED');
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function keyedHash(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}
// The salt for hashed addresses: LOG_SALT when set, else a labelled derivation of CSRF_SECRET (rotating it only changes the pseudonyms).
export const ipHash = async (env, ip) => (ip && (env?.LOG_SALT || env?.CSRF_SECRET) ? (await keyedHash(env.LOG_SALT || 'atlas-log-v1:' + env.CSRF_SECRET, 'ip:' + ip)).slice(0, 16) : '');

// Builds the record (also returned, for tests) and writes it. `f` may carry: route (a template), method, status, reason (a code),
// subj (a subject key), role, ip (raw, hashed here and dropped), colo, ray, n, bucket, head.
export async function secEvent(env, event, f = {}, write = line => console.log(line)) {
  if (!EVENTS.includes(event)) event = 'internal_error';
  const rec = { atlas_sec: 1, v: 1, ts: new Date().toISOString(), event };
  const src = { ...f, ip_h: f.ip ? await ipHash(env, f.ip) : f.ip_h };
  for (const k of FIELDS) {
    let v = src[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'reason') v = code(v);
    else if (k === 'route') v = routeTemplate(v);
    else if (k === 'subj') v = String(v).toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 16);
    else if (k === 'status' || k === 'n') v = Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : undefined;
    else if (k === 'directive') v = /^[a-z-]{3,40}$/.test(String(v)) ? String(v) : 'unknown';
    else if (k === 'blocked') v = String(v).toLowerCase().replace(/[^a-z0-9.:/-]/g, '').slice(0, 80); // an origin: scheme and host, never a path
    else if (k === 'role') v = ['user', 'reviewer', 'admin', 'external', 'system'].includes(v) ? v : undefined;
    else if (k === 'method') v = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(String(v).toUpperCase()) ? String(v).toUpperCase() : undefined;
    else v = String(v).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40);
    if (v !== undefined && v !== '') rec[k] = v;
  }
  try { write(JSON.stringify(rec)); } catch { /* logging must never break a request */ }
  return rec;
}

// A per-request logger: remembers who the request is (set once the sign-in is verified) so every later event carries the
// pseudonym, and whether a specific event was already written (the catch-all in app.js only fills in the gaps).
export function requestLog(request, env, write) {
  const url = new URL(request.url), pending = [];
  const ctx = { write, logged: false, subj: '', role: '',
    identify(subj, role) { ctx.subj = subj; ctx.role = role; },
    log(event, reason, status, extra = {}) {
      ctx.logged = true;
      pending.push(secEvent(env, event, { route: url.pathname, method: request.method, status, reason, subj: ctx.subj, role: ctx.role, ip: request.headers.get('cf-connecting-ip') || '',
        colo: request.cf?.colo, ray: request.headers.get('cf-ray'), ...extra }, write));
    },
    async flush() { await Promise.all(pending.splice(0)); } };
  return ctx;
}

// Logged once per isolate: a security switch is not in its default state (names only, never values).
let announced = '';
export async function announceFlags(env, names, write) {
  const key = names.join(',');
  if (!key || key === announced) return;
  announced = key;
  await secEvent(env, 'flag_state', { reason: 'FLAGS_ACTIVE', n: names.length, bucket: key.replace(/ATLAS_/g, '').replace(/,/g, '-') }, write);
}
export const resetAnnounced = () => { announced = ''; };
