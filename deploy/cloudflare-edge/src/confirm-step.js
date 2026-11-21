// Colleague confirm page lifecycle. Pure. The page runs the effects. The name stays confirmStep: the served page must not contain the word transition.
export const CONFIRM_PHASES = Object.freeze(['loading', 'choosing', 'submitting', 'recorded', 'empty', 'failed']);
export const CONFIRM_EVENTS = Object.freeze(['loaded', 'vacant', 'broke', 'submit', 'succeed', 'fail']);

export function confirmStep(state, event) {
  const refuse = (phase, type) => ({
    ok: false, illegal: true, state, effects: [],
    rejection: { id: 'confirm-page', phase, event: type },
  });
  const go = phase => ({ ok: true, illegal: false, state: { phase }, effects: [] });
  const phase = CONFIRM_PHASES.includes(state && state.phase) ? state.phase : 'unknown';
  const type = CONFIRM_EVENTS.includes(event && event.type) ? event.type : 'unknown';
  if (phase === 'unknown' || type === 'unknown') return refuse(phase, type);
  if ((phase === 'loading' || phase === 'choosing' || phase === 'recorded' || phase === 'empty') && type === 'loaded') return go('choosing');
  if ((phase === 'loading' || phase === 'choosing' || phase === 'recorded') && type === 'vacant') return go('empty');
  if (phase === 'loading' && type === 'broke') return go('failed');
  if (phase === 'choosing' && type === 'submit') {
    if (!event || event.ready !== true) return { ok: true, illegal: false, state, effects: [], guard: 'ready' };
    return go('submitting');
  }
  if (phase === 'submitting' && type === 'succeed') return go('recorded');
  if (phase === 'submitting' && type === 'fail') return go('choosing');
  return refuse(phase, type);
}
