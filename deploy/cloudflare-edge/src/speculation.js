// Plan A early processing (edge route only): at the existing early pause, an early batch transcription of the utterance
// so far, then optionally a cancellable text draft of the reply. Both are off by default, behind separate server flags,
// and both fail closed without an authoritative admission ledger. Nothing speculative is ever shown, played, voiced,
// recorded in the history, the ledger, the report or memory; it is used only when the turn ends reliably on exactly the
// same audio (and, for a draft, exactly the same reply context). See docs/EARLY_PROCESSING.md.

export const EARLY_STT_FLAG = 'EARLY_STT';     // '1': early batch transcription at the early pause
export const EARLY_DRAFT_FLAG = 'EARLY_DRAFT'; // '1' (with EARLY_STT): a cancellable text draft from that transcription
// Engineering bounds per speculative request. These are not cost caps; caps belong to the injected ledger.
export const LIMITS = Object.freeze({
  maxAudioMs: 30000,     // an utterance longer than this is not transcribed early
  perTurn: 3,            // early transcriptions per consultant turn (each mid-answer pause after new speech may start one)
  draftOutputTokens: 300, // the talker's max_tokens for a draft: the same bound as a committed reply (app.js chatStream)
  maxInputTokens: 12000, // a draft whose estimated prompt is larger is not started
  draftTimeoutMs: 8000,  // a draft not adopted by then is cancelled
  ledgerTimeoutMs: 150,  // an admission decision not made by then is a refusal
});

// Ledger contract (injectable): reserve(request) -> {ok: true, id} | {ok: false, reason}; settle(id, observed).
// reserve() is called before every speculative provider request and must count it against the caps at once, including
// requests still in flight. Reservations are never refunded: a cancelled or discarded request keeps its reservation,
// because a provider may bill audio or tokens already sent. settle() records what this process observed, separately.
// Only a ledger whose authority spans every session and instance (scope 'global') may enable the experiment.
export function speculationConfig(env = {}, ledger = null) {
  const stt = env[EARLY_STT_FLAG] === '1', draft = stt && env[EARLY_DRAFT_FLAG] === '1';
  if (!stt) return { enabled: false, reason: env[EARLY_DRAFT_FLAG] === '1' ? 'draft_without_stt' : 'off' };
  if (!ledger || typeof ledger.reserve !== 'function' || typeof ledger.settle !== 'function') return { enabled: false, reason: 'no_ledger' };
  if (ledger.scope !== 'global') return { enabled: false, reason: 'ledger_not_global' };
  return { enabled: true, stt: true, draft, ledger, limits: LIMITS };
}

// Accounting units (estimates, stated as such):
// audio: milliseconds of 24 kHz PCM16 sent (48 bytes per ms), every early request counted in full, repeats included.
export const audioMs = pcm => Math.ceil(pcm.length / 48);
// prompt tokens: an upper-bound estimate, the UTF-8 bytes of every message plus a per-message allowance for the chat
// template, assuming each token covers at least one byte. Not the provider's tokenizer count.
const encoder = new TextEncoder();
export function estimateInputTokens(messages) {
  let n = 16;
  for (const m of messages) n += encoder.encode(String(m?.content ?? '')).length + 8;
  return n;
}

// A process-local ledger with explicit caps, for tests and the local bench. Its scope is 'process' unless constructed
// otherwise: it cannot enforce a cap across Durable Object instances, so speculationConfig refuses it for deployment.
export class MemoryLedger {
  constructor(caps, { scope = 'process' } = {}) {
    if (!caps || typeof caps !== 'object') throw new Error('Explicit caps are required.');
    this.caps = { audioMs: 0, inputTokens: 0, outputTokens: 0, requests: 0, concurrent: 0, ...caps };
    this.scope = scope; this.next = 0; this.open = new Map(); this.records = [];
    this.reserved = { audioMs: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    this.observed = { audioMs: 0, outputChunks: 0, outputChars: 0, settled: 0 };
  }

  async reserve({ kind, audioMs = 0, inputTokens = 0, outputTokens = 0 } = {}) {
    const r = this.reserved, c = this.caps;
    if (this.open.size >= c.concurrent) return { ok: false, reason: 'concurrency' };
    if (r.requests + 1 > c.requests || r.audioMs + audioMs > c.audioMs || r.inputTokens + inputTokens > c.inputTokens || r.outputTokens + outputTokens > c.outputTokens) return { ok: false, reason: 'exhausted' };
    r.requests += 1; r.audioMs += audioMs; r.inputTokens += inputTokens; r.outputTokens += outputTokens;
    const id = 'r' + (++this.next), rec = { id, kind, estimate: { audioMs, inputTokens, outputTokens }, observed: null };
    this.open.set(id, rec); this.records.push(rec);
    return { ok: true, id };
  }

  async settle(id, observed = {}) {
    const rec = this.open.get(id);
    if (!rec) return;
    this.open.delete(id); rec.observed = { ...observed };
    this.observed.settled += 1;
    this.observed.audioMs += observed.audioMs || 0; this.observed.outputChunks += observed.outputChunks || 0; this.observed.outputChars += observed.outputChars || 0;
  }

  snapshot() { return { scope: this.scope, caps: { ...this.caps }, reserved: { ...this.reserved }, observed: { ...this.observed }, inFlight: this.open.size }; }
}
