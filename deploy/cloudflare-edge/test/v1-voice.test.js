// v2.2 V1: the voice engine. She no longer stops or pauses mid-reply: credit-based sending with a 500 ms lead, the floor waited for only before her first audio,
// barge-in on confirmed words (sound over her voice only ducks her volume), TTS streamed chunk by chunk, ElevenLabs streaming with per-piece fallback to Aura and a
// breaker, and the PCM cache keyed by provider, voice and model. Fakes only: no provider is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, LEAD_MS, clearPcmCache } from '../src/session.js';
import { GREETING_PIECES } from '../src/languages.js';
import { SAMPLE_RATE } from '../src/speech.js';
import { workersAI, pcmChunks, ttsStream, resetTtsBreaker, EL_BREAKER_FAILS } from '../src/app.js';

const GREETING = GREETING_PIECES.en;
const PROJECT = { title: 'Project Falcon (synthetic)', consultant: 'Alex', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
const settle = async (n = 200) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const until = async (cond, n = 3000) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setImmediate(r)); assert.ok(cond(), 'condition not reached'); };
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
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); clearPcmCache(); resetTtsBreaker(); });

// A session with scripted fakes. ai: overrides; opts: Session options. probeText: what the check of a sound over her voice hears.
function rig({ said = [], talk = null, ai: extra = {}, opts = {} } = {}) {
  const events = [], bytes = [], metrics = [], calls = { talker: [], stt: 0, probes: 0, probeText: '', tts: [] }; let t = 1000;
  const ai = {
    async transcribe(pcm, o) { if (o?.probe) { calls.probes += 1; return calls.probeText; } calls.stt += 1; return said[calls.stt - 1] || ''; },
    async synthesize(text) { calls.tts.push(text); return new Uint8Array(4800).fill(1); },
    async *chatStream(m) { calls.talker.push(m); yield* (talk ? talk(calls.talker.length - 1) : calls.talker.length === 1 ? ['Hello. ', 'What happened?'] : ['Thanks. ', 'What was the baseline?']); },
    async analyst() { return []; },
    ...extra,
  };
  const s = new Session({ flags: { replyGuard: 'off' }, ...opts, io: { send: e => events.push(e), sendBytes: b => bytes.push(b.length), close() {} }, ai, csrf: 'tok', voice: 'atlas', model: 'm',
    now: () => t, sleep: () => new Promise(r => setImmediate(r)), metric: (n, v) => metrics.push([n, v]) });
  open.add(s);
  return { s, events, bytes, metrics, calls, tick: (n = 1) => { t += 0.02 * n; }, say(segs) { for (const f of frames(segs)) { this.tick(); s.onBinary(f); } }, now: () => t };
}
const named = (h, n) => h.metrics.filter(([m]) => m === n).map(([, v]) => v);
const start = async (h, extra = {}) => { await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false, ...extra })); };
async function opened(h) { await start(h); await until(() => !h.s.busy() && h.bytes.length >= 10); h.s.playedMs[h.s.protectedItem] = 1e9; }

// ---------------------------------------------------------------- the pacer
test('credit-based sending: with playback reports, a lead of LEAD_MS goes out at once, and more only as the browser reports it played', async () => {
  const h = rig({ ai: { async synthesize(t) { h.calls.tts.push(t); return new Uint8Array(GREETING.includes(t) ? 4800 : 48000).fill(1); } } }); // the reply pieces are 1 s each
  await start(h); await until(() => h.bytes.length >= 10);
  const item = 'agent-1';
  const ack = ms => h.s.onText(JSON.stringify({ type: 'playback', item_id: item, played_ms: ms }));
  await ack(0); h.tick(); // a report: from now on playback is acknowledged
  assert.ok(h.s.ackFresh());
  await settle(50);
  const ahead = () => (h.s.sentMs[item] || 0) - (h.s.playedMs[item] || 0);
  assert.ok(ahead() <= LEAD_MS + 20, 'never more than the lead is buffered: ' + ahead());
  const before = h.s.sentMs[item];
  h.s.playedMs[item] = before; h.tick(); await h.s.onText(JSON.stringify({ type: 'playback', item_id: item, played_ms: before })); await settle(50);
  assert.ok(h.s.sentMs[item] > before, 'a report that it played lets the next audio go out');
  assert.ok(ahead() <= LEAD_MS + 20);
});

test('without playback reports the wall clock keeps the same lead: the first LEAD_MS goes out at once, and a late tick is made up, not lost as silence', async () => {
  const h = rig({ ai: { async synthesize() { return new Uint8Array(96000).fill(1); } } }); // 2 s per piece
  await start(h); await until(() => h.bytes.length >= 20);
  assert.ok(!h.s.acked);
  // 1 s of fake time passes with the pacer sleeping: everything sent so far is within the lead of the (fake) clock plus what the clock allows
  const sent0 = h.s.sentMs['agent-1'];
  assert.ok(sent0 >= LEAD_MS, 'the lead went out at once without waiting for the clock: ' + sent0);
  assert.equal(named(h, 'underrun').length, 0);
});

// ---------------------------------------------------------------- the floor and barge-in
test('the floor is waited for only before her first audio: a sound between her pieces holds nothing', async () => {
  let gate; const h = rig({ talk: n => n === 0 ? ['Hello. ', 'What happened?'] : ['Thanks. ', 'What was the baseline?'], ai: { async synthesize(t) { h.calls.tts.push(t); if (t === 'What was the baseline?') await new Promise(r => { gate = r; }); return new Uint8Array(14400).fill(1); } } });
  await opened(h);
  const sentBefore = h.bytes.length;
  h.calls.said = 1;
  // a consultant turn: an answer of real length, then the reply starts (her first piece goes out), then a short loud sound before her second piece is ready
  h.s.ai.transcribe = async (pcm, o) => o?.probe ? '' : 'We moved the whole billing platform to the new provider last spring.';
  h.say([[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && gate && h.bytes.length > sentBefore);
  const mid = h.bytes.length;
  h.say([[0.7, .5]]); // a sustained sound over her (an utterance has begun and is still going on) while her next piece is still being made
  assert.ok(h.s.turnDetector.active);
  gate(); await until(() => !h.s.busy());
  assert.ok(h.bytes.length > mid, 'her second piece went out although a sound was going on');
  assert.deepEqual(named(h, 'underrun'), [], 'no underrun'); assert.equal(named(h, 'reply_withdrawn').length, 0);
  assert.ok(!h.events.some(e => e.type === 'clear_audio' || e.type === 'agent_retract'));
});

test('a late synthesis and a 100 ms noise burst between her pieces: no underrun, no withdrawal', async () => {
  let gate; const h = rig({ talk: n => n === 0 ? ['Hello. ', 'What happened?'] : ['Thanks. ', 'What was the baseline?'], ai: { async synthesize(t) { h.calls.tts.push(t); if (t === 'What was the baseline?') await new Promise(r => { gate = r; }); return new Uint8Array(t === 'Thanks.' ? 28800 : 9600).fill(1); } } });
  h.s.ai.transcribe = async (pcm, o) => o?.probe ? '' : 'We moved the whole billing platform to the new provider last spring.';
  await opened(h);
  h.say([[1.2, .2], [1.3, .001]]);
  await until(() => gate); // "Thanks." (600 ms) is out; the next piece is late
  h.tick(5); h.say([[0.1, .5]]); // 100 ms later, noise
  gate(); await until(() => !h.s.busy());
  assert.deepEqual(named(h, 'underrun'), []); assert.deepEqual(named(h, 'reply_withdrawn'), []);
  assert.ok(!h.events.some(e => e.type === 'clear_audio' || e.type === 'agent_retract'));
});

async function overHer(h, probeText, speech = [[1.2, .5]]) { // her reply is playing (audio queued, acknowledged part-way) and the consultant speaks over it
  await opened(h);
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  h.calls.probeText = probeText;
  let onset = -1, stop = -1, i = 0;
  for (const f of frames([[0.2, .001], ...speech])) {
    h.tick(); h.s.onBinary(f); i++; await settle(3);
    if (onset < 0 && i > 10) onset = i; // the speech begins after 10 frames (200 ms) of quiet
    if (stop < 0 && h.events.some(e => e.type === 'clear_audio')) stop = i;
  }
  return { onset, stop, frames: i };
}

test('an echo-like burst over her voice only ducks her volume: she is never stopped (the check hears her own words)', async () => {
  const h = rig({ talk: () => ['What happened?'] });
  const echo = 'Hi, I\'m ATLAS, and I\'ll help you tell the story of your project.';
  h.s.live = null;
  await overHer(h, echo);
  assert.ok(!h.events.some(e => e.type === 'clear_audio'), 'no stop');
  assert.ok(h.calls.probes >= 1, 'it was checked');
  assert.deepEqual(h.events.filter(e => e.type === 'duck').map(e => e.on).slice(0, 2), [true, false], 'her volume dipped and came back');
});

test('one word is not an interruption ("okay"); a sound with no words is not either', async () => {
  for (const heard of ['okay', '']) {
    const h = rig(); await overHer(h, heard);
    assert.ok(!h.events.some(e => e.type === 'clear_audio'), JSON.stringify(heard));
    clearPcmCache();
  }
});

test('a real two-word interruption stops her within about 700 ms of the first sound', async () => {
  const h = rig(); const r = await overHer(h, 'wait please');
  assert.ok(r.stop > 0, 'she stopped');
  const ms = (r.stop - r.onset) * 20;
  assert.ok(ms <= 700, 'stopped ' + ms + ' ms after the first sound');
  assert.ok(h.events.some(e => e.type === 'user_speaking'));
  assert.equal(named(h, 'barge_in').length, 1);
  assert.equal(h.events.filter(e => e.type === 'duck').at(-1).on, false, 'and her volume is back for the next reply');
});

test('the greeting\'s first piece cannot be cut by sound or words; words after it can', async () => {
  const h = rig(); h.calls.probeText = 'wait please';
  await start(h);
  await until(() => h.s.protectedItem);
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  h.say([[0.2, .001], [1.2, .5]]); await settle();
  assert.ok(!h.events.some(e => e.type === 'clear_audio' || e.type === 'duck'), 'protected');
});

test('a reply that was heard is never withdrawn: no agent_retract, whatever the consultant does next', async () => {
  const h = rig({ said: ['We rebuilt the claims intake process for the insurance client.', 'Then we cut the backlog by a third in two months, across both regions.'] });
  await opened(h);
  h.say([[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.shown.item === 'agent-2');
  h.calls.probeText = 'then we cut';
  h.say([[1.0, .2]]); await settle(); h.say([[1.3, .001]]);
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.ok(!h.events.some(e => e.type === 'agent_retract') && named(h, 'reply_withdrawn').length === 0);
});

// ---------------------------------------------------------------- streaming into the session
test('streamed TTS: chunks with odd boundaries go out as they arrive, in whole 20 ms frames, before the piece is finished', async () => {
  let release; const total = 14400, sizes = [1000, 777, 3001, 2999, 6623]; // ends of chunks are not frame boundaries; the sum is total
  assert.equal(sizes.reduce((a, b) => a + b), total);
  const h = rig({ ai: { synthesize: undefined,
    async synthesize(t) { h.calls.tts.push(t); return new Uint8Array(4800).fill(1); },
    synthesizeStream(text) {
      if (GREETING.includes(text)) return (async function* () { yield new Uint8Array(4800).fill(1); })();
      return (async function* () { h.calls.tts.push(text); let n = 0; for (const [i, size] of sizes.entries()) { if (i === 3) await new Promise(r => { release = r; }); yield new Uint8Array(size).fill(2); n += size; } })();
    } }, talk: () => ['What was the baseline?'] });
  await start(h); await until(() => release);
  const reply = h.s.sentMs['agent-1'];
  assert.ok(reply > 100, 'the part of the piece that had arrived was already sent: ' + reply + ' ms');
  const chunksBefore = h.bytes.length;
  assert.ok(h.bytes.slice(-3).every(b => b === 960), 'whole frames while streaming');
  release(); await until(() => !h.s.busy());
  assert.equal(h.bytes.slice(0, 10).reduce((a, b) => a + b, 0), 9600, 'the greeting');
  const piece = h.bytes.slice(10);
  assert.equal(piece.reduce((a, b) => a + b, 0), total, 'every byte of the piece, none twice'); assert.ok(piece.slice(0, -1).every(b => b === 960));
  assert.equal(h.s.sentMs['agent-1'], 100 + 100 + total / 48 + 0 * chunksBefore);
  const tts = named(h, 'tts').at(-1); assert.deepEqual(Object.keys(tts), ['ms', 'audio_ms', 'chars', 'cached']); assert.equal(tts.audio_ms, total / 48);
});

test('a streamed piece that fails after some audio ends there; one that fails before any audio fails the reply (as a whole-buffer failure did)', async () => {
  const mid = rig({ ai: { synthesizeStream(text) { if (GREETING.includes(text)) return (async function* () { yield new Uint8Array(4800); })(); return (async function* () { yield new Uint8Array(4800); throw new Error('connection reset'); })(); } }, talk: () => ['What was the baseline?'] });
  await start(mid); await until(() => !mid.s.busy() && mid.bytes.length >= 15);
  assert.ok(!mid.events.some(e => e.type === 'error')); assert.equal(named(mid, 'tts_error')[0].midstream, 1);
  const bare = rig({ ai: { synthesizeStream(text) { if (GREETING.includes(text)) return (async function* () { yield new Uint8Array(4800); })(); return (async function* () { throw new Error('down'); })(); } }, talk: () => ['What was the baseline?'] });
  await start(bare); await until(() => bare.events.some(e => e.type === 'error'));
  assert.equal(bare.events.find(e => e.type === 'error').code, 'voice-unavailable');
});

test('a fallback of the voice is counted (tts_fallback); the admin is told once, a consultant never', async () => {
  for (const admin of [true, false]) {
    const h = rig({ opts: { admin }, ai: { synthesizeStream(text, v, lang, o) { return (async function* () { if (!GREETING.includes(text)) { o.onFallback({ reason: 'rate_limited', status: 429, to: 'aura' }); o.onFallback({ reason: 'timeout', to: 'aura' }); } yield new Uint8Array(4800); })(); } }, talk: () => ['What was the baseline?', ' And when?'] });
    await start(h); await until(() => !h.s.busy() && h.bytes.length >= 20);
    assert.ok(named(h, 'tts_fallback').length >= 2 && named(h, 'tts_fallback')[0].reason === 'rate_limited');
    const notes = h.events.filter(e => e.type === 'quality_warning' && /ElevenLabs/.test(e.message));
    assert.equal(notes.length, admin ? 1 : 0);
    clearPcmCache();
  }
});

test('a language only ElevenLabs speaks falls back to text when it fails: the piece is shown, the reply goes on', async () => {
  const h = rig({ ai: { speaks: () => true, synthesizeStream(text) { return (async function* () { if (GREETING.includes(text)) { yield new Uint8Array(4800); return; } throw Object.assign(new Error('x'), { code: 'TTS_TEXT_FALLBACK' }); })(); } }, talk: () => ['What was the baseline?'] });
  await start(h); await until(() => !h.s.busy() && h.events.some(e => e.type === 'agent_text' && /baseline/.test(e.text)));
  assert.ok(!h.events.some(e => e.type === 'error'));
});

test('the PCM cache is keyed by provider, voice and model: audio of one voice is never replayed for another', async () => {
  let key = 'aura:tts:harmonia'; const seen = [];
  const mk = () => rig({ ai: { voiceKey: () => key, async synthesize(t) { seen.push(key + '|' + t); return new Uint8Array(4800).fill(1); } }, talk: () => [''] });
  const a = mk(); await start(a); await until(() => !a.s.busy()); await a.s.end(false);
  const n = seen.length;
  const b = mk(); await start(b); await until(() => !b.s.busy()); await b.s.end(false);
  assert.equal(seen.length, n, 'the same voice: the greeting came from the cache');
  key = 'el:21m00Tcm4TlvDq8ikWAM:eleven_flash_v2_5';
  const c = mk(); await start(c); await until(() => !c.s.busy());
  assert.ok(seen.length > n && seen.slice(n).every(x => x.startsWith('el:')), 'another provider and voice: synthesised again');
});

// ---------------------------------------------------------------- the TTS functions of app.js
test('pcmChunks: whole 16-bit samples only, whatever the chunk boundaries (a trailing odd byte is dropped)', async () => {
  const parts = [[1, 2, 3], [4], [5, 6, 7, 8, 9], [10, 11]];
  const stream = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(Uint8Array.from(p)); c.close(); } });
  const out = []; for await (const c of pcmChunks(stream)) { assert.equal(c.length % 2, 0); out.push(...c); }
  assert.deepEqual(out, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const whole = []; for await (const c of pcmChunks(new Uint8Array(7).fill(1))) whole.push(c.length);
  assert.deepEqual(whole, [6]);
  assert.equal((await pcmChunks(new Uint8Array(1)).next()).done, true);
});

test('Aura streams: the first chunk is readable while the model is still producing', async () => {
  let close; const env = { TTS_MODEL: 'tts', TTS_VOICE: 'harmonia', AI: { async run() { return new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1001)); close = () => { c.enqueue(new Uint8Array(1001)); c.close(); }; } }); } } };
  const it = workersAI(env).synthesizeStream('Hi.', 'atlas', 'en')[Symbol.asyncIterator]();
  const first = await it.next(); assert.equal(first.value.length, 1000, 'whole samples: the odd byte waits');
  close(); const rest = []; for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value.length);
  assert.deepEqual(rest, [1002]);
});

const eleven = { provider: 'elevenlabs', elevenlabs: { apiKey: 'el-key', voiceId: 'voice1', modelId: 'eleven_flash_v2_5' }, source: 'env' };
const pcmResponse = (n = 4800, status = 200) => new Response(new Uint8Array(n).fill(3), { status });
const auraEnv = (log = []) => ({ TTS_MODEL: 'tts', TTS_VOICE: 'harmonia', AI: { async run(model) { log.push(model); return new Uint8Array(100).fill(9); } } });
const collect = async it => { const out = []; for await (const c of it) out.push(c); return out; };

test('ElevenLabs: the streaming endpoint, key header, Flash v2.5, language code and the neighbouring text; English and Spanish go to it when it is the provider', async () => {
  for (const lang of ['en', 'es', 'fr']) {
    const calls = [];
    const chunks = await collect(ttsStream(auraEnv(), eleven, 'Hola.', 'atlas', lang, { previousText: 'Before.', nextText: 'After.', fetcher: async (url, init) => { calls.push({ url: String(url), init }); return pcmResponse(); } }));
    assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/voice1/stream?output_format=pcm_24000');
    assert.equal(calls[0].init.headers['xi-api-key'], 'el-key'); assert.equal(calls[0].init.redirect, 'manual');
    assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Hola.', model_id: 'eleven_flash_v2_5', language_code: lang, previous_text: 'Before.', next_text: 'After.' });
    assert.equal(chunks.reduce((n, c) => n + c.length, 0), 4800);
  }
  // bare Aura (no key): no ElevenLabs call at all
  const log = []; const calls = [];
  await collect(ttsStream(auraEnv(log), { provider: 'aura' }, 'Hi.', 'atlas', 'en', { fetcher: async () => { calls.push(1); return pcmResponse(); } }));
  assert.deepEqual([calls.length, log], [0, ['tts']]);
});

test('ElevenLabs falls back to Aura for that piece on an error, 401, 429 or no first byte in time; the caller is told why', async () => {
  const cases = [['http 500', async () => pcmResponse(0, 500), 'http_500'], ['401', async () => pcmResponse(0, 401), 'unauthorized'], ['429', async () => pcmResponse(0, 429), 'rate_limited'],
    ['network', async () => { throw new TypeError('fetch failed'); }, 'error'],
    ['no first byte', (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))), 'timeout'],
    ['empty body', async () => pcmResponse(0), 'no_audio']];
  for (const [name, fetcher, reason] of cases) {
    resetTtsBreaker(); const log = [], notes = [];
    const chunks = await collect(ttsStream(auraEnv(log), eleven, 'Hi.', 'atlas', 'en', { fetcher, firstByteMs: 20, onFallback: i => notes.push(i) }));
    assert.deepEqual(log, ['tts'], name + ': Aura spoke it'); assert.equal(chunks.reduce((n, c) => n + c.length, 0), 100);
    assert.equal(notes.length, 1, name); assert.equal(notes[0].reason, reason, name); assert.equal(notes[0].to, 'aura');
  }
});

test('a language Aura cannot speak falls back to text (the caller is told with TTS_TEXT_FALLBACK)', async () => {
  const notes = [];
  await assert.rejects(collect(ttsStream(auraEnv(), eleven, 'Bonjour.', 'atlas', 'fr', { fetcher: async () => pcmResponse(0, 503), onFallback: i => notes.push(i) })), e => e.code === 'TTS_TEXT_FALLBACK');
  assert.equal(notes[0].to, 'text');
});

test('breaker: after three failures in a row ElevenLabs is skipped for a minute (Aura at once), then tried again', async () => {
  let now = 1e6, fetches = 0; const log = [], notes = [];
  const fail = async () => { fetches++; return pcmResponse(0, 503); }, ok = async () => { fetches++; return pcmResponse(); };
  const run = fetcher => collect(ttsStream(auraEnv(log), eleven, 'Hi.', 'atlas', 'en', { fetcher, now: () => now, onFallback: i => notes.push(i) }));
  for (let i = 0; i < EL_BREAKER_FAILS; i++) await run(fail);
  assert.equal(fetches, EL_BREAKER_FAILS); assert.ok(notes.at(-1).tripped, 'the third failure trips it');
  await run(ok); assert.equal(fetches, EL_BREAKER_FAILS, 'open: ElevenLabs was not called'); assert.equal(notes.at(-1).reason, 'breaker');
  now += 61000; await run(ok); assert.equal(fetches, EL_BREAKER_FAILS + 1, 'after a minute it is tried again');
  await run(ok); assert.equal(fetches, EL_BREAKER_FAILS + 2, 'and a success closes it');
});

test('speaks() and voiceKey(): ElevenLabs voices its 32 languages including en and es; the key names provider, voice and model', async () => {
  const bare = workersAI({ TTS_MODEL: 'tts', TTS_VOICE: 'harmonia' }), el = workersAI({ TTS_MODEL: 'tts', TTS_VOICE: 'harmonia', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v9' });
  assert.deepEqual(['en', 'es', 'fr', 'ja'].map(l => bare.speaks(l)), [true, true, false, false]);
  assert.deepEqual(['en', 'es', 'fr', 'ja'].map(l => el.speaks(l)), [true, true, true, true]);
  assert.notEqual(bare.voiceKey('en'), el.voiceKey('en')); assert.equal(el.voiceKey('en'), 'el:v9:eleven_flash_v2_5'); assert.match(bare.voiceKey('en'), /^aura:/);
  assert.notEqual(bare.voiceKey('en'), bare.voiceKey('es'));
});
