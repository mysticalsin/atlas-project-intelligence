// Contract-driven connectors (v2.2 C1). ONE generic HTTP connector, driven entirely by atlas_voice/config/connections.json (emitted as
// CONNECTIONS_CONFIG): when an owner supplies base URL, auth, schema and sample payloads, enabling a connection is configuration plus a
// contract test, not new code. Nothing in this file knows a vendor, an endpoint or a field name.
//
// OUTBOUND: createHttpConnector() implements the adapter interface jobs.js/branches.js already use (`send(envelope, payload)` ->
//   { ok:true, ack } | { ok:false, retryable?, error } | { ok:false, conflict:true, error }). It refuses to run unless ALL hold: the connection is
//   wired, its status is at least configured_untested, every secret named in its auth block is present, ATLAS_ADAPTERS=live, the base URL and
//   an endpoint are configured, a field_mapping exists and the ack_rule is complete. It never reports mock:false unless a real HTTP response
//   satisfied the ack_rule; a sandbox connection reports mock:true, sandbox:true (a sandbox record is never "synced" or "published").
//   The request body is built from the approved payload ONLY through field_mapping (an allowlist): nothing unmapped is sent, and a payload or
//   mapped body carrying a never-send key (transcript, internal notes, interview ids, source quotes...) is refused before any request.
//   HTTP: 2xx + ack_rule -> ack; 409/412 -> conflict (needs_reconciliation); 429, 5xx, 408, timeout, network -> retryable; 401/403 and other
//   4xx -> failed with a code; 3xx is never followed. Error codes never copy a response body.
// INBOUND: createInboundConnector() is a read-only fetch whose output passes an allowlist (model_fields / display_only_fields): names and
//   emails are never model-visible, unknown fields are dropped (reported by Atlas field name only), values are bounded scalars.
// Secrets are read from env by NAME at call time and never returned, logged or stored.
import { CONNECTIONS_CONFIG } from './policy.generated.js';

export const STATUS_ORDER = ['not_configured', 'configured_untested', 'contract_verified', 'live_verified'];
export const statusAtLeast = (status, min) => STATUS_ORDER.indexOf(status) >= STATUS_ORDER.indexOf(min) && STATUS_ORDER.includes(status);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const filled = v => typeof v === 'string' && v.trim() !== '';
const RESPONSE_MAX_BYTES = 262144;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

// ---- registry lookups ----
export const connectionById = (id, config = CONNECTIONS_CONFIG) => (config?.connections || []).find(c => c.id === id) || null;
// michat_cv -> MICHAT_CV (the CV destination is MiChat; the pack's "MeChat" is a typo).
export const connectionForAdapter = (adapter, config = CONNECTIONS_CONFIG) => (config?.connections || []).find(c => c.adapter === adapter) || null;

// ---- readiness ----
const secretPresent = (env, name, type) => type === 'mtls' ? typeof env?.[name]?.fetch === 'function' : filled(env?.[name]);
// null when `value` is an acceptable base URL: https, or http on a loopback host (tests and local mocks only); no credentials, query or fragment.
export function baseUrlProblem(value) {
  let u;
  try { u = new URL(String(value)); } catch { return 'BASE_URL_INVALID'; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) return 'BASE_URL_INVALID';
  return u.username || u.password || u.search || u.hash ? 'BASE_URL_INVALID' : null;
}
const endpointOf = (conn, use) => conn.endpoints?.[use] && filled(conn.endpoints[use].path) ? conn.endpoints[use] : null;

// -> { id, eligible, reasons: [code] }. `use` is 'send' (outbound), 'read' (inbound) or 'health'. Reason codes only, never values.
export function readiness(conn, env, { use = conn?.direction === 'inbound' ? 'read' : 'send', ignoreAdaptersFlag = false } = {}) {
  const reasons = [];
  if (!conn) return { id: null, eligible: false, reasons: ['UNKNOWN_CONNECTION'] };
  if (conn.managed_by !== 'http_connector') reasons.push('NOT_HTTP_CONNECTOR');
  if (conn.wired !== true) reasons.push('NOT_WIRED');
  if (!statusAtLeast(conn.status, 'configured_untested')) reasons.push(`STATUS_${String(conn.status).toUpperCase()}`);
  if (!ignoreAdaptersFlag && String(env?.ATLAS_ADAPTERS ?? '').trim().toLowerCase() !== 'live') reasons.push('ADAPTERS_NOT_LIVE');
  const auth = conn.auth || {};
  for (const n of auth.secret_names || []) if (!secretPresent(env, n, auth.type)) reasons.push(`SECRET_MISSING:${n}`);
  if (auth.type === 'oauth2_client_credentials' && !filled(env?.[auth.token_url_var]) ) reasons.push('TOKEN_URL_MISSING');
  else if (auth.type === 'oauth2_client_credentials' && baseUrlProblem(env[auth.token_url_var])) reasons.push('TOKEN_URL_INVALID');
  if (auth.type === 'api_key_header' && !filled(auth.header_name)) reasons.push('AUTH_HEADER_NAME_MISSING');
  if (!filled(conn.base_url_var) || !filled(env?.[conn.base_url_var])) reasons.push('BASE_URL_MISSING');
  else if (baseUrlProblem(env[conn.base_url_var])) reasons.push('BASE_URL_INVALID');
  if (!endpointOf(conn, use)) reasons.push('ENDPOINT_NOT_CONFIGURED');
  if (use !== 'health') {
    if (!isObj(conn.field_mapping) || !Object.keys(conn.field_mapping).length) reasons.push('FIELD_MAPPING_EMPTY');
    const ack = conn.ack_rule || {};
    if (conn.direction === 'outbound') {
      if (!filled(ack.record_id_path) || !filled(ack.version_path)) reasons.push('ACK_RULE_MISSING');
      if (ack.kind === 'publication') {
        const p = ack.publication || {};
        if (!filled(ack.hash_echo_path) || !filled(p.state_path) || !Array.isArray(p.published_values) || !p.published_values.length || !filled(p.canonical_url_path) || !filled(p.published_at_path)) reasons.push('PUBLICATION_ACK_RULE_MISSING');
      }
    }
  }
  return { id: conn.id, eligible: reasons.length === 0, reasons };
}
export const adapterReadiness = (env, adapter, config = CONNECTIONS_CONFIG) => readiness(connectionForAdapter(adapter, config), env);
export const anyLiveEligible = (env, config = CONNECTIONS_CONFIG) => (config?.connections || []).some(c => c.direction === 'outbound' && readiness(c, env).eligible);

// Everything a status page may show: names and booleans, never a secret or a URL.
export function connectionStatus(env, config = CONNECTIONS_CONFIG) {
  return (config?.connections || []).map(c => {
    const r = readiness(c, env), auth = c.auth || {}, use = c.direction === 'inbound' ? 'read' : 'send';
    return { id: c.id, label: c.label, direction: c.direction, workflow_step: c.workflow_step, status: c.status, owner: c.owner, managed_by: c.managed_by, wired: c.wired, sandbox: c.sandbox,
      schema_status: c.schema_status, eligible: r.eligible, reasons: r.reasons, auth_type: auth.type,
      secrets_present: Object.fromEntries((auth.secret_names || []).map(n => [n, secretPresent(env, n, auth.type)])),
      base_url_set: filled(env?.[c.base_url_var]), endpoint_configured: !!endpointOf(c, use) };
  });
}

// ---- paths and mapping ----
const segs = p => String(p).split('.').map(s => { if (UNSAFE.has(s.replace('[]', ''))) throw new Error('MAPPING_UNSAFE_PATH'); return s; });
export const getPath = (obj, path) => String(path).split('.').reduce((v, k) => isObj(v) && Object.hasOwn(v, k) ? v[k] : undefined, obj);
function setSegs(into, parts, value) {
  let cur = into;
  parts.slice(0, -1).forEach(k => { if (!isObj(cur[k])) cur[k] = {}; cur = cur[k]; });
  cur[parts[parts.length - 1]] = value;
}
// Copy src (a dotted path, `[]` marks an array whose items are mapped one by one) of `from` to dst of `into`.
function copy(src, dst, from, into) {
  const si = src.findIndex(s => s.endsWith('[]')), di = dst.findIndex(s => s.endsWith('[]'));
  if ((si < 0) !== (di < 0)) throw new Error('MAPPING_ARRAY_MISMATCH');
  if (si < 0) { const v = getPath(from, src.join('.')); if (v !== undefined) setSegs(into, dst, v); return; }
  const arr = getPath(from, [...src.slice(0, si), src[si].slice(0, -2)].join('.'));
  if (!Array.isArray(arr)) return;
  const dpath = [...dst.slice(0, di), dst[di].slice(0, -2)];
  let target = getPath(into, dpath.join('.'));
  if (!Array.isArray(target)) { target = []; setSegs(into, dpath, target); }
  const rest = [src.slice(si + 1), dst.slice(di + 1)];
  arr.forEach((item, i) => {
    if (!rest[0].length && !rest[1].length) { target[i] = item; return; }
    if (!isObj(target[i])) target[i] = {};
    copy(rest[0], rest[1], item, target[i]);
  });
}
// atlas path -> destination path, for every entry of the mapping. Unmapped Atlas fields are not sent.
export function mapOutbound(conn, payload) {
  const out = {};
  for (const [src, dst] of Object.entries(conn.field_mapping || {})) copy(segs(src), segs(dst), payload, out);
  for (const [dst, v] of Object.entries(conn.static_fields || {})) setSegs(out, segs(dst), v);
  return out;
}
// The first never-send key found at any depth, or null.
export function findForbidden(value, keys) {
  const bad = new Set(keys.map(k => String(k).toLowerCase()));
  const walk = v => {
    if (Array.isArray(v)) { for (const x of v) { const f = walk(x); if (f) return f; } return null; }
    if (!isObj(v)) return null;
    for (const [k, x] of Object.entries(v)) { if (bad.has(k.toLowerCase())) return k; const f = walk(x); if (f) return f; }
    return null;
  };
  return walk(value);
}
const neverSend = (conn, config) => [...(config?.data_minimisation?.never_send_keys || []), ...(conn.never_send_extra || [])];

// ---- HTTP plumbing ----
const tokenCache = new Map();
export const clearTokenCache = () => tokenCache.clear();
const bytes = new TextEncoder();
async function boundedText(res, max) {
  if (Number(res.headers.get('Content-Length') || 0) > max) return null;
  if (!res.body) return '';
  const reader = res.body.getReader(), parts = []; let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n); let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return new TextDecoder().decode(all);
}
async function timed(ms, run) { // run(signal): the request is aborted AND abandoned when the time is up, even if the fetcher ignores the signal
  const ac = new AbortController(); let timer;
  try { return await Promise.race([run(ac.signal), new Promise((_, no) => { timer = setTimeout(() => { ac.abort(); no(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); }, ms); })]); }
  finally { clearTimeout(timer); }
}
const b64 = s => btoa(String.fromCharCode(...bytes.encode(s)));
const form = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const fail = (error, retryable = false, extra = {}) => ({ ok: false, retryable, error: String(error).slice(0, 80), ...extra });

// Standard OAuth 2.0 client-credentials grant (RFC 6749 §4.4). Returns { token } or { error: result }.
async function accessToken(conn, env, { fetcher, now, timeoutMs, fresh = false }) {
  const a = conn.auth, id = env[a.secret_roles.client_id], secret = env[a.secret_roles.client_secret], url = env[a.token_url_var];
  const key = `${conn.id}|${url}|${id}`, hit = tokenCache.get(key);
  if (!fresh && hit && hit.exp > now()) return { token: hit.token };
  const basic = (a.token_auth || 'basic') === 'basic';
  const headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...(basic ? { Authorization: `Basic ${b64(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}` } : {}) };
  const body = form({ grant_type: 'client_credentials', scope: a.scope_var ? env[a.scope_var] : undefined, ...(basic ? {} : { client_id: id, client_secret: secret }) });
  let res;
  try { res = await timed(timeoutMs, signal => fetcher(url, { method: 'POST', headers, body, redirect: 'manual', signal })); }
  catch (e) { return { error: fail(e.code === 'TIMEOUT' ? 'OAUTH_TIMEOUT' : 'OAUTH_NETWORK_ERROR', true) }; }
  if (res.status === 429 || res.status >= 500) return { error: fail(`OAUTH_HTTP_${res.status}`, true) };
  if (res.status !== 200) return { error: fail(`OAUTH_TOKEN_REFUSED_${res.status}`, false) };
  let data;
  try { const t = await boundedText(res, 16384); data = JSON.parse(t); } catch { return { error: fail('OAUTH_RESPONSE_INVALID') }; }
  if (!isObj(data) || !filled(data.access_token) || !/^bearer$/i.test(String(data.token_type ?? 'bearer'))) return { error: fail('OAUTH_RESPONSE_INVALID') };
  const ttl = Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 60;
  tokenCache.set(key, { token: data.access_token, exp: now() + Math.max(0, ttl * 1000 - 30000) });
  return { token: data.access_token };
}
// Auth headers (and the fetch to use: the mTLS binding's own). Secrets are read here and nowhere else.
async function authorise(conn, env, ctx) {
  const a = conn.auth;
  switch (a.type) {
    case 'none': return { headers: {} };
    case 'bearer': return { headers: { Authorization: `Bearer ${env[a.secret_roles.token]}` } };
    case 'api_key_header': return { headers: { [a.header_name]: env[a.secret_roles.key] } };
    case 'mtls': { const b = env[a.secret_roles.binding]; return { headers: {}, fetcher: (u, i) => b.fetch(u, i) }; }
    case 'oauth2_client_credentials': { const t = await accessToken(conn, env, ctx); return t.error ? { error: t.error } : { headers: { Authorization: `Bearer ${t.token}` } }; }
    default: return { error: fail('AUTH_TYPE_UNSUPPORTED') };
  }
}
const urlFor = (conn, env, ep, values = {}, query = {}) => {
  const path = ep.path.replace(/\{([a-z_]+)\}/g, (_, k) => { if (!Object.hasOwn(values, k) || values[k] === undefined || values[k] === null || values[k] === '') throw new Error('ENDPOINT_PLACEHOLDER_UNRESOLVED'); return encodeURIComponent(String(values[k])); });
  const q = form(query);
  return env[conn.base_url_var].replace(/\/+$/, '') + path + (q ? '?' + q : '');
};
const retryAfter = res => { const s = Number(res.headers.get('Retry-After')); return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, 15 * 60 * 1000) : null; };
// Status -> the job envelope's vocabulary. Never copies a response body.
function statusResult(res) {
  const s = res.status;
  if (s === 409 || s === 412) return { ok: false, conflict: true, error: `DESTINATION_CONFLICT_HTTP_${s}` };
  if (s === 429) return fail('HTTP_429', true, { retry_after_ms: retryAfter(res) });
  if (s === 408 || s >= 500) return fail(`HTTP_${s}`, true, s === 503 ? { retry_after_ms: retryAfter(res) } : {});
  if (s >= 300 && s < 400) return fail('HTTP_REDIRECT_REFUSED');
  return fail(`HTTP_${s}`);
}
async function parseJson(res) {
  const type = res.headers.get('Content-Type') || '';
  if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(type)) return { error: 'RESPONSE_NOT_JSON' };
  const text = await boundedText(res, RESPONSE_MAX_BYTES);
  if (text === null) return { error: 'RESPONSE_TOO_LARGE' };
  try { return { json: JSON.parse(text) }; } catch { return { error: 'RESPONSE_NOT_JSON' }; }
}
async function exchange(conn, env, { method, url, headers, body, timeoutMs, fetcher, now }) {
  const run = async fresh => {
    const auth = await authorise(conn, env, { fetcher, now, timeoutMs, fresh });
    if (auth.error) return { early: auth.error };
    const send = auth.fetcher || fetcher;
    try { return { res: await timed(timeoutMs, signal => send(url, { method, redirect: 'manual', signal, headers: { Accept: 'application/json', ...headers, ...auth.headers }, ...(body !== undefined ? { body } : {}) })) }; }
    catch (e) { return { early: fail(e.code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR', true) }; }
  };
  let r = await run(false);
  if (r.res?.status === 401 && conn.auth.type === 'oauth2_client_credentials') r = await run(true); // an expired cached token: one fresh token, once
  return r;
}

// ---- outbound ----
// -> { ack } | { result } where result is the failure in the envelope's vocabulary.
export function parseAck(conn, json, envelope, payload, { now = () => new Date().toISOString() } = {}) {
  const rule = conn.ack_rule || {}, at = p => filled(p) ? getPath(json, p) : undefined;
  const id = at(rule.record_id_path), version = at(rule.version_path);
  const scalar = v => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v));
  if (!scalar(id) || !scalar(version)) return { result: fail('ACK_RULE_UNSATISFIED') };
  const expectedHash = payload?.content_hash ?? payload?.revision_hash ?? null;
  const revEcho = at(rule.revision_echo_path), hashEcho = at(rule.hash_echo_path), destRev = at(rule.destination_revision_path);
  if (rule.hash_echo_required && !filled(hashEcho)) return { result: fail('ACK_HASH_ECHO_MISSING') };
  if ((revEcho !== undefined && revEcho !== envelope.source_revision) || (filled(hashEcho) && expectedHash !== null && hashEcho !== expectedHash)) return { result: { ok: false, conflict: true, error: 'ACK_NOT_FOR_THIS_REVISION' } };
  const ack = { mock: conn.sandbox === true, sandbox: conn.sandbox === true, connection_id: conn.id, adapter: conn.adapter, destination_record_id: String(id), destination_version: typeof version === 'number' ? version : String(version),
    destination_revision: Number.isInteger(destRev) ? destRev : envelope.source_revision, revision: envelope.source_revision, hash: filled(hashEcho) ? hashEcho : expectedHash, payload_hash: envelope.payload_hash ?? null,
    acknowledged_at: now(), note: conn.sandbox ? 'Sandbox acknowledgement. Not a production record.' : 'Acknowledged by the destination over HTTP.' };
  if (rule.kind === 'publication') {
    const p = rule.publication || {}, state = at(p.state_path), url = at(p.canonical_url_path), when = at(p.published_at_path);
    // A 2xx is not publication: the CMS has to say the exact revision is published, with its URL and time.
    if (typeof state !== 'string' || !p.published_values.includes(state) || !filled(url) || !filled(when)) return { result: fail('CMS_ACCEPTED_NOT_PUBLISHED') };
    Object.assign(ack, { publication_state: state, canonical_url: url, published_at: when, revision_hash: hashEcho, published: true });
  }
  return { ack };
}

// The adapter the job pump calls. `adapter` is an adapter id (CONTRACTS name) or a connection id.
export function createHttpConnector(adapter, { env = {}, fetcher = (u, i) => fetch(u, i), now = () => Date.now(), config = CONNECTIONS_CONFIG } = {}) {
  const conn = connectionForAdapter(adapter, config) || connectionById(adapter, config);
  if (!conn || conn.direction !== 'outbound') throw new Error(`No outbound connection for ${adapter}.`);
  return {
    name: conn.adapter, connection_id: conn.id, label: conn.label, mock: false, sandbox: conn.sandbox === true,
    readiness: () => readiness(conn, env),
    async send(envelope, payload) {
      const r = readiness(conn, env);
      if (!r.eligible) return fail(`CONNECTION_NOT_READY:${r.reasons[0]}`.slice(0, 80), false, { reasons: r.reasons });
      const forbidden = findForbidden(payload, neverSend(conn, config));
      if (forbidden) return fail(`PAYLOAD_FORBIDDEN_FIELD:${forbidden}`);
      let body, url;
      try {
        body = mapOutbound(conn, payload);
        const bad = findForbidden(body, neverSend(conn, config));
        if (bad) return fail(`PAYLOAD_FORBIDDEN_FIELD:${bad}`);
        if (!Object.keys(body).length) return fail('PAYLOAD_EMPTY_AFTER_MAPPING');
        const ep = conn.endpoints.send;
        url = urlFor(conn, env, ep, { source_entity_id: envelope.source_entity_id, source_revision: envelope.source_revision, destination: envelope.destination });
      } catch (e) { return fail(/^[A-Z_]+$/.test(e.message) ? e.message : 'MAPPING_ERROR'); }
      const ep = conn.endpoints.send, timeoutMs = conn.timeout_ms ?? config.defaults?.timeout_ms ?? 8000;
      const header = conn.idempotency?.header || config.defaults?.idempotency?.header;
      const x = await exchange(conn, env, { method: ep.method, url, timeoutMs, fetcher, now,
        headers: { 'Content-Type': 'application/json', ...(header && envelope.idempotency_key ? { [header]: envelope.idempotency_key } : {}) }, body: JSON.stringify(body) });
      if (x.early) return x.early;
      const res = x.res;
      if (res.status < 200 || res.status >= 300) return statusResult(res);
      const parsed = await parseJson(res);
      if (parsed.error) return fail(parsed.error === 'RESPONSE_NOT_JSON' ? 'ACK_RULE_UNSATISFIED' : parsed.error);
      const out = parseAck(conn, parsed.json, envelope, payload, { now: () => new Date(now()).toISOString() });
      return out.result || { ok: true, ack: { ...out.ack, http_status: res.status } };
    },
  };
}

// ---- inbound ----
const clean = (v, max) => String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function sanitise(v, inb) {
  if (typeof v === 'string') return clean(v, inb.max_string_chars);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) { const items = v.slice(0, inb.max_list_items).map(x => typeof x === 'string' ? clean(x, inb.max_string_chars) : typeof x === 'number' && Number.isFinite(x) ? x : undefined); return items.some(x => x === undefined) ? undefined : items; }
  return undefined; // nested objects never pass
}
// The allowlist, pure: mapped values -> { model_fields, display_fields, dropped }. A never-to-model key is never model-visible.
export function allowlist(conn, values, config = CONNECTIONS_CONFIG) {
  const inb = conn.inbound || { model_fields: [], display_only_fields: [], max_string_chars: 200, max_list_items: 20 };
  const blocked = new Set((config?.data_minimisation?.never_to_model_keys || []).map(k => k.toLowerCase()));
  const model = new Set(inb.model_fields.filter(f => !blocked.has(f.toLowerCase()))), display = new Set(inb.display_only_fields);
  const out = { model_fields: {}, display_fields: {}, dropped: [] };
  for (const [field, raw] of Object.entries(values)) {
    const v = sanitise(raw, inb);
    if (v === undefined || (!model.has(field) && !display.has(field))) { out.dropped.push(field); continue; }
    (model.has(field) ? out.model_fields : out.display_fields)[field] = v;
  }
  return out;
}

export function createInboundConnector(id, { env = {}, fetcher = (u, i) => fetch(u, i), now = () => Date.now(), config = CONNECTIONS_CONFIG } = {}) {
  const conn = connectionById(id, config);
  if (!conn || conn.direction !== 'inbound') throw new Error(`No inbound connection ${id}.`);
  return {
    id: conn.id, connection_id: conn.id, label: conn.label, mock: false, sandbox: conn.sandbox === true,
    readiness: () => readiness(conn, env),
    // params: values for the endpoint's {placeholders} and query (e.g. { consultant_id }). Read-only: a GET, never a write.
    async read(params = {}) {
      const r = readiness(conn, env);
      if (!r.eligible) return fail(`CONNECTION_NOT_READY:${r.reasons[0]}`.slice(0, 80), false, { reasons: r.reasons });
      const ep = conn.endpoints.read, timeoutMs = conn.timeout_ms ?? config.defaults?.timeout_ms ?? 8000;
      if (String(ep.method).toUpperCase() !== 'GET') return fail('INBOUND_MUST_BE_GET');
      let url;
      try {
        const query = Object.fromEntries(Object.entries(ep.query || {}).map(([k, p]) => [k, params[p]]));
        url = urlFor(conn, env, ep, params, query);
      } catch (e) { return fail(/^[A-Z_]+$/.test(e.message) ? e.message : 'REQUEST_ERROR'); }
      const x = await exchange(conn, env, { method: 'GET', url, headers: {}, timeoutMs, fetcher, now });
      if (x.early) return x.early;
      if (x.res.status === 404) return { ok: true, found: false, model_fields: {}, display_fields: {}, dropped: [], mock: conn.sandbox === true, sandbox: conn.sandbox === true };
      if (x.res.status < 200 || x.res.status >= 300) return statusResult(x.res);
      const parsed = await parseJson(x.res);
      if (parsed.error) return fail(parsed.error);
      const root = conn.ack_rule?.root_path ? getPath(parsed.json, conn.ack_rule.root_path) : parsed.json;
      if ((conn.ack_rule?.required_paths || []).some(p => getPath(root, p) === undefined)) return fail('RESPONSE_MISSING_REQUIRED');
      const values = {};
      for (const [field, path] of Object.entries(conn.field_mapping)) { const v = getPath(root, path); if (v !== undefined) values[field] = v; }
      const f = filled(conn.ack_rule?.freshness_path) ? getPath(root, conn.ack_rule.freshness_path) : undefined;
      return { ok: true, found: true, ...allowlist(conn, values, config), as_of: typeof f === 'string' ? clean(f, 40) : new Date(now()).toISOString(),
        mock: conn.sandbox === true, sandbox: conn.sandbox === true };
    },
  };
}

// ---- health (manual preflight: scripts/connection_check.mjs --live; never called by the Worker) ----
// One request to the configured health endpoint. Returns the status code and the time only, never a body or a header.
export async function healthCheck(id, { env = {}, fetcher = (u, i) => fetch(u, i), now = () => Date.now(), config = CONNECTIONS_CONFIG } = {}) {
  const conn = connectionById(id, config);
  const r = readiness(conn, env, { use: 'health', ignoreAdaptersFlag: true });
  if (!r.eligible) return { ok: false, error: 'CONNECTION_NOT_READY', reasons: r.reasons };
  const ep = conn.endpoints.health, t0 = now();
  const x = await exchange(conn, env, { method: String(ep.method || 'GET').toUpperCase(), url: urlFor(conn, env, ep), headers: {}, timeoutMs: conn.timeout_ms ?? 8000, fetcher, now });
  if (x.early) return { ok: false, error: x.early.error, ms: now() - t0 };
  await x.res.body?.cancel?.().catch(() => {});
  return { ok: x.res.status >= 200 && x.res.status < 300, status: x.res.status, ms: now() - t0 };
}
