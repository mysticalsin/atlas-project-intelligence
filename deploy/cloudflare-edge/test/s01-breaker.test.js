// Sweep 01 group 8 (breaker, L4). Copied from the red tests at 96712474.
// Fails on main. Not skipped and not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, initialBreaker, blocked } from '../src/breaker.js';

test('L4 a failure that opens the breaker records a finite quiet period', () => {
  let state = initialBreaker();
  state = transition(state, { type: 'fail', now: 0 }).state;
  state = transition(state, { type: 'fail', now: 0 }).state;
  const opened = transition(state, { type: 'fail' });
  assert.equal(opened.ok, true);
  assert.equal(opened.state.phase, 'open');
  assert.equal(Number.isFinite(opened.state.until), true);
  assert.equal(blocked(opened.state, null, 1000), 'circuit_open');
});
