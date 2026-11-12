// The one door to every paid upstream in the edge app: Workers AI (env.AI.run, env.AI.toMarkdown) and the paid
// provider APIs (ElevenLabs, TypeSafe JEV, Hindsight). test/ledger-static.test.js fails if any other source file
// calls them directly. LEDGER_MODE selects what happens around each call (docs/LEDGER_MODES.md):
//   off      explicit only. The call is made exactly as before. The estimate is never evaluated. One log line says so.
//   observe  the estimate is logged (kind, model or provider, numbers only: never text) and recorded with the ledger
//            without waiting for it. The call is never blocked or delayed; a missing, failing or hanging ledger only
//            changes the log line.
//   enforce  (default, also when unset) the ledger must admit a reservation before the call is made. Over budget, an
//            unset limit, an unpriced call, a missing ledger, a ledger error or a ledger timeout refuses the call
//            (BudgetRefused) and nothing reaches the upstream. Production wrangler.jsonc sets enforce and must not set off.
// Any other LEDGER_MODE value is a configuration error and refuses every paid call.
import { ELEVENLABS_USD_PER_1K_CHARS, HINDSIGHT_RECALL_USD_PER_M, HINDSIGHT_RETAIN_USD_PER_M, LIMITS, PRICES, REALTIME_USD_PER_M_INPUT, REALTIME_USD_PER_M_OUTPUT, TYPESAFE_USD_PER_REQUEST, markdownFileUsd } from './prices.js';
export { LIMITS };
import { isIllegal, loadMonth, monthKey, transition } from './month-budget.js';
import { usageFrom } from './usage.js';

export const LEDGER_MODES = Object.freeze(['off', 'observe', 'enforce']);
export const DEFAULT_LEDGER_MODE = 'enforce';
export const RESERVATION_TTL_MS = 120000;
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

// The provider cap and the reserved output are this one number. reasoningTokens is inside it.
export function generationTokens(spec) {
  return Math.ceil(Number(spec?.maxTokens) || 0) + Math.ceil(Number(spec?.reasoningTokens) || 0);
}

// One token per UTF-8 byte of the body that is sent. A BPE token is at least one byte.
export function inputTokenCeiling(bytes) {
  const n = Math.ceil(Number(bytes) || 0);
  return n > 0 ? n : 1;
}

export function capText(text, maxChars) {
  const s = String(text ?? '');
  const n = Math.max(0, Math.floor(Number(maxChars) || 0));
  return s.length <= n ? s : s.slice(0, n);
}

// Keep the tail, on a 16-bit boundary. 24 kHz PCM16 is pcmBytesPerMs bytes per millisecond.
export function capPcm(pcm, maxAudioMs) {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm || 0);
  const maxBytes = Math.max(0, Math.floor(Number(maxAudioMs) || 0)) * LIMITS.pcmBytesPerMs;
  if (bytes.length <= maxBytes) return bytes;
  let start = bytes.length - maxBytes;
  if (start % 2) start += 1;
  return bytes.subarray(start);
}

export function realtimeReservation(seconds) {
  const spec = LIMITS.realtime;
  const raw = Math.ceil(Number(seconds) || spec.maxSeconds);
  const s = Math.max(1, Math.min(raw, spec.maxSeconds));
  const stopInput = s * spec.inputTokensPerSecond;
  const stopOutput = s * spec.outputTokensPerSecond;
  return { seconds: s, inputTokens: stopInput, outputTokens: stopOutput + spec.maxResponseTokens, stopInput, stopOutput };
}

export function boundedJevBody(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  if (utf8Length(s) > LIMITS.jev.contextTokens) {
    throw Object.assign(new Error('Story exceeds ranking context budget; prepare a reviewed shorter variant'), { status: 413 });
  }
  return s;
}

export function pdfPageCount(bytes) {
  const text = new TextDecoder('latin1').decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0));
  const matches = text.match(/\/Type\s*\/Page(?!s)/g);
  return matches ? matches.length : 0;
}

const KNOWN_DOCUMENTS = new Set(LIMITS.markdown.knownTypes || []);

function knownDocument(name, type) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (KNOWN_DOCUMENTS.has(ext)) return true;
  return /pdf|wordprocessingml|presentationml|spreadsheetml|text\/html|text\/plain|text\/csv/i.test(String(type || ''));
}

// Refuse before toMarkdown. Images are refused: detr-resnet-50 has no list price. A known document reserves the page cap.
export function markdownPlan(bytes, name = '', type = '') {
  const lim = LIMITS.markdown;
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const image = /^image\//.test(String(type)) || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(String(name));
  if (image || lim.maxImages < 1 && image) {
    return { ok: false, status: 413, code: 'unpriced_model', error: 'Image conversion is refused until detr-resnet-50 has a list price.' };
  }
  if (raw.length > lim.maxBytes) return { ok: false, status: 413, code: 'too_large', error: 'The file is larger than 10 MB.' };
  const pdf = /pdf/i.test(String(type)) || /\.pdf$/i.test(String(name)) || (raw.length >= 4 && raw[0] === 0x25 && raw[1] === 0x50 && raw[2] === 0x44 && raw[3] === 0x46);
  if (!pdf && !knownDocument(name, type)) return { ok: false, status: 415, code: 'unsupported_document', error: 'Only known document types can be converted.' };
  if (pdf && pdfPageCount(raw) > lim.maxPages) return { ok: false, status: 413, code: 'too_many_pages', error: 'The document has more pages than the conversion cap.' };
  return { ok: true, estimate: { kind: 'markdown', files: lim.maxPages, media: 'document' } };
}

function charsWithinCap(chars) {
  const c = Math.ceil(Number(chars));
  if (!(c > 0)) return null;
  if (c > LIMITS.tts.maxChars * 3) return null;
  return c;
}

export function ledgerMode(env) {
  const v = env?.LEDGER_MODE;
  if (v === undefined || v === null || v === '') return DEFAULT_LEDGER_MODE;
  return LEDGER_MODES.includes(v) ? v : 'invalid';
}

export const budgetRefused = e => e?.name === 'BudgetRefused';
const refused = reason => Object.assign(new Error('Spend ledger refused: ' + reason), { name: 'BudgetRefused', reason });

// Only these fields leave a call site: names from configuration and numbers. Never prompt, transcript or story text.
const STRING_FIELDS = ['kind', 'model', 'provider', 'lang', 'operation', 'media'];
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
const HINDSIGHT_FLAT_OPS = new Set(['list', 'forget', 'delete', 'stats', 'bank']);

export function priceOf(req, prices = PRICES) {
  if (req?.kind === 'realtime' && req?.provider === 'openai') {
    const i = Math.ceil(Number(req.inputTokens) || 0), o = Math.ceil(Number(req.outputTokens) || 0);
    if (req.settleUsage) return Math.ceil((i * REALTIME_USD_PER_M_INPUT + o * REALTIME_USD_PER_M_OUTPUT) / 1e6 * NANO);
    return i > 0 || o > 0 ? Math.ceil((i * REALTIME_USD_PER_M_INPUT + o * REALTIME_USD_PER_M_OUTPUT) / 1e6 * NANO) : null;
  }
  if (req?.kind === 'transcribe' && req?.provider === 'openai') {
    const ms = Math.ceil(Number(req.audioMs) || 0);
    if (req.settleUsage && ms === 0) return 0;
    if (!(ms > 0)) return null;
    return Math.ceil(ms / 1000 * LIMITS.realtime.transcribeUsdPerSecond * NANO);
  }
  if (req?.provider === 'elevenlabs') {
    const c = charsWithinCap(req.chars);
    return c ? Math.ceil(c / 1000 * ELEVENLABS_USD_PER_1K_CHARS * NANO) : null;
  }
  if (req?.kind === 'memory' || req?.provider === 'hindsight') {
    const tokens = Math.max(0, Math.ceil(Number(req.inputTokens) || 0) + Math.ceil(Number(req.outputTokens) || 0));
    const rate = req.operation === 'recall' ? HINDSIGHT_RECALL_USD_PER_M : HINDSIGHT_RETAIN_USD_PER_M;
    const measured = Math.ceil(Math.max(req.settleUsage ? 0 : 1, tokens) * rate / 1e6 * NANO);
    if (HINDSIGHT_FLAT_OPS.has(req.operation) && !req.settleUsage) return Math.ceil(LIMITS.hindsightOps.flatUsd * NANO);
    if (req.settleUsage) return Math.ceil(tokens * rate / 1e6 * NANO);
    return measured;
  }
  if (req?.kind === 'jev' || req?.provider === 'typesafe') {
    const n = Math.ceil(Number(req.requests) || 1);
    return n > 0 ? Math.ceil(n * TYPESAFE_USD_PER_REQUEST * NANO) : null;
  }
  if (req?.kind === 'markdown') {
    if (req.media === 'image') return null;
    const files = Math.ceil(Number(req.files) || 1);
    if (files < 1 || files > LIMITS.markdown.maxPages) return null;
    return Math.ceil(files * markdownFileUsd() * NANO);
  }
  const pr = req?.model ? prices[req.model] : null;
  if (!pr) return null;
  if (pr.usdPerAudioMin) {
    const ms = Math.ceil((Number(req.audioMs) || 0) / 1000) * 1000;
    if (!(ms > 0)) return null;
    const cap = req.kind === 'turn' ? LIMITS.turn.maxAudioMs : req.kind === 'stt' ? LIMITS.stt.maxAudioMs : null;
    if (cap != null && ms > cap) return null;
    return Math.ceil(ms / 60000 * pr.usdPerAudioMin * NANO);
  }
  if (pr.usdPerMInput != null && pr.usdPerMOutput == null) {
    const i = Math.ceil(Number(req.inputTokens));
    return i > 0 ? Math.ceil(i * pr.usdPerMInput / 1e6 * NANO) : null;
  }
  if (pr.usdPerMInput != null) {
    const i = Math.ceil(Number(req.inputTokens)), o = Math.ceil(Number(req.outputTokens));
    return i > 0 && o > 0 ? Math.ceil((i * pr.usdPerMInput + o * pr.usdPerMOutput) / 1e6 * NANO) : null;
  }
  if (pr.usdPer1kChars) { const c = charsWithinCap(req.chars); return c ? Math.ceil(c / 1000 * pr.usdPer1kChars * NANO) : null; }
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

// The production budget: one UTC calendar month. Reserve the ceiling, then settle the usage the response returns.
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
  sweep() {
    if (this.data.phase !== 'open') return;
    const now = this.now();
    for (const [id, rec] of Object.entries(this.data.open)) {
      if (Number.isInteger(rec.at) && now - rec.at <= RESERVATION_TTL_MS) continue;
      const next = transition(this.data, { type: 'settle', id, unsettled: true });
      if (!isIllegal(next)) this.data = next;
    }
  }
  reserve(raw) {
    const aligned = this.align();
    if (!aligned.ok) return { ok: false, reason: aligned.reason };
    if (this.data.phase === 'denied') return { ok: false, reason: this.data.denyReason || 'unknown_month' };
    this.sweep();
    const req = sanitize(raw);
    const before = this.data;
    const event = { type: 'reserve', kind: req.kind, nano: callCeilingNano(req, this.prices), limitNano: this.limitNano, at: this.now() };
    for (const key of ['model', 'provider', 'operation', 'media']) if (req[key]) event[key] = req[key];
    const next = transition(before, event);
    if (isIllegal(next)) { logIllegal(before, { type: 'reserve' }); return { ok: false, reason: 'unknown_month' }; }
    const id = 'P' + next.next;
    this.data = next;
    if (next.next !== before.next + 1 || !next.open[id]) return { ok: false, reason: refusalAdded(before, next) || 'exhausted:usd' };
    return { ok: true, id, usd: (next.reserved.nanoUsd - before.reserved.nanoUsd) / NANO };
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
    const rec = before.open[id];
    const usage = observed.usage && typeof observed.usage === 'object' && !Array.isArray(observed.usage) ? observed.usage : null;
    let actualNano;
    if (rec && usage) {
      const priced = priceOf({ kind: rec.kind, model: rec.model, provider: rec.provider, operation: rec.operation, media: rec.media, ...usage, settleUsage: true }, this.prices);
      if (Number.isInteger(priced) && priced >= 0) {
        const binding = (typeof rec.model === 'string' && rec.model.startsWith('@cf/')) || rec.kind === 'markdown';
        actualNano = priced + (binding ? PROXY_PER_CALL_NANO : 0);
      }
    } else if (!usage && Number.isInteger(observed.actualNano) && observed.actualNano >= 0) actualNano = observed.actualNano;
    const event = { type: 'settle', id, error: !!observed.error };
    if (actualNano !== undefined) event.actualNano = actualNano;
    const next = transition(before, event);
    if (isIllegal(next) || next === before) return false;
    this.data = next;
    if ((next.overruns?.requests || 0) > (before.overruns?.requests || 0)) {
      try { console.log(JSON.stringify({ atlas_metric: 'ledger', event: 'overrun', id: String(id), month: next.month || '' })); } catch { /* a log never hides the spend */ }
    }
    return true;
  }
  snapshot() {
    this.align();
    const d = this.data;
    const exhausted = d.phase === 'open' && (((d.overruns && d.overruns.requests > 0) || (this.limitNano != null && d.reserved.nanoUsd > this.limitNano)));
    return { month: d.month, phase: exhausted ? 'exhausted' : d.phase, exhausted, denyReason: d.denyReason, limitUsd: this.limitUsd,
      reserved: { ...d.reserved, usd: d.reserved.nanoUsd / NANO }, observed: { ...d.observed, usd: d.observed.nanoUsd / NANO },
      byKind: { ...d.byKind }, refusals: { ...d.refusals }, settled: { ...d.settled },
      overruns: { ...(d.overruns || { requests: 0, nanoUsd: 0 }) }, inFlight: Object.keys(d.open).length };
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
    this.ledger = null; this.tail = Promise.resolve();
  }
  async load() {
    if (this.ledger) return this.ledger;
    try {
      const saved = await this.storage.get('budget');
      this.ledger = new BudgetState({ limitUsd: this.limitUsd, prices: this.prices, saved: saved ?? null });
    } catch { return null; }
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
  snapshot() {
    const run = this.tail.then(async () => {
      const l = await this.load();
      if (!l) return { ok: false, reason: 'ledger_error' };
      const view = new BudgetState({ limitUsd: this.limitUsd, prices: this.prices, saved: l.toJSON() });
      return view.snapshot();
    });
    this.tail = run.then(() => {}, () => {});
    return run;
  }
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
// Each analyst attempt reserves on its own. A ledger refusal is not retried. The binding read stays in this file.
export function analystCall(env, estimate, input) {
  const door = paid(env);
  return door.run(estimate, env.ANALYST_MODEL, { ...input, reasoning: { effort: 'low' } }).catch(e => {
    if (e?.name === 'BudgetRefused') throw e;
    return door.run(estimate, env.ANALYST_MODEL, input);
  });
}

function settlementOf(out) {
  const usage = usageFrom(out);
  return usage ? { usage } : {};
}

let offLogged = false;
export function paid(env, { ledger, log = defaultLog, timeoutMs = LEDGER_TIMEOUT_MS } = {}) {
  const mode = ledgerMode(env);
  if (mode === 'off') {
    if (!offLogged) { offLogged = true; try { log({ atlas_metric: 'ledger', mode: 'off' }); } catch { /* logging never affects the call */ } }
    return {
      mode,
      run: (estimate, ...args) => env.AI.run(...args),
      toMarkdown: (estimate, ...args) => env.AI.toMarkdown(...args),
      fetch: (estimate, fetcher, ...args) => fetcher(...args),
      call: (estimate, fn) => fn(),
      hold: () => ({ run: (...args) => env.AI.run(...args), finish: async () => {} }),
    };
  }

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
    const commit = async observed => {
      try {
        const result = await l.settle(r.id, observed);
        if (result === false || (result && result.ok === false)) {
          line({ kind: req.kind }, { error: 'settle', ledger: 'settle_failed', id: r.id, reason: result?.reason || 'settle' });
          try { console.error(JSON.stringify({ atlas_metric: 'ledger', error: 'settle', ledger: 'settle_failed', id: r.id })); } catch { /* the refusal still propagates */ }
          return false;
        }
        return true;
      } catch (e) {
        line({ kind: req.kind }, { error: 'settle', ledger: 'settle_failed', id: r.id, ledger_error: e?.name || 'Error' });
        try { console.error(JSON.stringify({ atlas_metric: 'ledger', error: 'settle', ledger: 'settle_failed', id: r.id })); } catch { /* the refusal still propagates */ }
        return false;
      }
    };
    try {
      const out = await call();
      if (!(await commit(settlementOf(out)))) throw refused('ledger_error');
      return out;
    } catch (e) {
      if (e?.name === 'BudgetRefused' && e.reason === 'ledger_error') throw e;
      if (!(await commit({ error: e?.name || 'Error' }))) { try { e.ledger = 'settle_failed'; } catch { /* a frozen error still propagates */ } }
      throw e;
    }
  }

  const gate = mode === 'observe' ? observe : enforce;
  async function hold(estimate) {
    if (mode === 'off') return { run: (...args) => env.AI.run(...args), finish: async () => {} };
    if (mode === 'observe') {
      const req = estimateOf(estimate), nano = priceOf(req), usd = nano === null ? null : nano / NANO, { ledger: l, error } = book();
      if (!l) line(req, { usd, recorded: 'log_only', ...(error ? { ledger_error: error } : {}) });
      else {
        line(req, { usd, recorded: 'ledger' });
        Promise.resolve().then(() => l.record(req)).catch(e => line({ kind: req.kind }, { recorded: 'log_only', ledger_error: e?.name || 'Error' }));
      }
      return { run: (...args) => env.AI.run(...args), finish: async () => {} };
    }
    const req = estimateOf(estimate);
    const refuse = reason => { line(req, { refused: reason }); throw refused(reason); };
    if (mode === 'invalid') refuse('invalid_mode');
    const { ledger: l } = book();
    if (!l) refuse('no_ledger');
    let r;
    try { r = await withTimeout(Promise.resolve().then(() => l.reserve(req)), timeoutMs); }
    catch (e) { refuse(e?.name === 'LedgerTimeout' ? 'ledger_timeout' : 'ledger_error'); }
    if (!r?.ok || typeof r.id !== 'string') refuse(String(r?.reason || 'refused').slice(0, 40));
    const commit = async observed => {
      try {
        const result = await l.settle(r.id, observed);
        if (result === false || (result && result.ok === false)) {
          line({ kind: req.kind }, { error: 'settle', ledger: 'settle_failed', id: r.id, reason: result?.reason || 'settle' });
          return false;
        }
        return true;
      } catch (e) {
        line({ kind: req.kind }, { error: 'settle', ledger: 'settle_failed', id: r.id, ledger_error: e?.name || 'Error' });
        return false;
      }
    };
    return {
      run: (...args) => env.AI.run(...args),
      finish: async observed => { if (!(await commit(observed || {}))) throw refused('ledger_error'); },
    };
  }
  return {
    mode,
    run: (estimate, ...args) => gate(estimate, () => env.AI.run(...args)),
    toMarkdown: (estimate, ...args) => gate(estimate, () => env.AI.toMarkdown(...args)),
    fetch: (estimate, fetcher, ...args) => gate(estimate, () => fetcher(...args)),
    call: (estimate, fn) => gate(estimate, fn),
    hold,
  };
}
