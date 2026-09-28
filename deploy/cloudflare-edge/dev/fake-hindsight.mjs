// In-memory stand-in for the Hindsight HTTP API used by local runs and browser tests (same paths and shapes as
// @vectorize-io/hindsight-client 0.10.1). Recall returns stored sentences that share words with the query.
export function fakeHindsight() {
  const banks = new Map(), bank = id => { if (!banks.has(id)) banks.set(id, new Map()); return banks.get(id); };
  const words = t => new Set(String(t).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  return async (url, init = {}) => {
    if ((init.headers?.Authorization || '') !== 'Bearer local-hindsight-key') return new Response('{}', { status: 401 });
    const u = new URL(url), m = u.pathname.match(/^\/v1\/default\/banks\/([^/]+)(\/.*)?$/), body = init.body ? JSON.parse(init.body) : {};
    if (!m) return new Response('{}', { status: 404 });
    const id = decodeURIComponent(m[1]), rest = m[2] || '', b = bank(id), ok = x => new Response(JSON.stringify(x));
    if (init.method === 'PUT' && !rest) return ok({ bank_id: id });
    if (init.method === 'DELETE' && !rest) { const n = b.size; banks.delete(id); return ok({ success: true, deleted_count: n }); }
    if (init.method === 'POST' && rest === '/memories') { for (const it of body.items || []) b.set(it.document_id || crypto.randomUUID(), { content: it.content, tags: it.tags || [], updated_at: it.timestamp || new Date().toISOString() }); return ok({ success: true, items_count: (body.items || []).length }); }
    if (init.method === 'POST' && rest === '/memories/recall') {
      const q = words(body.query), results = [];
      for (const [doc, d] of b) { if (body.tags && !d.tags.some(t => body.tags.includes(t)) && d.tags.length) continue;
        for (const line of d.content.split('\n')) { const w = words(line); let n = 0; for (const x of q) if (w.has(x)) n++; if (n >= 2) results.push({ text: line, tags: d.tags, document_id: doc, mentioned_at: d.updated_at }); } }
      return ok({ results: results.slice(0, 8) });
    }
    if (init.method === 'GET' && rest === '/documents') return ok({ items: [...b].map(([doc, d]) => ({ id: doc, updated_at: d.updated_at, memory_unit_count: d.content.split('\n').length, tags: d.tags })) });
    if (init.method === 'DELETE' && rest.startsWith('/documents/')) { b.delete(decodeURIComponent(rest.slice(11))); return ok({ success: true }); }
    if (init.method === 'GET' && rest === '/stats') return ok({ documents: b.size });
    return new Response('{}', { status: 404 });
  };
}
