// Per-person memory API, served by that person's Interview Durable Object. The bank id arrives only in a header the
// Worker overwrites after verifying the sign-in (x-atlas-bank); CSRF/Origin are checked by the Worker.
import { retainItems, scrub } from './memory.js';
import * as privacy from './privacy.js';
import { RETENTION } from './policy.generated.js';
import { who } from './me-routes.js';
import { aiOff } from './kill-switches.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const retentionDays = () => RETENTION.categories.find(c => c.id === 'memory')?.days || 365;
// Forgets this person's memory documents last updated before the cutoff (a per-person prune; a bank-wide sweep would need a list of every bank).
async function prune(hs, bank, days, now = Date.now()) {
  const raw = await hs.documents(bank), list = raw.items || raw.documents || raw.results || [];
  for (const d of Array.isArray(list) ? list : []) {
    const at = Date.parse(d.updated_at || d.created_at || ''), id = String(d.id || d.document_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
    if (id && Number.isFinite(at) && now - at > days * 864e5) await hs.forgetDocument(bank, id).catch(() => {});
  }
}
export async function memoryRoutes(request, { storage, hs, env, fetcher = fetch }) {
  const url = new URL(request.url), bank = request.headers.get('x-atlas-bank') || '', role = request.headers.get('x-atlas-role') || 'user';
  if (!bank) return json({ error: 'Sign in first.' }, 401);
  // Private memory is OFF until the person turns it on (the memory consent purpose, privacy.js): `off` is true by default, and also while they have restricted or objected to it.
  const path = url.pathname.replace(/^\/api\/memory\/?/, ''), state = await privacy.loadState(storage), off = !privacy.memoryAllowed(state);
  let body = {};
  if (request.method === 'POST') { try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); } }
  try {
    if (request.method === 'GET' && !path) {
      if (!hs) return json({ enabled: false, off, documents: [] });
      const raw = await hs.documents(bank).catch(() => ({})), list = raw.items || raw.documents || raw.results || [];
      return json({ enabled: true, off, documents: (Array.isArray(list) ? list : []).slice(0, 100).map(d => ({ id: String(d.id || d.document_id || ''), updatedAt: d.updated_at || d.created_at || '', memories: d.memory_unit_count ?? null, tags: d.tags || [] })).filter(d => d.id) });
    }
    if (request.method === 'POST' && path === 'remember') {
      if (!hs) return json({ stored: false, reason: 'Memory is not configured.' });
      if (off) return json({ stored: false, reason: 'Memory is switched off.' });
      if (aiOff(env)) return json({ stored: false, reason: 'The AI features are paused by the ATLAS owner.' }); // X1 (red M2)
      const items = retainItems(body); // short structured facts only; the raw conversation field, if a page still sends it, is ignored
      await hs.retain(bank, items);
      await prune(hs, bank, retentionDays()).catch(() => {}); // the retention proposal for memory (retention.json): old documents of THIS person are forgotten as it is used
      return json({ stored: true, documents: items.map(i => i.document_id) });
    }
    if (request.method === 'POST' && path === 'forget') {
      if (!hs) return json({ error: 'Memory is not configured.' }, 404);
      if (body.all === true) { await hs.forgetAll(bank).catch(e => { if (e.status !== 404) throw e; }); return json({ forgotten: 'all' }); }
      const id = String(body.documentId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
      if (!id) return json({ error: 'Which memory?' }, 400);
      await hs.forgetDocument(bank, id); return json({ forgotten: id });
    }
    if (request.method === 'POST' && path === 'settings') {
      // Turning memory on grants the memory purpose, turning it off withdraws it: each a receipt (privacy.js), all or nothing.
      if (body.off === false && state.blocked?.memory) return json({ error: 'Memory stays off while you have restricted or objected to it. Lift that first.' }, 409);
      try { const r = await privacy.recordConsent(storage, env, who(request), { memory: body.off === false }, { channel: 'profile' }); return json({ off: !privacy.memoryAllowed(r.state) }); }
      catch { return json({ error: 'Your choice could not be recorded, so nothing changed. Please try again.' }, 502); }
    }
    // The switch alone, for the consent sentence (WOW_ZERO_CONFIG §3.4): DO storage only, never a Hindsight call.
    if (request.method === 'GET' && path === 'settings') return json({ off });
    if (request.method === 'GET' && path === 'test') {
      if (role !== 'admin') return json({ error: 'Admins only.' }, 403);
      const out = { hindsight: { configured: !!hs }, jev: { configured: !!env.TYPESAFE_API_KEY } };
      if (aiOff(env)) return json({ ...out, aiOff: true, note: 'The AI features are paused by the ATLAS owner; no probe was sent.' }); // X1 (red M2): the health probes are model calls too
      if (hs) { const t0 = Date.now(); try { await hs.ensureBank(bank); await hs.stats(bank); out.hindsight.ok = true; } catch (e) { out.hindsight.ok = false; out.hindsight.error = e.status === 402 ? 'no credits: add credits in Hindsight Cloud → Billing' : e.status === 401 || e.status === 403 ? 'key rejected: create a new key under Connect → Create API Key' : e.message; } out.hindsight.ms = Date.now() - t0; }
      if (env.TYPESAFE_API_KEY) {
        const t0 = Date.now();
        try {
          const r = await fetcher('https://api.typesafe.ai/v1/systemone', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + env.TYPESAFE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: env.JEV_MODEL || 'jev-latest', state: { text: 'The consultant cut claim triage time from 40 to 12 minutes.' }, questions: { ok: { type: 'noul', instructions: 'Does `text` describe a measurable result?' } } }) });
          const a = r.ok ? (await r.json())?.answers?.ok : null;
          out.jev.ok = typeof a?.noul === 'number'; if (!r.ok) out.jev.error = r.status === 401 || r.status === 403 ? 'key rejected' : r.status === 402 || r.status === 429 ? 'no credits or rate limited' : 'HTTP ' + r.status;
        } catch (e) { out.jev.ok = false; out.jev.error = e.message; }
        out.jev.ms = Date.now() - t0;
      }
      return json(out);
    }
    return json({ error: 'Not found.' }, 404);
  } catch (e) {
    return json({ error: e.status && e.status < 500 ? e.message : 'Memory is unavailable right now.' }, e.status === 400 ? 400 : 502);
  }
}
export { scrub };
