// Python <-> JavaScript parity for the next-move selector (atlas_voice/selector.py): every recorded situation gives the same Move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { select, similar, effectivePhase, contradiction } from '../src/selector.js';
import { SELECTOR_CONFIG, QUESTION_BANK, SELECTOR_LINES } from '../src/policy.generated.js';
const V = JSON.parse(readFileSync(new URL('./selector.vectors.json', import.meta.url)));
const KEYS = ['kind', 'intent', 'field', 'rung', 'say', 'why', 'reaction', 'ack_category', 'bridge', 'hook'];
const walk = function* (d) { if (d && typeof d === 'object') for (const [k, v] of Object.entries(d)) { yield k; yield* walk(v); } };
test('selector: at least 60 vectors', () => assert.ok(V.length >= 60, String(V.length)));
test('selector parity with Python on every vector', () => {
  for (const [args, expected] of V) assert.deepEqual(select(...args), expected, JSON.stringify(args).slice(0, 200));
});
test('selector returns exactly the ten Move keys and never a score', () => {
  for (const [args] of V) { const m = select(...args); assert.deepEqual(Object.keys(m), KEYS); assert.ok(![...walk(m)].some(k => /score|rank/i.test(k))); }
});
test('selector vectors cover every kind and every reaction', () => {
  const kinds = new Set(V.map(([, m]) => m.kind)), reactions = new Set(V.map(([, m]) => m.reaction));
  for (const k of ['ask', 'confirm_asr', 'reflect', 'summary', 'close', 'offer_move_on', 'accept_and_move']) assert.ok(kinds.has(k), k);
  for (const r of ['none', 'ack', 'earned']) assert.ok(reactions.has(r), r);
});
test('every question in the bank has exactly one question mark; the closing lines have none', () => {
  for (const [intent, e] of Object.entries(QUESTION_BANK)) for (const v of e.en) assert.equal(v.split('?').length - 1, 1, `${intent}: ${v}`);
  for (const e of Object.values(SELECTOR_LINES)) for (const v of e.en) assert.ok(!v.includes('?'), v);
});
test('every ask-like move says exactly one question', () => {
  for (const [, m] of V) assert.equal(m.say.split('?').length - 1, ['summary', 'close'].includes(m.kind) ? 0 : 1, m.say);
});
test('repetition: 3-gram Jaccard at 0.8, whole-text compare under three words', () => {
  const a = 'could you walk me through what was happening before the project started';
  assert.ok(similar(a, a.toUpperCase() + '!') && similar(a, a + ' today') && !similar(a, 'what was the main problem the team needed to solve') && !similar('', a));
  assert.ok(similar('hello there', 'Hello, there.') && !similar('hi', 'ho'));
});
test('phase follows the time left (the pace the session already uses)', () => {
  assert.equal(effectivePhase('breadth', 800), 'breadth'); assert.equal(effectivePhase('breadth', 210), 'closing'); assert.equal(effectivePhase('breadth', 211), 'breadth');
  assert.equal(effectivePhase('depth', 75), 'wrap'); assert.equal(effectivePhase('closing', 500), 'closing'); assert.equal(effectivePhase(null, null), 'breadth');
});
test('a contradiction needs numbers that differ on both sides', () => {
  const d = (...q) => ({ candidate_details: q.map(x => ({ field: 'outcome', quote: x, active: true })) });
  assert.equal(contradiction(d('It takes 25 minutes now', 'About 25 minutes')), null);
  assert.equal(contradiction(d('from 2 days to 25 minutes', 'It takes 25 minutes')), null);
  assert.deepEqual(contradiction(d('It takes 25 minutes now', 'The report now takes 40 minutes')), ['outcome', '25 minutes', '40 minutes']);
});
test('selector is fast (under 2 ms per move) and does not change its inputs', () => {
  const [args] = V.find(([a]) => a[2].length > 2) || V[0];
  const copy = JSON.stringify(args); select(...args); assert.equal(JSON.stringify(args), copy);
  const t0 = performance.now(); for (let i = 0; i < 300; i++) select(...args); const per = (performance.now() - t0) / 300;
  assert.ok(per < 2, `${per.toFixed(3)} ms`);
});
test('selector config is the one Python exports (integer weights only)', () => {
  for (const fc of Object.values(SELECTOR_CONFIG.fields)) for (const [k, v] of Object.entries(fc)) if (k !== 'intent') assert.ok(Number.isInteger(v), k);
  for (const v of Object.values(SELECTOR_CONFIG.weights)) assert.ok(Number.isInteger(v));
});
