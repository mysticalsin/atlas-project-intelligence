// HTTP surface of the reference library, run inside the LibraryStore Durable Object. Identity arrives only in
// headers the Worker overwrites after verifying the sign-in (x-atlas-user, x-atlas-role, x-atlas-email); CSRF and
// Origin are checked by the Worker before forwarding. Feature words go through the READY-gated registry
// (features.js) before the generic /:id routes; `env` is the LibraryStore DO's own env (vars and bindings).
import { featureRoutes } from './features.js';
import * as outreach from './outreach.js';
import * as profile from './profile.js';
import { adminRoutes, journeyRoutes, privacyRoutes } from './operate.js';
import { internalRoutes as privacyInternal } from './privacy-routes.js';
import { sweep as retentionSweep } from './retention.js';
import { holdRoutes } from './subject-rights.js';
import { verifyDaily } from './audit-chain.js';
import { secEvent } from './security-log.js';
import { productionDemoConflict, resolveTenantEnforcement } from './authz.js';
export const SYSTEM = { email: 'atlas', role: 'admin' }; // automatic review after a save
function scopedReviewer(user = {}) {
  return { email: 'atlas', role: 'admin', tenant: String(user.tenant || '').toLowerCase(), tenantEnforced: user.tenantEnforced === true };
}
// A rating engine exists: the review agent, or JEV with a key (docs/JEV_RATING.md §6.5).
const canRate = lib => !!(lib.complete || lib.rater?.available());
async function reportChain(lib, env) {
  try {
    const r = verifyDaily(lib.sql, lib.auditKey, lib.dbId);
    const head = String(r.head || '').slice(0, 16);
    if (r.ok) await secEvent(env, 'audit_chain_ok', { reason: 'CHAIN_VERIFIED', n: r.checked, head, legacy: r.legacyUnverified || 0 });
    else await secEvent(env, 'audit_chain_break', { reason: r.reason || 'VERIFY_FAILED', n: r.brokenSeq ?? r.checked, head });
    return r;
  } catch { await secEvent(env, 'audit_chain_break', { reason: 'VERIFY_FAILED' }); return { ok: false, reason: 'VERIFY_FAILED' }; }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Segments the library routes on. The platform URL parser has already resolved "." and "..", including "%2e".
// It keeps a trailing slash, a repeated slash, and "%2F". Empty segments are dropped here, and the words stay case-sensitive.
export function libraryParts(pathname) {
  return String(pathname || '').replace(/^\/api\/library\/?/, '').split('/').filter(Boolean);
}

// The same match the handlers use. privacyRoutes treats any later segment as POST privacy/delete.
// profile routes reject a third segment before delete, so only the two-segment form is a profile delete.
export function acceptedSubjectDelete(method, pathname) {
  if (method !== 'POST') return false;
  const parts = libraryParts(pathname);
  if (parts[0] === 'privacy' && parts[1] === 'delete') return true;
  return parts[0] === 'profile' && parts[1] === 'delete' && parts.length === 2;
}

export async function libraryRoutes(request, lib, { waitUntil = p => p, env = {}, storage = null } = {}) {
  const demoConflict = productionDemoConflict(env);
  if (demoConflict) return json(demoConflict, 503);
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/privacy/')) {
    const user = { email: request.headers.get('x-atlas-user') || '', mail: (request.headers.get('x-atlas-email') || '').toLowerCase(), role: request.headers.get('x-atlas-role') || 'user',
      tenant: request.headers.get('x-atlas-tenant') || '', tenantEnforced: resolveTenantEnforcement(env, request.headers.get('x-atlas-tenant-enforced')), subj: request.headers.get('x-atlas-subj') || '' };
    if (!user.email) return json({ error: 'Sign in first.' }, 401);
    let body = {};
    if (request.method === 'POST') { try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); } }
    try {
      const r = await privacyInternal({ lib, user, method: request.method, url, body, env, storage });
      if (r?.response) return r.response;
      return json(r.body, r.status || 200);
    } catch (e) {
      return e.status ? json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status) : json({ error: 'The library could not complete that request.' }, 500);
    }
  }
  // idp: the sign-in name claims (x-atlas-idp, always written by the Worker from the verified token; WOW_ZERO_CONFIG §5.5).
  const user = { email: request.headers.get('x-atlas-user') || '', mail: (request.headers.get('x-atlas-email') || '').toLowerCase(), role: request.headers.get('x-atlas-role') || 'user',
    tenant: request.headers.get('x-atlas-tenant') || '', tenantEnforced: resolveTenantEnforcement(env, request.headers.get('x-atlas-tenant-enforced')), idp: profile.idpClaims(request.headers.get('x-atlas-idp')) };
  if (!user.email) return json({ error: 'Sign in first.' }, 401);
  const parts = libraryParts(url.pathname), method = request.method;
  let body = {};
  if (method === 'POST') { try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); } }
  const ctx = { request, url, method, parts, body, user, lib, env, waitUntil };
  try {
    // External confirmers reach feature words only (the registry limits them to `confirmations`); nothing else.
    if (user.role === 'external') { const r = await featureRoutes(ctx); return r ? json(r.body, r.status || 200) : json({ error: 'Not found.' }, 404); }
    if (!parts.length && method === 'GET') return json(lib.list(user, Object.fromEntries(url.searchParams)));
    if (!parts.length && method === 'POST') {
      const saved = await lib.upsert(user, body);
      if (!saved.unchanged && canRate(lib)) waitUntil(lib.review(scopedReviewer(user), saved.id, { budget: 'background', waitUntil }).catch(() => {})); // automatic quality review of this tenant only
      return json(saved, saved.unchanged ? 200 : 201);
    }
    const [id, action, arg] = parts;
    // System calls (set only by the Worker's trigger endpoint or its daily cron).
    if (user.role === 'system') {
      if (user.tenantEnforced === true && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(user.tenant || ''))) {
        return json({ error: 'ATLAS_SYSTEM_TENANT is not a verified tenant id. Maintenance was not run.' }, 403);
      }
      if (method === 'POST' && id === 'trigger') return json(outreach.onTrigger(lib, user, body), 201);
      if (method === 'POST' && id === 'verify-chain') {
        const r = await reportChain(lib, env);
        return json({ verified: r.ok === true, reason: r.reason || (r.ok ? 'CHAIN_VERIFIED' : 'VERIFY_FAILED'), n: r.checked, head: String(r.head || '').slice(0, 16) });
      }
      if (method === 'POST' && id === 'scan-stale') {
        // The response is the same object main returns: scanStale, then the two dailies. Retention runs after that
        // count is taken, so an old draft is still counted as invited, and its keys are not added to the body.
        const payload = { invited: lib.scanStale(user), ...outreach.daily(lib, user), ...(profile.READY ? profile.daily(lib, lib.now(), user) : {}) };
        retentionSweep(lib, { tenant: user.tenantEnforced === true ? user.tenant : '' });
        await reportChain(lib, env);
        return json(payload);
      }
      const sys = await featureRoutes(ctx);
      if (sys) return json(sys.body, sys.status || 200);
      return json({ error: 'Not found.' }, 404);
    }
    const f = await featureRoutes(ctx);
    if (f) return json(f.body, f.status || 200);
    if (id === 'admin') { const r = await adminRoutes(ctx); return json(r.body, r.status || 200); }
    if (id === 'journey') { const r = await journeyRoutes(ctx); return json(r.body, r.status || 200); }
    if (id === 'erasure-holds') { const r = holdRoutes(ctx); return json(r.body, r.status || 200); }
    if (id === 'privacy') { const r = await privacyRoutes(ctx); return json(r.body, r.status || 200); }
    if (method === 'POST' && id === 'recommend') return json(await lib.recommend(user, body));
    if (method === 'POST' && id === 'merge') { const saved = await lib.merge(user, body); if (canRate(lib)) waitUntil(lib.review(scopedReviewer(user), saved.id, { budget: 'background', waitUntil }).catch(() => {})); return json(saved); }
    if (method === 'GET' && id === 'analytics') return json(lib.analytics(user));
    if (method === 'POST' && id === 'insights') return json(await lib.insights(user));
    if (method === 'GET' && id === 'export') return json(lib.exportAll(user));
    if (method === 'POST' && id === 'import') { const out = await lib.importAll(user, body); return json(out); }
    if (id === 'invitations') {
      if (method === 'GET' && !action) return json({ items: lib.invitations({ ...user, all: url.searchParams.get('all') === '1' }) });
      if (method === 'POST' && !action) { if (!['admin', 'reviewer'].includes(user.role)) return json({ error: 'Only a reviewer can schedule interviews for others.' }, 403); return json(lib.invite(user.email, body, user), 201); }
      if (method === 'POST' && action) return json(lib.updateInvitation(user, action, body));
    }
    if (method === 'POST' && action === 'slides') return json(await lib.slides(user, id, body));
    if (method === 'GET' && !action) return json(lib.get(user, id));
    if (method === 'GET' && action === 'revisions' && arg) return json(lib.revision(user, id, arg));
    // "Rate again" (and the consent "Allow"): a person is waiting; a second opinion continues in waitUntil.
    if (method === 'POST' && action === 'review') return json(await lib.review(user, id, { budget: 'interactive', waitUntil }));
    if (method === 'POST' && action === 'validate') return json(lib.validate(user, id, body));
    if (method === 'POST' && action === 'withdraw') return json(lib.withdraw(user, id, body));
    if (method === 'POST' && action === 'reinstate') return json(lib.reinstate(user, id));
    return json({ error: 'Not found.' }, 404);
  } catch (e) {
    return e.status ? json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status) : json({ error: 'The library could not complete that request.' }, 500);
  }
}
