// Plan A early processing on the edge Session (f0ea602a, APP-FIT ADAPT).
// At the existing early pause: up to three Nova-3 batches of the utterance so far, then an optional
// cancellable text draft. Both are off unless EARLY_STT is the exact string '1' and a global spend
// ledger is bound. EARLY_DRAFT is the exact string '1' and does nothing without EARLY_STT.
// The Worker passes no ledger, so both flags stay off in deployment.
// Nothing speculative is shown, played, or written into the history. A draft is adopted only when
// the early transcript was used and the reply prompt is byte-identical.

export const EARLY_STT_FLAG = 'EARLY_STT';
export const EARLY_DRAFT_FLAG = 'EARLY_DRAFT';
// Engineering bounds per speculative request. These are not cost caps; caps belong to the injected ledger.
export const LIMITS = Object.freeze({
  maxAudioMs: 30000,
  perTurn: 3,
  draftOutputTokens: 300,
  maxInputTokens: 12000,
  draftTimeoutMs: 8000,
  ledgerTimeoutMs: 150,
});

// reserve() counts the request, including ones still in flight, before it is sent.
// A refusal, a throw, or an answer slower than ledgerTimeoutMs means the request is not sent.
// scope 'global' is the only scope whose authority spans every session.
export function speculationConfig(env = {}, ledger = null) {
  const stt = env[EARLY_STT_FLAG] === '1';
  if (!stt) return { enabled: false, reason: env[EARLY_DRAFT_FLAG] === '1' ? 'draft_without_stt' : 'off' };
  if (!ledger || typeof ledger.reserve !== 'function' || typeof ledger.settle !== 'function') return { enabled: false, reason: 'no_ledger' };
  if (ledger.scope !== 'global') return { enabled: false, reason: 'ledger_not_global' };
  return { enabled: true, stt: true, draft: env[EARLY_DRAFT_FLAG] === '1', ledger, limits: LIMITS };
}

// What the Session runs. draft stays true only when speculationConfig admitted EARLY_DRAFT.
// perTurn cannot rise above LIMITS.perTurn. A caller can still ask for fewer.
export function bindEarly(speculation) {
  if (!speculation || speculation.enabled !== true || speculation.stt !== true) return null;
  const ledger = speculation.ledger;
  if (!ledger || ledger.scope !== 'global' || typeof ledger.reserve !== 'function' || typeof ledger.settle !== 'function') return null;
  const requested = Number(speculation.limits?.perTurn);
  const perTurn = Math.min(LIMITS.perTurn, Number.isFinite(requested) && requested > 0 ? requested : LIMITS.perTurn);
  return { ledger, stt: true, draft: speculation.draft === true, limits: { ...LIMITS, ...(speculation.limits || {}), perTurn } };
}

// Milliseconds of 24 kHz PCM16 (48 bytes per ms). This is what the session sends, not a bill.
export const audioMs = pcm => Math.ceil(pcm.length / 48);

// Upper bound on prompt tokens: UTF-8 bytes plus a per-message allowance. Not the provider's tokenizer.
const encoder = new TextEncoder();
export function estimateInputTokens(messages) {
  let n = 16;
  for (const m of messages) n += encoder.encode(String(m?.content ?? '')).length + 8;
  return n;
}

// Process-local ledger for tests. scope defaults to 'process', which speculationConfig refuses.
// release() undoes a reservation that was never sent. settle() does not refund a sent request.
export class MemoryLedger {
  constructor(caps, { scope = 'process' } = {}) {
    if (!caps || typeof caps !== 'object') throw new Error('Explicit caps are required.');
    this.caps = { audioMs: 0, inputTokens: 0, outputTokens: 0, requests: 0, concurrent: 0, ...caps };
    this.scope = scope;
    this.next = 0;
    this.open = new Map();
    this.records = [];
    this.reserved = { audioMs: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    this.observed = { audioMs: 0, outputChunks: 0, outputChars: 0, settled: 0 };
  }

  async reserve({ kind, audioMs = 0, inputTokens = 0, outputTokens = 0 } = {}) {
    const r = this.reserved, c = this.caps;
    if (this.open.size >= c.concurrent) return { ok: false, reason: 'concurrency' };
    if (r.requests + 1 > c.requests || r.audioMs + audioMs > c.audioMs || r.inputTokens + inputTokens > c.inputTokens || r.outputTokens + outputTokens > c.outputTokens) return { ok: false, reason: 'exhausted' };
    r.requests += 1; r.audioMs += audioMs; r.inputTokens += inputTokens; r.outputTokens += outputTokens;
    const id = 'r' + (++this.next);
    const rec = { id, kind, estimate: { audioMs, inputTokens, outputTokens }, observed: null };
    this.open.set(id, rec);
    this.records.push(rec);
    return { ok: true, id };
  }

  async settle(id, observed = {}) {
    const rec = this.open.get(id);
    if (!rec) return;
    this.open.delete(id);
    rec.observed = { ...observed };
    this.observed.settled += 1;
    this.observed.audioMs += observed.audioMs || 0;
    this.observed.outputChunks += observed.outputChunks || 0;
    this.observed.outputChars += observed.outputChars || 0;
  }

  // A reservation the session refused before sending. The slot and the estimate both come back.
  async release(id) {
    const rec = this.open.get(id);
    if (!rec) return;
    this.open.delete(id);
    const e = rec.estimate;
    this.reserved.requests -= 1;
    this.reserved.audioMs -= e.audioMs;
    this.reserved.inputTokens -= e.inputTokens;
    this.reserved.outputTokens -= e.outputTokens;
    rec.released = true;
  }

  snapshot() {
    return { scope: this.scope, caps: { ...this.caps }, reserved: { ...this.reserved }, observed: { ...this.observed }, inFlight: this.open.size };
  }
}
