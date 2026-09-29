// F6 Ask ATLAS (WOW_SPEC §F6): a typed question over the library, answered in the caller's own words.
// - Client filter, in code only: library client names found in the raw question restrict the pool to rows whose
//   client is that name AND that the caller can open fully. A name the caller has no full access to changes nothing.
// - The question is pseudonymised before any model call; retrieval follows §F1.1 (per-method floor, semantic first,
//   boosts reorder only); RERANK output is parsed strictly (null: the model did not answer; []: nothing reached 30).
// - Record text reaches the model only through recordView. Snippets are raw for full-access rows and masked
//   otherwise (raw never leaves the server for a non-full row). People come from record membership only, never
//   ranked; emails only with full access. Results are SafeSummaries. The audit row holds the result count only.
import { str, obj, fail, email as validEmail, rateLimit } from './util.js';
import { pseudonymise, forAuthor, recordView, clientMatcher, safeSummary } from './scrub.js';
import { snippetsOf, TOPIC_KEYS } from './snippets.js';
import { RERANK_POLICY, parseRerankStrict, candidateCard, lexical, rankPool, retrievalOf } from './reuse.js';
import { SIM_FLOOR, STRONG } from './bids.js';
import { winSignals } from './winloop.js';

export const READY = true;
const LABEL = 'Answers are interpretation over the library; open each reference for the facts. People are listed by the projects they worked on, never ranked.';
const UNRANKED = 'Not ranked: the ranking model did not answer. Similarity is not relevance.';
const NOTE = { empty_library: 'No references are available to you yet.', none: 'Nothing in the library answers this yet.', unranked: UNRANKED,
  filtered: 'Filtered to references for that client that you can open fully.', filteredNone: 'The ranking model judged none of them relevant to this question.' };
// On the client-filter path the named client is the relevance signal, and pseudonymising the question masks its name,
// so every row of that client reaches the ranking: no similarity floor there.
const UNFLOORED = Object.freeze({ semantic: -Infinity, lexical: -Infinity });
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export async function routes(ctx) {
  if (ctx.method !== 'POST' || ctx.parts.length !== 1) throw fail(404, 'Not found.');
  return { body: await ask(ctx.lib, ctx.user, obj(ctx.body)) };
}

async function ask(lib, user, b) {
  const question = str(b.question, 2000);
  if (question.length < 8 || question.length > 600) throw fail(400, 'Ask a question of 8 to 600 characters.');
  const limit = Math.max(1, Math.min(8, Math.round(Number(b.limit)) || 6));
  if (!rateLimit(lib, 'ask:' + user.email, 60, 36e5)) throw fail(429, 'Too many questions this hour. Try again later.');
  let pool = lib.visibleRows(user).filter(([r, level]) => r.status === 'published' || level === 'full'), note = '';
  const named = new Set();
  clientMatcher(lib)(question, (match, stored) => { named.add(norm(stored)); return match; });
  if (named.size) {
    const theirs = pool.filter(([r, level]) => level === 'full' && named.has(norm(r.data.client?.name)));
    if (theirs.length) { pool = theirs; note = NOTE.filtered; }
  }
  const q = pseudonymise(lib, question), mine = forAuthor(lib, q.map, { authorText: q.text });
  const answer = (verdict, method, results, extraNote) => {
    const people = [], byKey = new Map(), countries = new Map();
    for (const r of results) {
      for (const p of r.people) {
        const key = p.name.toLowerCase() + '\n' + (p.email || '');
        if (byKey.has(key)) { const e = byKey.get(key); if (!e.refIds.includes(r.id)) e.refIds.push(r.id); continue; }
        if (people.length === 10) continue;
        const e = { ...p, refIds: [r.id] }; byKey.set(key, e); people.push(e);
      }
      if (r.country) countries.set(r.country, (countries.get(r.country) || 0) + 1);
    }
    lib.log('library', user.email, 'ask', `${results.length} results`);
    return { verdict, method, results, people, countries: [...countries].map(([name, n]) => ({ name, n })).sort((x, y) => y.n - x.n || (x.name < y.name ? -1 : 1)),
      totals: { visible: results.length }, note: [note, extraNote].filter(Boolean).join(' '), label: LABEL };
  };
  if (!pool.length) return answer('empty_library', 'none', [], NOTE.empty_library);
  const qv = lib.embed ? await lib.embed(q.text).catch(() => null) : null, wins = winSignals(lib);
  const kept = rankPool(pool, q.text, qv, { floor: note ? UNFLOORED : SIM_FLOOR, boost: r => wins.get(r.id)?.boost || 0 }).slice(0, 12);
  const retrieval = retrievalOf(kept) || (qv ? 'semantic' : 'lexical');
  if (!kept.length) return answer('none', retrieval, [], NOTE.none);
  const cards = kept.map(k => candidateCard(k.row.id, recordView(lib, k.row.data)));
  const ranked = lib.complete ? parseRerankStrict(await lib.complete([{ role: 'system', content: RERANK_POLICY },
    { role: 'user', content: JSON.stringify({ context: { query: q.text }, candidates: cards }) }]).catch(() => ''), cards.map(c => c.id)) : null;
  if (ranked !== null && !ranked.length) return answer('none', retrieval + ' + model ranking', [], note ? NOTE.filteredNone : NOTE.none);
  const byId = new Map(kept.map(k => [k.row.id, k]));
  const picks = ranked ? [...ranked].sort((x, y) => y.relevance - x.relevance) : kept.map(k => ({ id: k.row.id, relevance: null, why: '', caveat: UNRANKED }));
  const results = picks.slice(0, limit).map(x => {
    const k = byId.get(x.id);
    return { ...safeSummary(lib, k.row, k.level, user), relevance: x.relevance, similarity: Math.round(k.similarity * 1000) / 1000, retrieval: k.retrieval,
      why: mine(x.why), caveat: mine(x.caveat), snippets: snippetsFor(lib, k, q.text), people: peopleOf(k) };
  });
  const verdict = !ranked ? 'unranked' : results.some(x => x.relevance >= STRONG) ? 'strong' : 'partial';
  return answer(verdict, retrieval + (ranked ? ' + model ranking' : ' (not ranked)'), results, ranked ? '' : NOTE.unranked);
}

// The two snippets with the most lexical overlap with the (pseudonymised) question, scored on the masked text.
// Full access: the raw sentence and source name (§2.3); otherwise the masked ones. `raw` and `rawSource` never leave
// the server otherwise.
function snippetsFor(lib, k, query) {
  const full = k.level === 'full';
  return snippetsOf(lib, k.row.data).map((s, i) => ({ s, i, score: lexical(query, s.text) })).sort((x, y) => y.score - x.score || x.i - y.i).slice(0, 2)
    .map(({ s }) => ({ kind: s.kind, ...(s.kind === 'consultant_words' ? { topic: TOPIC_KEYS[s.topic] } : { sourceName: full ? s.rawSource.name : s.source.name }), text: (full ? s.raw : s.text).slice(0, 300) }));
}

// Record membership only, in reference order: the reference owner, then the listed consultants. Never scored.
// An email only when the caller can open the record fully (the owner's is the record's owner, when it is an email).
function peopleOf({ row, level }) {
  const full = level === 'full', d = row.data || {}, out = [];
  const add = (name, role, mail) => { const n = str(name, 100), e = full ? validEmail(mail) : ''; if (n || e) out.push({ name: n, role: str(role, 100), ...(e ? { email: e } : {}) }); };
  add(d.consultant?.name, d.consultant?.role, row.owner);
  for (const c of d.details?.consultants || []) add(c?.name, c?.role, c?.email);
  return out;
}
