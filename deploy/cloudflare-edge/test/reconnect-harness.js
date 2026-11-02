// Shared fakes for checkpoint.test.js and session-reconnect.test.js (T10): a scripted Session (speech recognition, voice, talker, analyst),
// a clock the tests move by hand, and a Durable Object storage that enforces the real limits (128 keys per put or delete, 128 KiB per value).
// Not a test file (no .test.js): `node --test test/*.test.js` does not run it.
import { Session, clearPcmCache } from '../src/session.js';
import { CheckpointStore } from '../src/checkpoint.js';
import { SAMPLE_RATE } from '../src/speech.js';

export const PROJECT = { id: 'p-falcon', title: 'Project Falcon (synthetic)', consultant: 'Alex', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
export const ANSWER = 'We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.';
export const ANSWER2 = 'The median handling time dropped from fourteen minutes to nine minutes after the pilot, measured over six weeks across the claims team.';
export const QUESTION = 'What part of that work did you take on yourself, alongside the team?'; // the selector's question after ANSWER: the question spoken is the move's (v2.2 Q1)
export const USER = 'tony@example.com';

export class FakeStorage {
  constructor() { this.m = new Map(); this.alarm = null; this.puts = []; }
  async get(k) {
    if (Array.isArray(k)) return new Map(k.filter(x => this.m.has(x)).map(x => [x, structuredClone(this.m.get(x))]));
    return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined;
  }
  async put(o, v) {
    if (typeof o === 'string') o = { [o]: v }; // the Durable Object API takes (key, value) as well as an object of entries
    const keys = Object.keys(o); if (keys.length > 128) throw new Error('a put takes at most 128 keys');
    for (const k of keys) if (o[k] instanceof Uint8Array && o[k].length > 128 * 1024) throw new Error('value over 128 KiB');
    this.puts.push(keys.length);
    for (const k of keys) this.m.set(k, structuredClone(o[k]));
  }
  async delete(k) {
    if (Array.isArray(k)) { if (k.length > 128) throw new Error('a delete takes at most 128 keys'); let n = 0; for (const x of k) if (this.m.delete(x)) n++; return n; }
    return this.m.delete(k);
  }
  async list({ prefix = '' } = {}) { return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, structuredClone(v)])); }
  async setAlarm(t) { this.alarm = t; }
  async deleteAlarm() { this.alarm = null; }
  keys() { return [...this.m.keys()]; }
}

export const clock = (t = 1000) => ({ t, advance(s) { this.t += s; } });

export function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}

export const settle = async (n = 200) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
export const until = async (cond, n = 3000) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setImmediate(r)); if (!cond()) throw new Error('condition not reached'); };
export const open = new Set();
export async function cleanup() { for (const s of open) if (!s.finished) await s.end(false); open.clear(); clearPcmCache(); }

// said: what speech recognition hears, utterance by utterance. talk(n, messages): the deltas of talker call n (default: a thank-you and QUESTION).
// storage / clk can be shared by several rigs (a reconnect is a second Session on the same Durable Object storage). store: false for no checkpoint store.
export function rig({ said = [], talk = null, flags = {}, metrics = [], session = {}, storage = new FakeStorage(), clk = clock(), owner = USER, store = undefined } = {}) {
  const events = [], bytes = [], calls = { talker: [], analyst: 0, stt: 0, tts: [], probeText: '' }; let closed = false;
  const ai = {
    async transcribe(pcm, o) { if (o?.probe) return calls.probeText; calls.stt += 1; return said[calls.stt - 1] || ''; }, // (a probe: the check of a sound over her voice, v2.2 V1)
    async synthesize(text) { calls.tts.push(text); return new Uint8Array(4800).fill(1); },
    chatStream(messages) {
      const n = calls.talker.length; calls.talker.push(messages);
      const out = talk ? talk(n, messages) : ['Thanks. ', 'What part of that work ', 'did you take on yourself, alongside the team?'];
      return Array.isArray(out) ? (async function* () { yield* out; })() : out;
    },
    async analyst(messages) {
      calls.analyst += 1;
      const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
      return [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'outcome', item_id: seg.item_id, quote: seg.text.slice(0, 31) }] }) }];
    },
  };
  const keeper = store === false ? null : store || new CheckpointStore(storage, { owner, now: () => clk.t * 1000 });
  const s = new Session({ flags, checkpoint: keeper, ...session, io: { send: e => events.push(e), sendBytes: b => bytes.push(b.length), close: () => { closed = true; } }, ai, csrf: 'tok',
    voice: 'asteria', model: 'test-talker', now: () => clk.t, sleep: () => new Promise(r => setImmediate(r)), metric: (n, v) => metrics.push([n, v]) });
  open.add(s);
  return { s, events, bytes, calls, metrics, storage, store: keeper, clk, tick: () => { clk.t += 0.02; }, advance: sec => { clk.advance(sec); }, closed: () => closed };
}

// G2: the consent is an object of separate choices; the saved-interview choice is what lets the interview be kept and resumed (a bare `true` no longer implies it).
export const CONSENT = { transcription: true, draft: true, checkpoint: true };
export const startMsg = (extra = {}) => JSON.stringify({ type: 'start', consent: CONSENT, csrf: 'tok', project: PROJECT, capture: true, voice: 'asteria', memory: false, ...extra });
export const say = (h, segs) => { for (const f of frames(segs)) { h.tick(); h.s.onBinary(f); } };
export const talked = h => say(h, [[1.2, .2], [1.3, .001]]); // one utterance, then enough silence for the turn to end
export const send = (h, obj) => h.s.onText(JSON.stringify(obj));
export const screen = h => h.events.reduce((t, e) => e.type === 'agent_text' ? t + e.text : e.type === 'agent_retract' ? t.slice(0, t.length - Math.min(e.chars, t.length)) : t, '');
export const named = (metrics, name) => metrics.filter(([n]) => n === name).map(([, v]) => v);

export async function opened(h, extra = {}) {
  await h.s.onText(startMsg(extra));
  await until(() => h.s.finished || (!h.s.busy() && h.bytes.length >= 1));
  if (h.s.protectedItem) h.s.playedMs[h.s.protectedItem] = 1e9; // the greeting has played (browser acknowledgement)
}

// A started interview in which the consultant has answered once: ATLAS asked the opening question, the answer was heard, and ATLAS has asked QUESTION.
export async function interviewing(opts = {}) {
  const h = rig({ talk: n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', 'What part of that work ', 'did you take on yourself, alongside the team?'], ...opts, said: [ANSWER, ...(opts.said || [])] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  return h;
}
// Wait until the debounced checkpoint writer has written (or has nothing to write).
export const written = async h => { await until(() => !h.s.ckptRun && !h.s.ckptDirty && h.storage.keys().some(k => k.endsWith(':meta'))); };
export const sessionIdOf = h => h.events.find(e => e.type === 'ready').sessionId;
