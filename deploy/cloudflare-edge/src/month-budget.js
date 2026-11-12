// UTC calendar-month budget for the production spend ledger.
// docs/STATE-MACHINE-STANDARD.md is not vendored on this branch. This file follows that standard's rules:
// typed states and events, one pure transition, no I/O in the reducer, a single writer (transition), versioned
// persistence, and an unknown or legacy record maps to a deny state that is not healed into an open month.
// Callers log an illegal pair. This reducer does not log.

export const MONTH_BUDGET_VERSION = 1;
export const PHASES = Object.freeze(['open', 'denied']);
export const EVENTS = Object.freeze(['rollover', 'reserve', 'settle', 'record']);
const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export function monthKey(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) return null;
  const key = d.toISOString().slice(0, 7);
  return MONTH_RE.test(key) ? key : null;
}

export function isIllegal(result) { return !!result && result.illegal === true; }

function illegal(state, event) {
  return { illegal: true, phase: state && state.phase || 'unknown', event: event && event.type || 'unknown' };
}

function fresh(month) {
  return {
    v: MONTH_BUDGET_VERSION, phase: 'open', month, denyReason: '',
    next: 0, open: {}, reserved: { nanoUsd: 0, requests: 0 },
    observed: { nanoUsd: 0, requests: 0, unpriced: 0 },
    byKind: {}, refusals: {}, settled: { ok: 0, errors: 0 },
    overruns: { requests: 0, nanoUsd: 0 },
  };
}

function denied() {
  const s = fresh('');
  s.phase = 'denied';
  s.denyReason = 'unknown_month';
  return s;
}

function clone(state) { return JSON.parse(JSON.stringify(state)); }

function count(n) { return Number.isInteger(n) && n >= 0; }

function usable(saved) {
  const r = saved.reserved, o = saved.observed, set = saved.settled;
  return !!r && !!o && !!set && saved.open && typeof saved.open === 'object' && !Array.isArray(saved.open)
    && count(saved.next) && count(r.nanoUsd) && count(r.requests) && count(o.nanoUsd) && count(o.requests) && count(o.unpriced)
    && count(set.ok) && count(set.errors) && saved.byKind && typeof saved.byKind === 'object' && saved.refusals && typeof saved.refusals === 'object';
}

function copy(saved) {
  return {
    v: MONTH_BUDGET_VERSION, phase: 'open', month: saved.month, denyReason: '',
    next: saved.next, open: JSON.parse(JSON.stringify(saved.open)),
    reserved: { nanoUsd: saved.reserved.nanoUsd, requests: saved.reserved.requests },
    observed: { nanoUsd: saved.observed.nanoUsd, requests: saved.observed.requests, unpriced: saved.observed.unpriced },
    byKind: { ...saved.byKind }, refusals: { ...saved.refusals }, settled: { ok: saved.settled.ok, errors: saved.settled.errors },
    overruns: saved.overruns && count(saved.overruns.requests) && count(saved.overruns.nanoUsd)
      ? { requests: saved.overruns.requests, nanoUsd: saved.overruns.nanoUsd }
      : { requests: 0, nanoUsd: 0 },
  };
}

// null is a new ledger (open, no month yet). Anything else that is not version 1 of a known shape denies.
export function loadMonth(saved) {
  if (saved == null) return fresh('');
  if (typeof saved !== 'object' || saved.v !== MONTH_BUDGET_VERSION) return denied();
  if (saved.phase === 'denied') return saved.denyReason === 'unknown_month' ? denied() : denied();
  if (saved.phase !== 'open') return denied();
  if (saved.month !== '' && !MONTH_RE.test(saved.month || '')) return denied();
  if (!usable(saved)) return denied();
  return copy(saved);
}

function bump(state, reason) {
  const next = clone(state);
  next.refusals[reason] = (next.refusals[reason] || 0) + 1;
  return next;
}

// Pure. Returns the next state, or an illegal pair. It does not read the clock, storage or a limit from the environment.
export function transition(state, event) {
  if (!state || state.v !== MONTH_BUDGET_VERSION || !PHASES.includes(state.phase)) return illegal(state, event);
  if (!event || !EVENTS.includes(event.type)) return illegal(state, event);
  if (state.phase !== 'open') return illegal(state, event);
  if (event.type === 'rollover') {
    if (!MONTH_RE.test(event.month || '')) return denied();
    if (state.month === event.month) return illegal(state, event);
    if (state.month && event.month < state.month) return illegal(state, event);
    return fresh(event.month);
  }
  if (!state.month) return illegal(state, event);
  if (event.type === 'reserve') {
    if (event.limitNano == null || !Number.isInteger(event.limitNano) || event.limitNano <= 0) return bump(state, 'limit_unset');
    if (event.nano == null) return bump(state, 'unpriced');
    if (!Number.isInteger(event.nano) || event.nano < 0 || typeof event.kind !== 'string' || !event.kind) return illegal(state, event);
    if (state.reserved.nanoUsd + event.nano > event.limitNano) return bump(state, 'exhausted:usd');
    const next = clone(state);
    next.next += 1;
    next.reserved = { nanoUsd: state.reserved.nanoUsd + event.nano, requests: state.reserved.requests + 1 };
    next.byKind[event.kind] = (next.byKind[event.kind] || 0) + 1;
    const held = { kind: event.kind, nano: event.nano };
    if (Number.isInteger(event.at)) held.at = event.at;
    next.open['P' + next.next] = held;
    return next;
  }
  if (event.type === 'settle') {
    const rec = state.open[event.id];
    if (!rec) return state;
    const next = clone(state);
    delete next.open[event.id];
    const ceiling = rec.nano;
    const hasActual = Number.isInteger(event.actualNano) && event.actualNano >= 0;
    const charged = hasActual ? event.actualNano : ceiling;
    if (charged < ceiling) next.reserved.nanoUsd -= ceiling - charged;
    if (charged > ceiling) {
      const extra = charged - ceiling;
      next.reserved.nanoUsd += extra;
      next.overruns.requests += 1;
      next.overruns.nanoUsd += extra;
    }
    next.observed.nanoUsd += charged;
    next.observed.requests += 1;
    if (event.error) next.settled.errors += 1; else next.settled.ok += 1;
    return next;
  }
  const next = clone(state);
  next.observed.requests += 1;
  if (!Number.isInteger(event.nano) || event.nano < 0) next.observed.unpriced += 1;
  else next.observed.nanoUsd += event.nano;
  if (typeof event.kind === 'string' && event.kind) next.byKind[event.kind] = (next.byKind[event.kind] || 0) + 1;
  return next;
}
