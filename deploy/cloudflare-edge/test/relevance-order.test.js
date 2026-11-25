// Two stories with the same five dimension scores must keep the gateway order.
// A left-to-right sum of the weights is a tenth off, and the stories swap.
// Synthetic scores only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResult } from '../src/customer-jev.js';

const KEYS = ['problem_fit', 'transferability', 'evidence', 'decision_value', 'recency'];

function judged(scores) {
  const answers = {};
  for (let i = 0; i < KEYS.length; i++) {
    const score = scores[i];
    const probabilities = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    probabilities[score] = 1;
    answers[KEYS[i]] = { type: 'score', score, confidence: 1, probabilities };
  }
  return { model: 'fixture-not-a-live-model', answers };
}

function rank(scores) {
  return parseResult(judged(scores)).relevance_score;
}

test('two stories keep the gateway relevance order', () => {
  const higher = rank([0, 2, 3, 1, 2]);
  const lower = rank([0, 1, 1, 4, 4]);
  assert.equal(higher, 36.3);
  assert.equal(lower, 36.2);
  assert.deepEqual([higher, lower].sort((a, b) => b - a), [36.3, 36.2]);
  assert.equal(rank([0, 0, 1, 3, 1]), 18.8);
});
