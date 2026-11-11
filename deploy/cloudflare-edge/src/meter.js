// The one door to every paid upstream in the edge app: Workers AI (env.AI.run, env.AI.toMarkdown) and the paid
// provider APIs (ElevenLabs, TypeSafe JEV, Hindsight). test/ledger-coverage.test.js fails if any other source file
// calls them directly. LEDGER_MODE selects what happens around each call (docs/LEDGER_MODES.md):
//   off      (default, also when unset) the call is made exactly as before: same arguments, same result, and no ledger
//            is looked up or contacted. The estimate function is never evaluated.
//   observe  the estimate is logged (kind, model or provider, numbers only: never text) and recorded with the ledger
//            without waiting for it. The call is never blocked or delayed; a missing, failing or hanging ledger only
//            changes the log line.
//   enforce  the ledger must admit a reservation before the call is made. Over budget, an unset limit, an unpriced
//            call, a missing ledger, a ledger error or a ledger timeout refuses the call (BudgetRefused) and nothing
//            reaches the upstream. Production wrangler.jsonc sets enforce. The code default stays off.
// Any other LEDGER_MODE value is a configuration error and refuses every paid call, like enforce without a ledger.
import { ELEVENLABS_USD_PER_1K_CHARS, HINDSIGHT_USD_PER_REQUEST, PRICES, TYPESAFE_USD_PER_REQUEST, markdownFileUsd } from './prices.js';
import { isIllegal, loadMonth, monthKey, transition } from './month-budget.js';

export const LEDGER_MODES = Object.freeze(['off', 'observe', 'enforce']);
export const DEFAULT_LEDGER_MODE = 'off';
// Tony, 2026-11-11, via Jarvis 17:03 BRT: production voice spend is $5 per UTC calendar month, fail closed.
// Unset configuration uses this default. An explicit null, blank, zero, negative or unparseable value denies.
export const PRODUCTION_MONTHLY_LIMIT_USD = 5;
// Workers AI binding proxy, worst case, same formula as the live-test ledger: $0.30 / million requests plus
// 300,000 ms at $0.02 / million ms. Added to every binding call (@cf models and toMarkdown). The $1.50 live-test path is separate.
export const PROXY_PER_CALL_NANO = Math.round((0.30 / 1e6 + 300000 * 0.02 / 1e6) * 1e9);
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

// Conservative per-call ceiling in nano-dollars at list prices, or null when this request has no measurable size
// (zero audio, zero tokens, zero characters). A known kind with its canonical estimate is never null.
export function priceOf(req, prices = PRICES) {
  if (req?.provider === 'elevenlabs') {
    const c = Math.ceil(Number(req.chars));
    return c > 0 ? Math.ceil(c / 1000 * ELEVENLABS_USD_PER_1K_CHARS * NANO) : null;
  }
  if (req?.kind === 'memory' || req?.provider === 'hindsight') {
    const n = Math.ceil(Number(req.requests) || 1);
    return n > 0 ? Math.ceil(n * HINDSIGHT_USD_PER_REQUEST * NANO) : null;
  }
  if (req?.kind === 'jev' || req?.provider === 'typesafe') {
    const n = Math.ceil(Number(req.requests) || 1);
    return n > 0 ? Math.ceil(n * TYPESAFE_USD_PER_REQUEST * NANO) : null;
  }
  if (req?.kind === 'markdown') {
    const files = Math.max(1, Math.ceil(Number(req.files) || 1));
    return Math.ceil(files * markdownFileUsd() * NANO);
  }
  const pr = req?.model ? prices[req.model] : null;
  if (!pr) return null;
  if (pr.usdPerAudioMin) {
    const sec = Math.ceil((Number(req.audioMs) || 0) / 1000) * 1000, ms = req.kind === 'turn' ? Math.min(sec, TURN_AUDIO_MAX_MS) : sec;
    return ms > 0 ? Math.ceil(ms / 60000 * pr.usdPerAudioMin * NANO) : null;
  }
  if (pr.usdPerMInput != null && pr.usdPerMOutput == null) {
    const i = Math.ceil(Number(req.inputTokens));
    return i > 0 ? Math.ceil(i * pr.usdPerMInput / 1e6 * NANO) : null;
  }
  if (pr.usdPerMInput != null) {
    const i = Math.ceil(Number(req.inputTokens)), o = Math.ceil(Number(req.outputTokens));
    return i > 0 && o > 0 ? Math.ceil((i * pr.usdPerMInput + o * pr.usdPerMOutput) / 1e6 * NANO) : null;
  }
  if (pr.usdPer1kChars) { const c = Math.ceil(Number(req.chars)); return c > 0 ? Math.ceil(c / 1000 * pr.usdPer1kChars * NANO) : null; }
  return null;
}

// Admission ceiling in nano-dollars. A Workers AI binding call (a @cf model, or toMarkdown) adds the proxy worst case.
// ElevenLabs, Hindsight and TypeSafe are direct fetches and do not. A null price stays null.
export function callCeilingNano(req, prices = PRICES) {
  const base = priceOf(req, prices);
  if (base === null) return null;
  const binding = (typeof req?.model === 'string' && req.model.startsWith('@cf/')) || req?.kind === 'markdown';
  return binding ? base + PROXY_PER_CALL_NANO : base;
}

// undefined uses the $5 default. null, '', 0, a negative, or anything that is not a positive finite number denies.
export function resolveLimitUsd(value) {
  if (value === undefined) return { ok: true, usd: PRODUCTION_MONTHLY_LIMIT_USD };
  let n = value;
  if (typeof n === 'string') { const t = n.trim(); if (t === '') return { ok: false }; n = Number(t); }
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return { ok: true, usd: n };
  return { ok: false };
}

function refusalAdded(before, after) {
  for (const k of Object.keys(after.refusals)) if ((after.refusals[k] || 0) !== (before.refusals[k] || 0)) return k;
  return null;
}

function logIllegal(state, event) {
  try { console.log(JSON.stringify({ atlas_metric: 'month_budget', phase: state?.phase || 'unknown', event: event?.type || 'unknown' })); } catch { /* a log never admits a call */ }
}

// The production budget: one UTC calendar month, never refunded, reservation before the call.
// Month changes go through month-budget.js transition only. Bound as SPEND_LEDGER in wrangler.jsonc.
export class BudgetState {
  constructor({ limitUsd, prices = PRICES, saved = null, now = () => Date.now() } = {}) {
    const parsed = resolveLimitUsd(limitUsd);
    this.limitUsd = parsed.ok ? parsed.usd : null;
    this.limitNano = parsed.ok ? Math.round(parsed.usd * NANO) : null;
    this.prices = prices; this.now = now;
    this.data = loadMonth(saved);
  }
  toJSON() { return this.data; }
  restore(json) { this.data = loadMonth(json); }
  align() {
    if (this.data.phase !== 'open') return { ok: true };
    const month = monthKey(this.now());
    if (!month || month === this.data.month) return month ? { ok: true } : { ok: false, reason: 'unknown_month' };
    const next = transition(this.data, { type: 'rollover', month });
    if (isIllegal(next)) { logIllegal(this.data, { type: 'rollover' }); return { ok: false, reason: 'unknown_month' }; }
    this.data = next;
    if (this.data.phase === 'denied') return { ok: false, reason: this.data.denyReason || 'unknown_month' };
    return { ok: true };
  }
  reserve(raw) {
    const aligned = this.align();
    if (!aligned.ok) return { ok: false, reason: aligned.reason };
    if (this.data.phase === 'denied') return { ok: false, reason: this.data.denyReason || 'unknown_month' };
    const req = sanitize(raw);
    const before = this.data;
    const next = transition(before, { type: 'reserve', kind: req.kind, nano: callCeilingNano(req, this.prices), limitNano: this.limitNano });
    if (isIllegal(next)) { logIllegal(before, { type: 'reserve' }); return { ok: false, reason: 'unknown_month' }; }
    this.data = next;
    if (next.reserved.nanoUsd === before.reserved.nanoUsd) return { ok: false, reason: refusalAdded(before, next) || 'exhausted:usd' };
    return { ok: true, id: 'P' + next.next, usd: (next.reserved.nanoUsd - before.reserved.nanoUsd) / NANO };
  }
  record(raw) {
    const aligned = this.align();
    if (!aligned.ok || this.data.phase !== 'open') return { ok: false, reason: 'unknown_month' };
    const req = sanitize(raw);
    const next = transition(this.data, { type: 'record', kind: req.kind, nano: callCeilingNano(req, this.prices) });
    if (isIllegal(next)) { logIllegal(this.data, { type: 'record' }); return { ok: false, reason: 'unknown_month' }; }
    this.data = next;
    return { ok: true };
  }
  settle(id, observed = {}) {
    const aligned = this.align();
    if (!aligned.ok || this.data.phase !== 'open') return false;
    const before = this.data;
    const next = transition(before, { type: 'settle', id, error: !!observed.error });
    if (isIllegal(next) || next === before) return false;
    this.data = next;
    return true;
  }
  snapshot() {
    this.align();
    const d = this.data;
    return { month: d.month, phase: d.phase, denyReason: d.denyReason, limitUsd: this.limitUsd,
      reserved: { ...d.reserved, usd: d.reserved.nanoUsd / NANO }, observed: { ...d.observed, usd: d.observed.nanoUsd / NANO },
      byKind: { ...d.byKind }, refusals: { ...d.refusals }, settled: { ...d.settled }, inFlight: Object.keys(d.open).length };
  }
}

function configuredLimit(env, options) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'limitUsd')) return options.limitUsd;
  if (env && Object.prototype.hasOwnProperty.call(env, 'PRODUCTION_MONTHLY_LIMIT_USD')) return env.PRODUCTION_MONTHLY_LIMIT_USD;
  return undefined;
}

// Durable Object shape for the production budget (RPC methods). One writer: apply() runs load, mutate and put in order.
// Exported from worker.js and bound as SPEND_LEDGER.
export class ProductionSpendLedger {
  constructor(state, env = {}, options = {}) {
    this.storage = state.storage;
    this.limitUsd = configuredLimit(env, options);
    this.prices = options.prices;
    this.ledger = null; this.broken = false; this.tail = Promise.resolve();
  }
  async load() {
    if (this.broken) return null;
    if (this.ledger) return this.ledger;
    try {
      const saved = await this.storage.get('budget');
      this.ledger = new BudgetState({ limitUsd: this.limitUsd, prices: this.prices, saved: saved ?? null });
    } catch { this.broken = true; this.ledger = null; return null; }
    return this.ledger;
  }
  apply(f) {
    const run = this.tail.then(() => this._apply(f));
    this.tail = run.then(() => {}, () => {});
    return run;
  }
  async _apply(f) {
    const l = await this.load();
    if (!l) return { ok: false, reason: 'ledger_error' };
    const before = l.toJSON();
    let r;
    try { r = f(l); } catch { return { ok: false, reason: 'ledger_error' }; }
    try { await this.storage.put('budget', l.toJSON()); }
    catch { l.restore(before); return { ok: false, reason: 'ledger_error' }; }
    return r;
  }
  reserve(req) { return this.apply(l => l.reserve(req)); }
  record(req) { return this.apply(l => l.record(req)); }
  settle(id, observed) { return this.apply(l => l.settle(id, observed)); }
  snapshot() { return this.apply(l => l.snapshot()); }
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
