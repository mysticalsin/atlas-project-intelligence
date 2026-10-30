// Python <-> JavaScript parity for the turn pre-pass (atlas_voice/turns.py): every recorded utterance gives the same result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeTurn } from '../src/turns.js';
const V = JSON.parse(readFileSync(new URL('./turns.vectors.json', import.meta.url)));
test('turn pre-pass: at least 40 vectors', () => assert.ok(V.length >= 40));
test('turn pre-pass parity with Python on every vector', () => {
  for (const [args, expected] of V) assert.deepEqual(analyzeTurn(...args), expected, JSON.stringify(args).slice(0, 120));
});
test('turn pre-pass returns exactly the five keys, no person-describing key', () => {
  for (const [args] of V) assert.deepEqual(Object.keys(analyzeTurn(...args)), ['intents', 'cues', 'field_hints', 'numbers', 'words']);
});
test('turn pre-pass is fast (under 2 ms per utterance)', () => {
  const long = 'we used Python, Kafka and Terraform and it was about 80% faster, the client said it was the best team. '.repeat(40);
  analyzeTurn(long); const t0 = performance.now(); for (let i = 0; i < 200; i++) analyzeTurn(long); const per = (performance.now() - t0) / 200;
  assert.ok(per < 2, `${per.toFixed(3)} ms`);
});
