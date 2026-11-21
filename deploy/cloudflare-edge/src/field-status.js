// Interview ledger status and probe budget (row 2). Pure. ledger.js runs the effects.
// The labels and the defer sentence match atlas_voice/field_status.py.
export const DETAIL_PHASES = ['unset', 'unknown', 'uncertain', 'reported'];
export const PROBE_PHASES = ['open', 'asking', 'deferred'];
export const DEFER_SENTENCE = 'Two clarification plans did not resolve this point; offer to collect it later.';
const KINDS = ['unknown', 'uncertain', 'reported'];

function refuse(state, id, phase, event) {
  return { ok: false, illegal: true, state, effects: [], rejection: { id, phase, event } };
}

export function detailTransition(state, event) {
  const phase = state && DETAIL_PHASES.includes(state.phase) ? state.phase : 'unknown';
  const kind = event && event.type === 'classify' ? 'classify' : 'unknown';
  const label = event && KINDS.includes(event.kind) ? event.kind : '';
  if (phase !== 'unset' || kind !== 'classify' || !label) return refuse(state, 'detail-status', phase, kind);
  return { ok: true, illegal: false, state: { phase: label }, effects: [] };
}

export function classifyDetail(quote, uncertain, unknownRe, uncertainRe) {
  const kind = unknownRe.test(quote) ? 'unknown' : (uncertain === true || uncertainRe.test(quote)) ? 'uncertain' : 'reported';
  return detailTransition({ phase: 'unset' }, { type: 'classify', kind }).state.phase;
}

export function probeTransition(state, event) {
  const phase = state && PROBE_PHASES.includes(state.phase) ? state.phase : 'unknown';
  const plans = state && Number.isInteger(state.plans) && state.plans >= 0 ? state.plans : null;
  const kind = event && event.type === 'plan' ? 'plan' : 'unknown';
  if (phase === 'unknown' || kind === 'unknown' || plans === null) return refuse(state, 'probe-budget', phase, kind);
  if (phase === 'open' && plans === 0) return { ok: true, illegal: false, state: { phase: 'asking', plans: 1 }, effects: ['ask'] };
  if (phase === 'asking' && plans === 1) return { ok: true, illegal: false, state: { phase: 'asking', plans: 2 }, effects: ['ask'] };
  if ((phase === 'asking' && plans >= 2) || phase === 'deferred') {
    return { ok: true, illegal: false, state: { phase: 'deferred', plans }, effects: ['defer'] };
  }
  return refuse(state, 'probe-budget', phase, kind);
}
