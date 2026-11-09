// Conditional overlap bench for Plan A early processing: the real Session, mocked AI whose delays are chosen inputs
// (not measurements), on a virtual clock advanced by 20 ms microphone frames. It shows when early work CAN hide
// provider time under the existing end-of-turn wait, given those assumed delays. It measures no provider, no network,
// no browser playback and no audible audio, and it is not evidence of a live gain.
//   node dev/early-overlap-bench.mjs
import { Session, clearPcmCache } from '../src/session.js';
import { MemoryLedger } from '../src/speculation.js';
import { SAMPLE_RATE } from '../src/speech.js';

const PROJECT = { title: 'Synthetic bench project', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
const ANSWER = 'Two branches adopted it first.'; // under FILLER_WORDS: no cached acknowledgement masks the reply
const frame = amp => { const n = 480, pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true); return pcm; };
const VOICE = frame(0.2), QUIET = frame(0.001);
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function run({ mode, verdict, sttS, talkerS, turnS }) {
  const clock = { t: 1000 }, timers = [], marks = {}, counts = { stt: 0, talker: 0 };
  const after = s => new Promise(r => timers.push({ at: clock.t + s, r }));
  const fire = () => { for (let i = timers.length - 1; i >= 0; i--) if (timers[i].at <= clock.t + 1e-9) { timers[i].r(); timers.splice(i, 1); } };
  const ai = {
    async transcribe() { counts.stt += 1; await after(sttS); return ANSWER; },
    async synthesize() { return new Uint8Array(4800).fill(1); },
    async *chatStream() { counts.talker += 1; await after(talkerS); yield 'Which two, and why those first?'; },
    ...(verdict ? { async turnComplete() { await after(turnS); return verdict; } } : {}),
  };
  const ledger = new MemoryLedger({ audioMs: 1e7, inputTokens: 1e7, outputTokens: 1e7, requests: 100, concurrent: 4 }, { scope: 'bench' });
  const speculation = mode === 'baseline' ? null : { enabled: true, stt: true, draft: mode === 'early_stt_and_draft', ledger };
  const s = new Session({ io: { send() {}, sendBytes() { if (marks.armed && marks.audio === undefined) marks.audio = clock.t; }, close() {} }, ai, csrf: 'tok', voice: 'asteria', model: 'bench',
    now: () => clock.t, sleep: () => new Promise(r => setImmediate(r)), speculation });
  return { s, clock, marks, counts, fire, ledger };
}

async function measure(cfg) {
  clearPcmCache();
  const b = run(cfg), { s, clock, marks, fire } = b;
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  for (let j = 0; j < 400 && (s.busy() || b.counts.talker < 1); j++) { clock.t += 0.02; fire(); await settle(5); }
  s.playedMs[s.protectedItem] = 1e9; s.playbackDone = true;
  for (let i = 0; i < 60; i++) { clock.t += 0.02; s.onBinary(VOICE); fire(); await settle(2); }
  const last = clock.t; marks.armed = true;
  for (let i = 0; i < 400 && marks.audio === undefined; i++) { clock.t += 0.02; s.onBinary(QUIET); fire(); await settle(); }
  const r = { last_sound_to_first_reply_audio_sent_s: +(marks.audio - last).toFixed(2), stt_calls: b.counts.stt, talker_calls_after_opening: b.counts.talker - 1, reserved: b.ledger.snapshot().reserved };
  await s.end(false);
  return r;
}

const out = { kind: 'conditional overlap bench: mocked AI with ASSUMED delays on a virtual clock (20 ms frames); not provider latency, not first-audible, not a live gain', node: process.version, results: [] };
for (const [name, verdict] of [['turn model confident (0.95)', { complete: true, probability: 0.95 }], ['turn model unsure (0.60): plain-silence rule', { complete: true, probability: 0.6 }]]) {
  for (const turnS of [0, 0.3]) for (const sttS of [0.3, 0.8]) {
    const talkerS = 0.4, row = { scenario: name, assumed: { turn_model_s: turnS, stt_s: sttS, talker_first_token_s: talkerS } };
    for (const mode of ['baseline', 'early_stt', 'early_stt_and_draft']) row[mode] = await measure({ mode, verdict, sttS, talkerS, turnS });
    out.results.push(row);
  }
}
console.log(JSON.stringify(out, null, 1));
