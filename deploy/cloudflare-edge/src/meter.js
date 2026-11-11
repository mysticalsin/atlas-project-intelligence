// The one door to every paid upstream in the edge app: Workers AI (env.AI.run, env.AI.toMarkdown) and the paid
// provider APIs (ElevenLabs, TypeSafe JEV, Hindsight). test/ledger-static.test.js fails if any other source file
// calls them directly. LEDGER_MODE selects what happens around each call (docs/LEDGER_MODES.md):
//   off      (default, also when unset) the call is made exactly as before: same arguments, same result, and no ledger
//            is looked up or contacted. The estimate function is never evaluated.
//   observe  the estimate is logged (kind, model or provider, numbers only: never text) and recorded with the ledger
//            without waiting for it. The call is never blocked or delayed; a missing, failing or hanging ledger only
//            changes the log line.
//   enforce  the ledger must admit a reservation before the call is made. Over budget, an unset limit, an unpriced
//            call, a missing ledger, a ledger error or a ledger timeout refuses the call (BudgetRefused) and nothing
//            reaches the upstream. Opt-in only.
// Any other LEDGER_MODE value is a configuration error and refuses every paid call, like enforce without a ledger.
import { PRICES } from './prices.js';

export const LEDGER_MODES = Object.freeze(['off', 'observe', 'enforce']);
export const DEFAULT_LEDGER_MODE = 'off';
// Placeholder, deliberately unset: the production daily limit is Tony's decision (docs/LEDGER_MODES.md has a PROPOSED
// figure). While it is null, enforce refuses every paid call with 'limit_unset'.
export const PRODUCTION_DAILY_LIMIT_USD = null;
export const LEDGER_TIMEOUT_MS = 1000;
export const PRODUCTION_LEDGER_NAME = 'production';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const elevenLabsUrl = voice => `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_24000`;

const NANO = 1e9;
const utf8 = new TextEncoder();
export const utf8Length = s => utf8.encode(String(s ?? '')).length;
const TURN_AUDIO_MAX_MS = 8000;

export function ledgerMode(env) {
  const v = env?.LEDGER_MODE;
  if (v === undefined || v === null || v === '') return DEFAULT_LEDGER_MODE;
  return LEDGER_MODES.includes(v) ? v : 'invalid';
}

export const budgetRefused = e => e?.name === 'BudgetRefused';
const refused = reason => Object.assign(new Error('Spend ledger refused: ' + reason), { name: 'BudgetRefused', reason });

// Only these fields leave a call site: names from configuration and numbers. Never prompt, transcript or story text.
const STRING_FIELDS = ['kind', 'model', 'provider', 'lang'];
const NUMBER_FIELDS = ['audioMs', 'inputTokens', 'outputTokens', 'chars', 'files', 'requests'];
export function sanitize(req) {
  const out = {};
  for (const k of STRING_FIELDS) if (typeof req?.[k] === 'string') out[k] = req[k].slice(0, 80);
  for (const k of NUMBER_FIELDS) { const n = Number(req?.[k]); if (Number.isFinite(n) && n >= 0) out[k] = Math.ceil(n); }
  if (!out.kind) out.kind = 'unknown';
  return out;
}

// Conservative per-call ceiling in nano-dollars at list prices, or null when the call cannot be priced (an unpriced
// model, or any provider outside Workers AI): enforce refuses those, observe records usd: null.
export function priceOf(req, prices = PRICES) {
  const pr = req?.model ? prices[req.model] : null;
  if (!pr) return null;
  if (pr.usdPerAudioMin) {
    const sec = Math.ceil((Number(req.audioMs) || 0) / 1000) * 1000, ms = req.kind === 'turn' ? Math.min(sec, TURN_AUDIO_MAX_MS) : sec;
    return ms > 0 ? Math.ceil(ms / 60000 * pr.usdPerAudioMin * NANO) : null;
  }
  if (pr.usdPerMInput) {
    const i = Math.ceil(Number(req.inputTokens)), o = Math.ceil(Number(req.outputTokens));
    return i > 0 && o > 0 ? Math.ceil((i * pr.usdPerMInput + o * pr.usdPerMOutput) / 1e6 * NANO) : null;
  }
  if (pr.usdPer1kChars) { const c = Math.ceil(Number(req.chars)); return c > 0 ? Math.ceil(c / 1000 * pr.usdPer1kChars * NANO) : null; }
  return null;
}

// The production budget: one UTC day, never refunded, reservation before the call. Pure state; ProductionSpendLedger
// below is the Durable Object shape around it. Not bound in wrangler.jsonc: binding it is part of Tony's enable step.
export class BudgetState {
  constructor({ limitUsd = PRODUCTION_DAILY_LIMIT_USD, prices = PRICES, saved = null, now = () => Date.now() } = {}) {
    this.limitUsd = limitUsd; this.prices = prices; this.now = now;
    const s = saved || {};
    this.day = s.day || ''; this.next = s.next || 0; this.open = s.open || {};
    this.reserved = s.reserved || { requests: 0, nanoUsd: 0 }; this.observed = s.observed || { requests: 0, nanoUsd: 0, unpriced: 0 };
    this.byKind = s.byKind || {}; this.refusals = s.refusals || {}; this.settled = s.settled || { ok: 0, errors: 0 };
  }
  toJSON() { const { day, next, open, reserved, observed, byKind, refusals, settled } = this; return { day, next, open, reserved, observed, byKind, refusals, settled }; }
  roll() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.reserved = { requests: 0, nanoUsd: 0 }; this.observed = { requests: 0, nanoUsd: 0, unpriced: 0 }; this.byKind = {}; this.refusals = {}; }
  }
  refuse(reason) { this.refusals[reason] = (this.refusals[reason] || 0) + 1; return { ok: false, reason }; }
  reserve(raw) {
    this.roll();
    const req = sanitize(raw), limit = Number(this.limitUsd);
    if (this.limitUsd === null || this.limitUsd === undefined || !Number.isFinite(limit) || limit <= 0) return this.refuse('limit_unset');
    const nano = priceOf(req, this.prices);
    if (nano === null) return this.refuse('unpriced');
    if (this.reserved.nanoUsd + nano > Math.round(limit * NANO)) return this.refuse('exhausted:usd');
    this.reserved.nanoUsd += nano; this.reserved.requests += 1;
    this.byKind[req.kind] = (this.byKind[req.kind] || 0) + 1;
    const id = 'P' + (++this.next);
    this.open[id] = { kind: req.kind, nano };
    return { ok: true, id, usd: nano / NANO };
  }
  record(raw) {
    this.roll();
    const req = sanitize(raw), nano = priceOf(req, this.prices);
    this.observed.requests += 1;
    if (nano === null) this.observed.unpriced += 1; else this.observed.nanoUsd += nano;
    this.byKind[req.kind] = (this.byKind[req.kind] || 0) + 1;
    return { ok: true };
  }
  settle(id, observed = {}) {
    if (!this.open[id]) return false;
    delete this.open[id];
    if (observed.error) this.settled.errors += 1; else this.settled.ok += 1;
    return true;
  }
  snapshot() {
    this.roll();
    return { day: this.day, limitUsd: this.limitUsd, reserved: { ...this.reserved, usd: this.reserved.nanoUsd / NANO }, observed: { ...this.observed, usd: this.observed.nanoUsd / NANO },
      byKind: { ...this.byKind }, refusals: { ...this.refusals }, settled: { ...this.settled }, inFlight: Object.keys(this.open).length };
  }
}

// Durable Object shape for the production budget (RPC methods). Exported from no Worker entry and bound nowhere.
export class ProductionSpendLedger {
  constructor(state, env, { limitUsd = PRODUCTION_DAILY_LIMIT_USD } = {}) { this.storage = state.storage; this.limitUsd = limitUsd; this.ledger = null; }
  async load() { if (!this.ledger) this.ledger = new BudgetState({ limitUsd: this.limitUsd, saved: await this.storage.get('budget') }); return this.ledger; }
  async apply(f) { const l = await this.load(), r = f(l); await this.storage.put('budget', l.toJSON()); return r; }
  reserve(req) { return this.apply(l => l.reserve(req)); }
  record(req) { return this.apply(l => l.record(req)); }
  settle(id, observed) { return this.apply(l => l.settle(id, observed)); }
  async snapshot() { return (await this.load()).snapshot(); }
}

const defaultLog = line => console.log(JSON.stringify(line));

// The ledger for observe/enforce: an explicit client, else the SPEND_LEDGER Durable Object binding when present.
function resolveLedger(env, given) {
  if (given) return given;
  const ns = env?.SPEND_LEDGER;
  if (!ns || typeof ns.get !== 'function' || typeof ns.idFromName !== 'function') return null;
  return ns.get(ns.idFromName(PRODUCTION_LEDGER_NAME));
}

function withTimeout(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('ledger timeout'), { name: 'LedgerTimeout' })), ms); })])
    .finally(() => clearTimeout(timer));
}

// paid(env) -> { mode, run, toMarkdown, fetch }. Each takes an estimate function first, then exactly the arguments of
// the upstream call: run(estimate, ...args) is env.AI.run(...args); fetch(estimate, fetcher, ...args) is fetcher(...args).
export function paid(env, { ledger, log = defaultLog, timeoutMs = LEDGER_TIMEOUT_MS } = {}) {
  const mode = ledgerMode(env);
  if (mode === 'off') return {
    mode,
    run: (estimate, ...args) => env.AI.run(...args),
    toMarkdown: (estimate, ...args) => env.AI.toMarkdown(...args),
    fetch: (estimate, fetcher, ...args) => fetcher(...args),
  };

  let resolved;
  const book = () => {
    if (resolved === undefined) { try { resolved = { ledger: resolveLedger(env, ledger) }; } catch (e) { resolved = { ledger: null, error: e?.name || 'Error' }; } }
    return resolved;
  };
  const line = (req, values) => { try { log({ atlas_metric: 'ledger', mode, ...req, ...values }); } catch { /* logging never affects the call */ } };
  const estimateOf = estimate => { try { return sanitize(estimate()); } catch { return { kind: 'unknown' }; } };

  async function observe(estimate, call) {
    const req = estimateOf(estimate), nano = priceOf(req), usd = nano === null ? null : nano / NANO, { ledger: l, error } = book();
    if (!l) line(req, { usd, recorded: 'log_only', ...(error ? { ledger_error: error } : {}) });
    else {
      line(req, { usd, recorded: 'ledger' });
      Promise.resolve().then(() => l.record(req)).catch(e => line({ kind: req.kind }, { recorded: 'log_only', ledger_error: e?.name || 'Error' }));
    }
    return call();
  }

  async function enforce(estimate, call) {
    const req = estimateOf(estimate);
    const refuse = reason => { line(req, { refused: reason }); throw refused(reason); };
    if (mode === 'invalid') refuse('invalid_mode');
    const { ledger: l } = book();
    if (!l) refuse('no_ledger');
    let r;
    try { r = await withTimeout(Promise.resolve().then(() => l.reserve(req)), timeoutMs); }
    catch (e) { refuse(e?.name === 'LedgerTimeout' ? 'ledger_timeout' : 'ledger_error'); }
    if (!r?.ok || typeof r.id !== 'string') refuse(String(r?.reason || 'refused').slice(0, 40));
    const settle = observed => Promise.resolve().then(() => l.settle(r.id, observed)).catch(() => {});
    try { const out = await call(); settle({}); return out; } catch (e) { settle({ error: e?.name || 'Error' }); throw e; }
  }

  const gate = mode === 'observe' ? observe : enforce;
  return {
    mode,
    run: (estimate, ...args) => gate(estimate, () => env.AI.run(...args)),
    toMarkdown: (estimate, ...args) => gate(estimate, () => env.AI.toMarkdown(...args)),
    fetch: (estimate, fetcher, ...args) => gate(estimate, () => fetcher(...args)),
  };
}
