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
// Process CPU time (not wall time, which a busy machine inflates), best of 5 batches of 20 calls: the bounds are the Python test's (2 ms for real answers, 5 ms for junk).
const perCall = text => {
  const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  analyzeTurn(text); let best = Infinity;
  for (let b = 0; b < 5; b++) { const t0 = cpu(); for (let i = 0; i < 20; i++) analyzeTurn(text); best = Math.min(best, (cpu() - t0) / 20); }
  return best;
};
test('turn pre-pass is fast (under 2 ms per utterance, under 5 ms on degenerate input)', () => {
  const typical = 'So we migrated the billing platform from the old batch jobs to Kafka, and I personally owned the cutover plan. It was about 80% faster.';
  const long = 'we used Python, Kafka and Terraform and it was about 80% faster, the client said it was the best team. '.repeat(40);
  for (const t of [typical, long]) assert.ok(perCall(t) < 2, `${perCall(t).toFixed(3)} ms`);
  for (const t of ['we '.repeat(1500), 'a'.repeat(5000), '3 '.repeat(2000)]) assert.ok(perCall(t) < 5, `${t.slice(0, 6)}: ${perCall(t).toFixed(3)} ms`);
});
test('turn pre-pass: numbers stop at the cap, and a text without a digit has none', () => {
  assert.equal(analyzeTurn('3 '.repeat(500)).numbers.length, 20); assert.deepEqual(analyzeTurn('no digits here').numbers, []);
});
test('turn pre-pass: every gate is a list of non-empty lower-case literals', async () => {
  const G = await import('../src/policy.generated.js'), all = [...Object.values(G.TURN_CUE_GATES), ...Object.values(G.TURN_HINT_GATES), G.TURN_NUMBER_GATE, ...Object.values(G.TURN_INTENT_RULES).flat().map(r => r.gate)];
  assert.ok(all.length > 60);
  for (const gate of all) for (const req of gate) { assert.ok(req.length > 0); for (const w of req) assert.ok(w.length > 0 && w === w.toLowerCase()); }
});
