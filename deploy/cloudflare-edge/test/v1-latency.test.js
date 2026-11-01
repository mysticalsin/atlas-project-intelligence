// v2.2 V1: what the consultant hears, in real time, from the end of their turn: the dead air before her first word and the silences inside her reply. Fakes with
// realistic delays (speech recognition 300 ms, the model's first token 800 ms and then 40 ms a token, synthesis 250 ms to the first byte and 900 ms for a sentence, streamed
// in 60 ms chunks), the audio of a sentence as long as it would be said (50 ms a character), played back as a browser does (at once, never ahead of the clock).
// The same file runs on the base commit (V1_REPORT_ONLY=1) to print the "before" numbers: node --test test/v1-latency.test.js, and read the V1_LATENCY lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, clearPcmCache } from '../src/session.js';
import { SAMPLE_RATE } from '../src/speech.js';

const REPORT_ONLY = !!process.env.V1_REPORT_ONLY;
const PROJECT = { title: 'Project Falcon (synthetic)', consultant: 'Alex', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
const wait = ms => new Promise(r => setTimeout(r, ms));
const bytesFor = text => text.length > 100 ? 4800 : Math.round(text.length * 50 * 48 / 2) * 2; // 50 ms of speech a character (the long greeting lines are played short here: only the reply is measured)
function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}

async function run({ admin }) {
  clearPcmCache();
  const sent = [], metrics = [], events = []; let turnEnd = 0, talkerCalls = 0, item = null; const plays = new Map(); // plays: item -> the chunks the browser plays, [start, ms], back to back
  const reply = ['Thanks. ', 'What was the baseline before the change, ', 'and who measured it? '];
  const fixed = text => text.length <= 40;
  const ai = {
    async transcribe(pcm, o) { if (o?.probe) return ''; await wait(300); return 'We moved the whole billing platform to the new provider last spring with a team of five.'; },
    async synthesize(text) { await wait(fixed(text) ? 5 : 900); return new Uint8Array(bytesFor(text)).fill(1); },
    synthesizeStream(text) { return (async function* () { await wait(fixed(text) ? 5 : 250); const all = new Uint8Array(bytesFor(text)).fill(1); for (let i = 0; i < all.length; i += 2880) { if (!fixed(text)) await wait(60); yield all.subarray(i, i + 2880); } })(); },
    async *chatStream() { talkerCalls++; if (talkerCalls === 1) { yield 'Hello. '; yield 'What happened?'; return; } await wait(800); for (const d of reply) { yield d; await wait(40); } },
    async analyst() { return []; },
  };
  const s = new Session({ io: { send: e => { events.push(e); if (e.type === 'audio_turn') item = e.item_id; }, sendBytes: b => { const now = performance.now(), list = plays.get(item) || plays.set(item, []).get(item), last = list.at(-1); list.push([Math.max(now, last ? last[0] + last[1] : 0), b.length / 48]); sent.push([now, b.length]); }, close() {} }, ai, csrf: 'tok', voice: 'atlas', model: 'm', admin, metric: (n, v) => metrics.push([n, v]) });
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  for (let i = 0; i < 400 && (s.busy() || sent.length < 10); i++) await wait(10);
  // the browser reports what it has played, every 80 ms (the playback acknowledgement of voice-client.js)
  const acks = setInterval(() => { const now = performance.now(); for (const [id, list] of plays) s.onText(JSON.stringify({ type: 'playback', item_id: id, played_ms: Math.min((s.sentMs[id] || 0), Math.round(list.reduce((n, [st, ms]) => n + Math.max(0, Math.min(ms, now - st)), 0))) })); }, 80);
  s.playedMs[s.protectedItem] = 1e9; await wait(300);
  const queue = s.queueTranscription.bind(s); s.queueTranscription = (...a) => { turnEnd = performance.now(); return queue(...a); };
  const before = sent.length;
  for (const f of frames([[1.6, .2], [1.3, .001]])) s.onBinary(f);
  for (let i = 0; i < 600 && (!turnEnd || s.busy() || sent.length === before || performance.now() - sent.at(-1)[0] < 400); i++) await wait(10);
  clearInterval(acks); await s.end(false);
  if (process.env.V1_DEBUG) console.log('DBG turnEnd', Math.round(turnEnd), 'sent', JSON.stringify(sent.slice(before).slice(0, 8).map(([t, n]) => [Math.round(t - turnEnd), n])), 'before', before);
  // played back as a browser does: each chunk plays when it arrives or when the one before it has finished
  let pt = 0, firstAudio = -1, gaps = [];
  for (const [ts, n] of sent.slice(before)) {
    if (firstAudio < 0) { firstAudio = ts - turnEnd; pt = ts; }
    if (ts > pt + 1) gaps.push(Math.round(ts - pt)); // silence in her reply
    pt = Math.max(pt, ts) + n / 48;
  }
  const out = { admin, first_audio_ms: Math.round(firstAudio), silences_ms: gaps, longest_silence_ms: Math.max(0, ...gaps), underruns: metrics.filter(([n]) => n === 'underrun').length,
    ack: metrics.some(([n]) => n === 'ack'), timeline: metrics.filter(([n]) => n === 'turn_timeline').map(([, v]) => v) };
  console.log('V1_LATENCY ' + JSON.stringify(out));
  return out;
}

test('dead air before her first word stays within about 1.2 s after the turn ends, for the admin too, and her reply has no long silence inside it', async () => {
  for (const admin of [false, true]) {
    const r = await run({ admin });
    if (REPORT_ONLY) continue;
    assert.ok(r.first_audio_ms > 0 && r.first_audio_ms <= 1200, (admin ? 'admin' : 'consultant') + ': first audio ' + r.first_audio_ms + ' ms after the turn ended');
    assert.ok(r.ack, 'a short acknowledgement covers the model\'s thinking time');
    assert.ok(r.longest_silence_ms <= 400, 'no long silence inside the reply: ' + JSON.stringify(r.silences_ms));
    assert.ok(r.underruns <= 1, 'underruns: ' + r.underruns);
  }
});
