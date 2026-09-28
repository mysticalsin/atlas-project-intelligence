/* PCM transport only. This is NOT speech recognition or a speech synthesizer. */
class AtlasResampler {
  constructor(from, to) { this.from = from; this.to = to; this.phase = 0; this.prev = 0; }
  push(samples) {
    if (this.from === this.to) return samples;
    const out = [];
    for (const current of samples) {
      this.phase += this.to;
      while (this.phase >= this.from) {
        this.phase -= this.from;
        const fraction = Math.max(0, Math.min(1, 1 - this.phase / this.to));
        out.push(this.prev + (current - this.prev) * fraction);
      }
      this.prev = current;
    }
    return Float32Array.from(out);
  }
}
class AtlasDuplexProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputRate = new AtlasResampler(sampleRate, 24000);
    this.outputRate = new AtlasResampler(24000, sampleRate);
    this.frame = new Int16Array(480); this.offset = 0;
    this.ring = new Float32Array(Math.ceil(sampleRate * .35));
    this.read = 0; this.write = 0; this.count = 0; this.playing = false;
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
      } else if (m.type === 'flush') {
        this.count = 0; this.read = 0; this.write = 0; this.playing = false;
        this.low=0;this.mid=0;this.spectral=[0,0,0];this.spectralSamples=0;
      } else if (m.type === 'audio') {
        const pcm = new Int16Array(m.buffer);
        const floats = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;
        const samples = this.outputRate.push(floats);
        for (const x of samples) {
          if (this.count === this.ring.length) {
            this.read = (this.read + 1) % this.ring.length; this.count--; this.dropped++;
          }
          this.ring[this.write] = x;
          this.ringItems[this.write] = typeof m.item_id === 'string' ? m.item_id : null;
          this.write = (this.write + 1) % this.ring.length; this.count++;
        }
      }
    };
  }
  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0] || new Float32Array(output.length);
    let mic = 0, speaker = 0;
    if (this.enabled) {
      const samples = this.inputRate.push(input);
      for (const raw of samples) {
        const value = this.muted ? 0 : Math.max(-1, Math.min(1, raw));
        mic += value * value;
        this.frame[this.offset++] = value < 0 ? value * 32768 : value * 32767;
        if (this.offset === 480) {
          const data = this.frame.buffer;
          this.port.postMessage({type: 'pcm', buffer: data}, [data]);
          this.frame = new Int16Array(480); this.offset = 0;
        }
      }
      mic = Math.sqrt(mic / Math.max(1, samples.length));
    }
    if (!this.playing && this.count >= sampleRate * .06) this.playing = true;
    for (let i = 0; i < output.length; i++) {
      let value = 0;
      if (this.playing && this.count) {
        const item = this.ringItems[this.read];
        if (item) { this.lastPlayedItem=item; this.consumed.set(item,(this.consumed.get(item)||0)+1); if(this.consumed.size>64)this.consumed.delete(this.consumed.keys().next().value); }
        value = this.ring[this.read]; this.read = (this.read + 1) % this.ring.length; this.count--;
      } else if (!this.count) this.playing = false;
      output[i] = value; speaker += value * value;
      this.low+=this.lowA*(value-this.low); this.mid+=this.midA*(value-this.mid);
      this.spectral[0]+=this.low*this.low;this.spectral[1]+=(this.mid-this.low)**2;this.spectral[2]+=(value-this.mid)**2;this.spectralSamples++;
    }
    if (++this.meterCount >= 12) {
      this.meterCount = 0;
      this.port.postMessage({type: 'meter', mic, speaker: Math.sqrt(speaker / output.length),
        bands:{low:Math.sqrt(this.spectral[0]/Math.max(1,this.spectralSamples)),mid:Math.sqrt(this.spectral[1]/Math.max(1,this.spectralSamples)),high:Math.sqrt(this.spectral[2]/Math.max(1,this.spectralSamples))},
        queuedMs: 1000 * this.count / sampleRate, droppedSamples: this.dropped,
        playedItem:this.lastPlayedItem, playedMs:1000*(this.consumed.get(this.lastPlayedItem)||0)/sampleRate});
      this.spectral=[0,0,0];this.spectralSamples=0;
    }
    return true;
  }
}
registerProcessor('atlas-duplex', AtlasDuplexProcessor);
