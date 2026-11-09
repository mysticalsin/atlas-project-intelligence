// Plan A early processing: deterministic fixtures on a virtual clock with mocked AI and an in-process ledger (no model,
// no provider, no microphone, no spend). They bind the session's behaviour; they do not measure live latency or cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session, clearPcmCache, EARLY_PAUSE, END_SILENCE } from '../src/session.js';
import { workersAI } from '../src/app.js';
import { SAMPLE_RATE } from '../src/speech.js';

const S = await import('../src/speculation.js').catch(() => ({}));
const need = () => assert.ok(S.MemoryLedger && S.speculationConfig, 'src/speculation.js with MemoryLedger and speculationConfig');

const PROJECT = { title: 'Project Falcon (synthetic)', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
const LONG = 'We moved the whole claims intake to the new platform and the three regional teams adopted it within a month.';
function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}
const VOICE = s => [s, .2], QUIET = s => [s, .001];
const open = new Set();
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); clearPcmCache(); });
const tick = () => new Promise(r => setImmediate(r));
const until = async (cond, n = 4000) => { for (let i = 0; i < n && !cond(); i++) await tick(); assert.ok(cond(), 'condition not reached'); };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const ledger = (caps = {}) => new S.MemoryLedger({ audioMs: 1e7, inputTokens: 1e7, outputTokens: 1e7, requests: 1000, concurrent: 10, ...caps }, { scope: 'global' });

// stt: list of transcripts or functions (pcm, i) => value|promise, consumed in call order (early and final alike).
function harness({ stt = [], draft = false, led = null, ai = {}, session = {}, early = true, limits = {}, clock = { t: 1000 }, spec } = {}) {
  const events = [], bytes = [], metrics = [], calls = { talker: [], stt: [], tts: [], cancelled: 0, analyst: 0 };
  const base = {
    async transcribe(pcm) { const i = calls.stt.length; calls.stt.push({ t: clock.t, len: pcm.length }); const v = stt[i]; return typeof v === 'function' ? v(pcm, i) : v ?? ''; },
    async synthesize(text) { calls.tts.push({ t: clock.t, text }); return new Uint8Array(4800).fill(1); },
    async *chatStream(m, opts = {}) {
      calls.talker.push({ m, opts, t: clock.t });
      try { yield 'Thanks. '; yield 'What changed for the team?'; } finally { calls.cancelled += 0; }
    },
  };
  const speculation = spec !== undefined ? spec : early ? { enabled: true, stt: true, draft, ledger: led || (S.MemoryLedger ? ledger() : null), limits } : null;
  const s = new Session({ ...session, io: { send: e => events.push({ ...e, t: clock.t }), sendBytes: b => bytes.push(clock.t), close() {} }, ai: { ...base, ...(typeof ai === 'function' ? ai(calls, clock) : ai) },
    csrf: 'tok', voice: 'asteria', model: 'test-talker', now: () => clock.t, sleep: () => tick(), metric: (n, v) => metrics.push([n, v]), speculation });
  open.add(s);
  return { s, events, bytes, calls, clock, metrics, led: speculation?.ledger };
}
const feed = async (h, segs) => { for (const f of frames(segs)) { h.clock.t += 0.02; h.s.onBinary(f); await tick(); } };
async function opened(h) {
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 5);
  h.s.playedMs[h.s.protectedItem] = 1e9; h.s.playbackDone = true;
}
const screen = h => h.events.reduce((t, e) => e.type === 'agent_text' ? t + e.text : e.type === 'agent_retract' ? t.slice(0, t.length - Math.min(e.chars, t.length)) : t, '');
const named = (h, n) => h.metrics.filter(([m]) => m === n);
const users = h => h.s.history.filter(m => m.role === 'user').map(m => m.content);
// Client-visible output after time t: anything the browser would show or play.
const visibleAfter = (h, t) => ({ events: h.events.filter(e => e.t > t && ['agent_text', 'user_text', 'audio_turn', 'quality'].includes(e.type)).length, bytes: h.bytes.filter(x => x > t).length, tts: h.calls.tts.filter(c => c.t > t).length });
const between = EARLY_PAUSE + (END_SILENCE - EARLY_PAUSE) / 2; // a pause past the early pause that does not end the turn

test('config: off by default, separate flags, fail closed without a ledger whose authority spans every instance', () => {
  need();
  const g = ledger();
  assert.deepEqual(S.speculationConfig({}, g), { enabled: false, reason: 'off' });
  assert.deepEqual(S.speculationConfig({ EARLY_DRAFT: '1' }, g), { enabled: false, reason: 'draft_without_stt' });
  assert.deepEqual(S.speculationConfig({ EARLY_STT: '1' }, null), { enabled: false, reason: 'no_ledger' });
  assert.deepEqual(S.speculationConfig({ EARLY_STT: '1' }, new S.MemoryLedger({ requests: 1 })), { enabled: false, reason: 'ledger_not_global' });
  const stt = S.speculationConfig({ EARLY_STT: '1' }, g), both = S.speculationConfig({ EARLY_STT: '1', EARLY_DRAFT: '1' }, g);
  assert.equal(stt.enabled && stt.stt && !stt.draft, true, 'STT-only can be evaluated before drafts');
  assert.equal(both.enabled && both.draft, true);
  assert.throws(() => new S.MemoryLedger(), /Explicit caps/);
  const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /speculationConfig\(this\.env, null\)/, 'the deployed worker binds no ledger, so the flags alone cannot turn it on');
  assert.match(worker, /speculation: early/);
});

test('flags off, or flags on without a ledger: no added provider calls; the baseline transcribes once after the turn ends', async () => {
  need();
  for (const spec of [null, S.speculationConfig({}, ledger()), S.speculationConfig({ EARLY_STT: '1', EARLY_DRAFT: '1' }, null)]) {
    const h = harness({ spec, stt: ['First part and the rest of it.'] });
    await opened(h);
    await feed(h, [VOICE(1.2), QUIET(between), VOICE(1.0), QUIET(END_SILENCE + 0.3)]);
    await until(() => h.calls.talker.length === 2 && !h.s.busy());
    assert.equal(h.calls.stt.length, 1);
    assert.equal(h.calls.talker.length, 2, 'opening + one reply, no draft');
    assert.equal(h.metrics.filter(([m]) => m.startsWith('early')).length, 0);
    await h.s.end(false);
  }
});

test('STT-only phase: one early transcription at the pause is reused at a reliable end of turn; nothing reaches the client before it', async () => {
  need();
  const h = harness({ stt: [LONG] });
  await opened(h);
  await feed(h, [VOICE(1.5), QUIET(between)]);
  await until(() => h.calls.stt.length === 1);
  const pauseAt = h.clock.t, before = h.events.length;
  assert.equal(h.calls.talker.length, 1, 'no draft in the STT-only phase');
  assert.equal(h.s.history.filter(m => m.role === 'user').length, 0, 'nothing committed before the end of turn');
  assert.ok(h.events.slice(before).every(e => !['agent_text', 'user_text'].includes(e.type)));
  await feed(h, [QUIET(END_SILENCE)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.calls.stt.length, 1, 'the end of turn reused it: no second transcription');
  assert.deepEqual(users(h), [LONG]);
  assert.equal(named(h, 'early_stt_used').length, 1);
  const eot = named(h, 'stt').at(-1);
  assert.equal(eot[1].early, 1);
  const firstVisible = Math.min(...h.events.filter(e => e.t > pauseAt && e.type === 'agent_text').map(e => e.t));
  assert.ok(firstVisible >= pauseAt + (END_SILENCE - between) - 0.03, 'first reply text only after the reliable end of turn');
  assert.equal(h.led.snapshot().reserved.requests, 1);
});

test('continued speech after the early pause withdraws it; with no early request left, the whole answer takes the final batch path; no refund', async () => {
  need();
  const h = harness({ limits: { perTurn: 1 }, stt: ['We moved the claims intake.', 'We moved the claims intake, and then the three teams adopted it.'] });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(between)]);
  await until(() => h.calls.stt.length === 1);
  const reserved = h.led.snapshot().reserved.audioMs;
  await feed(h, [VOICE(1.0), QUIET(END_SILENCE + 0.2)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.calls.stt.length, 2, 'early (discarded) + final');
  assert.ok(h.calls.stt[1].len > h.calls.stt[0].len, 'the final call carries the whole answer');
  assert.deepEqual(users(h), ['We moved the claims intake, and then the three teams adopted it.']);
  assert.deepEqual(named(h, 'early_withdrawn').map(([, v]) => v.reason), ['speech']);
  const snap = h.led.snapshot();
  assert.equal(snap.reserved.audioMs, reserved, 'a withdrawn request keeps its reservation');
  assert.equal(snap.reserved.requests, 1);
  assert.equal(snap.observed.audioMs, reserved, 'observed audio is recorded separately from the estimate');
});

test('a withdrawn mid-answer request, then the final pause: only the final early request (exact audio) is reused', async () => {
  need();
  const h = harness({ stt: ['Part one.', 'Part one, and part two.'] });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(between), VOICE(1.0), QUIET(END_SILENCE + 0.2)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.calls.stt.length, 2, 'two early requests, no final call');
  assert.deepEqual(users(h), ['Part one, and part two.']);
  assert.deepEqual(named(h, 'early_withdrawn').map(([, v]) => v.reason), ['speech']);
  assert.equal(named(h, 'early_stt_used').length, 1);
  assert.equal(h.led.snapshot().reserved.requests, 2);
});

test('barge-in over an audible reply, then a pause: the interrupted reply is handled as before and the new turn is committed once', async () => {
  need();
  const gate = deferred();
  const h = harness({ stt: ['First answer.', 'Wait, one more thing.'], ai: calls => ({ async *chatStream(m) { calls.talker.push({ m }); if (calls.talker.length === 2) await gate.p; yield 'Thanks. '; yield 'What changed?'; } }) });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(END_SILENCE + 0.1)]);
  await until(() => h.s.replyTurn === 1 && h.s.busy());
  // Her reply is audible (a chunk queued) and heard well past CONTINUE_MS: speaking now is a barge-in (fed synchronously,
  // as in turn-latency.test.js, so playback cannot drain the chunk in between).
  const item = h.s.replyItem;
  h.s.sentMs[item] = 2200; h.s.queue.push({ gen: h.s.gen, item, bytes: new Uint8Array(960) });
  for (const f of frames([[1.4, .5]])) { h.clock.t += 0.02; h.s.onBinary(f); }
  assert.equal(named(h, 'barge_in').length, 1);
  gate.resolve();
  await feed(h, [QUIET(between)]);
  await until(() => h.calls.stt.length === 2);
  await feed(h, [QUIET(END_SILENCE)]);
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.deepEqual(users(h), ['First answer.', 'Wait, one more thing.']);
  assert.equal(h.calls.stt.length, 2, 'each turn used its own early transcription once');
  assert.equal(named(h, 'early_stt_used').length, 2);
});

test('multiple pauses: each new pause after new voice may start one early request (repeated audio counted), capped per turn', async () => {
  need();
  const h = harness({ stt: ['a', 'a b', 'a b c', 'a b c d final'], limits: { perTurn: 3 } });
  await opened(h);
  await feed(h, [VOICE(1.0), QUIET(between), VOICE(0.8), QUIET(between), VOICE(0.8), QUIET(between), VOICE(0.8), QUIET(between), VOICE(0.8), QUIET(END_SILENCE + 0.2)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(named(h, 'early_stt_sent').length, 3);
  assert.equal(named(h, 'early_skipped').filter(([, v]) => v.reason === 'per_turn').length, 2, 'the fourth mid-answer pause and the final pause');
  assert.equal(h.calls.stt.length, 4, 'three early + one final');
  const audio = named(h, 'early_stt_sent').reduce((n, [, v]) => n + v.audio_ms, 0);
  assert.equal(h.led.snapshot().reserved.audioMs, audio, 'every early request counted in full, repeats included');
  assert.deepEqual(users(h), ['a b c d final']);
});

test('negation after the pause: the early transcript and its draft are withdrawn, draft tokens never shown, upstream closed', async () => {
  need();
  let closed = 0;
  const gate = deferred();
  const h = harness({ draft: true, stt: ['We cut the processing cost by 40 percent.', 'We cut the processing cost by 40 percent. No, sorry, it was 14 percent, in one region.'],
    ai: calls => ({ async *chatStream(m, opts) { calls.talker.push({ m, opts }); try { if (calls.talker.length === 2) { yield 'Wow, 40 percent. '; await gate.p; } yield 'How was that measured?'; } finally { closed += 1; } } }) });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(between)]);
  await until(() => h.calls.talker.length === 2);
  const shown = screen(h);
  await feed(h, [VOICE(1.2), QUIET(END_SILENCE + 0.2)]);
  gate.resolve();
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.ok(!screen(h).includes('Wow, 40 percent'), 'the stale draft never reaches the screen');
  assert.ok(!h.s.history.some(m => m.content.includes('Wow, 40 percent')), 'nor the history');
  assert.equal(screen(h).slice(shown.length).includes('How was that measured?'), true);
  assert.deepEqual(users(h), ['We cut the processing cost by 40 percent. No, sorry, it was 14 percent, in one region.']);
  assert.ok(named(h, 'early_draft_withdrawn').some(([, v]) => v.reason === 'speech'));
  await until(() => closed >= 2);
});

test('a late early transcription (speech resumed before it returned) is discarded, never used', async () => {
  need();
  const late = deferred();
  const h = harness({ stt: [() => late.p, 'The full answer, with the second part.'] });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(between), VOICE(0.8), QUIET(END_SILENCE + 0.2)]);
  await until(() => h.calls.stt.length === 2);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  late.resolve('STALE first part');
  await until(() => named(h, 'early_late_discarded').length === 1);
  assert.deepEqual(users(h), ['The full answer, with the second part.']);
  assert.ok(!screen(h).includes('STALE'));
});

test('reordered results: an older early result finishing last never replaces the current one', async () => {
  need();
  const first = deferred();
  const h = harness({ stt: [() => first.p, 'first part and second part'] });
  await opened(h);
  await feed(h, [VOICE(1.0), QUIET(between), VOICE(0.8), QUIET(between)]);
  await until(() => h.calls.stt.length === 2);
  await feed(h, [QUIET(END_SILENCE)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  first.resolve('first part ONLY');
  await until(() => named(h, 'early_late_discarded').length === 1);
  assert.equal(h.calls.stt.length, 2, 'the current early result was reused: no final call');
  assert.deepEqual(users(h), ['first part and second part']);
});

test('draft phase: a draft composed during the pause is adopted only after the reliable end of turn; no text, audio or voice before it', async () => {
  need();
  const h = harness({ draft: true, stt: [LONG] });
  await opened(h);
  await feed(h, [VOICE(1.5), QUIET(between)]);
  await until(() => h.calls.talker.length === 2);
  const at = h.clock.t;
  await tick(); await tick();
  assert.equal(h.calls.talker[1].opts.maxTokens, 300, 'bounded output');
  assert.deepEqual(visibleAfter(h, at - between), { events: 0, bytes: 0, tts: 0 }, 'nothing visible, audible or synthesised from the draft before the end of turn');
  assert.equal(h.s.history.filter(m => m.role === 'user').length, 0);
  await feed(h, [QUIET(END_SILENCE)]);
  await until(() => !h.s.busy() && h.s.history.at(-1)?.role === 'assistant');
  assert.equal(h.calls.talker.length, 2, 'the reply adopted the draft: no second talker call');
  assert.equal(named(h, 'early_draft_adopted').length, 1);
  assert.ok(screen(h).endsWith('Thanks. What changed for the team?'));
  assert.deepEqual(users(h), [LONG]);
});

test('context change before the reply: the draft is cancelled and the reply is composed from the real context', async () => {
  need();
  let closed = 0;
  const h = harness({ draft: true, stt: [LONG], ai: calls => ({ async *chatStream(m, opts) { calls.talker.push({ m, opts }); try { yield calls.talker.length === 2 ? 'DRAFT text. ' : 'Real reply? '; } finally { closed += 1; } } }) });
  await opened(h);
  await feed(h, [VOICE(1.5), QUIET(between)]);
  await until(() => h.calls.talker.length === 2);
  h.s.guidance = { next_question: 'changed by the analyst after the draft' };
  await feed(h, [QUIET(END_SILENCE)]);
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.ok(!screen(h).includes('DRAFT'));
  assert.ok(named(h, 'early_draft_withdrawn').some(([, v]) => v.reason === 'context'));
  assert.ok(JSON.stringify(h.calls.talker[2].m).includes('changed by the analyst'));
});

test('ending (End or disconnect) during the pause withdraws everything; late results change nothing', async () => {
  need();
  for (const clean of [true, false]) {
    const sttLate = deferred(); let closed = 0;
    const h = harness({ draft: true, stt: [() => sttLate.p, 'final words'], ai: calls => ({ async *chatStream(m, opts) { calls.talker.push({ m, opts }); try { yield calls.talker.length === 1 ? 'Hello. What changed?' : 'DRAFTX'; } finally { closed += 1; } } }) });
    await opened(h);
    await feed(h, [VOICE(1.2), QUIET(between)]);
    await until(() => h.calls.stt.length === 1);
    const ending = h.s.end(clean);
    sttLate.resolve(LONG);
    await ending;
    await tick();
    assert.ok(named(h, 'early_withdrawn').some(([, v]) => v.reason === 'ended'), JSON.stringify(h.metrics.filter(([m]) => m.startsWith('early'))));
    assert.equal(h.calls.talker.length, 1, 'no draft or reply after the end');
    assert.ok(!h.events.some(e => e.type === 'agent_text' && e.text.includes('DRAFTX')));
  }
});

test('race: the end of turn arrives while the early transcription is in flight; it is awaited, not duplicated; turns stay in order', async () => {
  need();
  const slow = deferred();
  const h = harness({ stt: [() => slow.p, 'Second turn.'], ai: { async turnComplete() { return { complete: true, probability: 0.95 }; } } });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(EARLY_PAUSE + 0.1)]);
  await until(() => h.calls.stt.length === 1 && h.s.sttBusy === 1);
  slow.resolve('First turn.');
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.calls.stt.length, 1);
  h.s.playedMs[h.s.replyItem] = 1e9; h.s.playbackDone = true;
  await feed(h, [QUIET(1.5), VOICE(1.2), QUIET(EARLY_PAUSE + 0.1)]);
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.deepEqual(users(h), ['First turn.', 'Second turn.']);
});

test('an early transcription that fails falls back to the normal call exactly once; no duplicate commit', async () => {
  need();
  const h = harness({ stt: [() => Promise.reject(Object.assign(new Error('x'), { name: 'AiError' })), LONG] });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(between)]);
  await until(() => h.calls.stt.length === 1);
  await feed(h, [QUIET(END_SILENCE)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.calls.stt.length, 2);
  assert.deepEqual(users(h), [LONG]);
  assert.equal(named(h, 'early_stt_fallback').length, 1);
});

test('concurrent budget: one shared ledger refuses a second in-flight request from another session; that interview is unaffected', async () => {
  need();
  const led = ledger({ concurrent: 1 }), hold = deferred(), clock = { t: 1000 };
  const a = harness({ led, clock, stt: [() => hold.p] }), b = harness({ led, clock: { t: 1000 }, stt: ['B answer.'] });
  await opened(a); await opened(b);
  await feed(a, [VOICE(1.2), QUIET(between)]);
  await until(() => a.calls.stt.length === 1);
  await feed(b, [VOICE(1.2), QUIET(between)]);
  await until(() => named(b, 'early_refused').length === 1);
  assert.equal(named(b, 'early_refused')[0][1].reason, 'concurrency');
  assert.equal(b.calls.stt.length, 0, 'refused before any request');
  await feed(b, [QUIET(END_SILENCE)]);
  await until(() => b.calls.talker.length === 2 && !b.s.busy());
  assert.deepEqual(users(b), ['B answer.']);
  assert.equal(b.s.earlyOff, '', 'a concurrency refusal does not stop later attempts');
  hold.resolve('A');
});

test('cap exhaustion stops admission for the session; later turns use the baseline path only', async () => {
  need();
  const led = ledger({ requests: 1 });
  const h = harness({ led, stt: ['One.', 'Two, final.'], ai: { async turnComplete() { return { complete: true, probability: 0.95 }; } } });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(EARLY_PAUSE + 0.1)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  h.s.playedMs[h.s.replyItem] = 1e9; h.s.playbackDone = true;
  await feed(h, [QUIET(1.5), VOICE(1.2), QUIET(EARLY_PAUSE + 0.1)]);
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.equal(named(h, 'early_refused')[0][1].reason, 'exhausted');
  assert.equal(h.s.earlyOff, 'exhausted');
  assert.equal(h.calls.stt.length, 2, 'one early (reused) + one baseline');
  assert.deepEqual(users(h), ['One.', 'Two, final.']);
  assert.equal(led.snapshot().reserved.requests, 1);
});

test('an unavailable or slow ledger fails closed: no early request, the interview continues', async () => {
  need();
  for (const bad of [{ scope: 'global', reserve() { throw new Error('down'); }, settle() {} },
    { scope: 'global', reserve: () => new Promise(() => {}), settle() {} }]) {
    const h = harness({ led: bad, limits: { ledgerTimeoutMs: 5 }, stt: [LONG] });
    await opened(h);
    await feed(h, [VOICE(1.2), QUIET(between)]);
    await until(() => named(h, 'early_refused').length === 1);
    await feed(h, [QUIET(END_SILENCE)]);
    await until(() => h.calls.talker.length === 2 && !h.s.busy());
    assert.equal(h.calls.stt.length, 1, 'only the baseline transcription');
    assert.ok(['unavailable', 'timeout'].includes(h.s.earlyOff));
    assert.deepEqual(users(h), [LONG]);
  }
});

test('duration and prompt bounds: long audio is not sent early; an oversized draft prompt is not started', async () => {
  need();
  const h = harness({ limits: { maxAudioMs: 500 }, stt: [LONG] });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(between)]);
  await tick();
  assert.equal(named(h, 'early_skipped')[0][1].reason, 'duration');
  assert.equal(h.calls.stt.length, 0);
  const d = harness({ draft: true, limits: { maxInputTokens: 10 }, stt: [LONG] });
  await opened(d);
  await feed(d, [VOICE(1.2), QUIET(between)]);
  await until(() => named(d, 'early_skipped').length === 1);
  assert.equal(named(d, 'early_skipped')[0][1].reason, 'draft_input');
  assert.equal(d.calls.talker.length, 1);
});

test('accounting: estimates and observations are separate; estimates are upper bounds stated in their own units', () => {
  need();
  assert.equal(S.audioMs(new Uint8Array(48000)), 1000);
  const m = [{ role: 'system', content: 'abc' }, { role: 'user', content: 'é' }];
  assert.equal(S.estimateInputTokens(m), 16 + 3 + 8 + 2 + 8);
  const L = ledger({ requests: 2, outputTokens: 300 });
  return (async () => {
    const r = await L.reserve({ kind: 'draft', inputTokens: 100, outputTokens: 300 });
    assert.equal((await L.reserve({ kind: 'draft', inputTokens: 1, outputTokens: 1 })).reason, 'exhausted');
    await L.settle(r.id, { outputChunks: 2, outputChars: 20, cancelled: 1 });
    const snap = L.snapshot();
    assert.deepEqual(snap.reserved, { audioMs: 0, inputTokens: 100, outputTokens: 300, requests: 1 }, 'no refund after a cancelled draft');
    assert.equal(snap.observed.outputChars, 20);
    assert.equal(snap.inFlight, 0);
  })();
});

test('workersAI: maxTokens can only lower the talker bound', async () => {
  const seen = [];
  const env = { TALKER_MODEL: 't', AI: { async run(model, inputs) { seen.push(inputs.max_tokens); return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: [DONE]\n')); c.close(); } }); } } };
  for (const maxTokens of [undefined, 50, 1000]) for await (const _ of workersAI(env).chatStream([], { maxTokens })) { /* drain */ }
  assert.deepEqual(seen, [300, 50, 300]);
});

// run65, session 8, turn 2: smart-turn was unsure (0.62) at a mid-answer pause, so the silence rule ended the turn and the
// adopted draft started playing. The rest of the answer, spoken with ordinary gaps between words, began as her reply
// became audible and was never heard: under the barge-in gate (4x level, 450 ms of unbroken loud audio) it was not speech.
const WORDS = Array.from({ length: 6 }, () => [VOICE(0.3), QUIET(0.1)]).flat(); // about 2.4 s of speech with word gaps
const PART1 = 'I owned the routing rules myself.', PART2 = 'The regional team adopted them in the second month.';
function midAnswer({ echo = false } = {}) {
  let long = false;
  const h = harness({ draft: true, stt: [PART1, echo ? 'Thanks, that is a clear example of ownership.' : PART2],
    ai: calls => ({
      async turnComplete() { return { complete: true, probability: 0.62 }; },
      async *chatStream(m, opts) { calls.talker.push({ m, opts }); if (!long) { yield 'Hello. Where shall we start?'; return; } yield 'Thanks, that is a clear example of ownership. '; yield 'What changed for the team?'; },
      async synthesize(text) { calls.tts.push({ t: calls.clock?.t, text }); return new Uint8Array(long ? 48000 * 5 : 4800).fill(1); }, // her reply: 5 s each piece
    }) });
  return { h, speakLong: () => { long = true; } };
}

test('a turn ended at a mid-answer pause: the rest of the answer, spoken as her reply starts, is heard and merged into the same turn', async () => {
  need();
  const { h, speakLong } = midAnswer();
  await opened(h);
  speakLong();
  await feed(h, [VOICE(1.2), QUIET(END_SILENCE + 0.1)]); // part one, then a pause the silence rule ends (the turn model was unsure)
  // Only until her reply is first heard (the virtual clock moves only with microphone frames, so waiting longer would play it all).
  const n0 = h.bytes.length; await until(() => named(h, 'early_draft_adopted').length === 1 && h.bytes.length > n0 && h.s.audible());
  assert.deepEqual(users(h), [PART1], 'the turn ended at the pause');
  await feed(h, [...WORDS, QUIET(END_SILENCE + 0.2)]); // ...and they carry on while her reply is playing
  for (let i = 0; i < 20000 && !(h.calls.talker.length === 3 && !h.s.busy()); i++) await tick();
  assert.deepEqual(users(h), [PART1 + ' ' + PART2], 'one turn: nothing they said is dropped');
  assert.equal(named(h, 'turn_resumed').length, 1, 'a continuation, not a barge-in');
  assert.equal(named(h, 'barge_in').length, 0);
  assert.equal(named(h, 'reply_withdrawn').length, 1, 'the reply to the first part is taken back');
  assert.ok(h.calls.talker[2].m.some(m => m.role === 'user' && m.content === PART1 + ' ' + PART2), 'the next reply answers the whole answer');
  assert.ok(!h.s.history.some(m => m.content.includes('[interrupted')), 'not recorded as an interruption');
});

test('the same window does not let her own voice withdraw her reply: an echo is transcribed, ignored, and she carries on', async () => {
  need();
  const { h, speakLong } = midAnswer({ echo: true });
  await opened(h);
  speakLong();
  await feed(h, [VOICE(1.2), QUIET(END_SILENCE + 0.1)]);
  const n0 = h.bytes.length; await until(() => named(h, 'early_draft_adopted').length === 1 && h.bytes.length > n0 && h.s.audible());
  await feed(h, [...WORDS, QUIET(END_SILENCE + 0.2)]); // the microphone picks up her own words
  for (let i = 0; i < 20000 && !named(h, 'echo_ignored').length && h.calls.talker.length < 3; i++) await tick();
  for (let i = 0; i < 50; i++) await tick();
  assert.equal(named(h, 'echo_ignored').length, 1, 'heard and transcribed, then recognised as her own words');
  assert.equal(named(h, 'reply_withdrawn').length, 0, 'no withdrawal on the sound alone');
  assert.equal(h.calls.talker.length, 2, 'no new reply');
  assert.deepEqual(users(h), [PART1]);
});

// run67: the hold itself. Her reply has two pieces, both already queued for playback when the consultant carries on;
// the browser acknowledges playback as it happens, so the pump runs in (virtual) real time.
const FIRST = 'Thanks, that is a clear example of ownership.', SECOND = 'Which teams used the rules first?';
function held({ second = PART2, third } = {}) {
  let long = false;
  const h = harness({ draft: true, stt: [PART1, second, ...(third ? [third] : [])],
    ai: calls => ({
      async turnComplete() { return { complete: true, probability: 0.62 }; },
      async *chatStream(m, opts) { calls.talker.push({ m, opts }); if (!long) { yield 'Hello. Where shall we start?'; return; } if (calls.talker.length === 2) { yield FIRST + ' '; yield SECOND; } else yield 'What changed for the team?'; },
      async synthesize(text) { calls.tts.push({ text }); return new Uint8Array(!long ? 4800 : text === FIRST ? 48000 * 0.5 : 48000 * 5).fill(1); },
    }) });
  return { h, speakLong: () => { long = true; } };
}
const feedAck = async (h, segs) => {
  for (const f of frames(segs)) {
    h.clock.t += 0.02; h.s.onBinary(f); await tick();
    const item = h.s.currentItem; if (item && h.s.sentMs[item]) await h.s.onText(JSON.stringify({ type: 'playback', item_id: item, played_ms: h.s.sentMs[item] }));
  }
};
const started = (h, text) => h.events.some(e => e.type === 'agent_text' && e.text.includes(text));
async function replyQueued(h, speakLong) {
  await opened(h);
  speakLong();
  await feedAck(h, [VOICE(1.2), QUIET(END_SILENCE + 0.1)]); // the silence rule ends the turn at the mid-answer pause
  await until(() => named(h, 'early_draft_adopted').length === 1 && started(h, FIRST) && h.s.queue.some(c => c.text?.includes(SECOND)));
}

test('held: while they carry on, no new piece of her reply starts (the one playing may finish)', async () => {
  need();
  const { h, speakLong } = held();
  await replyQueued(h, speakLong);
  await feedAck(h, WORDS); // 2.4 s: longer than what is left of her first piece
  assert.equal(named(h, 'turn_resumed').length, 1);
  assert.equal(started(h, SECOND), false, 'the second piece did not start while they were speaking');
  assert.ok(h.s.queue[0]?.text?.includes(SECOND) && !h.s.audible(), 'her first piece has played out; the second waits, silent');
  await feedAck(h, [QUIET(END_SILENCE + 0.2)]);
  for (let i = 0; i < 20000 && !(h.calls.talker.length === 3 && !h.s.busy()); i++) await tick();
  assert.equal(started(h, SECOND), false, 'withdrawn before it was ever voiced');
  assert.deepEqual(users(h), [PART1 + ' ' + PART2]);
});

for (const [how, result] of [['empty', () => ''], ['failed', () => Promise.reject(Object.assign(new Error('down'), { name: 'ProviderError' }))]]) {
  test(`held until the transcription resolves; a ${how} transcription releases the hold and her reply continues`, async () => {
    need();
    const stt = deferred();
    const { h, speakLong } = held({ second: () => stt.p, third: () => stt.p }); // the early call, and the fallback after an early failure
    await replyQueued(h, speakLong);
    await feedAck(h, [...WORDS, QUIET(END_SILENCE + 0.2)]); // the utterance has ended; its transcription is still out
    assert.equal(h.s.turnDetector.active, false);
    assert.ok(h.s.sttBusy > 0, 'still transcribing');
    await feedAck(h, [QUIET(1.0)]);
    assert.equal(started(h, SECOND), false, 'still held after the utterance ended, until its transcript is known');
    stt.p.catch(() => {}); if (how === 'empty') stt.resolve(result()); else stt.reject(await result().catch(e => e));
    await feedAck(h, [QUIET(0.6)]);
    assert.equal(started(h, SECOND), true, 'released: her reply continues where it stopped');
    assert.equal(named(h, 'reply_withdrawn').length, 0);
    assert.equal(h.calls.talker.length, 2, 'no new reply');
    assert.deepEqual(users(h), [PART1]);
    if (how === 'failed') assert.equal(named(h, 'stt_error').length, 1, 'the transcription itself failed (early and fallback)');
  });
}

test('one definition of the 1.2 s: the window and the continuation decision both discount the time spent noticing the speech', async () => {
  need();
  for (const [playedMs, resumed] of [[1500, true], [1800, false]]) {
    const { h, speakLong } = held();
    await replyQueued(h, speakLong);
    h.s.playedMs[h.s.replyItem] = playedMs; // as acknowledged; no further acknowledgements below
    await feed(h, [VOICE(0.6)]); // continuous loud speech
    assert.equal(named(h, 'turn_resumed').length, resumed ? 1 : 0, 'played ' + playedMs);
    assert.equal(named(h, 'barge_in').length, resumed ? 0 : 1);
    // A continuation is held (withdrawn on a transcript with words, or once it passes the barge-in gate), never cut at onset.
    assert.equal(named(h, 'reply_withdrawn').length, 0, 'not withdrawn at the onset (played ' + playedMs + ')');
    assert.equal(!!h.s.hold, resumed);
    await h.s.end(false);
  }
});

test('held and paused: a sound that passes the barge-in gate still withdraws her reply at once, before any transcript', async () => {
  need();
  const { h, speakLong } = held();
  await replyQueued(h, speakLong);
  await feedAck(h, WORDS); // the hold: her first piece plays out, the second waits
  assert.equal(h.s.audible(), false, 'paused for more than 300 ms: nothing audible');
  assert.ok(h.s.hold && h.s.turnDetector.active);
  const stt = h.calls.stt.length;
  await feedAck(h, [VOICE(0.6)]); // 600 ms of unbroken loud sound
  assert.equal(named(h, 'reply_withdrawn').length, 1, 'withdrawn on the gate alone');
  assert.equal(h.calls.stt.length, stt, 'no transcript was needed');
  assert.equal(h.s.hold, null);
  assert.equal(started(h, SECOND), false);
});
