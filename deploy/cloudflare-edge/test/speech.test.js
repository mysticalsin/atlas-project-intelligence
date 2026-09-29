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

// ---- Natural phrasing for the voice (sentence ends, pieces, markup) and a band-limited 16 kHz path. ----
import { Phrases, speakable, to16k, rms } from '../src/speech.js';
const steps = deltas => { const p = new Phrases(); return [...deltas.map(d => p.feed(d)), p.flush()]; };

test('sentence ends skip initialisms, abbreviations, an ellipsis before lowercase, decimals and list numbers', () => {
  assert.deepEqual(sentences('We used A.I. to triage. Then we'), [['We used A.I. to triage.'], 'Then we']);
  assert.deepEqual(sentences('For example, e.g. Kafka, i.e. a queue. It'), [['For example, e.g. Kafka, i.e. a queue.'], 'It']);
  assert.deepEqual(sentences('Mr. Smith and Dr. Patel led it. And'), [['Mr. Smith and Dr. Patel led it.'], 'And']);
  assert.deepEqual(sentences('The U.S. team grew 3.5 times. Next'), [['The U.S. team grew 3.5 times.'], 'Next']);
  assert.deepEqual(sentences('We had data... and more data... So'), [['We had data... and more data...'], 'So']);
  assert.deepEqual(sentences('Kafka, Spark, etc. were used vs. the old stack. Ok'), [['Kafka, Spark, etc. were used vs. the old stack.'], 'Ok']);
  assert.deepEqual(sentences('He said "done." Then'), [['He said "done."'], 'Then']);
  assert.deepEqual(sentences('1. We migrated. 2. We trained. 3'), [['1. We migrated.', '2. We trained.'], '3']);
  // At the end of the streamed text a full stop still ends the sentence at once, as ! and ? do.
  assert.deepEqual(sentences('It ended. '), [['It ended.'], '']); assert.deepEqual(sentences('Really? '), [['Really?'], '']);
});

test('phrases: the first piece goes at once, then short sentences join the next; the clause fast path needs 40 characters', () => {
  assert.deepEqual(steps(['Thanks. ', 'What was ', 'the baseline?']), [['Thanks.'], [], [], ['What was the baseline?']]);
  assert.deepEqual(steps(['Great. ', 'That is clear. ', 'So it worked. ', 'Who measured the change before and after?', ' Ok.']),
    [['Great.'], [], [], [], ['That is clear. So it worked. Who measured the change before and after?'], ['Ok.']]);
  // Model tokens carry the space before the next word: an ellipsis before a lowercase word is not an end.
  assert.deepEqual(steps(['Well...', ' it depends.', ' Right.']), [[], [], ['Well... it depends.'], ['Right.']]);
  assert.deepEqual(steps(['Before we get into the numbers and the detail, ', 'tell me who ', 'owned it.']), [['Before we get into the numbers and the detail,'], [], [], ['tell me who owned it.']]);
  assert.deepEqual(steps(['Right, so the budget, ', 'who owned it?', ' And']), [[], [], ['Right, so the budget, who owned it?'], ['And']]);
  assert.deepEqual(steps(['We used A.', 'I. models, e.g. ', 'GPT, in the U.S. ', 'market. It worked.']), [[], [], [], ['We used A.I. models, e.g. GPT, in the U.S. market.'], ['It worked.']]);
  // Every piece is an exact slice of the streamed text (the on-screen text is cut at it).
  const text = 'Great. That is clear.\n\nSo it worked. Who measured the change before and after? Ok.', p = new Phrases(), got = [];
  for (const ch of text) got.push(...p.feed(ch));
  got.push(...p.flush()); let at = 0;
  for (const piece of got) { const i = text.indexOf(piece, at); assert.ok(i >= at && !text.slice(at, i).trim(), piece); at = i + piece.length; }
  assert.equal(at, text.length);
});

test('speakable: markdown and list markers are removed for the voice only', () => {
  assert.equal(speakable('**Budget**: we cut __costs__ by `40%`.'), 'Budget: we cut costs by 40%.');
  assert.equal(speakable('- the budget\n- the scope'), 'the budget the scope');
  assert.equal(speakable('1. We migrated.\n2) We trained.'), 'We migrated. We trained.');
  assert.equal(speakable('## Summary\nWe moved.'), 'Summary We moved.');
  assert.equal(speakable('C# and F# stay, -5 degrees, 3.5 times.'), 'C# and F# stay, -5 degrees, 3.5 times.');
  assert.equal(speakable('*really* good'), 'really good');
  assert.equal(speakable('**'), ''); assert.equal(speakable(' - '), '');
});

test('phrase and speakable parity with Python', () => {
  for (const [deltas, exp] of V._phrases) assert.deepEqual(steps(deltas), exp, deltas.join('|'));
  for (const [text, exp] of V._speakable) assert.equal(speakable(text), exp, text);
});

const toneAt = (hz, sec = 0.5, amp = 0.5) => { const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(amp * 32767 * Math.sin(2 * Math.PI * hz * i / SAMPLE_RATE)), true); return pcm; };
const middle = pcm => pcm.subarray(800, pcm.length - 800); // away from the edges

test('to16k band-limits before decimating: 8-12 kHz no longer folds into the speech band; speech passes', () => {
  for (const hz of [9000, 10000, 11000]) { // above the 8 kHz limit of 16 kHz audio: would alias to 7, 6 and 5 kHz
    const inp = toneAt(hz), out = to16k(inp);
    assert.equal(out.length, Math.floor(inp.length / 2 * 2 / 3) * 2);
    assert.ok(rms(middle(out)) < 0.03 * rms(middle(inp)), `${hz} Hz leaks ${(rms(middle(out)) / rms(middle(inp))).toFixed(3)}`);
  }
  for (const hz of [300, 1000, 3000, 5000]) { const inp = toneAt(hz), ratio = rms(middle(to16k(inp))) / rms(middle(inp)); assert.ok(Math.abs(ratio - 1) < 0.03, `${hz} Hz gain ${ratio.toFixed(3)}`); }
  const odd = new Uint8Array(3001 * 2).fill(0); odd.set(toneAt(1000, 0.1).subarray(0, 4000));
  assert.equal(to16k(odd.subarray(2)).length, Math.floor(3000 * 2 / 3) * 2, 'unaligned views work');
});
