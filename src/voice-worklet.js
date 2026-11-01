/* PCM transport only. This is NOT speech recognition or a speech synthesizer. */
// Band-limited polyphase resampler: Kaiser-windowed sinc (beta 8), cutoff 0.45 x the lower rate, 32 lower-rate samples
// each side, linear phase. Measured in tests/resampler.test.js: flat within 0.05 dB up to 0.42 x the lower rate (10 kHz when
// 24 kHz is the lower rate); images and aliases >= 90 dB down at 48, 44.1, 32 and 16 kHz (>= 65 dB at a non-standard rate,
// whose filter phases are quantized to 1024); 32 / lower rate of added delay (1.33 ms at 24 kHz, 2 ms at 16 kHz). A 48 kHz
// device costs 65 taps x 48000 + 129 taps x 24000 = 6.2 M multiply-adds per second. The output schedule (samples per block)
// is unchanged, so the ring buffer, the 480-sample frames and the playback acknowledgements behave as before. Coefficients
// and buffers are allocated once; write() allocates nothing unless a block larger than any before arrives.
const RESAMPLE_ZEROS = 32, RESAMPLE_BETA = 8, RESAMPLE_CUTOFF = .45, RESAMPLE_MAX_PHASES = 1024;
function besselI0(x) { let sum = 1, term = 1; for (let k = 1; k < 64 && term > 1e-12 * sum; k++) { term *= (x / (2 * k)) ** 2; sum += term; } return sum; }
class AtlasResampler {
  constructor(from, to) {
    this.from = from; this.to = to; this.phase = 0; this.pos = 0; this.taps = 0; this.out = new Float32Array(512);
    const a = Math.round(from), b = Math.round(to); let g = a, r = b; while (r) [g, r] = [r, g % r];
    this.up = b / g; this.down = a / g; // one input sample advances the phase by `up`, one output sample consumes `down`
    if (a === b) return;
    const low = Math.min(a, b), half = RESAMPLE_ZEROS * a / low, center = Math.ceil(half), taps = 2 * center + 1;
    const cutoff = RESAMPLE_CUTOFF * low / a, phases = Math.min(this.up, RESAMPLE_MAX_PHASES), norm = besselI0(RESAMPLE_BETA);
    this.taps = taps; this.phases = phases; this.hist = new Float32Array(2 * taps); this.coef = new Float32Array(phases * taps);
    // Row p: taps (oldest input first) for an output lying center + p/phases input samples before the newest input.
    for (let p = 0; p < phases; p++) {
      const row = p * taps; let sum = 0;
      for (let j = 0; j < taps; j++) {
        const t = j - center + p / phases, u = t / half, x = 2 * cutoff * t;
        const v = Math.abs(u) > 1 ? 0 : besselI0(RESAMPLE_BETA * Math.sqrt(1 - u * u)) / norm * (x ? Math.sin(Math.PI * x) / (Math.PI * x) : 1);
        this.coef[row + j] = v; sum += v;
      }
      for (let j = 0; j < taps; j++) this.coef[row + j] /= sum; // exact unity gain at DC for every phase
    }
  }
  // Resamples `length` samples of `input` (times `scale`) into this.out and returns how many were written.
  write(input, length = input.length, scale = 1) {
    const up = this.up, down = this.down, need = Math.floor((this.phase + length * up) / down);
    if (this.out.length < need) this.out = new Float32Array(need); // only when a larger block than any before arrives
    const out = this.out;
    if (!this.taps) { for (let i = 0; i < length; i++) out[i] = input[i] * scale; return length; }
    const taps = this.taps, hist = this.hist, coef = this.coef, phases = this.phases;
    let pos = this.pos, phase = this.phase, n = 0;
    for (let i = 0; i < length; i++) {
      const x = input[i] * scale; hist[pos] = x; hist[pos + taps] = x; // mirrored: hist[pos .. pos+taps) is always contiguous
      if (++pos === taps) pos = 0;
      phase += up;
      while (phase >= down) {
        phase -= down;
        const row = ((phase * phases / up) | 0) * taps; let acc = 0;
        for (let j = 0; j < taps; j++) acc += hist[pos + j] * coef[row + j];
        out[n++] = acc;
      }
    }
    this.pos = pos; this.phase = phase;
    return n;
  }
  push(samples) { const n = this.write(samples); return this.out.slice(0, n); } // copying convenience; the audio thread uses write()
  reset() { if (this.hist) this.hist.fill(0); }
}
class AtlasDuplexProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputRate = new AtlasResampler(sampleRate, 24000);
    this.outputRate = new AtlasResampler(24000, sampleRate);
    this.frame = new Int16Array(480); this.offset = 0; this.silence = new Float32Array(128);
    // v2.2 V1: a one second ring (the server sends up to ~0.5 s ahead of what has played), playback starts at 150 ms buffered (or, after a stall, 60 ms after the last
    // audio arrived), her volume ducks while a sound over her voice is checked, and every time the ring runs dry mid-playback is counted.
    this.ring = new Float32Array(Math.ceil(sampleRate * 1));
    this.read = 0; this.write = 0; this.count = 0; this.playing = false; this.waited = 0; this.underruns = 0;
    this.gain = 1; this.gainTarget = 1; this.duckLeft = 0; this.gainStep = 1 / (.015 * sampleRate);
    this.ringItems = new Array(this.ring.length).fill(null); this.consumed = new Map(); this.lastPlayedItem = null;
    this.low = 0; this.mid = 0; this.spectral = [0,0,0]; this.spectralSamples = 0;
    this.lowA=1-Math.exp(-2*Math.PI*350/sampleRate); this.midA=1-Math.exp(-2*Math.PI*2400/sampleRate);
    this.enabled = false; this.muted = false; this.meterCount = 0; this.dropped = 0;
    this.port.onmessage = event => {
      const m = event.data;
      if (m.type === 'state') {
        if (!!m.muted !== this.muted) { this.offset = 0; this.frame.fill(0); }
        this.enabled = !!m.enabled; this.muted = !!m.muted;
        if (!this.enabled) this.offset = 0;
      } else if (m.type === 'duck') {
        this.gainTarget = m.on ? .25 : 1; this.duckLeft = m.on ? Math.ceil(3 * sampleRate) : 0; // (it lets go by itself after 3 s: a lost message cannot leave her quiet)
      } else if (m.type === 'flush') {
        this.count = 0; this.read = 0; this.write = 0; this.playing = false; this.waited = 0; this.gainTarget = 1; this.duckLeft = 0;
        this.low=0;this.mid=0;this.spectral=[0,0,0];this.spectralSamples=0;
        this.outputRate.reset(); // the filter's memory of the cut-off reply must not play into the next one
      } else if (m.type === 'audio') {
        const pcm = new Int16Array(m.buffer); this.waited = 0;
        const length = this.outputRate.write(pcm, pcm.length, 1 / 32768), samples = this.outputRate.out;
        for (let i = 0; i < length; i++) {
          if (this.count === this.ring.length) {
            this.read = (this.read + 1) % this.ring.length; this.count--; this.dropped++;
          }
          this.ring[this.write] = samples[i];
          this.ringItems[this.write] = typeof m.item_id === 'string' ? m.item_id : null;
          this.write = (this.write + 1) % this.ring.length; this.count++;
        }
      }
    };
  }
  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (this.silence.length !== output.length) this.silence = new Float32Array(output.length);
    const input = inputs[0]?.[0] || this.silence;
    let mic = 0, speaker = 0;
    if (this.enabled) {
      const length = this.inputRate.write(input), samples = this.inputRate.out;
      for (let i = 0; i < length; i++) {
        const value = this.muted ? 0 : Math.max(-1, Math.min(1, samples[i]));
        mic += value * value;
        this.frame[this.offset++] = value < 0 ? value * 32768 : value * 32767;
        if (this.offset === 480) {
          const data = this.frame.buffer;
          this.port.postMessage({type: 'pcm', buffer: data}, [data]);
          this.frame = new Int16Array(480); this.offset = 0;
        }
      }
      mic = Math.sqrt(mic / Math.max(1, length));
    }
    if (!this.playing && this.count) { this.waited += output.length; if (this.count >= sampleRate * .15 || this.waited >= sampleRate * .06) this.playing = true; }
    if (this.duckLeft > 0 && (this.duckLeft -= output.length) <= 0) this.gainTarget = 1;
    for (let i = 0; i < output.length; i++) {
      let value = 0;
      if (this.playing && this.count) {
        const item = this.ringItems[this.read];
        if (item) { this.lastPlayedItem=item; this.consumed.set(item,(this.consumed.get(item)||0)+1); if(this.consumed.size>64)this.consumed.delete(this.consumed.keys().next().value); }
        value = this.ring[this.read]; this.read = (this.read + 1) % this.ring.length; this.count--;
      } else if (!this.count && this.playing) { this.playing = false; this.underruns++; }
      if (this.gain !== this.gainTarget) this.gain = this.gain < this.gainTarget ? Math.min(this.gainTarget, this.gain + this.gainStep) : Math.max(this.gainTarget, this.gain - this.gainStep);
      output[i] = value * this.gain; speaker += value * value;
      this.low+=this.lowA*(value-this.low); this.mid+=this.midA*(value-this.mid);
      this.spectral[0]+=this.low*this.low;this.spectral[1]+=(this.mid-this.low)**2;this.spectral[2]+=(value-this.mid)**2;this.spectralSamples++;
    }
    if (++this.meterCount >= 12) {
      this.meterCount = 0;
      this.port.postMessage({type: 'meter', mic, speaker: Math.sqrt(speaker / output.length),
        bands:{low:Math.sqrt(this.spectral[0]/Math.max(1,this.spectralSamples)),mid:Math.sqrt(this.spectral[1]/Math.max(1,this.spectralSamples)),high:Math.sqrt(this.spectral[2]/Math.max(1,this.spectralSamples))},
        queuedMs: 1000 * this.count / sampleRate, droppedSamples: this.dropped, underruns: this.underruns,
        playedItem:this.lastPlayedItem, playedMs:1000*(this.consumed.get(this.lastPlayedItem)||0)/sampleRate});
      this.spectral=[0,0,0];this.spectralSamples=0;
    }
    return true;
  }
}
registerProcessor('atlas-duplex', AtlasDuplexProcessor);
