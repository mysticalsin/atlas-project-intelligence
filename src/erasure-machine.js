// Privacy erasure. Pure transitions. The journey privacy button is the only writer.
// The view is not stored. Nothing here reads or writes a journey row.
export const ERASURE_STATES = Object.freeze(['idle', 'confirming', 'in_flight', 'receipt', 'failed']);
export const ERASURE_EVENTS = Object.freeze(['ask', 'cancel', 'confirm', 'succeed', 'fail']);
export const ERASURE_ID = 'privacy-delete';

const LEGAL = new Set([
  'idle:ask',
  'confirming:cancel',
  'confirming:confirm',
  'in_flight:succeed',
  'in_flight:fail',
  'receipt:ask',
  'failed:ask',
]);

export function initialErasure() {
  return { status: 'idle' };
}

function ok(status, effects) {
  return { ok: true, illegal: false, state: { status }, effects };
}

function illegal(state, event) {
  const phase = ERASURE_STATES.includes(state?.status) ? state.status : 'unknown';
  const type = ERASURE_EVENTS.includes(event?.type) ? event.type : 'unknown';
  return {
    ok: false, illegal: true, state, effects: [],
    rejection: { id: ERASURE_ID, phase, event: type },
  };
}

export function erasureTransition(state, event) {
  const type = event?.type;
  if (!ERASURE_STATES.includes(state?.status) || !LEGAL.has(state.status + ':' + type)) return illegal(state, event);
  if (type === 'ask') return ok('confirming', ['show_confirm']);
  if (type === 'cancel') return ok('idle', ['dismiss_confirm']);
  if (type === 'confirm') return ok('in_flight', ['post_delete']);
  if (type === 'succeed') return ok('receipt', ['show_receipt']);
  return ok('failed', ['show_error']);
}
