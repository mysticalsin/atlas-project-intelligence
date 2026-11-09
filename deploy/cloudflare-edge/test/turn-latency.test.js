// Turn-taking safety while answering fast: deterministic fixtures on a virtual clock with mocked AI (no model, no
// provider, no microphone). They bind what the session does today; they do not measure live provider latency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, clearPcmCache, EARLY_PAUSE, END_SILENCE, THINKING_PAUSE } from '../src/session.js';
import { workersAI } from '../src/app.js';
import { SAMPLE_RATE } from '../src/speech.js';

const PROJECT = { title: 'Project Falcon (synthetic)', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}
const open = new Set();
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); clearPcmCache(); });
function harness(said, ai = {}, session = {}) {
  const events = [], bytes = [], calls = { talker: [], stt: [], tts: [] }, clock = { t: 1000 };
  const base = {
    async transcribe() { calls.stt.push(clock.t); return said[calls.stt.length - 1] || ''; },
    async synthesize(text) { calls.tts.push(text); return new Uint8Array(4800).fill(1); },
    async *chatStream(m) { calls.talker.push(m); yield 'Thanks. '; yield 'What changed for the team?'; },
  };
  const merged = { ...base, ...(typeof ai === 'function' ? ai(calls, clock) : ai) };
  const s = new Session({ ...session, io: { send: e => events.push(e), sendBytes: b => bytes.push(b.length), close() {} }, ai: merged, csrf: 'tok',
    voice: 'asteria', model: 'test-talker', now: () => clock.t, sleep: () => new Promise(r => setImmediate(r)) });
  open.add(s);
  return { s, events, bytes, calls, clock, tick: () => { clock.t += 0.02; } };
}
const until = async (cond, n = 4000) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setImmediate(r)); assert.ok(cond(), 'condition not reached'); };
const sayAsync = async (h, segs) => { for (const f of frames(segs)) { h.tick(); h.s.onBinary(f); await new Promise(r => setImmediate(r)); } };
const say = (h, segs) => { for (const f of frames(segs)) { h.tick(); h.s.onBinary(f); } };
async function opened(h) {
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 5);
  h.s.playedMs[h.s.protectedItem] = 1e9;
}
const screen = h => h.events.reduce((t, e) => e.type === 'agent_text' ? t + e.text : e.type === 'agent_retract' ? t.slice(0, t.length - Math.min(e.chars, t.length)) : t, '');

test('mid-answer pauses shorter than the early pause start nothing: no transcription, no reply, no audio', async () => {
  const h = harness(['unused']);
  await opened(h);
  const bytes = h.bytes.length;
  await sayAsync(h, [[1.0, .2], [EARLY_PAUSE - 0.2, .001], [1.0, .2], [EARLY_PAUSE - 0.2, .001], [0.6, .2]]);
  assert.equal(h.calls.stt.length, 0, 'nothing is transcribed while they are still talking');
  assert.equal(h.calls.talker.length, 1, 'only the opening was composed');
  assert.equal(h.bytes.length, bytes, 'no reply audio while they talk');
});

test('end of turn: a confident turn model ends it at the early pause; unsure waits for plain silence; unfinished waits for the thinking pause', async () => {
  for (const [verdict, lo, hi] of [[{ complete: true, probability: 0.95 }, EARLY_PAUSE, EARLY_PAUSE + 0.1],
    [{ complete: true, probability: 0.6 }, END_SILENCE, END_SILENCE + 0.1],
    [{ complete: false, probability: 0.9 }, THINKING_PAUSE, THINKING_PAUSE + 0.1], [null, END_SILENCE, END_SILENCE + 0.1]]) {
    const h = harness(['We moved the whole claims intake to the new platform.'], { async turnComplete() { return verdict; } });
    await opened(h);
    await sayAsync(h, [[1.2, .2]]);
    const lastSound = h.clock.t;
    await sayAsync(h, [[THINKING_PAUSE + 0.4, .001]]);
    await until(() => h.calls.stt.length === 1);
    const waited = h.calls.stt[0] - lastSound;
    assert.ok(waited >= lo - 0.03 && waited <= hi, `${JSON.stringify(verdict)}: transcribed ${waited.toFixed(2)} s after the last sound`);
    await h.s.end(false);
  }
});

test('a correction with a negation after a pause revises the turn: the started reply is withdrawn and the whole corrected answer is answered once', async () => {
  let hold, gated = true;
  const h = harness(['We cut the processing cost by 40 percent.', 'No, sorry, not 40 percent: it was 14 percent, and only in one region.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Oh wow. '; if (calls.talker.length === 2 && gated) await new Promise(r => { hold = r; }); yield 'How was that measured?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.shown.item === 'agent-2');
  say(h, [[1.0, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 3);
  gated = false; hold?.();
  await until(() => !h.s.busy());
  assert.ok(h.events.some(e => e.type === 'agent_retract' && e.item_id === 'agent-2'), 'the reply to the first part is taken back on screen');
  assert.deepEqual(h.s.history.filter(m => m.role === 'user').map(m => m.content),
    ['We cut the processing cost by 40 percent. No, sorry, not 40 percent: it was 14 percent, and only in one region.']);
  assert.equal(h.s.history.filter(m => m.role === 'assistant').length, 2, 'opening + one answer to the corrected turn');
  assert.ok(h.calls.talker[2].some(m => m.role === 'user' && m.content.includes('not 40 percent')), 'the next reply is composed from the corrected words');
  assert.ok(!screen(h).includes('Oh wow. How was that measured?Oh wow.'), 'the withdrawn words are not left on screen');
});

test('a late transcript of the first part is answered only together with the rest, in order', async () => {
  let release;
  const h = harness([], (calls, clock) => ({
    async transcribe() { calls.stt.push(clock.t); if (calls.stt.length === 1) { await new Promise(r => { release = r; }); return 'The pilot ran in two branches.'; } return 'Then the bank rolled it out to forty.'; } }));
  await opened(h);
  await sayAsync(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.stt.length === 1);
  await sayAsync(h, [[0.8, .2]]); // they carry on while the first part is still being transcribed
  release();
  await sayAsync(h, [[0.4, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.deepEqual(h.s.history.filter(m => m.role === 'user').map(m => m.content), ['The pilot ran in two branches. Then the bank rolled it out to forty.']);
  assert.equal(h.calls.talker.length, 2, 'one reply, after the whole answer');
});

test('barge-in on an audible reply stops it at once and nothing more of it is sent', async () => {
  const metrics = []; let hold;
  const h = harness(['A short answer about the rollout across the teams.'], { async *chatStream() { await new Promise(r => { hold = r; }); yield 'Thanks.'; } },
    { metric: (n, v) => metrics.push([n, v]) });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  hold(); await until(() => !h.s.busy() && h.bytes.length >= 5);
  h.s.playedMs[h.s.protectedItem] = 1e9;
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.s.replyTurn === 1 && h.s.busy());
  const item = h.s.replyItem, gen = h.s.gen;
  h.s.sentMs[item] = 2200; h.s.queue.push({ gen, item, bytes: new Uint8Array(960) });
  say(h, [[0.6, .5]]);
  assert.ok(metrics.some(([n]) => n === 'barge_in'), 'barge-in');
  assert.ok(h.events.some(e => e.type === 'clear_audio'), 'the browser is told to stop playback');
  assert.ok(h.s.gen > gen && !h.s.queue.some(c => c.gen === gen), 'the stopped reply has no audio left to send');
  hold();
});

test('a withdrawn reply is a stale generation: its later tokens are never shown or voiced, and its talker stream is closed', async () => {
  let hold, closed = false;
  const h = harness(['The migration finished in March.', 'And then support tickets dropped.'], calls => ({
    async *chatStream(m) {
      calls.talker.push(m);
      if (calls.talker.length !== 2) { yield 'What changed after that?'; return; }
      try { yield 'Oh nice. '; await new Promise(r => { hold = r; }); yield 'STALE WORDS'; yield ' MORE STALE WORDS'; } finally { closed = true; }
    } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.shown.item === 'agent-2');
  say(h, [[1.0, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 3);
  hold();
  await until(() => !h.s.busy() && closed);
  assert.ok(!h.calls.tts.some(t => t.includes('STALE')), 'stale tokens are never synthesised');
  assert.ok(!h.events.some(e => e.type === 'agent_text' && e.text.includes('STALE')), 'stale tokens are never shown');
  assert.ok(closed, 'the abandoned talker stream was closed');
});

test('the Workers AI talker stream is cancelled upstream when the session stops reading it', async () => {
  let cancelled = 0;
  const env = { TALKER_MODEL: 'test', AI: { async run() {
    const enc = new TextEncoder(); let n = 0;
    return new ReadableStream({ pull(c) { n += 1; c.enqueue(enc.encode(`data: {"response":"word${n} "}\n\n`)); }, cancel() { cancelled += 1; } });
  } } };
  const ai = workersAI(env);
  for await (const d of ai.chatStream([{ role: 'user', content: 'hi' }])) { if (d.startsWith('word2')) break; }
  await new Promise(r => setImmediate(r));
  assert.equal(cancelled, 1, 'the upstream body is cancelled');
  cancelled = 0;
  const done = { TALKER_MODEL: 'test', AI: { async run() { const enc = new TextEncoder();
    return new ReadableStream({ start(c) { c.enqueue(enc.encode('data: {"response":"a"}\n\ndata: [DONE]\n\n')); }, cancel() { cancelled += 1; } }); } } };
  const out = []; for await (const d of workersAI(done).chatStream([])) out.push(d);
  assert.deepEqual(out, ['a']);
});
