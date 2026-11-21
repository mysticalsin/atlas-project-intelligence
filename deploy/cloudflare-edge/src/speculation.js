// A29 early batch on the edge Session (APP-FIT ADAPT of f0ea602a). One Nova-3 call at the existing
// early pause, admitted only when a global spend ledger is bound. EARLY_DRAFT is a separate flag and
// still cannot start a model call: a partial must not reach the LLM, the transcript or TTS.
// The Worker passes no ledger, so both flags stay off in deployment.

export const EARLY_STT_FLAG = 'EARLY_STT';
export const EARLY_DRAFT_FLAG = 'EARLY_DRAFT';
// One early batch per consultant turn. The other numbers are engineering bounds, not a cost cap.
export const LIMITS = Object.freeze({
  maxAudioMs: 30000,
  perTurn: 1,
  ledgerTimeoutMs: 150,
});

// reserve() must count the request, including ones still in flight, before it is sent. A refusal,
// a throw, or an answer slower than ledgerTimeoutMs means the request is not sent. scope 'global'
// is the only scope whose authority spans every session. A process-local counter cannot.
export function speculationConfig(env = {}, ledger = null) {
  const stt = env[EARLY_STT_FLAG] === '1';
  if (!stt) return { enabled: false, reason: env[EARLY_DRAFT_FLAG] === '1' ? 'draft_without_stt' : 'off' };
  if (!ledger || typeof ledger.reserve !== 'function' || typeof ledger.settle !== 'function') return { enabled: false, reason: 'no_ledger' };
  if (ledger.scope !== 'global') return { enabled: false, reason: 'ledger_not_global' };
  return { enabled: true, stt: true, draft: env[EARLY_DRAFT_FLAG] === '1', ledger, limits: LIMITS };
}

// What the Session will actually run. draft is always false: the flag is recorded by speculationConfig
// and does not open a second model call. perTurn stays 1 even if a caller passes a higher limit.
export function bindEarly(speculation) {
  if (!speculation || speculation.enabled !== true || speculation.stt !== true) return null;
  const ledger = speculation.ledger;
  if (!ledger || ledger.scope !== 'global' || typeof ledger.reserve !== 'function' || typeof ledger.settle !== 'function') return null;
  return { ledger, limits: { ...LIMITS, ...(speculation.limits || {}), perTurn: 1 }, draft: false };
}

// Milliseconds of 24 kHz PCM16 (48 bytes per ms). This is what the session sends, not a bill.
export const audioMs = pcm => Math.ceil(pcm.length / 48);

// Process-local ledger for tests. scope defaults to 'process', which speculationConfig refuses.
export class MemoryLedger {
  constructor(caps, { scope = 'process' } = {}) {
    if (!caps || typeof caps !== 'object') throw new Error('Explicit caps are required.');
    this.caps = { audioMs: 0, inputTokens: 0, outputTokens: 0, requests: 0, concurrent: 0, ...caps };
    this.scope = scope;
    this.next = 0;
    this.open = new Map();
    this.records = [];
    this.reserved = { audioMs: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    this.observed = { audioMs: 0, settled: 0 };
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
  }
}
