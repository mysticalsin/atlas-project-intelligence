// F7 Win loop (WOW_SPEC §F7): which kinds of proof are associated with won bids. A proof type is fixed when a
// reference is marked as used in a bid, and every number here comes from the bids and bid_references tables only.
// Every signed-in user sees the per-proof-type aggregates; per-story rows only reviewers, admins and the story's own
// people (full access, Q13); there are never per-consultant numbers. Association, not causation: MIN_N, the boost
// bounds and the hint thresholds are uncalibrated pilot values (Q2). While READY is false the helpers called from
// existing paths (winSignals from Library.recommend, guidance) keep their S0 neutral values.
import { fail } from './util.js';
import { processable } from './privacy.js';
import { ensure } from './bids.js';
import { claimSummary } from './claims.js';
import { NUMERIC_SRC } from './policy.generated.js';

export const READY = true;
export const MIN_N = 5;
const PER_BIDDER_CAP = 3, DECIDED_PER_BIDDER = 25; // see tallies(): per bidder and story; per bidder in the totals
// X1 (red L1, old): a figure is shown or used only when it rests on decided bids of at least MIN_BIDDERS different people, and one person's bids count at most PER_BIDDER_CAP times per
// proof type, so one account (or two) cannot move a company-wide statistic however many bids it makes.
const MIN_BIDDERS = 3;
const OVERALL_MIN = 10, HINT_GAP = 0.15, Z = 1.959963984540054; // Z: the two-sided 95% normal quantile
const TYPES = ['quantified+confirmed', 'quantified+unconfirmed', 'qualitative+confirmed', 'qualitative+unconfirmed'];
const HINTS = ['quantified', 'confirmed'];
const LABEL = 'Association, not causation. Weights are uncalibrated.';
const LOW_N = `Fewer than ${MIN_N} decided bids: not shown.`;
const LOW_BIDDERS = `Decided bids from fewer than ${MIN_BIDDERS} different people: not shown.`;
const NUMERIC = new RegExp(NUMERIC_SRC, 'i'); // the interview's own "quantified" rule (atlas_voice.quality.NUMERIC)
const r4 = x => Math.round(x * 1e4) / 1e4;

// Wilson score interval, 95%: 3 won of 5 decided gives about [0.23, 0.88]. null without a valid count.
export function wilson(won, n) {
  if (!Number.isInteger(n) || !Number.isInteger(won) || n <= 0 || won < 0 || won > n) return null;
  const p = won / n, z2 = Z * Z, d = 1 + z2 / n, c = (p + z2 / (2 * n)) / d, h = Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
  return [r4(Math.max(0, c - h)), r4(Math.min(1, c + h))];
}

// At the time of use: quantified when the outcome or evidence answer states a figure; confirmed when at least one
// current claim is confirmed by someone else (claims.claimSummary, current claims only).
export function proofTypeOf(lib, row) {
  const a = Array.isArray(row?.data?.answers) ? row.data.answers : [];
  const quantified = NUMERIC.test(String(a[3] || '')) || NUMERIC.test(String(a[4] || ''));
  const confirmed = (Number(claimSummary(lib, row, { independent: true })?.confirmed) || 0) > 0; // a self-named confirmer is not the N+1 (red-team M3)
  return (quantified ? 'quantified' : 'qualitative') + '+' + (confirmed ? 'confirmed' : 'unconfirmed');
}

// Counts per proof type and per story, cached per Library instance. The key covers new uses (count, last use) and
// every outcome change: a rowid-weighted checksum of outcomes, so even two outcomes swapped at the same instant
// invalidate it (a stricter key than §F7.1's COUNT/MAX pair).
const cache = new WeakMap();
function tallies(lib) {
  ensure(lib);
  const u = lib.rows('SELECT COUNT(*) AS n, MAX(used_at) AS at FROM bid_references')[0] || {};
  const b = lib.rows("SELECT COUNT(*) AS n, MAX(decided_at) AS at, SUM(rowid * (CASE outcome WHEN 'won' THEN 1 WHEN 'lost' THEN 2 WHEN 'withdrawn' THEN 3 ELSE 4 END)) AS sum FROM bids")[0] || {};
  const sig = [u.n, u.at, b.n, b.at, b.sum].join('|'), hit = cache.get(lib);
  if (hit?.sig === sig) return hit;
  // Per story, one use is one bid ((bid_id, ref_id) is the key). Per proof type, `used` counts uses but outcomes count
  // distinct bids (bidsOf: type -> bid id -> outcome), so one bid citing five stories of a type is one decided bid.
  const blank = () => ({ used: 0, won: 0, lost: 0, pending: 0, bidders: new Set() }), byType = new Map(TYPES.map(t => [t, blank()])), byRef = new Map(), bidsOf = new Map(TYPES.map(t => [t, new Map()]));
  const count = (s, outcome, bidder) => { if (outcome === 'won') s.won++; else if (outcome === 'lost') s.lost++; else if (outcome === 'pending') s.pending++; if (bidder && (outcome === 'won' || outcome === 'lost')) s.bidders.add(bidder); };
  // Red-team L1: anyone can create bids and set their outcome, so a use counts only when (a) the bidder is not the story's own owner or a
  // listed consultant (nobody promotes their own story), and (b) it is among the first PER_BIDDER_CAP uses of that story by that bidder
  // (one account cannot move a rate alone; it takes several people). Totals count each bidder's decided bids up to a cap as well.
  const seenBy = new Map(), typeBids = new Map();
  for (const r of lib.rows(`SELECT u.bid_id, u.ref_id, u.proof_type, b.outcome, b.owner AS bidder, f.owner AS ref_owner, f.members AS ref_members
      FROM bid_references u JOIN bids b ON b.id = u.bid_id LEFT JOIN refs f ON f.id = u.ref_id ORDER BY u.used_at, u.rowid`)) {
    if (r.bidder && (r.bidder === r.ref_owner || String(r.ref_members || '').includes(',' + r.bidder + ','))) continue;
    const key = r.bidder + '\n' + r.ref_id, n = (seenBy.get(key) || 0) + 1;
    seenBy.set(key, n);
    if (n > PER_BIDDER_CAP) continue;
    if (byType.has(r.proof_type)) {
      // one bidder's distinct bids per proof type, first PER_BIDDER_CAP only
      const tk = r.bidder + '\n' + r.proof_type, mine = typeBids.get(tk) || typeBids.set(tk, new Set()).get(tk);
      if (mine.has(r.bid_id) || mine.size < PER_BIDDER_CAP) { mine.add(r.bid_id); byType.get(r.proof_type).used++; bidsOf.get(r.proof_type).set(r.bid_id, { outcome: r.outcome, bidder: r.bidder }); }
    }
    if (!byRef.has(r.ref_id)) byRef.set(r.ref_id, blank());
    const s = byRef.get(r.ref_id); s.used++; count(s, r.outcome, r.bidder);
  }
  for (const [type, bids] of bidsOf) for (const { outcome, bidder } of bids.values()) count(byType.get(type), outcome, bidder);
  const t = lib.rows("SELECT (SELECT COUNT(*) FROM bids) AS bids, SUM(CASE WHEN outcome IN ('won', 'lost') THEN 1 ELSE 0 END) AS decided FROM (SELECT outcome, ROW_NUMBER() OVER (PARTITION BY owner ORDER BY created_at, rowid) AS n FROM bids) WHERE n <= ?", DECIDED_PER_BIDDER)[0] || {};
  const entry = { sig, byType, bidsOf, byRef, totals: { bids: t.bids || 0, decided: t.decided || 0 } };
  cache.set(lib, entry);
  return entry;
}
const cell = s => { const decided = s.won + s.lost, shown = decided >= MIN_N && s.bidders.size >= MIN_BIDDERS; return { decided, winRate: shown ? r4(s.won / decided) : null, ci95: shown ? wilson(s.won, decided) : null, caveat: shown ? '' : decided >= MIN_N ? LOW_BIDDERS : LOW_N }; };

// Ranking feedback for F1 match and Library.recommend: refId -> { decided, won, winRate, boost }. The boost is
// clamp(0.1 x (story rate - overall rate), -0.03, +0.05), only with at least 10 decided bids overall and 5 decided
// uses of that story; callers add it to the order of rows ABOVE the similarity floor only, never to model relevance.
export function winSignals(lib) {
  if (!READY) return new Map();
  const t = tallies(lib);
  if (!t.signals) {
    let won = 0, lost = 0;
    for (const s of t.byRef.values()) { won += s.won; lost += s.lost; }
    const overall = won + lost ? won / (won + lost) : 0, enough = t.totals.decided >= OVERALL_MIN;
    t.signals = new Map([...t.byRef].map(([id, s]) => {
      const decided = s.won + s.lost, rate = decided ? s.won / decided : 0, counts = decided >= MIN_N && s.bidders.size >= MIN_BIDDERS;
      return [id, { decided, won: s.won, winRate: counts ? r4(rate) : null, boost: enough && counts ? r4(Math.max(-0.03, Math.min(0.05, 0.1 * (rate - overall)))) : 0 }];
    }));
  }
  return new Map([...t.signals].map(([id, v]) => [id, { ...v }]));
}

// The interview hint (aggregate only: no ids, titles or names). 'quantified' when at least 10 bids are decided, both
// groups have 5+ decided bids and quantified proof's win rate beats qualitative by 15+ points; else 'confirmed' by
// the same rule for confirmed vs unconfirmed; else null. A group is the set of distinct bids with a use in it. From
// bids and bid_references only (no visibleRows scan).
export function guidance(lib) {
  if (!READY) return { hint: null, decided: 0, basis: 'not built' };
  const t = tallies(lib);
  if (!t.guidance) {
    const group = test => {
      const outcomes = new Map(); for (const [type, m] of t.bidsOf) if (test(type)) for (const [id, o] of m) outcomes.set(id, o);
      let won = 0, lost = 0; const who = new Set(); for (const { outcome, bidder } of outcomes.values()) { if (outcome === 'won') won++; else if (outcome === 'lost') lost++; else continue; who.add(bidder); }
      return { decided: won + lost, rate: won + lost ? won / (won + lost) : 0, who: who.size };
    };
    const beats = (a, b) => a.decided >= MIN_N && b.decided >= MIN_N && a.who >= MIN_BIDDERS && b.who >= MIN_BIDDERS && a.rate - b.rate >= HINT_GAP - 1e-9;
    const pct = g => `${Math.round(g.rate * 100)}% of ${g.decided}`;
    const q = group(x => x.startsWith('quantified')), ql = group(x => x.startsWith('qualitative')), c = group(x => x.endsWith('+confirmed')), u = group(x => x.endsWith('+unconfirmed'));
    const decided = t.totals.decided;
    t.guidance = decided < OVERALL_MIN ? { hint: null, decided, basis: `Fewer than ${OVERALL_MIN} decided bids.` }
      : beats(q, ql) ? { hint: 'quantified', decided, basis: `Quantified proof won ${pct(q)} decided bids; qualitative ${pct(ql)}.` }
        : beats(c, u) ? { hint: 'confirmed', decided, basis: `Confirmed proof won ${pct(c)} decided bids; unconfirmed ${pct(u)}.` }
          : { hint: null, decided, basis: 'No proof type stands out yet.' };
  }
  return { ...t.guidance };
}

function stats(lib, user) {
  const t = tallies(lib);
  const proofTypes = [...t.byType].map(([proofType, s]) => { const c = cell(s); return { proofType, used: s.used, won: s.won, lost: s.lost, decided: c.decided, winRate: c.winRate, ci95: c.ci95, caveat: c.caveat }; });
  const stories = [];
  for (const [refId, s] of t.byRef) {
    const row = lib.row(refId);
    if (lib.access(row, user) !== 'full' || !processable(lib, row.owner, 'matching')) continue; // reviewers and admins: every active story; anyone else: their own (Q13); not a restricted or objecting owner's (G2)
    const c = cell(s);
    stories.push({ refId, title: row.data.title, used: s.used, won: s.won, lost: s.lost, pending: s.pending, decided: c.decided, winRate: c.winRate, ci95: c.ci95, caveat: c.caveat });
  }
  stories.sort((a, b) => b.decided - a.decided || b.used - a.used || (a.refId < b.refId ? -1 : 1));
  return { minN: MIN_N, proofTypes, stories, totals: { ...t.totals }, label: LABEL };
}

export async function routes(ctx) {
  const { method, parts, lib, user } = ctx;
  if (method === 'GET' && parts.length === 1) return { body: stats(lib, user) };
  if (method === 'GET' && parts.length === 2 && parts[1] === 'guidance') return { body: guidance(lib) };
  throw fail(404, 'Not found.');
}

// For the Interview DO: GET /api/library/wins/guidance from the global LibraryStore AS the interviewee (the identity
// the Worker forwarded to that DO), capped at 1.5 s. null on any failure or timeout; never throws. Session starts it
// without awaiting and maps the hint to the generated WIN_HINTS note.
export async function fetchWinHint(env, identity, { timeoutMs = 1500 } = {}) {
  if (!env?.LIBRARY) return null;
  let timer = null;
  try {
    const request = new Request('https://atlas.internal/api/library/wins/guidance', { headers: {
      'x-atlas-user': String(identity?.user || ''), 'x-atlas-role': String(identity?.role || 'user'), 'x-atlas-email': String(identity?.mail || '') } });
    const work = (async () => {
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(request);
      if (!res?.ok) return null;
      const b = await res.json();
      return { hint: HINTS.includes(b?.hint) ? b.hint : null, decided: Number.isInteger(b?.decided) ? b.decided : 0, basis: typeof b?.basis === 'string' ? b.basis.slice(0, 300) : '' };
    })().catch(() => null);
    return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}
