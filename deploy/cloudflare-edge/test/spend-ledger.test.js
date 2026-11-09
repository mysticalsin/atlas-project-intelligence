// Shared spend ledger for the owner-approved Plan A live test: caps, ceilings, no refund, latching stop, claims, fail
// closed, concurrent contention from many Worker copies, and the Session's early work counted in full. Mocked AI only:
// no provider, no network, no spend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, clearPcmCache, EARLY_PAUSE, END_SILENCE } from '../src/session.js';
import { speculationConfig, MemoryLedger } from '../src/speculation.js';
import { SAMPLE_RATE } from '../src/speech.js';

const L = await import('../src/spend-ledger.js').catch(() => ({}));
const need = () => assert.ok(L.LedgerState && L.meteredAI && L.ledgerClient, 'src/spend-ledger.js with LedgerState, ledgerClient and meteredAI');
const MODELS = { stt: '@cf/deepgram/nova-3', turn: '@cf/pipecat-ai/smart-turn-v2', talker: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', tts: { en: '@cf/deepgram/aura-2-en', es: '@cf/deepgram/aura-2-es' } };
const state = (caps = {}) => new L.LedgerState({ models: MODELS, caps: { ...L.CAPS, ...caps } });
const withSession = st => ({ st, session: st.startSession().session });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('ceilings: list prices per call, audio rounded up to whole seconds, the turn model at most 8 s', () => {
  need();
  const { st, session } = withSession(state());
  const proxy = 0.0000003 + 0.006;
  near(L.PROXY_PER_CALL_USD, proxy);
  near(st.reserve({ kind: 'stt', session, audioMs: 1001 }).usd, 2 / 60 * 0.0052 + proxy);
  near(st.reserve({ kind: 'turn', session, audioMs: 30000 }).usd, 8 / 60 * 0.00033795 + proxy);
  near(st.reserve({ kind: 'talker', session, inputTokens: 10000, outputTokens: 300 }).usd, (10000 * 0.293 + 300 * 2.253) / 1e6 + proxy);
  near(st.reserve({ kind: 'tts', session, chars: 500, lang: 'en' }).usd, 0.5 * 0.030 + proxy);
  assert.equal(st.snapshot().reserved.audioMs, 2000 + 8000);
});

test('an unpriced model, voice or malformed request is refused and stops the test', () => {
  need();
  const st = new L.LedgerState({ models: { ...MODELS, stt: '@cf/openai/whisper' } }), session = st.startSession().session;
  assert.deepEqual(st.reserve({ kind: 'stt', session, audioMs: 1000 }), { ok: false, reason: 'unpriced' });
  assert.equal(st.reserve({ kind: 'talker', session, inputTokens: 10, outputTokens: 300 }).reason, 'stopped');
  const b = withSession(state());
  assert.equal(b.st.reserve({ kind: 'tts', session: b.session, chars: 10, lang: 'fr' }).reason, 'unpriced');
  assert.equal(withSession(state()).st.reserve({ kind: 'talker', session: 's1', inputTokens: 10, outputTokens: 301 }).reason, 'unpriced');
  assert.equal(withSession(state()).st.reserve({ kind: 'analyst', session: 's1' }).reason, 'unpriced');
});

test('every cap is enforced at admission and latches a hard stop', () => {
  need();
  const sessions = state();
  for (let i = 0; i < 10; i++) assert.equal(sessions.startSession().ok, true);
  assert.equal(sessions.startSession().reason, 'exhausted:sessions');
  assert.equal(sessions.reserve({ kind: 'stt', session: 's1', audioMs: 1000 }).reason, 'stopped');

  const turns = withSession(state());
  for (let i = 0; i < 10; i++) assert.equal(turns.st.startTurn(turns.session).ok, true);
  assert.equal(turns.st.startTurn(turns.session).reason, 'exhausted:turns');

  const cases = [
    ['audioMs', { kind: 'stt', audioMs: 60000 }, 30],
    ['audioRequests', { kind: 'turn', audioMs: 1000 }, 100],
    ['inputTokens', { kind: 'talker', inputTokens: 10000, outputTokens: 1 }, 10],
    ['outputTokens', { kind: 'talker', inputTokens: 1, outputTokens: 200 }, 100],
    ['ttsChars', { kind: 'tts', chars: 1000, lang: 'en' }, 20],
  ];
  for (const [unit, req, fits] of cases) {
    const { st, session } = withSession(state({ usd: 100, inFlight: 1e6 }));
    for (let i = 0; i < fits; i++) assert.equal(st.reserve({ ...req, session }).ok, true, unit + ' ' + i);
    assert.equal(st.reserve({ ...req, session }).reason, 'exhausted:' + unit);
    assert.equal(st.snapshot().stopped, 'exhausted:' + unit);
  }
  const usd = withSession(state({ usd: 0.1, inFlight: 1e6 }));
  let n = 0; while (usd.st.reserve({ kind: 'tts', session: usd.session, chars: 100, lang: 'en' }).ok) n += 1;
  assert.equal(n, 11); // each $0.003 + $0.0060003 proxy = $0.0090003; 11 = $0.0990033, the 12th would pass $0.10
  assert.equal(usd.st.snapshot().stopped, 'exhausted:usd');
  assert.ok(usd.st.snapshot().reserved.usd <= 0.1);
});

test('no refund: settling, cancelling or failing keeps the full reservation; observed amounts are separate', () => {
  need();
  const { st, session } = withSession(state());
  const a = st.reserve({ kind: 'stt', session, audioMs: 5000 }), before = st.snapshot().reserved;
  assert.equal(st.settle(a.id, { audioMs: 0, error: 'Cancelled' }), true);
  assert.equal(st.settle(a.id, {}), false);
  assert.deepEqual(st.snapshot().reserved, before);
  assert.equal(st.snapshot().observed.errors, 1);
});

test('the default caps are the approved ones', () => {
  need();
  assert.deepEqual({ ...L.CAPS, inFlight: undefined }, { sessions: 10, turnsPerSession: 10, audioMs: 1800000, audioRequests: 100, inputTokens: 100000, outputTokens: 20000, ttsChars: 20000, usd: 1.5, inFlight: undefined });
});

test('a pre-reserved request is claimed once, by its own session and kind', () => {
  need();
  const st = state(), s1 = st.startSession().session, s2 = st.startSession().session;
  const r = st.reserve({ kind: 'stt', session: s1, audioMs: 1000 });
  assert.equal(st.claim(r.id, 'stt', s2), false);
  assert.equal(st.claim(r.id, 'draft', s1), false);
  assert.equal(st.claim(r.id, 'stt', s1), true);
  assert.equal(st.claim(r.id, 'stt', s1), false);
  assert.equal(st.reserve({ kind: 'stt', session: 's9', audioMs: 1000 }).reason, 'unknown_session');
});

test('state survives a Durable Object restart, stop included', () => {
  need();
  const { st, session } = withSession(state({ usd: 0.001 }));
  st.reserve({ kind: 'tts', session, chars: 100, lang: 'en' });
  const again = new L.LedgerState({ models: MODELS, caps: { ...L.CAPS, usd: 0.001 }, saved: JSON.parse(JSON.stringify(st.toJSON())) });
  assert.deepEqual(again.snapshot(), st.snapshot());
  assert.equal(again.reserve({ kind: 'stt', session, audioMs: 1000 }).reason, 'stopped');
});

// A Durable Object stub over one LedgerState: every call crosses an async boundary with random latency, as RPC does.
const stubOf = (st, { jitter = 3, fail = false } = {}) => new Proxy({}, { get: (_, m) => async (...a) => {
  await new Promise(r => setTimeout(r, Math.random() * jitter));
  if (fail) throw Object.assign(new Error('unavailable'), { name: 'DurableObjectError' });
  return st[m](...a);
} });
function fakeAI(counter) {
  return {
    async transcribe() { counter.stt += 1; await new Promise(r => setTimeout(r, Math.random() * 3)); return { text: 'ok', language: 'en' }; },
    async turnComplete() { counter.turn += 1; return { complete: true, probability: 0.9 }; },
    async synthesize() { counter.tts += 1; return new Uint8Array(480); },
    async *chatStream() { counter.talker += 1; yield 'Which team?'; },
    async analyst() { counter.analyst += 1; return '{}'; },
  };
}

test('concurrent contention: 10 Worker copies sharing one ledger never pass the dollar cap, and every upstream call was admitted', async () => {
  need();
  const st = new L.LedgerState({ models: MODELS, caps: { ...L.CAPS, sessions: 10, usd: 0.2, inFlight: 1e6 } });
  const counter = { stt: 0, turn: 0, tts: 0, talker: 0, analyst: 0 }, denied = { n: 0 };
  const copies = await Promise.all(Array.from({ length: 10 }, async () => {
    const stub = stubOf(st), started = await stub.startSession();
    return L.meteredAI(fakeAI(counter), L.ledgerClient(stub, started.session));
  }));
  const pcm = new Uint8Array(48 * 10000);
  await Promise.all(copies.flatMap(ai => Array.from({ length: 20 }, async (_, i) => {
    try { if (i % 2) await ai.transcribe(pcm); else for await (const _d of ai.chatStream([{ role: 'user', content: 'x'.repeat(2000) }])) { /* drain */ } }
    catch (e) { assert.equal(e.name, 'BudgetRefused'); denied.n += 1; }
  })));
  const snap = st.snapshot();
  assert.ok(snap.reserved.usd <= 0.2 + 1e-12, String(snap.reserved.usd));
  assert.ok(snap.reserved.requests > 10 && snap.reserved.requests < 200, String(snap.reserved.requests));
  assert.equal(snap.stopped, 'exhausted:usd');
  assert.equal(counter.stt + counter.talker, snap.reserved.requests);
  assert.equal(counter.stt + counter.talker + denied.n, 200);
  assert.equal(snap.byKind.stt, counter.stt); assert.equal(snap.byKind.talker, counter.talker);
});

test('control: per-copy memory ledgers with the same cap overspend together, so the experiment refuses them', async () => {
  need();
  const copies = Array.from({ length: 4 }, () => new MemoryLedger({ audioMs: 60000, inputTokens: 0, outputTokens: 0, requests: 100, concurrent: 100 }));
  for (const m of copies) while ((await m.reserve({ kind: 'stt', audioMs: 10000 })).ok);
  assert.equal(copies.reduce((n, m) => n + m.snapshot().reserved.audioMs, 0), 240000); // 4x the "cap"
  assert.equal(speculationConfig({ EARLY_STT: '1' }, copies[0]).reason, 'ledger_not_global');
  const st = state(), client = L.ledgerClient(stubOf(st), st.startSession().session);
  assert.equal(speculationConfig({ EARLY_STT: '1', EARLY_DRAFT: '1' }, client).enabled, true);
});

test('fail closed: a refusal, a failing ledger or an unclaimable reservation makes no upstream call; unmetered methods are absent', async () => {
  need();
  const counter = { stt: 0, turn: 0, tts: 0, talker: 0, analyst: 0 };
  const stopped = state({ usd: 0 }), s = stopped.startSession().session;
  const refusedAI = L.meteredAI(fakeAI(counter), L.ledgerClient(stubOf(stopped), s));
  await assert.rejects(refusedAI.transcribe(new Uint8Array(4800)), { name: 'BudgetRefused' });
  const failing = L.meteredAI(fakeAI(counter), L.ledgerClient(stubOf(state(), { fail: true }), 's1'));
  await assert.rejects(failing.turnComplete(new Uint8Array(4800)), { name: 'DurableObjectError' });
  await assert.rejects(failing.synthesize('hello', 'x', 'en'), { name: 'DurableObjectError' });
  const ok = withSession(state()), ai = L.meteredAI(fakeAI(counter), L.ledgerClient(stubOf(ok.st), ok.session));
  await assert.rejects(ai.transcribe(new Uint8Array(4800), { reserved: 'L999' }), { reason: 'unclaimed' });
  await assert.rejects(ai.synthesize('hola', 'x', 'fr'), { reason: 'unpriced_voice' });
  assert.equal(ai.analyst, undefined); assert.equal(ai.report, undefined); assert.equal(ai.embed, undefined); assert.equal(ai.rankProbe, undefined);
  assert.deepEqual(counter, { stt: 0, turn: 0, tts: 0, talker: 0, analyst: 0 });
});

// The real Session with the metered wrapper and a speculation config over the same shared ledger.
function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}
const tick = () => new Promise(r => setImmediate(r));
const until = async (cond, n = 4000) => { for (let i = 0; i < n && !cond(); i++) await tick(); assert.ok(cond(), 'condition not reached'); };
async function sessionOn(st, { draft = false, stt = ['We moved the claims intake.', 'We moved the claims intake and the team adopted it.'] } = {}) {
  const clock = { t: 1000 }, counter = { stt: 0, turn: 0, tts: 0, talker: 0, analyst: 0 }, bytes = [];
  const base = fakeAI(counter);
  base.transcribe = async () => stt[Math.min(counter.stt++, stt.length - 1)];
  delete base.turnComplete;
  const stub = stubOf(st, { jitter: 0 }), client = L.ledgerClient(stub, (await stub.startSession()).session);
  const s = new Session({ io: { send() {}, sendBytes: () => bytes.push(clock.t), close() {} }, ai: L.meteredAI(base, client), csrf: 'tok', voice: 'v', model: 'm',
    now: () => clock.t, sleep: () => tick(), speculation: speculationConfig({ EARLY_STT: '1', EARLY_DRAFT: draft ? '1' : '' }, client) });
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: { title: 'Synthetic', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] }, capture: false }));
  await until(() => !s.busy() && bytes.length >= 1);
  s.playedMs[s.protectedItem] = 1e9; s.playbackDone = true;
  const feed = async segs => { for (const f of frames(segs)) { clock.t += 0.02; s.onBinary(f); await tick(); } };
  return { s, counter, feed, clock };
}

test('session: a discarded early transcription is reserved and counted in full, once, and the final one separately', async () => {
  need(); clearPcmCache();
  const st = state(), h = await sessionOn(st);
  const between = EARLY_PAUSE + (END_SILENCE - EARLY_PAUSE) / 2;
  await h.feed([[1.5, .2], [between, .001], [1.0, .2], [END_SILENCE + 0.4, .001]]);
  await until(() => h.counter.talker >= 2);
  const snap = st.snapshot();
  assert.ok(snap.byKind.stt >= 2, JSON.stringify(snap.byKind));
  assert.ok(h.counter.stt <= snap.byKind.stt); // every upstream transcription had a reservation; one withdrawn before sending keeps its own
  assert.ok(snap.reserved.audioMs >= 1500 + 2500, String(snap.reserved.audioMs)); // the discarded early audio and the final audio both counted
  assert.equal(snap.byKind.talker, h.counter.talker);
  assert.equal(snap.refusals.unclaimed, undefined);
  await h.s.end(false);
});

test('session: an early draft is reserved as a draft and claimed, never reserved twice as a reply', async () => {
  need(); clearPcmCache();
  const st = state(), h = await sessionOn(st, { draft: true, stt: ['We moved the whole claims intake to the new platform and the three regional teams adopted it within a month.'] });
  await h.feed([[1.5, .2], [EARLY_PAUSE + (END_SILENCE - EARLY_PAUSE) / 2, .001]]);
  await until(() => h.counter.talker >= 2);
  await h.feed([[END_SILENCE, .001]]);
  await until(() => !h.s.busy() && h.s.history.at(-1)?.role === 'assistant');
  await new Promise(r => setTimeout(r, 20));
  const snap = st.snapshot();
  assert.equal((snap.byKind.draft || 0) + (snap.byKind.talker || 0), h.counter.talker, JSON.stringify(snap.byKind));
  assert.equal(snap.byKind.draft, 1, JSON.stringify(snap.byKind));
  assert.equal(h.counter.talker, 2, 'opening plus the adopted draft: no separate reply call');
  assert.ok(h.counter.stt <= snap.byKind.stt);
  await h.s.end(false);
});

test('session: a stopped ledger turns early work off and leaves no unmetered call', async () => {
  need(); clearPcmCache();
  const st = state({ usd: 0.03 }), h = await sessionOn(st); // the opening and its prewarm fit; little else does
  const between = EARLY_PAUSE + (END_SILENCE - EARLY_PAUSE) / 2;
  await h.feed([[1.5, .2], [between, .001], [1.0, .2], [END_SILENCE + 0.4, .001]]);
  for (let i = 0; i < 200; i++) await tick();
  const snap = st.snapshot();
  assert.ok(snap.stopped.startsWith('exhausted:'), snap.stopped);
  assert.ok(snap.reserved.usd <= 0.03);
  assert.equal(h.counter.stt + h.counter.talker + h.counter.tts, snap.reserved.requests);
  await h.s.end(false);
});
