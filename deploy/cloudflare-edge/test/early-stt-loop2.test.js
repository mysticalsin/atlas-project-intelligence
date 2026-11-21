// Loop 2 of A29. Three findings from the Inspector FAIL of head 77e60078.
// Local fixtures and a virtual clock only: no provider, no microphone, no spend.
// These tests fail on 77e60078 and stay red until the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, clearPcmCache, EARLY_PAUSE, END_SILENCE } from '../src/session.js';
import { SAMPLE_RATE } from '../src/speech.js';

const S = await import('../src/speculation.js');

const PROJECT = { title: 'Project Falcon (synthetic)', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
const TOKEN = 'EARLY-TOKEN-A29';
const SPOKEN = 'SPOKEN-AT-END';
const DRAFT_TEXT = 'DRAFT-SHOULD-NOT-SHOW';
const open = new Set();
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); clearPcmCache(); });

const tick = () => new Promise(r => setImmediate(r));
const until = async (cond, n = 4000) => { for (let i = 0; i < n && !cond(); i++) await tick(); assert.ok(cond(), 'condition not reached'); };
const between = EARLY_PAUSE + (END_SILENCE - EARLY_PAUSE) / 2;
const wait = ms => new Promise(r => setTimeout(r, ms));

function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.subarray(i, Math.min(pcm.length, i + 960)));
  }
  return out;
}
const VOICE = s => [s, 0.2], QUIET = s => [s, 0.001];

function caps() {
  return { audioMs: 1e7, inputTokens: 1e7, outputTokens: 1e7, requests: 20, concurrent: 1 };
}

function harness({ stt = [TOKEN], ledger, draft = false, ai = {} } = {}) {
  const events = [], metrics = [], calls = { talker: 0, stt: [], tts: [], closed: 0 };
  const clock = { t: 1000 };
  const speculation = {
    enabled: true, stt: true, draft, ledger,
    limits: S.LIMITS,
  };
  const s = new Session({
    io: { send: e => events.push(JSON.parse(JSON.stringify(e))), sendBytes() {}, close() {} },
    ai: {
      async transcribe() {
        const v = stt[calls.stt.length];
        calls.stt.push(v);
        return typeof v === 'function' ? v() : v ?? '';
      },
      async synthesize() { calls.tts.push(1); return new Uint8Array(4800).fill(1); },
      async *chatStream() {
        calls.talker += 1;
        try { yield calls.talker === 1 ? 'Hello. What changed?' : DRAFT_TEXT; }
        finally { /* a normal finish is not a withdrawal */ }
      },
      ...ai,
    },
    csrf: 'tok', voice: 'asteria', model: 'test-talker', now: () => clock.t,
    sleep: () => tick(), metric: (n, v) => metrics.push([n, v]), speculation,
  });
  open.add(s);
  return { s, events, calls, clock, metrics };
}

const feed = async (h, segs) => { for (const f of frames(segs)) { h.clock.t += 0.02; h.s.onBinary(f); await tick(); } };
async function opened(h) {
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy());
  h.s.playedMs[h.s.protectedItem] = 1e9;
  h.s.playbackDone = true;
  h.clock.t += 1;
}
const named = (h, n) => h.metrics.filter(([name]) => name === n);
const users = h => h.s.history.filter(m => m.role === 'user').map(m => m.content);
const visible = h => JSON.stringify({ events: h.events, tts: h.calls.tts, history: h.s.history });

test('a reserve that succeeds after the 150 ms ledger timeout is released, so the slot and 1900 ms are not left open', async () => {
  const ledger = new S.MemoryLedger(caps(), { scope: 'global' });
  const real = ledger.reserve.bind(ledger);
  let audioMs = 0;
  let go;
  const hold = new Promise(r => { go = r; });
  ledger.reserve = async req => { audioMs = req.audioMs; await hold; return real(req); };
  const h = harness({ ledger, stt: [TOKEN] });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(0.7)]);
  await wait(250);
  assert.ok(named(h, 'early_refused').some(([, v]) => v.reason === 'timeout'), 'a ledger answer slower than 150 ms is a refusal');
  assert.equal(h.calls.stt.length, 0, 'the timed-out admission must not send audio');
  assert.equal(audioMs, 1900);
  go();
  await wait(50);
  assert.equal(ledger.open.size, 0, 'a late success must not keep the concurrency slot');
  assert.equal(ledger.reserved.audioMs, 0, 'a late success must not keep the 1900 ms of reserved audio');
  await h.s.end(false);
});

test('EARLY_DRAFT is a withdrawable talker draft, and a second and third early batch are admitted', async () => {
  const ledger = new S.MemoryLedger({ ...caps(), concurrent: 4 }, { scope: 'global' });
  const cfg = S.speculationConfig({ EARLY_STT: '1', EARLY_DRAFT: '1' }, ledger);
  const bound = S.bindEarly(cfg);
  assert.equal(cfg.draft, true);
  assert.equal(cfg.limits.perTurn, 3);
  assert.equal(bound && bound.draft, true, 'bindEarly must not force draft false');
  assert.equal(bound.limits.perTurn, 3, 'bindEarly must not force a single batch');
  assert.equal(S.speculationConfig({ EARLY_STT: 'true' }, ledger).enabled, false, 'only the exact string 1 turns the flag on');
  assert.equal(S.speculationConfig({ EARLY_STT: 'yes' }, ledger).enabled, false);

  let releaseDraft;
  const gate = new Promise(r => { releaseDraft = r; });
  const calls = { closed: 0 };
  const h = harness({
    ledger, draft: true,
    stt: [TOKEN, 'SECOND-BATCH', 'THIRD-BATCH', 'FOURTH-NOT-EARLY'],
    ai: {
      async *chatStream() {
        h.calls.talker += 1;
        try {
          yield h.calls.talker === 1 ? 'Hello. What changed?' : DRAFT_TEXT;
          if (h.calls.talker > 1) await gate;
        } finally { /* return() on a draft counts below */ }
      },
    },
  });
  // The harness ai is spread before this override loses the closed counter. Rebuild the iterator here.
  h.s.ai.chatStream = function chatStream() {
    const it = {
      yielded: false,
      async next() {
        if (this.yielded) { await gate; return { done: true, value: undefined }; }
        this.yielded = true;
        h.calls.talker += 1;
        return { done: false, value: h.calls.talker === 1 ? 'Hello. What changed?' : DRAFT_TEXT };
      },
      async return() { calls.closed += 1; releaseDraft(); return { done: true, value: undefined }; },
    };
    it[Symbol.asyncIterator] = () => it;
    return it;
  };
  await opened(h);
  const opening = h.calls.talker;
  await feed(h, [VOICE(0.8), QUIET(between)]);
  await until(() => h.calls.stt.length === 1 && h.calls.talker === opening + 1);
  assert.equal(visible(h).includes(DRAFT_TEXT), false, 'a draft is not shown, played, or written into the transcript');
  assert.equal(visible(h).includes(TOKEN), false);
  await feed(h, [VOICE(0.8), QUIET(between)]);
  await until(() => h.calls.stt.length === 2 && calls.closed >= 1);
  assert.ok(named(h, 'early_withdrawn').some(([, v]) => v.reason === 'speech'), 'speech after the pause withdraws the open batch');
  assert.ok(named(h, 'early_draft_withdrawn').some(([, v]) => v.reason === 'speech'), 'the talker draft is withdrawable');
  await feed(h, [VOICE(0.8), QUIET(between)]);
  await until(() => h.calls.stt.length === 3);
  await feed(h, [VOICE(0.8), QUIET(between)]);
  await wait(30);
  assert.equal(h.calls.stt.length, 3, 'the fourth pause is past perTurn and is not sent');
  assert.ok(named(h, 'early_skipped').some(([, v]) => v.reason === 'per_turn'));
  releaseDraft();
  await h.s.end(false);
});

test('end(true) withdraws a still-matching early batch instead of adopting it', async () => {
  const ledger = new S.MemoryLedger({ ...caps(), concurrent: 4 }, { scope: 'global' });
  const h = harness({ ledger, draft: true, stt: [TOKEN, SPOKEN] });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(between)]);
  await until(() => h.calls.stt.length === 1);
  await h.s.end(true);
  await until(() => h.s.finished);
  assert.equal(named(h, 'early_stt_used').length, 0, 'the matching early transcript is not adopted');
  assert.ok(named(h, 'early_withdrawn').some(([, v]) => v.reason === 'ended'));
  assert.equal(h.calls.stt.length, 2, 'the final words take the normal transcription');
  assert.deepEqual(users(h), [SPOKEN]);
  assert.equal(visible(h).includes(TOKEN), false);
  assert.equal(named(h, 'early_draft_adopted').length, 0);
  await h.s.end(false);
});
