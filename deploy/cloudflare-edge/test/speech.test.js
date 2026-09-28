import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EnergyTurns, sentences, wav, SAMPLE_RATE } from '../src/speech.js';

const V = JSON.parse(readFileSync(new URL('./speech.vectors.json', import.meta.url)));
const tone = (sec, amp, hz = 180) => { const n = Math.floor(SAMPLE_RATE * sec), a = []; for (let i = 0; i < n; i++) a.push(Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * hz * i / SAMPLE_RATE))); return a; };
for (const [name, v] of Object.entries(V)) {
  if (name.startsWith('_')) continue;
  test('EnergyTurns parity: ' + name, () => {
    const samples = v.segments.flatMap(([s, a]) => tone(s, a)), t = new EnergyTurns(), events = [];
    for (let i = 0; i < samples.length; i += 480) {
      const chunk = samples.slice(i, i + 480), pcm = new Uint8Array(chunk.length * 2), dv = new DataView(pcm.buffer);
      chunk.forEach((s, k) => dv.setInt16(k * 2, s, true));
      const [started, utt] = t.feed(pcm, v.agent);
      if (started) events.push(['start', i]);
      if (utt) events.push(['utt', i, utt.length]);
    }
    assert.deepEqual(events, v.events); assert.ok(Math.abs(t.floor - v.floor) < 1e-9);
  });
}
test('sentence splitting parity', () => { for (const [s, exp] of V._sentences) assert.deepEqual(sentences(s), exp); });
test('wav header', () => { const w = wav(new Uint8Array(20)), d = new DataView(w.buffer); assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF'); assert.equal(d.getUint32(24, true), 24000); assert.equal(d.getUint32(40, true), 20); });
import { isEcho } from '../src/speech.js';
test('echo detection matches Python', () => {
  const agent = "I'm ATLAS, here to discuss your project experience. What problem were you trying to solve with Project Falcon?";
  assert.ok(isEcho('what problem were you trying to solve', agent));
  assert.ok(!isEcho('Tickets were bouncing between three support teams', agent));
  assert.ok(!isEcho('yes', agent) && !isEcho('a b c', ''));
});

test('echo detection parity across scripts (French, Japanese, Russian, English)', () => { for (const [a, b, exp] of V._echo) assert.equal(isEcho(a, b), exp, a); });
