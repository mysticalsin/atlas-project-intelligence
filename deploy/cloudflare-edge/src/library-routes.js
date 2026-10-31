// HTTP surface of the reference library, run inside the LibraryStore Durable Object. Identity arrives only in
// headers the Worker overwrites after verifying the sign-in (x-atlas-user, x-atlas-role, x-atlas-email); CSRF and
// Origin are checked by the Worker before forwarding. Feature words go through the READY-gated registry
// (features.js) before the generic /:id routes; `env` is the LibraryStore DO's own env (vars and bindings).
import { featureRoutes } from './features.js';
import * as outreach from './outreach.js';
import * as profile from './profile.js';
import * as evidence from './evidence.js';
import * as branches from './branches.js';
import * as privacy from './privacy.js';
import { internalRoutes as privacyInternal } from './privacy-routes.js';
import * as retention from './retention.js';
import { holdRoutes } from './subject-rights.js';
import { enforce } from './ratelimit.js';
import { secEvent } from './security-log.js';
import { obj } from './util.js';
import * as ks from './kill-switches.js';
export const SYSTEM = { email: 'atlas', role: 'admin' }; // automatic review after a save
// A rating engine exists: the review agent, or JEV with a key (docs/JEV_RATING.md §6.5).
const canRate = lib => !!(lib.complete || lib.rater?.available());

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// X1 (red L1): the model-calling and personal routes of the feature modules, limited per person in the Durable Object STORAGE (ratelimit.js), not only in this isolate's memory
// (util.rateLimit resets whenever the object is evicted). The in-module limits stay as a second, tighter-grained guard.
const persistentLimit = (method, parts) => {
  if (method !== 'POST') return null;
  const [word, id, action] = parts;
  if (word === 'ask' && parts.length === 1) return 'ask';
  if (word === 'people' && id === 'lookup') return 'people';
  if (word !== 'bids') return null;
  if (parts.length === 1) return 'bid-create';
  return parts.length === 3 ? { requirements: 'bid-edit', match: 'bid-match', onepager: 'onepager' }[action] || null : null;
};

export async function libraryRoutes(request, lib, { waitUntil = p => p, env = {}, storage = null } = {}) {
  // idp: the sign-in name claims (x-atlas-idp, always written by the Worker from the verified token; WOW_ZERO_CONFIG §5.5).
  const url = new URL(request.url), user = { email: request.headers.get('x-atlas-user') || '', mail: (request.headers.get('x-atlas-email') || '').toLowerCase(), role: request.headers.get('x-atlas-role') || 'user',
    idp: profile.idpClaims(request.headers.get('x-atlas-idp')), subj: privacy.subjectOf(request.headers.get('x-atlas-subj')) };
  if (!user.email) return json({ error: 'Sign in first.' }, 401);
  const parts = url.pathname.replace(/^\/api\/library\/?/, '').split('/').filter(Boolean), method = request.method;
  let body = {};
  if (method === 'POST') { try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); } }
  const ctx = { request, url, method, parts, body, user, lib, env, waitUntil, storage };
  // Per-person rate limit on the costly and the personal routes (ratelimit.js enforce, in this Durable Object's storage); a refusal is a 429 and a numbers-only security event.
  const limited = async name => {
    if (!storage || user.role === 'system') return null;
    const refused = await enforce(storage, name, user.subj || user.email);
    if (refused) await secEvent(env, 'rate_limited', { route: url.pathname, method, status: 429, reason: 'RATE:' + name.toUpperCase().replace(/-/g, '_'), subj: user.subj, role: user.role, bucket: name });
    return refused;
  };
  try {
    // The privacy surface (consent receipts, export, erasure, flags): only the Worker and the person's Interview Durable Object reach it.
    if (url.pathname.startsWith('/api/privacy/')) { const r = await privacyInternal(ctx); return r.response || json(r.body, r.status || 200); }
    // External confirmers reach feature words only (the registry limits them to `confirmations`); nothing else.
    if (user.role === 'external') { const r = await featureRoutes(ctx); return r ? json(r.body, r.status || 200) : json({ error: 'Not found.' }, 404); }
    // Evidence store (T13): /api/library/evidence/... from a browser, /api/evidence/... only from the Interview DO (never forwarded by the Worker).
    const ev = evidence.target(url.pathname);
    if (ev) { const r = user.role === 'system' ? null : await evidence.routes({ ...ctx, rest: ev.rest, internal: ev.internal }); return json(r ? r.body : { error: 'Not found.' }, r ? r.status || 200 : 404); }
    if (!parts.length && method === 'GET') return json(lib.list(user, Object.fromEntries(url.searchParams)));
    // X1 (red L12): free-text search travels in a POST body, never in a URL (a query string lands in access logs). The GET above stays for the plain filters.
    if (method === 'POST' && parts.length === 1 && parts[0] === 'search') return json(lib.list(user, obj(body)));
    if (!parts.length && method === 'POST') {
      { const refused = await limited('upsert'); if (refused) return refused; }
      const saved = await lib.upsert(user, body);
      if (!saved.unchanged && canRate(lib)) waitUntil(lib.review(SYSTEM, saved.id, { budget: 'background', waitUntil }).catch(() => {})); // automatic quality review
      return json(saved, saved.unchanged ? 200 : 201);
    }
    const [id, action, arg] = parts;
    // System calls (set only by the Worker's trigger endpoint or its daily cron).
    if (user.role === 'system') {
      if (method === 'POST' && id === 'trigger') return json(outreach.onTrigger(lib, user.email, body), 201);
      if (method === 'POST' && id === 'scan-stale') {
        // X1 (red M3): READ_ONLY freezes the cron. The chain check (worker.js) has already run; nothing else here may write: no stale-reference invitations, no retention erasure, no audit
        // re-seal, no profile or outreach housekeeping, no destination retries.
        if (ks.readOnly(env)) { await secEvent(env, 'kill_switch', { route: url.pathname, method, status: 200, reason: 'READ_ONLY', role: 'system' }); return json({ readOnly: true, skipped: ['scanStale', 'retention', 'outreach', 'profile', 'branches'] }); }
        const swept = { invited: lib.scanStale(), ...outreach.daily(lib), ...(profile.READY ? profile.daily(lib) : {}) };
        const kept = retention.sweep(lib); // G2: the retention schedule (counts only; absent on a quiet day)
        if (kept.auditHead) { await secEvent(env, 'audit_chain_ok', { reason: 'CHAIN_RESEALED', n: kept.auditRows || 0, head: String(kept.auditHead).slice(0, 16), prev: String(kept.auditPreviousHead || '').slice(0, 16) }); delete kept.auditHead; delete kept.auditPreviousHead; }
        if (kept.auditRefused) { await secEvent(env, 'audit_chain_break', { reason: 'REWRITE_REFUSED', n: kept.auditRefused.brokenSeq }); delete kept.auditRefused; }
        if (Object.keys(kept).length) swept.retention = kept;
        branches.configure(lib, { env }); await branches.pump(evidence.evidence(lib)).catch(() => {}); // due destination retries (T15); a no-op unless ATLAS_ADAPTERS=mock
        return json(swept);
      }
      const sys = await featureRoutes(ctx);
      if (sys) return json(sys.body, sys.status || 200);
      return json({ error: 'Not found.' }, 404);
    }
    if (id === 'privacy') { const h = holdRoutes(ctx); return json(h.body, h.status || 200); } // the DPO's list of what erasure held back (admin only)
    { const name = persistentLimit(method, parts); if (name) { const refused = await limited(name); if (refused) return refused; } }
    const f = await featureRoutes(ctx);
    if (f) return json(f.body, f.status || 200);
    if (method === 'POST' && id === 'recommend') { const refused = await limited('recommend'); if (refused) return refused; return json(await lib.recommend(user, body)); }
    if (method === 'POST' && id === 'merge') {
      { const refused = await limited('upsert'); if (refused) return refused; }
      const saved = await lib.merge(user, body); if (canRate(lib)) waitUntil(lib.review(SYSTEM, saved.id, { budget: 'background', waitUntil }).catch(() => {})); return json(saved); }
    if (method === 'GET' && id === 'analytics') return json(lib.analytics(user));
    if (method === 'POST' && id === 'insights') { const refused = await limited('insights'); if (refused) return refused; return json(await lib.insights(user)); }
    if (method === 'GET' && id === 'export') { const refused = await limited('export'); if (refused) return refused; return json(lib.exportAll(user)); }
    if (method === 'POST' && id === 'import') { const refused = await limited('import'); if (refused) return refused; const out = await lib.importAll(user, body); return json(out); }
    if (id === 'invitations') {
      if (method === 'GET' && !action) return json({ items: lib.invitations({ ...user, all: url.searchParams.get('all') === '1' }) });
      if (method === 'POST' && !action) { if (!['admin', 'reviewer'].includes(user.role)) return json({ error: 'Only a reviewer can schedule interviews for others.' }, 403); return json(lib.invite(user.email, body), 201); }
      if (method === 'POST' && action) return json(lib.updateInvitation(user, action, body));
    }
    if (method === 'POST' && action === 'slides') { const refused = await limited('slides'); if (refused) return refused; return json(await lib.slides(user, id, body)); }
    if (method === 'GET' && !action) return json(lib.get(user, id, { audit: true }));
    if (method === 'GET' && action === 'revisions' && arg) return json(lib.revision(user, id, arg));
    // "Rate again" (and the consent "Allow"): a person is waiting; a second opinion continues in waitUntil.
    if (method === 'POST' && action === 'review') { const refused = await limited('review'); if (refused) return refused; return json(await lib.review(user, id, { budget: 'interactive', waitUntil })); }
    // G2: the owner's explicit "Submit for review": the one way out of a private draft. Only then does the automatic quality review start.
    if (method === 'POST' && action === 'submit') {
      { const refused = await limited('submit'); if (refused) return refused; }
      const done = lib.submit(user, id);
      if (!done.unchanged && canRate(lib)) waitUntil(lib.review(SYSTEM, id, { budget: 'background', waitUntil }).catch(() => {}));
      return json(done);
    }
    if (method === 'POST' && action === 'validate') return json(lib.validate(user, id, body));
    if (method === 'POST' && action === 'withdraw') return json(lib.withdraw(user, id, body));
    if (method === 'POST' && action === 'reinstate') return json(lib.reinstate(user, id));
    return json({ error: 'Not found.' }, 404);
  } catch (e) {
    return e.status ? json({ error: e.message, ...(e.reason ? { reason: e.reason } : {}) }, e.status) : json({ error: 'The library could not complete that request.' }, 500);
  }
}
