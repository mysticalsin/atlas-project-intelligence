// UTC calendar-month budget for the production spend ledger.
// docs/STATE-MACHINE-STANDARD.md is not vendored on this branch. This file follows that standard's rules:
// typed states and events, one pure transition, no I/O in the reducer, a single writer (transition), versioned
// persistence. Version 1 is read in place, with unsettled 0 and no carry. An unknown version is not
// loaded and must not be rewritten. A malformed known version denies and is not healed into an open month.
// Callers log an illegal pair. This reducer does not log.

export const MONTH_BUDGET_VERSION = 2;
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
    byKind: {}, refusals: {}, settled: { ok: 0, errors: 0, unsettled: 0 },
    overruns: { requests: 0, nanoUsd: 0 }, carry: null,
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
    byKind: { ...saved.byKind }, refusals: { ...saved.refusals },
    // A version 1 document has no unsettled count and no carry. Those fields default here.
    settled: { ok: saved.settled.ok, errors: saved.settled.errors, unsettled: saved.v === 1 ? 0 : (count(saved.settled.unsettled) ? saved.settled.unsettled : 0) },
    overruns: saved.overruns && count(saved.overruns.requests) && count(saved.overruns.nanoUsd)
      ? { requests: saved.overruns.requests, nanoUsd: saved.overruns.nanoUsd }
      : { requests: 0, nanoUsd: 0 },
    carry: saved.v === 1 ? null : (saved.carry && typeof saved.carry === 'object' && !Array.isArray(saved.carry) ? JSON.parse(JSON.stringify(saved.carry)) : null),
  };
}

// A future or unknown version is not a month this build can read. The caller must not replace the stored document.
export function isForeignMonth(saved) {
  return !!saved && typeof saved === 'object' && !Array.isArray(saved)
    && Object.prototype.hasOwnProperty.call(saved, 'v') && saved.v !== 1 && saved.v !== MONTH_BUDGET_VERSION;
}

// null is a new ledger (open, no month yet). Version 1 is read with the new fields defaulted.
// Any other version, or a version 1 or 2 document that is not a known shape, denies.
export function loadMonth(saved) {
  if (saved == null) return fresh('');
  if (typeof saved !== 'object' || Array.isArray(saved) || (saved.v !== 1 && saved.v !== MONTH_BUDGET_VERSION)) return denied();
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
    // One month record. Open holds move with their ids; settled spend does not. Settle finds the id here.
    const next = fresh(event.month);
    const carried = {};
    let nano = 0;
    let requests = 0;
    for (const [id, rec] of Object.entries(state.open || {})) {
      if (!rec || !Number.isInteger(rec.nano) || rec.nano < 0) continue;
      carried[id] = JSON.parse(JSON.stringify(rec));
      nano += rec.nano;
      requests += 1;
    }
    next.open = carried;
    next.next = count(state.next) ? state.next : 0;
    next.reserved = { nanoUsd: nano, requests };
    next.settled.unsettled = count(state.settled && state.settled.unsettled) ? state.settled.unsettled : 0;
    if (Object.keys(carried).length) next.carry = { ids: Object.keys(carried), nanoUsd: nano };
    else if (state.carry && typeof state.carry === 'object' && !Array.isArray(state.carry)) next.carry = JSON.parse(JSON.stringify(state.carry));
    else next.carry = null;
    return next;
  }
  if (!state.month) return illegal(state, event);
  if (event.type === 'reserve') {
    if (event.limitNano == null || !Number.isInteger(event.limitNano) || event.limitNano <= 0) return bump(state, 'limit_unset');
    if (event.nano == null) return bump(state, 'unpriced');
    if (!Number.isInteger(event.nano) || event.nano < 0 || typeof event.kind !== 'string' || !event.kind) return illegal(state, event);
    // An overrun already recorded this month. The real amount stays; the next reservation is refused.
    if (state.overruns && state.overruns.requests > 0) return bump(state, 'exhausted:usd');
    if (state.reserved.nanoUsd + event.nano > event.limitNano) return bump(state, 'exhausted:usd');
    const next = clone(state);
    next.next += 1;
    next.reserved = { nanoUsd: state.reserved.nanoUsd + event.nano, requests: state.reserved.requests + 1 };
    next.byKind[event.kind] = (next.byKind[event.kind] || 0) + 1;
    const held = { kind: event.kind, nano: event.nano };
    for (const key of ['model', 'provider', 'operation', 'media']) {
      if (typeof event[key] === 'string' && event[key]) held[key] = event[key];
    }
    if (Number.isInteger(event.at)) held.at = event.at;
    next.open['P' + next.next] = held;
    return next;
  }
  if (event.type === 'settle') {
    const rec = state.open[event.id];
    if (!rec) return state;
    // The TTL marks the hold. It stays open, still charged at its ceiling, until a real settle arrives.
    if (event.expire) {
      if (rec.expired) return state;
      const next = clone(state);
      next.open[event.id] = { ...next.open[event.id], expired: true };
      next.settled.unsettled = (next.settled.unsettled || 0) + 1;
      return next;
    }
    const next = clone(state);
    delete next.open[event.id];
    const ceiling = rec.nano;
    const hasActual = Number.isInteger(event.actualNano) && event.actualNano >= 0;
    let charged = hasActual ? event.actualNano : ceiling;
    // A late settle may raise the charge. It does not refund, so the freed room cannot admit new spend.
    if (rec.expired && charged < ceiling) charged = ceiling;
    if (rec.expired && hasActual && !event.unsettled && !event.error) next.settled.unsettled = Math.max(0, (next.settled.unsettled || 0) - 1);
    if (charged < ceiling) next.reserved.nanoUsd -= ceiling - charged;
    if (charged > ceiling) {
      const extra = charged - ceiling;
      next.reserved.nanoUsd += extra;
      next.overruns.requests += 1;
      next.overruns.nanoUsd += extra;
    }
    next.observed.nanoUsd += charged;
    next.observed.requests += 1;
    if (event.unsettled) next.settled.unsettled = (next.settled.unsettled || 0) + 1;
    else if (event.error) next.settled.errors += 1;
    else next.settled.ok += 1;
    return next;
  }
  const next = clone(state);
  next.observed.requests += 1;
  if (!Number.isInteger(event.nano) || event.nano < 0) next.observed.unpriced += 1;
  else next.observed.nanoUsd += event.nano;
  if (typeof event.kind === 'string' && event.kind) next.byKind[event.kind] = (next.byKind[event.kind] || 0) + 1;
  return next;
}
