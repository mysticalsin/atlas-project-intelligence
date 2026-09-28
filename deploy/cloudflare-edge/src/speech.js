// JavaScript port of atlas_voice/speech.py EnergyTurns, sentences and wav_bytes (parity-tested).
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

// 24 kHz PCM16 -> 16 kHz PCM16 (linear interpolation), the rate turn-detection models expect.
export function to16k(pcm) {
  const n = pcm.length >> 1, src = new DataView(pcm.buffer, pcm.byteOffset, n * 2), m = Math.floor(n * 2 / 3), out = new Uint8Array(m * 2), dst = new DataView(out.buffer);
  for (let i = 0; i < m; i++) { const x = i * 1.5, a = Math.floor(x), f = x - a, s0 = src.getInt16(a * 2, true), s1 = a + 1 < n ? src.getInt16((a + 1) * 2, true) : s0; dst.setInt16(i * 2, Math.round(s0 + (s1 - s0) * f), true); }
  return out;
}

export function isEcho(text, recentAgentText) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) || [], agent = new Set(recentAgentText.toLowerCase().match(/[\p{L}\p{N}_']+/gu) || []); // any script
  if (words.length < 3 || !agent.size) return false;
  return words.filter(w => agent.has(w)).length / words.length >= 0.7;
}

export function sentences(buffer) {
  const parts = buffer.split(/(?<=[.!?])\s+|(?<=[。！？।])\s*/); // Latin, CJK and Devanagari sentence ends
  if (parts.length === 1) return [[], buffer];
  return [parts.slice(0, -1).filter(p => p.trim()), parts[parts.length - 1]];
}

export function wav(pcm, rate = SAMPLE_RATE) {
  const header = new ArrayBuffer(44), v = new DataView(header), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  return concat(new Uint8Array(header), pcm);
}
