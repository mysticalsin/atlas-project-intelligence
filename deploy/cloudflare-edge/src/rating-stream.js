// Interactive rating attempt stream (S1). Pure. storyRater runs the effects.
// The breaker is a different machine. This one only counts the attempts of one rate() call.
export const RATING_STREAM_PHASES = Object.freeze(['idle', 'running', 'settled']);
export const RATING_STREAM_EVENTS = Object.freeze(['launch', 'succeed', 'retryable', 'terminal', 'deadline', 'observe']);

export function initialRatingStream() {
  return { phase: 'idle', attempts: 0, pending: 0, hedged: 0, max: 0 };
}

function reject(state, phase, event) {
  return {
    ok: false, illegal: true, state, effects: [],
    rejection: { id: 'rating-stream', phase, event },
  };
}

function stay(state, guard) {
  return { ok: true, illegal: false, state, effects: [], guard };
}

function move(state, effects) {
  return { ok: true, illegal: false, state, effects };
}

export function ratingStreamTransition(state, event) {
  const phase = RATING_STREAM_PHASES.includes(state?.phase) ? state.phase : 'unknown';
  const type = RATING_STREAM_EVENTS.includes(event?.type) ? event.type : 'unknown';
  if (phase === 'unknown' || type === 'unknown') return reject(state, phase, type);

  const room = event?.room === true;
  const max = Number.isFinite(event?.max) ? event.max : state.max;

  if (phase === 'idle' && type === 'launch') {
    if (!room) return stay(state, 'room');
    if (!(max >= 1)) return stay(state, 'budget');
    return move({ phase: 'running', attempts: 1, pending: 1, hedged: 0, max }, ['request']);
  }
  if (phase === 'idle' && type === 'deadline') {
    return move({ ...state, phase: 'settled', pending: 0 }, ['note_timeout', 'resolve', 'observe']);
  }
  if (phase === 'running' && type === 'launch') {
    if (!room) return stay(state, 'room');
    if (state.attempts >= state.max) return stay(state, 'budget');
    const attempts = state.attempts + 1;
    return move({ ...state, attempts, pending: state.pending + 1, hedged: attempts > 1 ? 1 : 0 }, ['request']);
  }
  if (phase === 'running' && (type === 'succeed' || type === 'terminal')) {
    return move({ ...state, phase: 'settled', pending: 0 }, ['resolve', 'observe']);
  }
  if (phase === 'running' && type === 'retryable') {
    const pending = state.pending - 1;
    if (room && state.attempts < state.max) {
      const attempts = state.attempts + 1;
      return move({ ...state, attempts, pending: pending + 1, hedged: attempts > 1 ? 1 : 0 }, ['request']);
    }
    if (pending <= 0) return move({ ...state, phase: 'settled', pending: 0 }, ['resolve', 'observe']);
    return move({ ...state, pending }, []);
  }
  if (phase === 'running' && type === 'deadline') {
    return move({ ...state, phase: 'settled', pending: 0 }, ['note_timeout', 'resolve', 'observe']);
  }
  if (phase === 'settled' && type === 'observe') return move({ ...state }, ['log_observer']);
  return reject(state, phase, type);
}
