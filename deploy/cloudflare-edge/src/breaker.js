// Story-rating circuit breaker. Pure transitions: storyRater is the only writer and the only place that calls JEV.
// In memory for one LibraryStore. Not written to the database. loadBreaker maps a legacy {fails, openUntil, authKey}
// snapshot, or anything it does not recognise, to a safe state (closed, no auth key) so a bad snapshot cannot block
// every rating or remember a key.
export const BREAKER_VERSION = 1;
export const BREAKER_FAILS = 3;
export const BREAKER_OPEN_MS = 60000;

export const BREAKER_PHASES = Object.freeze(['closed', 'open', 'probing']);
export const BREAKER_EVENTS = Object.freeze(['begin', 'succeed', 'fail', 'auth_fail', 'ignore']);
// begin is illegal while a trial is already in flight (probing). Every other pair is legal; guards may still deny begin.
// open:succeed and open:fail are legal on purpose. A request admitted while the breaker was closed can still
// be in flight when a later failure opens it. That request has to settle. Dropping succeed or fail would leave
// the count and the window wrong. A rejection log is phase and event only, never the key.
const LEGAL = new Set([
  'closed:begin', 'open:begin',
  'closed:succeed', 'open:succeed', 'probing:succeed',
  'closed:fail', 'open:fail', 'probing:fail',
  'closed:auth_fail', 'open:auth_fail', 'probing:auth_fail',
  'closed:ignore', 'open:ignore', 'probing:ignore',
]);

const defaultLog = line => { try { console.warn(JSON.stringify(line)); } catch { /* logging never changes the decision */ } };

export function initialBreaker() {
  return { version: BREAKER_VERSION, phase: 'closed', fails: 0, until: 0, authKey: null };
}

export function authKeyMatches(state, key) {
  return state.authKey !== null && state.authKey === key;
}

// The 60 s are not over. A probing trial has already cleared `until`, so this guard is only the open window.
export function windowStillOpen(state, now) {
  return state.phase === 'open' && now < state.until;
}

function clampFails(n) {
  return Number.isInteger(n) && n >= 0 && n < BREAKER_FAILS ? n : null;
}

export function loadBreaker(raw) {
  const fresh = initialBreaker();
  if (!raw || typeof raw !== 'object') return fresh;
  const authKey = typeof raw.authKey === 'string' && raw.authKey ? raw.authKey : null;
  if (raw.version === BREAKER_VERSION && (raw.phase === 'closed' || raw.phase === 'open')) {
    if (raw.phase === 'open' && Number.isFinite(raw.until) && raw.until > 0) {
      const fails = Number.isInteger(raw.fails) && raw.fails >= 0 && raw.fails < BREAKER_FAILS ? raw.fails : 0;
      return { version: BREAKER_VERSION, phase: 'open', fails, until: raw.until, authKey };
    }
    const fails = clampFails(raw.fails);
    if (raw.phase === 'closed' && fails !== null) return { version: BREAKER_VERSION, phase: 'closed', fails, until: 0, authKey };
  }
  // A probing snapshot is mid-request. The request is gone, so this is closed rather than stuck open.
  if (raw.version === BREAKER_VERSION && raw.phase === 'probing') {
    const fails = clampFails(raw.fails);
    return { version: BREAKER_VERSION, phase: 'closed', fails: fails ?? 0, until: 0, authKey };
  }
  // Legacy in-memory shape from before the machine: { fails, openUntil, authKey }.
  if (raw.version === undefined && ('fails' in raw || 'openUntil' in raw || 'authKey' in raw)) {
    const until = Number(raw.openUntil);
    if (Number.isFinite(until) && until > 0) {
      const fails = Number.isInteger(Number(raw.fails)) && Number(raw.fails) >= 0 && Number(raw.fails) < BREAKER_FAILS ? Number(raw.fails) : 0;
      return { version: BREAKER_VERSION, phase: 'open', fails, until, authKey };
    }
    const fails = clampFails(Number(raw.fails));
    if (fails !== null) return { version: BREAKER_VERSION, phase: 'closed', fails, until: 0, authKey };
  }
  return fresh;
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
function illegal(state, event, log) {
  // ids are not on this machine. phase and event only: never the key, a story, or an address.
  log({ atlas_metric: 'breaker', illegal: true, phase: state?.phase || 'unknown', event });
  return { ok: false, illegal: true, denied: false, state, reason: event === 'begin' ? 'circuit_open' : 'illegal', trial: false };
}

// Mirrors the previous note() and the trial admit. fail increments, and opens at 3 or immediately when event.trial.
// A failure that does not open leaves `until` as it was, including a second failure note after the one that opened.
export function transition(state, event, { log = defaultLog } = {}) {
  const type = event?.type;
  if (!BREAKER_PHASES.includes(state?.phase) || !LEGAL.has(state.phase + ':' + type)) return illegal(state, type || 'unknown', log);
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
  if (type === 'ignore') {
    const phase = state.phase === 'probing' ? 'closed' : state.phase;
    const until = state.phase === 'probing' ? 0 : state.until;
    return done({ ...state, phase, until });
  }
  // fail. A probing fail is the half-open trial even when the caller omits event.trial, so the phase
  // re-opens the breaker on its own. event.trial covers a trial note that arrives after the phase moved on.
  const fails = state.fails + 1;
  if (state.phase === 'probing' || event.trial || fails >= BREAKER_FAILS) return done({ ...state, phase: 'open', fails: 0, until: event.now + BREAKER_OPEN_MS });
  const until = state.phase === 'probing' ? 0 : state.until;
  return done({ ...state, phase: until > 0 ? 'open' : 'closed', fails, until });
}
