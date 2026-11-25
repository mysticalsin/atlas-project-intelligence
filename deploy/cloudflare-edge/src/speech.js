// JavaScript port of atlas_voice/speech.py EnergyTurns, sentences, Phrases, speakable and wav_bytes (parity-tested).
export const SAMPLE_RATE = 24000;

export function rms(bytes) {
  const n = bytes.length >> 1;
  if (!n) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = view.getInt16(i * 2, true); sum += s * s; }
  return Math.sqrt(sum / n) / 32768;
}

const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

export class EnergyTurns {
  constructor(endSilence = 1.1, minSpeech = 0.30, maxSeconds = 90) {
    this.floor = 0.004; this.active = false; this.loud = 0; this.quiet = 0; this.spoken = 0;
    this.buffer = new Uint8Array(0); this.pre = new Uint8Array(0);
    this.endSilence = endSilence; this.minSpeech = minSpeech; this.maxBytes = Math.floor(maxSeconds * SAMPLE_RATE * 2);
  }

  // Returns [started, utteranceOrNull]. Same rules as the Python EnergyTurns.
  feed(pcm, agentSpeaking = false) {
    const seconds = pcm.length / (2 * SAMPLE_RATE), level = rms(pcm);
    const threshold = Math.max(0.012, this.floor * 3.2) * (agentSpeaking ? 4.0 : 1.0);
    let started = false, done = null;
    if (!this.active) {
      if (level < threshold) this.floor = this.floor * 0.97 + Math.min(level, 0.05) * 0.03;
      const pre = concat(this.pre, pcm), keep = Math.floor(0.3 * SAMPLE_RATE * 2);
      this.pre = pre.length > keep ? pre.slice(pre.length - keep) : pre;
      this.loud = level > threshold ? this.loud + seconds : 0;
      // While ATLAS is audible, a barge-in needs 450 ms of sustained loud speech, not a blip or echo.
      if (this.loud >= (agentSpeaking ? 0.45 : 0.08)) { this.active = true; started = true; this.buffer = this.pre.slice(); this.quiet = 0; this.spoken = 0; }
    } else {
      this.buffer = concat(this.buffer, pcm);
      this.spoken += seconds;
      this.quiet = level < threshold * 0.7 ? this.quiet + seconds : 0;
      if ((this.quiet >= this.endSilence && this.spoken >= this.minSpeech) || this.buffer.length >= this.maxBytes) {
        done = this.buffer; this.active = false; this.loud = 0; this.pre = new Uint8Array(0); this.buffer = new Uint8Array(0);
      }
    }
    return [started, done];
  }

  // End the current utterance now (semantic end-of-turn said the consultant has finished). Null when idle.
  flush() {
    if (!this.active || !this.buffer.length) return null;
    const done = this.buffer; this.active = false; this.loud = 0; this.pre = new Uint8Array(0); this.buffer = new Uint8Array(0); this.quiet = 0;
    return done;
  }
}

// 24 kHz PCM16 -> 16 kHz PCM16, the rate turn-detection models expect. Band-limited: a windowed-sinc low-pass at 7.2 kHz
// (below the new 8 kHz limit) evaluated at each output position, 1.5 input samples apart (so two kernel phases). Plain
// interpolation would fold 8-12 kHz into the speech band.
const FIR_HALF = 24, FIR_CUTOFF = 7200 / SAMPLE_RATE;
function firPhase(frac) {
  const taps = [];
  for (let j = 1 - FIR_HALF; j <= FIR_HALF; j++) {
    const t = j - frac, x = 2 * FIR_CUTOFF * t, window = 0.54 + 0.46 * Math.cos(Math.PI * t / FIR_HALF);
    taps.push((x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * window);
  }
  const sum = taps.reduce((a, b) => a + b, 0);
  return Float64Array.from(taps, v => v / sum); // unity gain at DC
}
const FIR = [firPhase(0), firPhase(0.5)];
export function to16k(pcm) {
  const n = pcm.length >> 1, view = new DataView(pcm.buffer, pcm.byteOffset, n * 2), src = new Float64Array(n);
  for (let i = 0; i < n; i++) src[i] = view.getInt16(i * 2, true);
  const m = Math.floor(n * 2 / 3), out = new Uint8Array(m * 2), dst = new DataView(out.buffer);
  for (let i = 0; i < m; i++) {
    const a = (i * 3) >> 1, taps = FIR[i & 1]; // input position 1.5 i = a + (0 or 0.5)
    let y = 0;
    for (let j = 1 - FIR_HALF, k = 0; j <= FIR_HALF; j++, k++) y += taps[k] * src[Math.min(n - 1, Math.max(0, a + j))];
    dst.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(y))), true);
  }
  return out;
}

export function isEcho(text, recentAgentText) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) || [], agent = new Set(recentAgentText.toLowerCase().match(/[\p{L}\p{N}_']+/gu) || []); // any script
  if (words.length < 3 || !agent.size) return false;
  return words.filter(w => agent.has(w)).length / words.length >= 0.7;
}

// A sentence end: . ! or ? (then any closing quote, bracket or markdown) before whitespace, or a CJK or Devanagari stop.
const END = /([.!?]+)["'\u201d\u2019\u00bb)\]*_`]*(\s+)|[\u3002\uff01\uff1f\u0964]\s*/gu;
const ABBREVIATIONS = new Set('mr mrs ms dr prof st jr sr vs etc cf approx inc ltd corp dept mme mlle hr sra dott sig dhr mevr ca'.split(' '));
export const MIN_PIECE = 40; // characters: shorter sentences join the next piece, and the first clause goes early only from here
const CLAUSE = new RegExp(`^(.{${MIN_PIECE},}?[,;:\u2014\u2013])\\s+`, 'su');
const chars = s => [...s].length; // code points, as in Python

// [end, next] of each sentence end in text: text.slice(0, end) is finished and the next sentence starts at next.
function boundaries(text) {
  const cuts = []; let start = 0;
  for (const m of text.matchAll(END)) {
    const next = m.index + m[0].length;
    let end = m.index + 1;
    if (m[1] !== undefined) {
      end = next - m[2].length;
      if (!/[!?]/.test(m[1])) { // full stops only: maybe an initial, an abbreviation or a list number
        if (/^\p{Ll}/u.test(text.slice(next))) continue; // a lowercase word continues the sentence ("data... and", "etc. were")
        const before = text.slice(start, m.index);
        if (/^\s*[0-9]{1,2}$/.test(before)) continue; // "1." opens a list item
        if (m[1] === '.') {
          const token = /[\p{L}.]*$/u.exec(before)[0];
          const initial = token.length > 0 && token.split('.').every(part => chars(part) === 1);
          // "don't." ends on t. That letter follows an apostrophe, so it is not the initial in "J." or "A.I."
          const contracted = initial && /['\u2019]$/u.test(before.slice(0, before.length - token.length));
          if ((initial || ABBREVIATIONS.has(token.toLowerCase())) && !contracted) continue; // "A.I.", "e.g.", "U.S.", "J.", "Dr.", "vs."
        }
      }
    }
    cuts.push([end, next]); start = next;
  }
  return cuts;
}

export function sentences(buffer) {
  const done = []; let start = 0;
  for (const [end, next] of boundaries(buffer)) { if (buffer.slice(start, end).trim()) done.push(buffer.slice(start, end)); start = next; }
  return [done, buffer.slice(start)];
}

// Streaming reply text -> the pieces to synthesise, each an exact slice of the text (trimmed). The first piece goes as soon
// as it is a whole sentence, or a clause of MIN_PIECE characters, so ATLAS starts talking early. After it, a sentence
// shorter than MIN_PIECE joins the next one while more text is coming: the voice gets whole phrases with natural
// intonation instead of clipped fragments with a pause after each.
export class Phrases {
  constructor() { this.text = ''; this.first = true; }
  feed(delta) {
    this.text += delta;
    const out = []; let start = 0;
    for (const [end, next] of boundaries(this.text)) {
      const piece = this.text.slice(start, end).trim();
      if (this.first || !piece || chars(piece) >= MIN_PIECE) { if (piece) { out.push(piece); this.first = false; } start = next; }
    }
    if (this.first) { const m = CLAUSE.exec(this.text.slice(start)); if (m) { out.push(m[1].trim()); this.first = false; start += m[0].length; } }
    this.text = this.text.slice(start);
    return out;
  }
  flush() { const piece = this.text.trim(); this.text = ''; return piece ? [piece] : []; }
}

// What the voice says for a piece of reply text: markdown and list markers removed, whitespace collapsed (the on-screen
// text keeps them). Empty when nothing speakable is left.
export function speakable(text) {
  const t = text.replace(/^\s*(?:#{1,6}|[-*\u2022]|[0-9]{1,2}[.)])\s+/gmu, '').replace(/\*\*|__|[*`]/g, '').split(/\s+/).filter(Boolean).join(' ');
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

export function wav(pcm, rate = SAMPLE_RATE) {
  const header = new ArrayBuffer(44), v = new DataView(header), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  return concat(new Uint8Array(header), pcm);
}
