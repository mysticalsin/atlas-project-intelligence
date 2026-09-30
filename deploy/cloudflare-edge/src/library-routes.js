// HTTP surface of the reference library, run inside the LibraryStore Durable Object. Identity arrives only in
// headers the Worker overwrites after verifying the sign-in (x-atlas-user, x-atlas-role, x-atlas-email); CSRF and
// Origin are checked by the Worker before forwarding. Feature words go through the READY-gated registry
// (features.js) before the generic /:id routes; `env` is the LibraryStore DO's own env (vars and bindings).
import { featureRoutes } from './features.js';
import * as outreach from './outreach.js';
import * as profile from './profile.js';
export const SYSTEM = { email: 'atlas', role: 'admin' }; // automatic review after a save
// A rating engine exists: the review agent, or JEV with a key (docs/JEV_RATING.md §6.5).
const canRate = lib => !!(lib.complete || lib.rater?.available());

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function libraryRoutes(request, lib, { waitUntil = p => p, env = {} } = {}) {
  // idp: the sign-in name claims (x-atlas-idp, always written by the Worker from the verified token; WOW_ZERO_CONFIG §5.5).
  const url = new URL(request.url), user = { email: request.headers.get('x-atlas-user') || '', mail: (request.headers.get('x-atlas-email') || '').toLowerCase(), role: request.headers.get('x-atlas-role') || 'user',
    idp: profile.idpClaims(request.headers.get('x-atlas-idp')) };
  if (!user.email) return json({ error: 'Sign in first.' }, 401);
  const parts = url.pathname.replace(/^\/api\/library\/?/, '').split('/').filter(Boolean), method = request.method;
  let body = {};
  if (method === 'POST') { try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); } }
  const ctx = { request, url, method, parts, body, user, lib, env, waitUntil };
  try {
    // External confirmers reach feature words only (the registry limits them to `confirmations`); nothing else.
    if (user.role === 'external') { const r = await featureRoutes(ctx); return r ? json(r.body, r.status || 200) : json({ error: 'Not found.' }, 404); }
    if (!parts.length && method === 'GET') return json(lib.list(user, Object.fromEntries(url.searchParams)));
    if (!parts.length && method === 'POST') {
      const saved = await lib.upsert(user, body);
      if (!saved.unchanged && canRate(lib)) waitUntil(lib.review(SYSTEM, saved.id, { budget: 'background', waitUntil }).catch(() => {})); // automatic quality review
      return json(saved, saved.unchanged ? 200 : 201);
    }
    const [id, action, arg] = parts;
    // System calls (set only by the Worker's trigger endpoint or its daily cron).
    if (user.role === 'system') {
      if (method === 'POST' && id === 'trigger') return json(outreach.onTrigger(lib, user.email, body), 201);
      if (method === 'POST' && id === 'scan-stale') return json({ invited: lib.scanStale(), ...outreach.daily(lib), ...(profile.READY ? profile.daily(lib) : {}) });
      const sys = await featureRoutes(ctx);
      if (sys) return json(sys.body, sys.status || 200);
      return json({ error: 'Not found.' }, 404);
    }
    const f = await featureRoutes(ctx);
    if (f) return json(f.body, f.status || 200);
    if (method === 'POST' && id === 'recommend') return json(await lib.recommend(user, body));
    if (method === 'POST' && id === 'merge') { const saved = await lib.merge(user, body); if (canRate(lib)) waitUntil(lib.review(SYSTEM, saved.id, { budget: 'background', waitUntil }).catch(() => {})); return json(saved); }
    if (method === 'GET' && id === 'analytics') return json(lib.analytics(user));
    if (method === 'POST' && id === 'insights') return json(await lib.insights(user));
    if (method === 'GET' && id === 'export') return json(lib.exportAll(user));
    if (method === 'POST' && id === 'import') { const out = await lib.importAll(user, body); return json(out); }
    if (id === 'invitations') {
      if (method === 'GET' && !action) return json({ items: lib.invitations({ ...user, all: url.searchParams.get('all') === '1' }) });
      if (method === 'POST' && !action) { if (!['admin', 'reviewer'].includes(user.role)) return json({ error: 'Only a reviewer can schedule interviews for others.' }, 403); return json(lib.invite(user.email, body), 201); }
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
    return e.status ? json({ error: e.message }, e.status) : json({ error: 'The library could not complete that request.' }, 500);
  }
}
