// TypeSafe JEV as an optional next-question ranker. OFF unless a server-side TYPESAFE_API_KEY exists.
// Privacy: the request carries only the story's shape (fields covered, statuses, flags, stage) and never
// transcript text, quotes or project names. Guard rails: JEV only chooses when the ledger's rules leave a
// free choice, and only overrides the default when clearly better and confident. No key or bad answer = no change.
import { FIELDS } from './policy.generated.js';

export const LEVELS = ['Adds nothing useful now', 'Minor value', 'Useful, not the priority', 'Strong next step', 'The single most valuable next question'];
const FREE_CHOICE = 'Find the most decision-useful detail, not a bigger claim.';
const finite = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;

export function candidates(plan) {
  if (plan.why_this_question !== FREE_CHOICE || !plan.next_field) return [];
  const paused = new Set([...(plan.unresolved_fields || []), ...Object.keys(plan.deferred_fields || {})]);
  const pool = (plan.missing || []).filter(f => !paused.has(f) && f !== 'measurement');
  return [plan.next_field, ...pool.filter(f => f !== plan.next_field)].slice(0, 4);
}

export function requestBody(model, plan, fields) {
  return { model, state: {
      interview_shape: { story_route: plan.story_route, recorded: (plan.candidate_details || []).map(d => ({ field: d.field, status: d.status })),
        missing: plan.missing, flags: plan.flags, measurement_gaps: plan.measurement_gaps },
      notice: 'Only the structure of a consultant interview is given, never its content. Judge which question most improves a defensible, customer-useful account. Never reward bigger claims.' },
    questions: Object.fromEntries(fields.map(f => [f, { type: 'score', criteria: LEVELS,
      instructions: `How valuable is asking about "${FIELDS[f][0]}" next ("${FIELDS[f][1]}")? Prefer a concrete episode, the person's own contribution and inspectable evidence.` }])) };
}

export function parse(data, fields) {
  const out = {};
  for (const f of fields) {
    const a = data?.answers?.[f];
    if (a?.type !== 'score' || !finite(a.score, 0, 4) || !finite(a.confidence, 0, 1)) throw new Error('Invalid JEV score');
    const p = a.probabilities || {}, keys = Object.keys(p);
    if (keys.length !== 5 || ['0', '1', '2', '3', '4'].some(k => !finite(p[k], 0, 1))) throw new Error('Invalid JEV distribution');
    const total = keys.reduce((s, k) => s + p[k], 0), expected = keys.reduce((s, k) => s + Number(k) * p[k], 0);
    // JEV prints probabilities to 2 decimals: the sum may be off by 5 x 0.005 and the implied score by (0+1+2+3+4) x 0.005.
    if (Math.abs(total - 1) > 0.025 || Math.abs(expected - a.score) > 0.05) throw new Error('Inconsistent JEV distribution');
    out[f] = { score: a.score, confidence: a.confidence };
  }
  return out;
}

// Returns replacement guidance, or null to keep the ledger's own choice.
export function choose(plan, guidance, scores) {
  const current = scores[plan.next_field];
  let best = plan.next_field;
  for (const [f, s] of Object.entries(scores)) if (s.score > scores[best].score) best = f;
  // A lead of 0.5 is enough. Adding the two decimals can make that lead look smaller.
  const margin = scores[best].score - current.score;
  if (best === plan.next_field || margin + 1e-9 < 0.5 || scores[best].confidence < 0.6) return null;
  return { ...guidance, field: best, label: FIELDS[best][0], question: FIELDS[best][1], ranked_by: 'jev',
    why: `JEV ranked this the most valuable next question (${scores[best].score.toFixed(1)}/4, confidence ${scores[best].confidence.toFixed(2)}).` };
}

export function jevRanker(env, fetcher = fetch) {
  if (!env.TYPESAFE_API_KEY) return null;
  return async (plan, guidance) => {
    const fields = candidates(plan);
    if (fields.length < 2) return null;
    const r = await fetcher('https://api.typesafe.ai/v1/systemone', { method: 'POST', redirect: 'manual',
      headers: { 'Authorization': 'Bearer ' + env.TYPESAFE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(env.JEV_MODEL || 'jev-latest', plan, fields)), signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error('JEV HTTP ' + r.status);
    return choose(plan, guidance, parse(await r.json(), fields));
  };
}
