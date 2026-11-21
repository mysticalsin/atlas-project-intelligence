// A29 early STT. Local fixtures and a virtual clock only: no provider, no microphone, no spend.
// The flag-off trace is the behaviour of this Session with early processing unbound. A bound global
// ledger may run one Nova-3 batch (the same transcribe()) at EARLY_PAUSE. That batch is reused only
// when the final audio is that prefix plus silence. Any later speech discards it and endTurn runs
// the normal transcription. EARLY_DRAFT cannot put a partial into the LLM, the transcript or TTS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Session, clearPcmCache, EARLY_PAUSE, END_SILENCE } from '../src/session.js';
import { SAMPLE_RATE, rms } from '../src/speech.js';

const S = await import('../src/speculation.js').catch(() => ({}));
const need = () => assert.ok(S.MemoryLedger && S.speculationConfig && S.bindEarly, 'src/speculation.js exports MemoryLedger, speculationConfig and bindEarly');

const PROJECT = { title: 'Project Falcon (synthetic)', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
const TOKEN = 'EARLY-TOKEN-A29';
const FULL = 'FULL-TOKEN-A29 the later sentence was spoken after the pause.';
const open = new Set();
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); clearPcmCache(); });

const tick = () => new Promise(r => setImmediate(r));
const until = async (cond, n = 4000) => { for (let i = 0; i < n && !cond(); i++) await tick(); assert.ok(cond(), 'condition not reached'); };
const between = EARLY_PAUSE + (END_SILENCE - EARLY_PAUSE) / 2;

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

function globalLedger() {
  const reserved = [];
  return {
    scope: 'global',
    reserved,
    async reserve(req) { const id = 'r' + (reserved.length + 1); reserved.push({ id, ...req }); return { ok: true, id }; },
    async settle() {},
  };
}

function harness({ stt = [TOKEN], speculation = null, ai = {} } = {}) {
  const events = [], bytes = [], metrics = [], calls = { talker: [], stt: [], tts: [] };
  const clock = { t: 1000 };
  const base = {
    async transcribe(pcm) {
      const i = calls.stt.length;
      calls.stt.push({ t: clock.t, len: pcm.length, pcm: pcm.slice() });
      const v = stt[i];
      return typeof v === 'function' ? v(pcm, i) : v ?? '';
    },
    async synthesize(text) { calls.tts.push({ t: clock.t, text }); return new Uint8Array(4800).fill(1); },
    async *chatStream(messages) { calls.talker.push(messages); yield 'Thanks. '; yield 'What changed for the team?'; },
  };
  const s = new Session({
    io: { send: e => events.push(JSON.parse(JSON.stringify(e))), sendBytes: b => bytes.push(b.length), close() {} },
    ai: { ...base, ...ai }, csrf: 'tok', voice: 'asteria', model: 'test-talker', now: () => clock.t,
    sleep: () => tick(), metric: (n, v) => metrics.push([n, v]), speculation,
  });
  open.add(s);
  return { s, events, bytes, calls, clock, metrics };
}

const feed = async (h, segs) => { for (const f of frames(segs)) { h.clock.t += 0.02; h.s.onBinary(f); await tick(); } };

async function opened(h, { capture = false } = {}) {
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture }));
  await until(() => !h.s.busy() && h.bytes.length >= 5);
  h.s.playedMs[h.s.protectedItem] = 1e9;
  h.s.playbackDone = true;
  h.clock.t += 1; // past the audible tail, so the answer is a turn and not a barge-in
}

const users = h => h.s.history.filter(m => m.role === 'user').map(m => m.content);
const seen = h => JSON.stringify({ events: h.events, talker: h.calls.talker, tts: h.calls.tts, history: h.s.history });

function roundNumbers(value) {
  if (typeof value === 'number') return Math.round(value * 1000) / 1000;
  if (Array.isArray(value)) return value.map(roundNumbers);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundNumbers(v)]));
  return value;
}

function canonical(h) {
  return roundNumbers({
    stt: h.calls.stt.map(c => ({ t: c.t, len: c.len })),
    tts: h.calls.tts.map(c => c.text),
    talker: h.calls.talker,
    history: h.s.history,
    metrics: h.metrics,
    events: h.events,
    bytes: h.bytes.length,
  });
}
const digest = h => createHash('sha256').update(JSON.stringify(canonical(h))).digest('hex');

// Recorded on 8b0972ec with early processing unbound (speculation null). The fix must keep this digest.
const FLAG_OFF_SHA256 = 'c238e784ce5c19438953bc2d3a27ee05543e1eb6c909a98b2a23788b437f3bc4';

test('flag off, and a flag that has no global ledger, keep the recorded trace', async () => {
  const h = harness();
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(END_SILENCE + 0.3)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const off = digest(h);
  assert.equal(off, FLAG_OFF_SHA256);
  assert.equal(h.calls.stt.length, 1, 'one transcription, after the turn');
  assert.equal(h.metrics.filter(([name]) => String(name).startsWith('early')).length, 0);
  assert.equal('early' in (h.metrics.find(([name]) => name === 'stt')?.[1] || {}), false);
  await h.s.end(false);
  clearPcmCache();

  let reserves = 0;
  const refused = harness({
    speculation: { enabled: true, stt: true, draft: true, ledger: { scope: 'process', reserve() { reserves += 1; return { ok: true, id: 'no' }; }, async settle() {} } },
  });
  await opened(refused);
  await feed(refused, [VOICE(1.2), QUIET(END_SILENCE + 0.3)]);
  await until(() => refused.calls.talker.length === 2 && !refused.s.busy());
  assert.equal(digest(refused), off, 'a process ledger cannot turn the flag on');
  assert.equal(reserves, 0);
  assert.equal(refused.calls.stt.length, 1);
  await refused.s.end(false);
});

test('the early batch is reused only when the final audio is that prefix plus silence', async () => {
  const led = globalLedger();
  const h = harness({ speculation: { enabled: true, stt: true, draft: false, ledger: led, limits: { perTurn: 3 } }, stt: [TOKEN] });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(between)]);
  await until(() => h.calls.stt.length === 1);
  const prefix = h.calls.stt[0];
  assert.equal(h.calls.talker.length, 1, 'the opening is the only model call during the pause');
  assert.equal(users(h).length, 0);
  const pauseAt = h.clock.t;
  await feed(h, [QUIET(END_SILENCE)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.calls.stt.length, 1, 'silence after the prefix does not send a second batch');
  assert.equal(h.calls.stt[0].len, prefix.len);
  assert.ok(h.calls.stt[0].t <= pauseAt);
  assert.deepEqual(users(h), [TOKEN]);
  assert.equal(led.reserved.length, 1, 'one admitted batch even if a caller asks for more');
  assert.equal(h.metrics.filter(([name]) => name === 'early_stt_used').length, 1);
  await h.s.end(false);
});

test('any speech after the early batch discards it and endTurn transcribes the whole utterance', async () => {
  const h = harness({
    speculation: { enabled: true, stt: true, draft: true, ledger: globalLedger(), limits: { perTurn: 3 } },
    stt: [TOKEN, FULL],
  });
  await opened(h);
  await feed(h, [VOICE(1.2), QUIET(between)]);
  await until(() => h.calls.stt.length === 1);
  const prefix = h.calls.stt[0].pcm;
  await feed(h, [VOICE(0.8), QUIET(between)]);
  assert.equal(h.calls.stt.length, 1, 'one early batch per turn: the second pause does not send another');
  await feed(h, [QUIET(END_SILENCE)]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.calls.stt.length, 2, 'the discarded batch is not the endTurn transcription');
  const final = h.calls.stt[1].pcm;
  assert.ok(final.length > prefix.length);
  assert.equal(Buffer.compare(final.subarray(0, prefix.length), prefix), 0);
  assert.ok(rms(final.subarray(prefix.length)) > 0.02, 'the extra audio is speech, not silence');
  assert.deepEqual(users(h), [FULL]);
  assert.equal(seen(h).includes(TOKEN), false, 'the discarded transcript is not reused');
  assert.equal(h.metrics.filter(([name]) => name === 'early_stt_used').length, 0);
  await h.s.end(false);
});

test('EARLY_STT and EARLY_DRAFT stay off unless a global spend ledger is bound', () => {
  need();
  const caps = { audioMs: 1e7, inputTokens: 1e7, outputTokens: 1e7, requests: 10, concurrent: 2 };
  const global = new S.MemoryLedger(caps, { scope: 'global' });
  assert.deepEqual(S.speculationConfig({}, global), { enabled: false, reason: 'off' });
  assert.deepEqual(S.speculationConfig({ EARLY_DRAFT: '1' }, global), { enabled: false, reason: 'draft_without_stt' });
  assert.deepEqual(S.speculationConfig({ EARLY_STT: '1' }, null), { enabled: false, reason: 'no_ledger' });
  assert.deepEqual(S.speculationConfig({ EARLY_STT: '1', EARLY_DRAFT: '1' }, null), { enabled: false, reason: 'no_ledger' });
  assert.deepEqual(S.speculationConfig({ EARLY_STT: '1' }, new S.MemoryLedger(caps)), { enabled: false, reason: 'ledger_not_global' });
  assert.throws(() => new S.MemoryLedger(), /Explicit caps/);
  const stt = S.speculationConfig({ EARLY_STT: '1' }, global);
  const both = S.speculationConfig({ EARLY_STT: '1', EARLY_DRAFT: '1' }, global);
  assert.equal(stt.enabled && stt.stt && stt.draft === false, true);
  assert.equal(both.enabled && both.draft === true, true);
  assert.equal(S.LIMITS.perTurn, 1, 'one early batch');
  const bound = S.bindEarly(both);
  assert.equal(bound.draft, false, 'EARLY_DRAFT cannot start a model call');
  assert.equal(bound.limits.perTurn, 1);
  assert.equal(S.bindEarly(S.speculationConfig({ EARLY_STT: '1' }, null)), null);
  assert.equal(S.bindEarly({ enabled: true, stt: true, draft: true, ledger: { scope: 'process', reserve() {}, settle() {} } }), null);
  const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /speculationConfig\(this\.env, null\)/, 'the Worker binds no ledger, so the env flags cannot turn this on');
  assert.match(worker, /speculation: early/);
  const session = readFileSync(new URL('../src/session.js', import.meta.url), 'utf8');
  assert.match(session, /this\.ai\.transcribe\(/);
  assert.doesNotMatch(session, /@cf\/|whisper|nova-2|EARLY_MODEL/);
});

test('an early transcript does not reach the LLM, TTS or the transcript before the turn ends', async () => {
  const h = harness({
    speculation: { enabled: true, stt: true, draft: true, ledger: globalLedger() },
    stt: [TOKEN], capture: true,
  });
  await opened(h, { capture: true });
  await feed(h, [VOICE(1.2), QUIET(between)]);
  await until(() => h.calls.stt.length === 1);
  for (let i = 0; i < 30; i++) await tick();
  assert.equal(h.calls.talker.length, 1, 'EARLY_DRAFT does not call the talker');
  assert.equal(h.calls.tts.some(c => c.text.includes(TOKEN)), false);
  assert.equal(h.events.some(e => e.type === 'user_text'), false);
  assert.equal(users(h).length, 0);
  assert.equal(seen(h).includes(TOKEN), false);
  const marked = { talker: h.calls.talker.length, tts: h.calls.tts.length, events: h.events.length };
  await feed(h, [QUIET(END_SILENCE)]);
  await until(() => h.calls.talker.length === 2 && h.events.some(e => e.type === 'user_text') && !h.s.busy());
  assert.ok(h.calls.talker.length > marked.talker);
  assert.equal(h.events.filter(e => e.type === 'user_text').map(e => e.text).join(' '), TOKEN);
  assert.equal(h.calls.stt.length, 1);
  const reply = h.calls.talker[1];
  assert.equal(reply.some(m => m.role === 'user' && m.content === TOKEN), true);
  assert.equal(h.calls.talker.length, 2, 'the committed reply is the only later model call');
  await h.s.end(false);
});

test('state-machines row 12 records the early batch instead of an absent file', () => {
  const doc = readFileSync(new URL('../../../docs/state-machines.md', import.meta.url), 'utf8');
  const row = doc.split('\n').find(line => line.startsWith('| 12 |'));
  assert.ok(row);
  assert.doesNotMatch(row, /not in the tree/);
  assert.match(row, /EARLY_STT/);
  assert.match(row, /EARLY_DRAFT/);
  assert.match(row, /prefix/);
  assert.match(row, /silence/);
  assert.match(row, /global/);
});

test('Kyutai, Realtime and PersonaPlex are unchanged and Nova-3 stays the edge recogniser', () => {
  const root = new URL('../../..', import.meta.url);
  for (const rel of ['atlas_voice/cascade.py', 'atlas_voice/realtime.py', 'atlas_voice/server.py']) {
    const text = readFileSync(new URL(rel, root), 'utf8');
    assert.doesNotMatch(text, /EARLY_STT|EARLY_DRAFT|speculation/);
  }
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(wrangler, /"STT_MODEL": "@cf\/deepgram\/nova-3"/);
});

function schedule(clock, timers, seconds) {
  return new Promise(resolve => timers.push({ at: clock.t + seconds, resolve }));
}
function fire(clock, timers) {
  for (let i = timers.length - 1; i >= 0; i--) if (timers[i].at <= clock.t + 1e-9) { timers[i].resolve(); timers.splice(i, 1); }
}

async function firstAudio({ on, sttS, talkerS, draft = false }) {
  clearPcmCache();
  const clock = { t: 1000 }, timers = [], marks = {};
  const counts = { stt: 0, talker: 0 };
  const ai = {
    async transcribe() { counts.stt += 1; await schedule(clock, timers, sttS); return 'Two branches adopted it first.'; },
    async synthesize() { return new Uint8Array(4800).fill(1); },
    async *chatStream() { counts.talker += 1; await schedule(clock, timers, talkerS); yield 'Which two, and why those first?'; },
  };
  const speculation = on ? { enabled: true, stt: true, draft, ledger: globalLedger() } : null;
  const s = new Session({
    io: { send() {}, sendBytes() { if (marks.armed && marks.audio === undefined) marks.audio = clock.t; }, close() {} },
    ai, csrf: 'tok', voice: 'asteria', model: 'bench', now: () => clock.t, sleep: () => tick(), speculation,
  });
  open.add(s);
  const frame = amp => frames([[0.02, amp]])[0];
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  for (let j = 0; j < 400 && (s.busy() || counts.talker < 1); j++) { clock.t += 0.02; fire(clock, timers); await tick(); await tick(); }
  s.playedMs[s.protectedItem] = 1e9; s.playbackDone = true;
  for (let i = 0; i < 60; i++) { clock.t += 0.02; s.onBinary(frame(0.2)); fire(clock, timers); await tick(); }
  const last = clock.t; marks.armed = true;
  for (let i = 0; i < 400 && marks.audio === undefined; i++) { clock.t += 0.02; s.onBinary(frame(0.001)); fire(clock, timers); await tick(); await tick(); }
  const gap = marks.audio === undefined ? null : Math.round((marks.audio - last) * 1000) / 1000;
  await s.end(false);
  return { gap_s: gap, stt: counts.stt, talker_after_opening: counts.talker - 1 };
}

test('synthetic first audio is sooner with the flag on, and a draft flag does not call the model early', async () => {
  const off = await firstAudio({ on: false, sttS: 0.8, talkerS: 0.4 });
  const on = await firstAudio({ on: true, sttS: 0.8, talkerS: 0.4 });
  const drafted = await firstAudio({ on: true, sttS: 0.8, talkerS: 0.4, draft: true });
  console.log(JSON.stringify({ synthetic_first_audio_s: { off: off.gap_s, on: on.gap_s, draft_flag: drafted.gap_s }, stt: { off: off.stt, on: on.stt }, talker_after_opening: { on: on.talker_after_opening, draft_flag: drafted.talker_after_opening } }));
  assert.ok(on.gap_s !== null && off.gap_s !== null);
  assert.ok(on.gap_s < off.gap_s, 'the early batch overlaps the rest of the silence');
  assert.equal(on.stt, 1);
  assert.equal(off.stt, 1);
  assert.equal(drafted.gap_s, on.gap_s);
  assert.equal(drafted.talker_after_opening, 1, 'EARLY_DRAFT does not start a partial reply');
});
