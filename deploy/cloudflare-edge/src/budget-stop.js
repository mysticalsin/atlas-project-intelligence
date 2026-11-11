// The visible stop when this month's AI budget is used up.
// One pure transition. Effects (the HTTP response, the voice event, the page) run outside this file.
// docs/STATE-MACHINE-STANDARD.md is not vendored on this branch. The reducer follows its rules:
// typed states and events, no I/O, illegal pairs returned rather than thrown.

export const BUDGET_CODE = 'budget_exhausted';
export const BUDGET_MESSAGE = "This month's AI budget is used up.";
export const PHASES = Object.freeze(['pending', 'exhausted', 'closed']);
export const EVENTS = Object.freeze(['refusal']);
// Reasons the production ledger can return. Only exhausted:usd is the visible month stop.
export const REASONS = Object.freeze(['exhausted:usd', 'unpriced', 'limit_unset', 'unknown_month', 'ledger_error', 'no_ledger', 'ledger_timeout', 'invalid_mode', 'refused']);

export function isIllegal(result) { return !!result && result.illegal === true; }

function illegal(state, event) {
  return { illegal: true, phase: state && state.phase || 'unknown', event: event && event.type || 'unknown' };
}

export function transition(state, event) {
  if (!state || !PHASES.includes(state.phase) || state.phase !== 'pending') return illegal(state, event);
  if (!event || !EVENTS.includes(event.type) || !REASONS.includes(event.reason)) return illegal(state, event);
  if (event.reason === 'exhausted:usd') return { phase: 'exhausted', code: BUDGET_CODE, message: BUDGET_MESSAGE };
  return { phase: 'closed', reason: event.reason };
}

// The exhausted outcome, or null when this error is not the month stop.
export function budgetOutcome(error) {
  if (error?.name !== 'BudgetRefused' && error?.code !== BUDGET_CODE) return null;
  const next = transition({ phase: 'pending' }, { type: 'refusal', reason: error?.code === BUDGET_CODE ? 'exhausted:usd' : String(error.reason || '') });
  return next.phase === 'exhausted' ? { code: next.code, message: next.message } : null;
}

export function exhaustedError() {
  return Object.assign(new Error(BUDGET_MESSAGE), { name: 'BudgetExhausted', status: 429, code: BUDGET_CODE });
}

// { status, body } for the one HTTP shape, or null when the error is not the month stop.
export function httpBudget(error) {
  const stop = budgetOutcome(error);
  return stop ? { status: 429, body: { error: stop.message, code: stop.code } } : null;
}

// A model call that may be absent. Exhaustion is carried back; any other ledger refusal still throws.
export async function optionalModel(promise, empty) {
  try { return { value: await promise, budget: null }; }
  catch (e) {
    const stop = budgetOutcome(e);
    if (stop) return { value: empty, budget: stop };
    if (e?.name === 'BudgetRefused') throw e;
    return { value: empty, budget: null };
  }
}

// A model call whose text is the feature. Exhaustion throws the typed error; other model failures return ''.
export async function generatedText(promise) {
  try { return await promise; }
  catch (e) {
    if (budgetOutcome(e)) throw exhaustedError();
    if (e?.name === 'BudgetRefused') throw e;
    return '';
  }
}
