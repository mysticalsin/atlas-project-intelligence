// The person's own Interview Durable Object, in the data subject rights (v2.2 G2): consent state, the interview kept for resuming, private memory. The Worker's /api/me/*
// and /api/consent call these (only the Worker can reach this path: it builds the request itself from the verified identity, and no browser route is forwarded here).
//   GET  /api/consent        the consent state in force (what the session checks), the flags that block memory
//   POST /api/consent        a change of choices {purposes: {checkpoint?, memory?, notice?}, channel}: state and receipts, all or nothing
//   POST /api/consent/block  the Worker tells this object that memory is blocked (restriction or objection) or not
//   GET  /api/me/export      the checkpoint (meta and content when present) and the private memory documents (content when the memory service gives it)
//   POST /api/me/erase-claim record a confirmation nonce as used (single-use erase tokens, X1 red L10); 409 when it was already used
//   POST /api/me/erase       purge the checkpoint, forget the whole memory bank, clear the consent state (the receipts stay in the library)
import { CheckpointStore } from './checkpoint.js';
import * as privacy from './privacy.js';
import { obj } from './util.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export const who = request => ({ user: request.headers.get('x-atlas-user') || '', role: request.headers.get('x-atlas-role') || 'user', mail: request.headers.get('x-atlas-email') || '', subj: request.headers.get('x-atlas-subj') || '' });

export async function meRoutes(request, { storage, hs, env, now = () => Date.now() }) {
  const url = new URL(request.url), id = who(request), bank = request.headers.get('x-atlas-bank') || '';
  if (!id.user) return json({ error: 'Sign in first.' }, 401);
  let body = {};
  if (request.method === 'POST') { try { body = await request.json(); } catch { body = {}; } }
  if (request.method === 'GET' && url.pathname === '/api/consent') { const state = await privacy.loadState(storage); return json({ purposes: state.purposes, blocked: state.blocked || {} }); }
  if (request.method === 'POST' && url.pathname === '/api/consent') {
    const wanted = {};
    for (const [k, v] of Object.entries(obj(obj(body).purposes))) { if (!privacy.PURPOSES.includes(k) || typeof v !== 'boolean') return json({ error: 'Unknown consent choice.' }, 400); wanted[k] = v; }
    if (wanted.memory === true && (await privacy.loadState(storage)).blocked?.memory) return json({ error: 'Memory is switched off because you restricted or objected to it. Lift that first.' }, 409);
    try {
      // The receipt's channel is the route's, never the body's (X1, red L10): this route is the person's settings, so 'profile'. The interview dialog's channel is set by the session itself.
      const r = await privacy.recordConsent(storage, env, id, wanted, { channel: 'profile' });
      return json({ purposes: r.state.purposes, changed: r.changes.map(c => ({ purpose: c.purpose, granted: c.granted })) });
    } catch { return json({ error: 'Your choice could not be recorded, so nothing changed. Please try again.' }, 502); }
  }
  if (request.method === 'POST' && url.pathname === '/api/consent/block') {
    const state = await privacy.setBlocked(storage, { memory: obj(body).memory === true });
    if (state.blocked.memory && privacy.grantedIn(state, 'memory')) {
      try { await privacy.recordConsent(storage, env, id, { memory: false }, { channel: 'api' }); } catch { /* the block alone already stops memory (memoryAllowed) */ }
    }
    return json({ blocked: state.blocked });
  }
  if (request.method === 'GET' && url.pathname === '/api/me/export') {
    const out = { exportedAt: new Date(now()).toISOString(), consent: await privacy.loadState(storage) };
    const store = new CheckpointStore(storage, { owner: id.user, now });
    try {
      const m = await store.meta();
      if (!m) out.checkpoint = null;
      else { let content = null; try { content = await store.load(m.sessionId); } catch { /* unreadable: the meta alone */ } out.checkpoint = { meta: { sessionId: m.sessionId, savedAt: m.savedAt, expiresAt: m.expiresAt, input: m.input, bytes: m.bytes }, content }; }
    } catch { out.checkpoint = { error: 'The saved interview could not be read.' }; }
    if (!hs || !bank) out.memory = { enabled: false, documents: [] };
    else {
      try {
        const raw = await hs.documents(bank), list = raw.items || raw.documents || raw.results || [];
        const docs = [];
        for (const d of (Array.isArray(list) ? list : []).slice(0, 100)) {
          const docId = String(d.id || d.document_id || ''); if (!docId) continue;
          let content = null; // best effort: the memory service's per-document read (its contract was not verified against a live account)
          if (typeof hs.document === 'function') { try { const x = await hs.document(bank, docId); content = x?.original_text ?? x?.text ?? x?.content ?? null; } catch { content = null; } }
          docs.push({ id: docId, updatedAt: d.updated_at || d.created_at || '', memories: d.memory_unit_count ?? null, tags: d.tags || [], content });
        }
        out.memory = { enabled: true, documents: docs };
      } catch { out.memory = { enabled: true, documents: [], error: 'The memory service did not answer.' }; }
    }
    return json(out);
  }
  if (request.method === 'POST' && url.pathname === '/api/me/erase-claim') {
    const nonce = String(obj(body).nonce || ''), exp = Number(obj(body).exp);
    if (!/^[0-9a-f]{16}$/.test(nonce) || !Number.isFinite(exp)) return json({ error: 'Bad request.' }, 400);
    const key = 'erase-used:' + nonce;
    if (await storage.get(key)) return json({ error: 'Already used.' }, 409);
    await storage.put(key, { exp });
    if (typeof storage.list === 'function') { // finished nonces go (a token is only valid for ten minutes)
      const all = await storage.list({ prefix: 'erase-used:', limit: 100 }), dead = [...all].filter(([, v]) => !(Number(v?.exp) > now())).map(([k]) => k);
      if (dead.length) await storage.delete(dead);
    }
    return json({ claimed: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/me/erase') {
    const out = { checkpointPurged: 0, memory: { forgotten: !hs || !bank, error: '' }, consentCleared: false };
    try { out.checkpointPurged = await new CheckpointStore(storage, { owner: id.user, now }).purge(); } catch { out.checkpointError = true; }
    if (hs && bank) { try { await hs.forgetAll(bank); out.memory.forgotten = true; } catch (e) { if (e?.status === 404) out.memory.forgotten = true; else out.memory.error = 'The memory service did not confirm. Try again.'; } }
    try { await storage.delete(['consent', 'memoryOff']); out.consentCleared = true; } catch { /* the next call retries */ }
    out.complete = !out.checkpointError && out.memory.forgotten && out.consentCleared;
    return json(out);
  }
  return json({ error: 'Not found.' }, 404);
}
