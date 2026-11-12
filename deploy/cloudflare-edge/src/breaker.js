// Story-rating circuit breaker. Pure transitions: storyRater is the only writer and the only place that calls JEV.
// In memory for one LibraryStore. Not written to the database, so there is no snapshot codec.
export const BREAKER_FAILS = 3;
export const BREAKER_OPEN_MS = 60000;

export const BREAKER_PHASES = Object.freeze(['closed', 'open', 'probing']);
export const BREAKER_EVENTS = Object.freeze(['begin', 'succeed', 'fail', 'auth_fail', 'ignore']);
// begin is illegal while a trial is already in flight (probing). Every other pair is legal; guards may still deny begin.
// open:succeed and open:fail are legal on purpose. A request admitted while the breaker was closed can still
// be in flight when a later failure opens it. That request has to settle. Dropping succeed or fail would leave
// the count and the window wrong. A rejection marker is phase and event only, never the key.
// storyRater logs that marker. transition does not.
const LEGAL = new Set([
  'closed:begin', 'open:begin',
  'closed:succeed', 'open:succeed', 'probing:succeed',
  'closed:fail', 'open:fail', 'probing:fail',
  'closed:auth_fail', 'open:auth_fail', 'probing:auth_fail',
  'closed:ignore', 'open:ignore', 'probing:ignore',
]);

export function initialBreaker() {
  return { phase: 'closed', fails: 0, until: 0, authKey: null };
}

export function authKeyMatches(state, key) {
  return state.authKey !== null && state.authKey === key;
}

// The 60 s are not over. A probing trial has already cleared `until`, so this guard is only the open window.
export function windowStillOpen(state, now) {
  return state.phase === 'open' && now < state.until;
}

export function blocked(state, key, now) {
  if (authKeyMatches(state, key)) return 'auth';
  if (state.phase === 'probing' || windowStillOpen(state, now)) return 'circuit_open';
  return null;
}

function done(state, extra = {}) {
  return { ok: true, illegal: false, denied: false, state, reason: null, trial: false, ...extra };
}
function deny(state, guard, reason) {
  return { ok: false, illegal: false, denied: true, guard, state, reason, trial: false };
}
function illegal(state, event) {
  // ids are not on this machine. phase and event only: never the key, a story, or an address.
  return {
    ok: false, illegal: true, denied: false, state, reason: event === 'begin' ? 'circuit_open' : 'illegal', trial: false,
    rejection: { atlas_metric: 'breaker', illegal: true, phase: state?.phase || 'unknown', event },
  };
}

// Mirrors the previous note() and the trial admit. fail increments, and opens at 3 or immediately when event.trial.
// A failure that does not open leaves `until` as it was, including a second failure note after the one that opened.
export function transition(state, event) {
  const type = event?.type;
  if (!BREAKER_PHASES.includes(state?.phase) || !LEGAL.has(state.phase + ':' + type)) return illegal(state, type || 'unknown');
  if (type === 'begin') {
    if (authKeyMatches(state, event.key)) return deny(state, 'authKeyMatches', 'auth');
    if (windowStillOpen(state, event.now)) return deny(state, 'windowStillOpen', 'circuit_open');
    if (state.phase === 'open') return done({ ...state, phase: 'probing', until: 0 }, { trial: true });
    return done(state, { trial: false });
  }
  if (type === 'succeed') return done({ ...state, phase: 'closed', fails: 0, until: 0 });
  if (type === 'auth_fail') {
    const phase = state.phase === 'probing' ? 'closed' : state.phase;
    const until = state.phase === 'probing' ? 0 : state.until;
    return done({ ...state, phase, until, authKey: typeof event.key === 'string' ? event.key : state.authKey });
  }
  // A 429 or any other ignored ending never closes a probe and never starts a new open window.
  // Only succeed closes probing.
  if (type === 'ignore') return done({ ...state });
  // fail. A probing fail is the half-open trial even when the caller omits event.trial, so the phase
  // re-opens the breaker on its own. event.trial covers a trial note that arrives after the phase moved on.
  const fails = state.fails + 1;
  if (state.phase === 'probing' || event.trial || fails >= BREAKER_FAILS) return done({ ...state, phase: 'open', fails: 0, until: event.now + BREAKER_OPEN_MS });
  const until = state.phase === 'probing' ? 0 : state.until;
  return done({ ...state, phase: until > 0 ? 'open' : 'closed', fails, until });
}
