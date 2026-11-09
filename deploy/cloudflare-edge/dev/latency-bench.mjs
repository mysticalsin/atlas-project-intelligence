// Local turn-latency bench: the real Session with mocked AI that answers instantly, on a virtual clock that advances
// only with fed 20 ms microphone frames (each frame is followed by letting all pending work settle).
// It measures the pipeline's own end-of-turn and scheduling waits, plus in-process Node overhead. It does NOT measure
// provider latency (speech recognition, turn model, talker or voice), network, browser playback or audible audio.
//   node dev/latency-bench.mjs [samples=20]
import { Session, clearPcmCache } from '../src/session.js';
import { SAMPLE_RATE } from '../src/speech.js';

const N = Number(process.argv[2]) || 20;
const PROJECT = { title: 'Synthetic bench project', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
const LONG = 'We moved the whole claims intake to the new platform and the three regional teams adopted it within a month.';
const SHORT = 'Two branches.';
const frame = amp => { const n = 480, pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true); return pcm; };
const VOICE = frame(0.2), QUIET = frame(0.001);
const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function session(verdict, answer) {
  const clock = { t: 1000 }, metrics = [], marks = {}; let sent = 0;
  const ai = {
    async transcribe() { if (marks.stt === undefined) { marks.stt = clock.t; marks.sttWall = performance.now(); } return answer; },
    async synthesize() { return new Uint8Array(4800).fill(1); },
    async *chatStream() { marks.text ??= clock.t; yield 'Right, that makes sense. '; yield 'What changed for the team?'; },
    ...(verdict === undefined ? {} : { async turnComplete() { return verdict; } }),
  };
  const s = new Session({ io: { send() {}, sendBytes() { sent += 1; if (marks.armed && marks.audio === undefined) { marks.audio = clock.t; marks.audioWall = performance.now(); } }, close() {} },
    ai, csrf: 'tok', voice: 'asteria', model: 'bench', now: () => clock.t, sleep: () => new Promise(r => setImmediate(r)), metric: (n, v) => metrics.push([n, v]) });
  return { s, clock, metrics, marks, sent: () => sent };
}

async function turn(b) {
  const { s, clock, marks } = b;
  for (const k of ['stt', 'sttWall', 'text', 'audio', 'audioWall']) delete marks[k];
  marks.armed = false;
  for (let i = 0; i < 60; i++) { clock.t += 0.02; s.onBinary(VOICE); await settle(2); }
  const last = clock.t; marks.armed = true;
  for (let i = 0; i < 250 && marks.audio === undefined; i++) { clock.t += 0.02; s.onBinary(QUIET); await settle(); }
  const r = { stt: marks.stt - last, text: marks.text - last, audio: marks.audio - last, endToAudioWall: marks.audioWall - marks.sttWall };
  s.playedMs[s.replyItem] = 1e9; s.playbackDone = true;
  for (let i = 0; i < 400 && s.busy(); i++) { clock.t += 0.02; s.onBinary(QUIET); await settle(5); }
  for (let i = 0; i < 20; i++) { clock.t += 0.02; s.onBinary(QUIET); await settle(2); }
  return r;
}

const SCENARIOS = [
  ['turn model confident (0.95), long answer (cached acknowledgement first)', { complete: true, probability: 0.95 }, LONG],
  ['turn model confident (0.95), short answer (no acknowledgement)', { complete: true, probability: 0.95 }, SHORT],
  ['turn model unsure (0.60): plain-silence rule', { complete: true, probability: 0.6 }, LONG],
  ['no turn model: plain-silence rule', undefined, LONG],
  ['turn model hears an unfinished thought: thinking pause', { complete: false, probability: 0.9 }, LONG],
];
const stats = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b), q = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return v.length ? { n: v.length, min: +v[0].toFixed(3), p50: +q(0.5).toFixed(3), p90: +q(0.9).toFixed(3), max: +v.at(-1).toFixed(3) } : { n: 0 }; };

const out = { kind: 'synthetic local bench: mocked AI with zero provider delay, virtual clock (20 ms frame resolution); wall times are in-process Node overhead only',
  node: process.version, samples_per_cell: N, constants_from: 'src/session.js', results: [] };
for (const [name, verdict, answer] of SCENARIOS) {
  const cold = [], warm = [];
  for (let i = 0; i < N; i++) {
    clearPcmCache();
    const b = session(verdict, answer);
    await b.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
    for (let j = 0; j < 400 && b.s.busy(); j++) { b.clock.t += 0.02; await settle(5); }
    b.s.playedMs[b.s.protectedItem] = 1e9; b.s.playbackDone = true;
    cold.push(await turn(b)); // first answer of a fresh session (acknowledgement cache only prewarmed)
    warm.push(await turn(b)); // a later answer in the same session
    await b.s.end(false);
  }
  const cell = rs => ({ endpoint_to_transcription_start_s: stats(rs.map(r => r.stt)), endpoint_to_first_talker_text_s: stats(rs.map(r => r.text)),
    endpoint_to_first_reply_audio_sent_s: stats(rs.map(r => r.audio)), transcription_call_to_first_audio_sent_wall_ms: stats(rs.map(r => r.endToAudioWall)) });
  out.results.push({ scenario: name, cold: cell(cold), warm: cell(warm) });
}
console.log(JSON.stringify(out, null, 1));
