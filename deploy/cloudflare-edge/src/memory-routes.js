// Per-person memory API, served by that person's Interview Durable Object. The bank id arrives only in a header the
// Worker overwrites after verifying the sign-in (x-atlas-bank); CSRF/Origin are checked by the Worker.
import { retainItems, scrub } from './memory.js';
import { limitRoute } from './ratelimit.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function memoryRoutes(request, { storage, hs, env, fetcher = fetch }) {
  const url = new URL(request.url);
  // Same endpoint the Interview object serves (worker.js). The Worker calls it with no bank header.
  if (url.pathname === '/api/limit') return limitRoute(request, storage);
  const bank = request.headers.get('x-atlas-bank') || '', role = request.headers.get('x-atlas-role') || 'user';
  if (!bank) return json({ error: 'Sign in first.' }, 401);
  const path = url.pathname.replace(/^\/api\/memory\/?/, ''), off = (await storage.get('memoryOff')) === true;
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
      const items = retainItems(body);
      await hs.retain(bank, items);
      return json({ stored: true, documents: items.map(i => i.document_id) });
    }
    if (request.method === 'POST' && path === 'forget') {
      if (!hs) return json({ error: 'Memory is not configured.' }, 404);
      if (body.all === true) { await hs.forgetAll(bank).catch(e => { if (e.status !== 404) throw e; }); return json({ forgotten: 'all' }); }
      // A stored document id is this token. Anything else is refused before a delete.
      const id = String(body.documentId || '');
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return json({ error: 'Which memory?' }, 400);
      await hs.forgetDocument(bank, id); return json({ forgotten: id });
    }
    if (request.method === 'POST' && path === 'settings') {
      await storage.put('memoryOff', body.off === true);
      return json({ off: body.off === true });
    }
    // The switch alone, for the consent sentence (WOW_ZERO_CONFIG §3.4): DO storage only, never a Hindsight call.
    if (request.method === 'GET' && path === 'settings') return json({ off });
    if (request.method === 'GET' && path === 'test') {
      if (role !== 'admin') return json({ error: 'Admins only.' }, 403);
      const out = { hindsight: { configured: !!hs }, jev: { configured: !!env.TYPESAFE_API_KEY } };
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
