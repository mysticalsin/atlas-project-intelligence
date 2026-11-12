// The privacy surface inside the LibraryStore (v2.2 G2). Only the Worker and the person's own Interview Durable Object reach /api/privacy/* (the Worker forwards nothing
// under that path from a browser), always under the identity the Worker verified (x-atlas-user, x-atlas-subj). The browser-facing routes are the Worker's /api/me/* and
// /api/consent, which call these. Every call here is rate limited per person and leaves a numbers-only security event.
import * as privacy from './privacy.js';
import { exportMine, eraseMine } from './subject-rights.js';
import { enforce } from './ratelimit.js';
import { secEvent } from './security-log.js';
import { obj, fail } from './util.js';

const EVENT = { 'GET export': 'privacy_export', 'POST erase': 'privacy_erase', 'POST flags': 'privacy_flags', 'POST receipts': 'consent_change' };
const BUCKET = { 'GET export': 'me-export', 'POST erase': 'me-erase', 'POST flags': 'flags', 'POST receipts': 'consent' };

export async function internalRoutes(ctx) {
  const { lib, user, method, url, body, env = {}, storage } = ctx, path = url.pathname.replace(/^\/api\/privacy\/?/, '').split('/').filter(Boolean), key = method + ' ' + path[0];
  if (user.role === 'system' || user.role === 'external') throw fail(404, 'Not found.');
  privacy.ensure(lib);
  const subj = user.subj;
  if (BUCKET[key]) {
    const refused = await enforce(storage, BUCKET[key], subj || user.email);
    if (refused) { await secEvent(env, 'rate_limited', { route: url.pathname, method, status: 429, reason: 'RATE:' + BUCKET[key].toUpperCase().replace(/-/g, '_'), subj, role: user.role, bucket: BUCKET[key] }); return { status: 429, response: refused }; }
  }
  const note = async (reason, extra = {}) => secEvent(env, EVENT[key], { route: url.pathname, method, status: 200, reason, subj, role: user.role, ...extra });
  if (key === 'POST receipts') {
    if (!subj) throw fail(400, 'A subject key is required.');
    const b = obj(body), r = privacy.recordReceipts(lib, subj, b.items, { channel: b.channel });
    if (r.recorded.length) await note('CONSENT_CHANGED', { n: r.recorded.length });
    return { body: { recorded: r.recorded.length, state: r.state } };
  }
  if (key === 'GET state') { if (!subj) throw fail(400, 'A subject key is required.'); return { body: { state: privacy.stateFromReceipts(lib, subj), flags: privacy.flagsOf(lib, user.email) } }; }
  if (key === 'GET flags') return { body: privacy.flagsOf(lib, user.email) };
  if (key === 'POST flags') { const f = privacy.setFlags(lib, user.email, body, { subj }); await note('FLAGS_SET'); return { body: f }; }
  if (key === 'GET export') { if (!subj) throw fail(400, 'A subject key is required.'); const out = exportMine(lib, user, subj); await note('EXPORT_BUILT'); return { body: out }; }
  if (key === 'POST erase') {
    if (!subj) throw fail(400, 'A subject key is required.');
    if (obj(body).confirmed !== true) throw fail(400, 'Erasure needs the confirmation the Worker checks.'); // the Worker verified the confirmation token; a direct call cannot skip it
    const out = eraseMine(lib, user, subj);
    await note('ERASURE_DONE', { n: Object.values(out.counts).reduce((a, b) => a + b, 0) });
    if (out.auditHead) await secEvent(env, 'audit_chain_ok', { reason: 'CHAIN_RESEALED', n: out.counts.auditRows || 0, head: String(out.auditHead).slice(0, 16), prev: String(out.auditPreviousHead || '').slice(0, 16) });
    if (out.auditRefused) await secEvent(env, 'audit_chain_break', { reason: 'REWRITE_REFUSED', n: out.auditRefused.brokenSeq }); // the chain failed its check, so erasure did not re-seal it (X1, red M8)
    return { body: out };
  }
  throw fail(404, 'Not found.');
}
