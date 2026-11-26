// F4.3 Microsoft Teams bot helpers (WOW_SPEC §F4.3): BUILT, NOT CONNECTED. No SDK. Every outbound HTTP call goes through
// an injectable `fetcher`; tests use fakes only. Nothing here sends on its own: outreach.js calls `send` only for a row an
// admin or reviewer approved, and only when teamsStatus(env) === 'connected' (never in this build: no tenant exists).
import { str, uuidish } from './util.js';

export const BOT_ISSUER = 'https://api.botframework.com'; // the only accepted issuer (Q5): no Entra first-party, no emulator
export const OPENID_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const SERVICE_HOSTS = Object.freeze(['smba.trafficmanager.net']); // extend with TEAMS_SERVICE_HOSTS (comma-separated host names)
const DAY_MS = 864e5, REFETCH_MS = 5 * 60e3, SKEW_S = 300, MAX_BODY = 262144, LINK_MAX = 2048;
const SCOPE = 'https://api.botframework.com/.default', RETRY = new Set([429, 412, 502, 504]);
const enc = new TextEncoder(), dec = new TextDecoder();

// The bot's app id: TEAMS_BOT_APP_ID, which defaults to TEAMS_APP_ID (one app registration serves both; WOW_ZERO_CONFIG §4).
export const botAppId = (env = {}) => String(env.TEAMS_BOT_APP_ID || env.TEAMS_APP_ID || '');
// 'connected' once the app id, the tenant id and the bot secret are all present (no separate on switch; WOW_ZERO_CONFIG
// §4); anything else is BLOCKED_EXTERNAL.
export function teamsStatus(env = {}) {
  return !!env.TEAMS_APP_ID && !!env.TEAMS_TENANT_ID && !!env.TEAMS_BOT_SECRET ? 'connected' : 'BLOCKED_EXTERNAL'; // the bot id defaults to the app id
}

const hostsOf = env => [...SERVICE_HOSTS, ...String(env?.TEAMS_SERVICE_HOSTS || '').toLowerCase().split(',').map(h => h.trim()).filter(h => /^[a-z0-9.-]+$/.test(h))];
// The serviceUrl as a base ending in '/', when it is https on an allow-listed host; else ''.
// A query or a fragment is not part of that base. Appending the activities path
// would otherwise land in the query or the fragment, and the post would miss the conversation.
function serviceBase(value, env) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    if (!hostsOf(env).includes(u.hostname.toLowerCase())) return '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    if (u.search || u.hash || u.href.includes('?') || u.href.includes('#')) return '';
    return u.href;
  } catch { return ''; }
}
const b64url = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));

// ---- Signing keys: OpenID metadata + JWKS, cached per isolate for 24 h. A refetch (expired cache or unknown kid) is
// attempted at most once per 5 minutes, whatever the outcome, so a flood of bad kids never becomes a flood of fetches.
let cache = { at: -Infinity, tried: -Infinity, keys: [], crypto: new Map() };
export function resetBotKeyCache() { cache = { at: -Infinity, tried: -Infinity, keys: [], crypto: new Map() }; } // tests only
async function fetchJson(fetcher, url) {
  const r = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function refresh(fetcher, now) {
  const meta = await fetchJson(fetcher, OPENID_URL), u = new URL(String(meta?.jwks_uri || ''));
  if (u.protocol !== 'https:' || !(u.hostname === 'login.botframework.com' || u.hostname.endsWith('.botframework.com'))) throw new Error('Unexpected jwks_uri host.');
  const jwks = await fetchJson(fetcher, u.href);
  const keys = (Array.isArray(jwks?.keys) ? jwks.keys : []).filter(k => k && k.kty === 'RSA' && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string')
    .map(k => ({ kid: k.kid, jwk: { kty: 'RSA', n: k.n, e: k.e }, endorsements: Array.isArray(k.endorsements) ? k.endorsements.map(String) : [] }));
  cache = { ...cache, at: now, keys, crypto: new Map() };
}
async function keyFor(kid, fetcher, now) {
  const find = () => cache.keys.find(k => k.kid === kid) || null;
  if ((now - cache.at >= DAY_MS || !find()) && now - cache.tried >= REFETCH_MS) {
    cache.tried = now;
    try { await refresh(fetcher, now); } catch { /* keep the previous keys */ }
  }
  const k = find();
  if (k && !cache.crypto.has(k.kid)) cache.crypto.set(k.kid, await crypto.subtle.importKey('jwk', k.jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  return k ? { ...k, key: cache.crypto.get(k.kid) } : null;
}

// Bot Framework connector authentication (WOW_SPEC §F4.3, checks 1-9). PURE apart from the key cache: no dedupe, no
// storage, no side effect. Returns {ok: true, status: 200, activity, claims} or {ok: false, status, error}.
export async function verifyBotActivity(request, bodyText, env = {}, fetcher = (...a) => fetch(...a), { now = Date.now() } = {}) {
  const deny = (status, error) => ({ ok: false, status, error });
  const text = String(bodyText ?? '');
  if (enc.encode(text).length > MAX_BODY) return deny(413, 'Request too large.');                                       // 9
  if (!botAppId(env) || !env.TEAMS_TENANT_ID) return deny(503, 'Teams is not configured.');
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') || '');  // 1
  if (!m) return deny(401, 'A Bot Framework bearer token is required.');
  let header, payload, signature;
  try { header = JSON.parse(dec.decode(b64url(m[1]))); payload = JSON.parse(dec.decode(b64url(m[2]))); signature = b64url(m[3]); } catch { return deny(401, 'Malformed token.'); }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !payload || typeof payload !== 'object') return deny(401, 'Unsupported token.');
  const key = await keyFor(header.kid, fetcher, now);                                                                    // 2, 3
  if (!key) return cache.keys.length ? deny(401, 'Unknown signing key.') : deny(503, 'Bot Framework signing keys are unavailable.');
  let valid = false;
  try { valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key.key, signature, enc.encode(m[1] + '.' + m[2])); } catch { valid = false; }
  if (!valid) return deny(401, 'Bad token signature.');
  const t = now / 1000, aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];                                  // 4
  if (payload.iss !== BOT_ISSUER) return deny(401, 'Wrong token issuer.');
  if (!aud.includes(botAppId(env))) return deny(401, 'Wrong token audience.');
  if (typeof payload.exp !== 'number' || payload.exp + SKEW_S < t) return deny(401, 'Expired token.');
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - SKEW_S > t)) return deny(401, 'Token not yet valid.');
  let activity;
  try { activity = JSON.parse(text); } catch { return deny(400, 'Invalid JSON.'); }
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return deny(400, 'Invalid activity.');
  const claimUrl = payload.serviceurl ?? payload.serviceUrl;                                                            // 5
  if (typeof claimUrl !== 'string' || claimUrl !== activity.serviceUrl) return deny(401, 'The serviceUrl claim does not match the activity.');
  if (!serviceBase(claimUrl, env)) return deny(401, 'The serviceUrl host is not allowed.');
  if (activity.channelId !== 'msteams' || !key.endorsements.includes('msteams')) return deny(403, 'Only the Microsoft Teams channel is accepted.');  // 6
  if (activity.recipient?.id !== '28:' + botAppId(env)) return deny(403, 'The activity is not addressed to this bot.');                     // 7
  const tenant = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId;                                    // 8
  if (typeof tenant !== 'string' || tenant.toLowerCase() !== String(env.TEAMS_TENANT_ID).toLowerCase()) return deny(403, 'Wrong tenant.');
  return { ok: true, status: 200, activity, claims: payload };
}

// ---- Outbound client (only when connected): tenant-specific client-credentials token cached until exp - 300 s;
// POST {serviceUrl}v3/conversations/{id}/activities; 429/412/502/504 retried at most twice with backoff. The activity
// is built from the approved row only (no random parts), so a retry resends the same content.
export function teamsClient(env = {}, fetcher = (...a) => fetch(...a), { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (teamsStatus(env) !== 'connected') return null;
  let token = null;
  const retrying = async make => {
    for (let attempt = 0; ; attempt++) {
      const r = await make();
      if (!RETRY.has(r.status) || attempt >= 2) return r;
      const after = Number(r.headers.get('Retry-After'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 500 * 2 ** attempt);
    }
  };
  const failure = async (r, what) => { const j = await r.json().catch(() => ({})); return Object.assign(new Error(`${what}: HTTP ${r.status}`), { status: r.status, code: String(j?.error?.code || j?.error || '') }); };
  async function bearer() {
    if (token && now() < token.exp - 300e3) return token.value;
    const r = await retrying(() => fetcher(`https://login.microsoftonline.com/${encodeURIComponent(env.TEAMS_TENANT_ID)}/oauth2/v2.0/token`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: botAppId(env), client_secret: env.TEAMS_BOT_SECRET, scope: SCOPE }).toString() }));
    if (!r.ok) throw await failure(r, 'Teams token');
    const j = await r.json();
    if (typeof j?.access_token !== 'string' || !j.access_token) throw Object.assign(new Error('Teams token: no access_token'), { status: 502 });
    token = { value: j.access_token, exp: now() + Math.max(0, Number(j.expires_in) || 0) * 1000 };
    return token.value;
  }
  const target = (ref, path) => {
    const base = serviceBase(ref?.serviceUrl, env), conv = str(ref?.conversationId, 512);
    if (!base || !conv) throw Object.assign(new Error('The conversation reference is not allowed.'), { status: 400 });
    return `${base}v3/conversations/${encodeURIComponent(conv)}${path}`;
  };
  return {
    async send(ref, activity) {
      const url = target(ref, '/activities'), body = JSON.stringify(activity);
      const r = await retrying(async () => fetcher(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Bearer ' + await bearer(), 'Content-Type': 'application/json' }, body }));
      if (!r.ok) throw await failure(r, 'Teams send');
      const j = await r.json().catch(() => ({}));
      return { id: str(j?.id, 200) };
    },
    // Member lookup at install time, for routing outreach by email only (never for authorisation).
    async member(ref, userId) {
      const url = target(ref, '/members/' + encodeURIComponent(str(userId, 256)));
      const r = await retrying(async () => fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + await bearer() } }));
      if (!r.ok) throw await failure(r, 'Teams member');
      const j = await r.json().catch(() => ({}));
      return { email: String(j?.email || j?.userPrincipalName || '') };
    },
  };
}

// ---- Adaptive Cards 1.5. Callers pass masked text only (project references go through the record masking).
const originOf = v => { try { const o = new URL(String(v)).origin; return /^https?:\/\//.test(o) ? o : ''; } catch { return ''; } };
const hex32 = v => { const s = uuidish(v).replace(/-/g, ''); return s.length === 32 ? s : ''; };
const card = (body, actions) => ({ type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.5', body, ...(actions.length ? { actions } : {}) });
const block = (text, extra = {}) => ({ type: 'TextBlock', text, wrap: true, ...extra });
const link = url => (url && url.length <= LINK_MAX ? url : '');

// The interview invitation card: "Start now" opens /go/invitation/<id>, which survives an interactive sign-in and lands on
// #invitation/<id> (T4 handles the hash);
// "Tomorrow" and "Not for this project" are Action.Execute verbs carrying only the outreach id.
export function interviewCard({ invitationId, outreachId, projectRef, approverName, origin, note } = {}) {
  const o = originOf(origin), id = hex32(invitationId), ref = str(projectRef, 80) || 'your recent project', data = { outreachId: str(outreachId, 64) };
  const url = link(o && id ? `${o}/go/invitation/${id}` : '') || link(o ? o + '/' : '');
  const body = [block("12 minutes while it's fresh?", { size: 'Medium', weight: 'Bolder' }),
    block(`A short voice interview about ${ref}, so the work can be reused as a project reference.`)];
  if (str(approverName, 200)) body.push(block(`Approved by ${str(approverName, 200)}.`, { isSubtle: true, size: 'Small' }));
  if (str(note, 200)) body.push(block(str(note, 200), { isSubtle: true }));
  const actions = [...(url ? [{ type: 'Action.OpenUrl', title: 'Start now', url }] : []),
    { type: 'Action.Execute', title: 'Tomorrow', verb: 'snooze', data }, { type: 'Action.Execute', title: 'Not for this project', verb: 'decline', data }];
  return card(body, actions);
}

// A plain card: a title, optional text and optional link (gap requests, confirmations, action results).
export function messageCard({ title, text, url, label } = {}) {
  const u = link(/^https?:\/\//.test(String(url || '')) ? String(url) : '');
  const body = [block(str(title, 200) || 'ATLAS', { weight: 'Bolder' }), ...(str(text, 300) ? [block(str(text, 300))] : [])];
  return card(body, u ? [{ type: 'Action.OpenUrl', title: str(label, 40) || 'Open ATLAS', url: u }] : []);
}
