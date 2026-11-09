// Shared spend ledger for the owner-approved Plan A live test (docs/LIVE_TEST_PRIVACY_CHECK.md, docs/LIVE_TEST_BOUND.md).
// One authority (a Durable Object, live-test/entry.js) that every paid Workers AI call in the test path reserves with
// before it is made: baseline and Plan A, speech recognition, the turn model, the talker (drafts included) and speech
// synthesis. Reservations are priced at a conservative per-call ceiling from the official pricing page, never refunded
// (a cancelled or discarded request counts as billed in full), and any exhausted cap latches a hard stop. Every method
// is synchronous on in-memory state, so a single Durable Object instance decides each request atomically.
import { estimateInputTokens, audioMs } from './speculation.js';
import { workersAI } from './app.js';

export const PRICING_SOURCE = 'https://developers.cloudflare.com/workers-ai/platform/pricing/ (page last updated 2026-10-20, read 2026-11-09)';
// List prices, no free allocation assumed. smart-turn-v2: the page lists $0.00033795 per audio minute and 0.51 neurons
// per audio minute (= $0.00000561 at $0.011 per 1,000 neurons); the higher figure is used.
export const PRICES = Object.freeze({
  '@cf/deepgram/nova-3': { usdPerAudioMin: 0.0052 },
  '@cf/pipecat-ai/smart-turn-v2': { usdPerAudioMin: 0.00033795 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { usdPerMInput: 0.293, usdPerMOutput: 2.253 },
  '@cf/deepgram/aura-2-en': { usdPer1kChars: 0.030 },
  '@cf/deepgram/aura-2-es': { usdPer1kChars: 0.030 },
});
// The owner-approved caps for the live test, combined across baseline and Plan A. inputTokens was raised from 100,000
// to 800,000 on 2026-11-09 by owner decision ("raise only the input-token cap while keeping the $1.50 total"). audioRequests (speech recognition and
// turn model together) keeps the bound within $1.50 even if each audio request were billed as a full minute; the
// pricing page states no per-request minimum either way (docs/LIVE_TEST_BOUND.md).
export const CAPS = Object.freeze({ sessions: 10, turnsPerSession: 10, audioMs: 30 * 60000, audioRequests: 100, inputTokens: 800000, outputTokens: 20000, ttsChars: 20000, usd: 1.50, inFlight: 8 });
// wrangler dev reaches a remote binding through a proxy session; whether that bills as Worker usage is not stated
// (https://developers.cloudflare.com/workers/development-testing/). Every reservation therefore also carries the Workers
// Standard worst case per call (https://developers.cloudflare.com/workers/platform/pricing/, page updated 2026-10-02):
// $0.30 per million requests plus the 5-minute CPU maximum per invocation at $0.02 per million CPU ms.
export const PROXY_PER_CALL_USD = 0.30 / 1e6 + 300000 * 0.02 / 1e6;
// route: 'binding' (wrangler dev with a remote AI binding: proxy worst case per call) or 'rest' (the Workers AI REST API
// called directly; no proxy session or Worker exists on that route, so no proxy item is priced).
export const ROUTES = Object.freeze({ binding: PROXY_PER_CALL_USD, rest: 0 });
export const TURN_AUDIO_MAX_MS = 8000; // app.js turnComplete sends at most the last 8 s of audio
export const TALKER_MAX_OUTPUT = 300;  // app.js chatStream max_tokens bound (maxTokens can only lower it)
const NANO = 1e9;
const utf8 = new TextEncoder();

export class LedgerState {
  constructor({ models, caps = CAPS, prices = PRICES, saved = null, route = 'binding' } = {}) {
    if (!(route in ROUTES)) throw new Error('Unknown route: ' + route);
    this.caps = { ...caps }; this.prices = prices; this.route = route;
    this.models = { stt: models?.stt, turn: models?.turn, talker: models?.talker, tts: { en: models?.tts?.en, es: models?.tts?.es } };
    const s = saved || {};
    this.next = s.next || 0; this.stopped = s.stopped || ''; this.sessions = s.sessions || {}; this.open = s.open || {}; this.claimed = s.claimed || {};
    this.reserved = s.reserved || { requests: 0, audioMs: 0, audioRequests: 0, inputTokens: 0, outputTokens: 0, ttsChars: 0, nanoUsd: 0 };
    this.byKind = s.byKind || {}; this.refusals = s.refusals || {};
    this.observed = s.observed || { settled: 0, audioMs: 0, outputChars: 0, outputChunks: 0, ttsChars: 0, errors: 0 };
  }

  toJSON() { const { next, stopped, sessions, open, claimed, reserved, byKind, refusals, observed } = this; return { next, stopped, sessions, open, claimed, reserved, byKind, refusals, observed }; }

  refuse(reason, latch = false) {
    if (latch && !this.stopped) this.stopped = reason;
    this.refusals[reason] = (this.refusals[reason] || 0) + 1;
    return { ok: false, reason };
  }

  startSession() {
    if (this.stopped) return this.refuse('stopped');
    const n = Object.keys(this.sessions).length;
    if (n >= this.caps.sessions) return this.refuse('exhausted:sessions', true);
    const session = 's' + (n + 1);
    this.sessions[session] = { turns: 0 };
    return { ok: true, session };
  }

  startTurn(session) {
    if (this.stopped) return this.refuse('stopped');
    const s = this.sessions[session];
    if (!s) return this.refuse('unknown_session');
    if (s.turns >= this.caps.turnsPerSession) return this.refuse('exhausted:turns', true);
    s.turns += 1;
    return { ok: true, turn: s.turns };
  }

  // The per-call ceiling in nano-dollars (the provider ceiling plus the proxy worst case) and the cap units of one
  // request, or null when it cannot be priced.
  price(req) {
    const priced = this.providerPrice(req);
    return priced && { ...priced, nano: priced.nano + Math.ceil(ROUTES[this.route] * NANO) };
  }

  providerPrice(req) {
    const p = this.prices, k = req?.kind;
    const audio = () => Math.ceil(Math.max(0, Number(req.audioMs) || 0) / 1000) * 1000; // whole seconds, rounded up
    if (k === 'stt' || k === 'turn') {
      const pr = p[k === 'stt' ? this.models.stt : this.models.turn];
      if (!pr?.usdPerAudioMin) return null;
      const ms = k === 'turn' ? Math.min(audio(), TURN_AUDIO_MAX_MS) : audio();
      return { units: { audioMs: ms, audioRequests: 1 }, nano: Math.ceil(ms / 60000 * pr.usdPerAudioMin * NANO) };
    }
    if (k === 'talker' || k === 'draft') {
      const pr = p[this.models.talker], i = Math.ceil(Number(req.inputTokens)), o = Math.ceil(Number(req.outputTokens));
      if (!pr?.usdPerMInput || !(i > 0) || !(o > 0) || o > TALKER_MAX_OUTPUT) return null;
      return { units: { inputTokens: i, outputTokens: o }, nano: Math.ceil((i * pr.usdPerMInput + o * pr.usdPerMOutput) / 1e6 * NANO) };
    }
    if (k === 'tts') {
      const pr = p[this.models.tts[req.lang]], c = Math.ceil(Number(req.chars));
      if (!pr?.usdPer1kChars || !(c > 0)) return null;
      return { units: { ttsChars: c }, nano: Math.ceil(c / 1000 * pr.usdPer1kChars * NANO) };
    }
    return null;
  }

  reserve(req) {
    if (this.stopped) return this.refuse('stopped');
    if (!this.sessions[req?.session]) return this.refuse('unknown_session');
    const priced = this.price(req);
    if (!priced) return this.refuse('unpriced', true);
    if (Object.keys(this.open).length >= this.caps.inFlight) return this.refuse('concurrency');
    const r = this.reserved, u = priced.units, c = this.caps;
    for (const [unit, cap] of [['audioMs', c.audioMs], ['audioRequests', c.audioRequests], ['inputTokens', c.inputTokens], ['outputTokens', c.outputTokens], ['ttsChars', c.ttsChars]])
      if ((u[unit] || 0) && r[unit] + u[unit] > cap) return this.refuse('exhausted:' + unit, true);
    if (r.nanoUsd + priced.nano > Math.round(c.usd * NANO)) return this.refuse('exhausted:usd', true);
    for (const unit of ['audioMs', 'audioRequests', 'inputTokens', 'outputTokens', 'ttsChars']) r[unit] += u[unit] || 0;
    r.nanoUsd += priced.nano; r.requests += 1;
    this.byKind[req.kind] = (this.byKind[req.kind] || 0) + 1;
    const id = 'L' + (++this.next);
    this.open[id] = { kind: req.kind, session: req.session, nano: priced.nano, units: u };
    return { ok: true, id, usd: priced.nano / NANO };
  }

  // A request reserved earlier by the session itself (Plan A early transcription or draft) is used once, by its own kind.
  claim(id, kind, session) {
    const rec = this.open[id];
    if (!rec || this.claimed[id] || rec.session !== session || rec.kind !== kind) return false;
    this.claimed[id] = true;
    return true;
  }

  settle(id, observed = {}) {
    if (!this.open[id]) return false;
    delete this.open[id]; delete this.claimed[id];
    const o = this.observed;
    o.settled += 1; o.audioMs += observed.audioMs || 0; o.outputChars += observed.outputChars || 0; o.outputChunks += observed.outputChunks || 0; o.ttsChars += observed.ttsChars || 0;
    if (observed.error) o.errors += 1;
    return true;
  }

  snapshot() {
    return { stopped: this.stopped, caps: { ...this.caps }, sessions: Object.keys(this.sessions).length, turns: Object.values(this.sessions).reduce((n, s) => n + s.turns, 0),
      reserved: { ...this.reserved, usd: this.reserved.nanoUsd / NANO }, byKind: { ...this.byKind }, refusals: { ...this.refusals }, observed: { ...this.observed }, inFlight: Object.keys(this.open).length, route: this.route, pricing: PRICING_SOURCE };
  }
}

export const modelsOf = env => ({ stt: env.STT_MODEL, turn: env.TURN_MODEL || '@cf/pipecat-ai/smart-turn-v2', talker: env.TALKER_MODEL,
  tts: { en: env.TTS_MODEL, es: env.TTS_MODEL_ES || '@cf/deepgram/aura-2-es' } });

// A ledger bound to one session, over a Durable Object stub (or any object with the same methods).
export function ledgerClient(stub, session) {
  return { scope: 'global', session,
    reserve: req => stub.reserve({ ...req, session }), claim: (id, kind) => stub.claim(id, kind, session), settle: (id, observed) => stub.settle(id, observed) };
}

const refused = reason => Object.assign(new Error('Spend ledger refused: ' + reason), { name: 'BudgetRefused', reason });

// Every paid call goes through the ledger first. Only these methods exist: anything else (analyst, report, embeddings,
// ElevenLabs) is absent, so the test path cannot reach an unmetered paid call.
export function meteredAI(ai, ledger) {
  async function admit(req, reservedId) {
    if (reservedId) { if (await ledger.claim(reservedId, req.kind)) return reservedId; throw refused('unclaimed'); }
    const r = await ledger.reserve(req);
    if (!r?.ok) throw refused(r?.reason || 'refused');
    return r.id;
  }
  const settle = (id, observed) => Promise.resolve().then(() => ledger.settle(id, observed)).catch(() => {});
  const metered = {
    speaks: lang => lang === 'en' || lang === 'es',
    async transcribe(pcm, opts = {}) {
      const ms = audioMs(pcm), id = await admit({ kind: 'stt', audioMs: ms }, opts.reserved);
      try { const r = await ai.transcribe(pcm); settle(id, { audioMs: ms }); return r; } catch (e) { settle(id, { audioMs: ms, error: e?.name || 'Error' }); throw e; }
    },
    async turnComplete(pcm) {
      const ms = Math.min(audioMs(pcm), TURN_AUDIO_MAX_MS), id = await admit({ kind: 'turn', audioMs: ms });
      try { const r = await ai.turnComplete(pcm); settle(id, { audioMs: ms }); return r; } catch (e) { settle(id, { audioMs: ms, error: e?.name || 'Error' }); throw e; }
    },
    async synthesize(text, speaker, lang = 'en') {
      if (lang !== 'en' && lang !== 'es') throw refused('unpriced_voice');
      const chars = utf8.encode(String(text)).length, id = await admit({ kind: 'tts', chars, lang });
      try { const r = await ai.synthesize(text, speaker, lang); settle(id, { ttsChars: chars }); return r; } catch (e) { settle(id, { ttsChars: chars, error: e?.name || 'Error' }); throw e; }
    },
    async *chatStream(messages, opts = {}) {
      const kind = opts.reserved ? 'draft' : 'talker';
      const id = await admit({ kind, inputTokens: estimateInputTokens(messages), outputTokens: TALKER_MAX_OUTPUT }, opts.reserved);
      let chunks = 0, chars = 0, error;
      try {
        for await (const d of ai.chatStream(messages, { affinity: opts.affinity, maxTokens: Math.min(TALKER_MAX_OUTPUT, Number(opts.maxTokens) || TALKER_MAX_OUTPUT) })) { chunks += 1; chars += String(d).length; yield d; }
      } catch (e) { error = e?.name || 'Error'; throw e; }
      finally { settle(id, { outputChunks: chunks, outputChars: chars, error }); }
    },
  };
  // Only what the wrapped AI offers: the session treats a missing turn model differently from a refused one.
  return Object.fromEntries(Object.entries(metered).filter(([k]) => k === 'speaks' || typeof ai[k] === 'function'));
}

// The Workers AI REST API as a stand-in for the env.AI binding, so app.js workersAI keeps its exact request shapes.
// Not exported: the only way to obtain it is meteredRestAI below, which wraps every method in the ledger first.
// onCall receives timings and status codes only (never the token, the account id or any content).
function restBinding({ token, accountId, fetchImpl = fetch, onCall = () => {} }) {
  if (!token || !accountId) throw new Error('Workers AI REST credentials are missing.');
  const base = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(accountId) + '/ai/run/';
  return {
    async run(model, inputs, options = {}) {
      const headers = { authorization: 'Bearer ' + token, ...(options.extraHeaders || {}) };
      let url = base + model, body;
      if (inputs?.audio?.body) {
        const { audio, ...rest } = inputs, q = new URLSearchParams();
        for (const [k, v] of Object.entries(rest)) if (['string', 'number', 'boolean'].includes(typeof v)) q.set(k, String(v));
        body = new Uint8Array(await new Response(audio.body).arrayBuffer());
        headers['content-type'] = audio.contentType;
        if ([...q].length) url += '?' + q;
      } else { body = JSON.stringify(inputs); headers['content-type'] = 'application/json'; }
      const t0 = Date.now(), r = await fetchImpl(url, { method: 'POST', headers, body });
      const call = { model, status: r.status, headers_ms: Date.now() - t0, stream: !!inputs?.stream };
      if (!r.ok) {
        let codes = [];
        try { codes = ((await r.json())?.errors || []).map(e => e.code); } catch { /* not JSON */ }
        onCall({ ...call, codes });
        throw Object.assign(new Error(`Workers AI REST ${r.status} ${codes.join(',')}`.trim()), { name: 'RestAIError', status: r.status, codes });
      }
      if (inputs?.stream) { onCall(call); return r.body; }
      const type = r.headers.get('content-type') || '';
      if (type.includes('application/json')) {
        const j = await r.json();
        onCall({ ...call, done_ms: Date.now() - t0 });
        if (j?.success === false) throw Object.assign(new Error('Workers AI REST error ' + (j.errors || []).map(e => e.code).join(',')), { name: 'RestAIError' });
        return j?.result ?? j;
      }
      const bytes = new Uint8Array(await r.arrayBuffer());
      onCall({ ...call, done_ms: Date.now() - t0, bytes: bytes.length });
      return bytes;
    },
  };
}

// The REST route for the local live test: the client exists only inside this metered wrapper.
export function meteredRestAI(env, ledger, { token, accountId, fetchImpl, onCall } = {}) {
  const AI = restBinding({ token, accountId, fetchImpl, onCall });
  const { ELEVENLABS_API_KEY, ...safe } = env;
  return meteredAI(workersAI({ ...safe, AI }), ledger);
}
