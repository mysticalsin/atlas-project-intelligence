// Sweep 01 group 8 (breaker, L4). Copied from the red tests at 96712474.
// Fails on main. Not skipped and not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, initialBreaker, blocked, BREAKER_OPEN_MS } from '../src/breaker.js';

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

test('L4 a missing, infinite, or zero clock still opens for a finite quiet period', () => {
  const openAt = now => {
    let state = initialBreaker();
    state = transition(state, { type: 'fail', now: 0 }).state;
    state = transition(state, { type: 'fail', now: 0 }).state;
    return transition(state, { type: 'fail', now }).state;
  };
  for (const now of [undefined, NaN, Infinity, -Infinity, 0, 1000]) {
    const opened = openAt(now);
    const expected = (Number.isFinite(now) ? now : 0) + BREAKER_OPEN_MS;
    assert.equal(opened.until, expected);
    assert.equal(Number.isFinite(opened.until), true);
    assert.equal(blocked(opened, null, expected - 1), 'circuit_open');
    assert.notEqual(blocked(opened, null, expected), 'circuit_open');
  }
  let counting = initialBreaker();
  counting = transition(counting, { type: 'fail', now: 5 }).state;
  const still = transition(counting, { type: 'fail' });
  assert.equal(still.state.phase, 'closed');
  assert.equal(still.state.until, 0);
});
