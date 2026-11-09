// Owner-approved Plan A live test: a LOCAL-ONLY Worker for `wrangler dev` (docs/LIVE_TEST_BOUND.md). Never deploy it:
// it has no routes and refuses every request unless LIVE_TEST_LOCAL=1 is passed on the dev command line and the
// request comes from localhost. Every paid Workers AI call goes through the SpendLedger Durable Object first.
// Test material is synthetic speech only: scripted fictional answers voiced by Workers AI speech synthesis (metered),
// held in this process's memory and never written to disk (docs/LIVE_TEST_PRIVACY_CHECK.md).
import { DurableObject } from 'cloudflare:workers';
import { Session, clearPcmCache } from '../src/session.js';
import { workersAI } from '../src/app.js';
import { speculationConfig } from '../src/speculation.js';
import { LedgerState, ledgerClient, meteredAI, modelsOf } from '../src/spend-ledger.js';
import { SAMPLE_RATE } from '../src/speech.js';

export class SpendLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.state = new LedgerState({ models: modelsOf(env), saved: await ctx.storage.get('ledger') }); });
  }
  // Not awaited: the output gate holds each reply until the write is durable.
  save(r) { this.ctx.storage.put('ledger', this.state.toJSON()); return r; }
  startSession() { return this.save(this.state.startSession()); }
  startTurn(session) { return this.save(this.state.startTurn(session)); }
  reserve(req) { return this.save(this.state.reserve(req)); }
  claim(id, kind, session) { return this.save(this.state.claim(id, kind, session)); }
  settle(id, observed) { return this.save(this.state.settle(id, observed)); }
  snapshot() { return this.state.snapshot(); }
}

const PROJECT = { title: 'Harbour Lane claims pilot (synthetic)', role: 'Delivery lead', sector: 'Insurance', stage: 'Pilot', answers: [] };
const FRAME = 960; // 20 ms of 24 kHz PCM16
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

// Fixed-delay fake for checking the harness itself under workerd at no cost (LIVE_TEST_MOCK_AI=1). Not a measurement.
function mockAI() {
  const tone = n => { const pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer); for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(0.2 * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true); return pcm; };
  return {
    speaks: l => l === 'en',
    async transcribe() { await sleep(300); return { text: 'We moved the claims intake to the new platform.', language: 'en' }; },
    async turnComplete() { await sleep(100); return { complete: true, probability: 0.95 }; },
    async synthesize(text) { await sleep(150); return tone(Math.round(Math.min(6, 0.06 * String(text).length) * SAMPLE_RATE)); },
    async *chatStream() { await sleep(400); yield 'Thanks. '; yield 'Which team adopted it first?'; },
  };
}

const synthCache = new Map();
async function voiceOf(ai, text, voice) {
  if (!synthCache.has(text)) synthCache.set(text, await ai.synthesize(text, voice, 'en'));
  return synthCache.get(text);
}

const silence = ms => new Uint8Array(Math.round(ms * 48));
const loud = (pcm, from, to) => { const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength); for (let i = from; i + 1 < to; i += 2) if (Math.abs(dv.getInt16(i, true)) > 1000) return true; return false; };

// A browser streams microphone frames continuously, so this does too: queued audio, otherwise silence, every 20 ms on a
// drift-corrected schedule (the session ends a session whose frames stop). lastSpeech: when the last voiced frame of
// the final part of an answer was handed to the session, which is the end of speech for every timing below.
// Like the browser, it also acknowledges playback every 80 ms, as if each reply item played in real time from its first
// byte (no network, no jitter buffer, no speaker).
class Mic {
  constructor(s) { this.s = s; this.queue = []; this.on = true; this.lastSpeech = 0; this.playStart = {}; this.loop = this.run(); }
  ack() {
    const item = this.s.currentItem, sent = item ? this.s.sentMs[item] || 0 : 0;
    if (!item || !sent) return;
    this.playStart[item] ??= Date.now();
    this.s.onText(JSON.stringify({ type: 'playback', item_id: item, played_ms: Math.min(sent, Date.now() - this.playStart[item]) }));
  }
  async run() {
    const t0 = Date.now(), quiet = new Uint8Array(FRAME);
    for (let k = 1; this.on; k++) {
      const f = this.queue.shift();
      this.s.onBinary(f ? f.pcm : quiet);
      if (f?.last) this.lastSpeech = Date.now();
      if (f?.done) f.done();
      if (k % 4 === 0) this.ack();
      await sleep(Math.max(0, t0 + k * 20 - Date.now()));
    }
  }
  say(pcm, final = false) {
    return new Promise(done => {
      let lastLoud = -1;
      for (let i = 0; i < pcm.length; i += FRAME) { const f = { pcm: pcm.slice(i, i + FRAME) }; this.queue.push(f); if (final && loud(pcm, i, i + FRAME)) lastLoud = this.queue.length - 1; }
      if (lastLoud >= 0) this.queue[lastLoud].last = true;
      if (this.queue.length) this.queue.at(-1).done = done; else done();
    });
  }
  stop() { this.on = false; return this.loop; }
}

async function waitIdle(s, ms, ready = () => true) {
  const t = Date.now();
    while (Date.now() - t < ms) { if (ready() && !s.busy() && s.playbackDone) return true; await sleep(50); }
  return false;
}

// One synthetic session in one mode: an opening, then each scripted turn (parts separated by a 1.0 s mid-answer pause).
async function runSession(env, body) {
  const stub = env.SPEND_LEDGER.get(env.SPEND_LEDGER.idFromName('live-test'));
  const started = await stub.startSession();
  if (!started.ok) return { refused: started.reason, ledger: await stub.snapshot() };
  const client = ledgerClient(stub, started.session), ai = meteredAI(env.LIVE_TEST_MOCK_AI === '1' ? mockAI() : workersAI(env), client);
  const mode = body.mode, flags = mode === 'baseline' ? {} : { EARLY_STT: '1', EARLY_DRAFT: mode === 'early_draft' ? '1' : '' };
  const spec = mode === 'baseline' ? null : speculationConfig(flags, client);
  if (spec && !spec.enabled) return { refused: 'speculation_' + spec.reason };
  const marks = { last: 0, events: [], firstBytes: [], metrics: [] }, errors = [];
  clearPcmCache();
  const s = new Session({ ai, csrf: 'local', voice: 'atlas', model: env.TALKER_MODEL, speculation: spec,
    io: { send: e => marks.events.push({ t: Date.now(), type: e.type, chars: typeof e.text === 'string' ? e.text.length : undefined, code: e.code }), sendBytes: () => marks.firstBytes.push(Date.now()), close() {} },
    metric: (name, values) => marks.metrics.push({ t: Date.now(), ...values, metric: name }) });
  const turns = []; let mic = null;
  try {
    await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'local', project: PROJECT, capture: false }));
    mic = new Mic(s);
    if (!await waitIdle(s, 30000, () => marks.firstBytes.length > 0)) errors.push('opening_timeout');
    marks.opening = marks.metrics.map(({ t, ...m }) => m);
    for (const turn of body.turns || []) {
      const t = await stub.startTurn(started.session);
      if (!t.ok) { errors.push('turn_' + t.reason); break; }
      const parts = [];
      for (const text of turn.parts) parts.push(await voiceOf(ai, text, env.SYNTH_VOICE || 'arcas'));
      const from = { events: marks.events.length, bytes: marks.firstBytes.length, metrics: marks.metrics.length };
      for (let i = 0; i < parts.length; i++) { await mic.say(parts[i], i === parts.length - 1); if (i < parts.length - 1) await mic.say(silence(turn.pauseMs || 1000)); }
      const end = mic.lastSpeech, t0 = Date.now();
      while (Date.now() - t0 < 20000 && marks.firstBytes.length === from.bytes) await sleep(20);
      // Only what happens after the end of speech: a reply started and withdrawn at a mid-answer pause does not count.
      const since = (list, ok = () => true) => { const x = list.find(e => (e.t ?? e) >= end && ok(e)); return x === undefined ? null : (x.t ?? x) - end; };
      turns.push({ index: t.turn, transcript_ms: since(marks.metrics.slice(from.metrics), m => m.metric === 'stt'), first_token_ms: since(marks.events.slice(from.events), e => e.type === 'agent_text'),
        first_audio_sent_ms: since(marks.firstBytes.slice(from.bytes)), metrics: marks.metrics.slice(from.metrics).map(({ t, ...m }) => ({ ...m, at_ms: t - end })) });
      if (!await waitIdle(s, 40000)) errors.push('reply_timeout');
      await sleep(300);
    }
  } catch (e) { errors.push(e?.name === 'BudgetRefused' ? 'budget_' + e.reason : (e?.name || 'Error')); }
  finally { await mic?.stop(); await s.end(false).catch(() => errors.push('end_error')); }
  const refusals = marks.metrics.filter(m => m.metric === 'early_refused').length;
  return { mode, session: started.session, opening: marks.opening || null, tail: marks.metrics.slice(-12).map(({ t, ...m }) => m), turns, errors: [...errors, ...marks.events.filter(e => e.type === 'error').map(e => 'event_' + (e.code || 'error'))], early_refusals: refusals, ledger: await stub.snapshot() };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.LIVE_TEST_LOCAL !== '1' || !['localhost', '127.0.0.1'].includes(url.hostname)) return new Response('Not found', { status: 404 });
    if (request.method === 'GET' && url.pathname === '/ledger') return json(await env.SPEND_LEDGER.get(env.SPEND_LEDGER.idFromName('live-test')).snapshot());
    if (request.method === 'POST' && url.pathname === '/run') {
      const body = await request.json();
      if (!['baseline', 'early_stt', 'early_draft'].includes(body?.mode)) return json({ error: 'mode' }, 400);
      return json(await runSession(env, body));
    }
    return new Response('Not found', { status: 404 });
  },
};
