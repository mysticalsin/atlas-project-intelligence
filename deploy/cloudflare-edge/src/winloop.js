// F7 Win loop (WOW_SPEC §F7): which kinds of proof are associated with won bids. A proof type is fixed when a
// reference is marked as used in a bid, and every number here comes from the bids and bid_references tables only.
// Every signed-in user sees the per-proof-type aggregates; per-story rows only reviewers, admins and the story's own
// people (full access, Q13); there are never per-consultant numbers. Association, not causation: MIN_N, the boost
// bounds and the hint thresholds are uncalibrated pilot values (Q2). While READY is false the helpers called from
// existing paths (winSignals from Library.recommend, guidance) keep their S0 neutral values.
import { fail } from './util.js';
import { ensure } from './bids.js';
import { claimSummary } from './claims.js';
import { NUMERIC_SRC } from './policy.generated.js';
import { TENANT_ID } from './authz.js';

export const READY = true;
export const MIN_N = 5;
const OVERALL_MIN = 10, HINT_GAP = 0.15, Z = 1.959963984540054; // Z: the two-sided 95% normal quantile
const TYPES = ['quantified+confirmed', 'quantified+unconfirmed', 'qualitative+confirmed', 'qualitative+unconfirmed'];
const HINTS = ['quantified', 'confirmed'];
const LABEL = 'Association, not causation. Weights are uncalibrated.';
const LOW_N = `Fewer than ${MIN_N} decided bids: not shown.`;
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
  const confirmed = (Number(claimSummary(lib, row)?.confirmed) || 0) > 0;
  return (quantified ? 'quantified' : 'qualitative') + '+' + (confirmed ? 'confirmed' : 'unconfirmed');
}

// Counts per proof type and per story, cached per Library instance. The key covers new uses (count, last use) and
// every outcome change: a rowid-weighted checksum of outcomes, so even two outcomes swapped at the same instant
// invalidate it (a stricter key than §F7.1's COUNT/MAX pair).
const cache = new WeakMap();
function winScope(user) {
  if (user?.tenantEnforced === true) {
    const tenant = String(user.tenant || '').toLowerCase();
    return TENANT_ID.test(tenant) ? tenant : null;
  }
  return '';
}
function tallies(lib, user) {
  ensure(lib);
  const scope = winScope(user);
  if (scope === null) return { sig: 'refused', byType: new Map(TYPES.map(t => [t, { used: 0, won: 0, lost: 0, pending: 0 }])), bidsOf: new Map(), byRef: new Map(), totals: { bids: 0, decided: 0 } };
  const u = lib.rows("SELECT COUNT(*) AS n, MAX(u.used_at) AS at FROM bid_references u JOIN bids b ON b.id = u.bid_id WHERE lower(COALESCE(b.tenant, '')) = ?", scope)[0] || {};
  const b = lib.rows("SELECT COUNT(*) AS n, MAX(decided_at) AS at, SUM(rowid * (CASE outcome WHEN 'won' THEN 1 WHEN 'lost' THEN 2 WHEN 'withdrawn' THEN 3 ELSE 4 END)) AS sum FROM bids WHERE lower(COALESCE(tenant, '')) = ?", scope)[0] || {};
  const sig = [scope, u.n, u.at, b.n, b.at, b.sum].join('|'), hit = cache.get(lib);
  if (hit?.sig === sig) return hit;
  // Per story, one use is one bid ((bid_id, ref_id) is the key). Per proof type, `used` counts uses but outcomes count
  // distinct bids (bidsOf: type -> bid id -> outcome), so one bid citing five stories of a type is one decided bid.
  const blank = () => ({ used: 0, won: 0, lost: 0, pending: 0 }), byType = new Map(TYPES.map(t => [t, blank()])), byRef = new Map(), bidsOf = new Map(TYPES.map(t => [t, new Map()]));
  const count = (s, outcome) => { if (outcome === 'won') s.won++; else if (outcome === 'lost') s.lost++; else if (outcome === 'pending') s.pending++; };
  for (const r of lib.rows("SELECT u.bid_id, u.ref_id, u.proof_type, b.outcome FROM bid_references u JOIN bids b ON b.id = u.bid_id WHERE lower(COALESCE(b.tenant, '')) = ?", scope)) {
    if (byType.has(r.proof_type)) { byType.get(r.proof_type).used++; bidsOf.get(r.proof_type).set(r.bid_id, r.outcome); }
    if (!byRef.has(r.ref_id)) byRef.set(r.ref_id, blank());
    const s = byRef.get(r.ref_id); s.used++; count(s, r.outcome);
  }
  for (const [type, outcomes] of bidsOf) for (const outcome of outcomes.values()) count(byType.get(type), outcome);
  const t = lib.rows("SELECT COUNT(*) AS bids, SUM(CASE WHEN outcome IN ('won', 'lost') THEN 1 ELSE 0 END) AS decided FROM bids WHERE lower(COALESCE(tenant, '')) = ?", scope)[0] || {};
  const entry = { sig, byType, bidsOf, byRef, totals: { bids: t.bids || 0, decided: t.decided || 0 } };
  cache.set(lib, entry);
  return entry;
}
const cell = s => { const decided = s.won + s.lost, shown = decided >= MIN_N; return { decided, winRate: shown ? r4(s.won / decided) : null, ci95: shown ? wilson(s.won, decided) : null, caveat: shown ? '' : LOW_N }; };

// Ranking feedback for F1 match and Library.recommend: refId -> { decided, won, winRate, boost }. The boost is
// clamp(0.1 x (story rate - overall rate), -0.03, +0.05), only with at least 10 decided bids overall and 5 decided
// uses of that story; callers add it to the order of rows ABOVE the similarity floor only, never to model relevance.
export function winSignals(lib, user) {
  if (!READY) return new Map();
  const t = tallies(lib, user);
  if (!t.signals) {
    let won = 0, lost = 0;
    for (const s of t.byRef.values()) { won += s.won; lost += s.lost; }
    const overall = won + lost ? won / (won + lost) : 0, enough = t.totals.decided >= OVERALL_MIN;
    t.signals = new Map([...t.byRef].map(([id, s]) => {
      const decided = s.won + s.lost, rate = decided ? s.won / decided : 0, counts = decided >= MIN_N;
      return [id, { decided, won: s.won, winRate: counts ? r4(rate) : null, boost: enough && counts ? r4(Math.max(-0.03, Math.min(0.05, 0.1 * (rate - overall)))) : 0 }];
    }));
  }
  return new Map([...t.signals].map(([id, v]) => [id, { ...v }]));
}

// The interview hint (aggregate only: no ids, titles or names). 'quantified' when at least 10 bids are decided, both
// groups have 5+ decided bids and quantified proof's win rate beats qualitative by 15+ points; else 'confirmed' by
// the same rule for confirmed vs unconfirmed; else null. A group is the set of distinct bids with a use in it. From
// bids and bid_references only (no visibleRows scan).
export function guidance(lib, user) {
  if (!READY) return { hint: null, decided: 0, basis: 'not built' };
  const t = tallies(lib, user);
  if (!t.guidance) {
    const group = test => {
      const outcomes = new Map(); for (const [type, m] of t.bidsOf) if (test(type)) for (const [id, o] of m) outcomes.set(id, o);
      let won = 0, lost = 0; for (const o of outcomes.values()) { if (o === 'won') won++; else if (o === 'lost') lost++; }
      return { decided: won + lost, rate: won + lost ? won / (won + lost) : 0 };
    };
    const beats = (a, b) => a.decided >= MIN_N && b.decided >= MIN_N && a.rate - b.rate >= HINT_GAP - 1e-9;
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
  const t = tallies(lib, user);
  const proofTypes = [...t.byType].map(([proofType, s]) => { const c = cell(s); return { proofType, used: s.used, won: s.won, lost: s.lost, decided: c.decided, winRate: c.winRate, ci95: c.ci95, caveat: c.caveat }; });
  const stories = [];
  for (const [refId, s] of t.byRef) {
    const row = lib.row(refId);
    if (lib.access(row, user) !== 'full') continue; // reviewers and admins: every active story; anyone else: their own (Q13)
    const c = cell(s);
    stories.push({ refId, title: row.data.title, used: s.used, won: s.won, lost: s.lost, pending: s.pending, decided: c.decided, winRate: c.winRate, ci95: c.ci95, caveat: c.caveat });
  }
  stories.sort((a, b) => b.decided - a.decided || b.used - a.used || (a.refId < b.refId ? -1 : 1));
  return { minN: MIN_N, proofTypes, stories, totals: { ...t.totals }, label: LABEL };
}

export async function routes(ctx) {
  const { method, parts, lib, user } = ctx;
  if (user?.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) return { status: 403, body: { error: 'A verified tenant is required.' } };
  if (method === 'GET' && parts.length === 1) return { body: stats(lib, user) };
  if (method === 'GET' && parts.length === 2 && parts[1] === 'guidance') return { body: guidance(lib, user) };
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
      'x-atlas-user': String(identity?.user || ''), 'x-atlas-role': String(identity?.role || 'user'), 'x-atlas-email': String(identity?.mail || ''),
      'x-atlas-tenant': String(identity?.tenant || ''), 'x-atlas-tenant-enforced': identity?.tenantEnforced ? '1' : '0' } });
    const work = (async () => {
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(request);
      if (!res?.ok) return null;
      const b = await res.json();
      return { hint: HINTS.includes(b?.hint) ? b.hint : null, decided: Number.isInteger(b?.decided) ? b.decided : 0, basis: typeof b?.basis === 'string' ? b.basis.slice(0, 300) : '' };
    })().catch(() => null);
    return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}
