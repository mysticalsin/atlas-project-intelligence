// Colleague confirm page. The page lifecycle is a reducer. The page runs the effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_EVENTS, CONFIRM_PHASES, confirmStep } from '../src/confirm-step.js';

const LEGAL = {
  'loading:loaded': 'choosing',
  'choosing:loaded': 'choosing',
  'recorded:loaded': 'choosing',
  'empty:loaded': 'choosing',
  'loading:vacant': 'empty',
  'choosing:vacant': 'empty',
  'recorded:vacant': 'empty',
  'loading:broke': 'failed',
  'choosing:submit': 'submitting',
  'submitting:succeed': 'recorded',
  'submitting:fail': 'choosing',
};

test('every legal confirm pair, and every other pair is refused', () => {
  let legal = 0;
  let illegal = 0;
  for (const phase of CONFIRM_PHASES) {
    for (const type of CONFIRM_EVENTS) {
      const before = { phase };
      const result = confirmStep(before, { type, ready: true });
      const key = phase + ':' + type;
      if (Object.hasOwn(LEGAL, key)) {
        legal++;
        assert.equal(result.ok, true, key);
        assert.equal(result.illegal, false, key);
        assert.equal(result.rejection, undefined, key);
        assert.equal(result.state.phase, LEGAL[key], key);
        assert.notEqual(result.state, before, key);
      } else {
        illegal++;
        assert.equal(result.illegal, true, key);
        assert.equal(result.ok, false, key);
        assert.equal(result.state, before, key);
        assert.deepEqual(result.effects, [], key);
        assert.deepEqual(result.rejection, { id: 'confirm-page', phase, event: type }, key);
      }
    }
  }
  assert.equal(legal, Object.keys(LEGAL).length);
  assert.equal(legal + illegal, CONFIRM_PHASES.length * CONFIRM_EVENTS.length);
  assert.equal(illegal, 25);
});

test('a submit that is not ready stays on choosing and is not a refusal', () => {
  const before = { phase: 'choosing' };
  const result = confirmStep(before, { type: 'submit', ready: false });
  assert.equal(result.ok, true);
  assert.equal(result.illegal, false);
  assert.equal(result.guard, 'ready');
  assert.equal(result.state, before);
  assert.deepEqual(result.effects, []);
});

test('an unknown phase or event is refused and the stored state is kept', () => {
  const before = { phase: 'archived' };
  const result = confirmStep(before, { type: 'loaded' });
  assert.equal(result.state, before);
  assert.equal(result.rejection.phase, 'unknown');
  assert.equal(result.rejection.event, 'loaded');
  const named = confirmStep({ phase: 'choosing' }, { type: 'reopen' });
  assert.equal(named.rejection.event, 'unknown');
  assert.equal(named.rejection.phase, 'choosing');
});

test('no confirm phase is unreachable, and every terminal phase is reachable', () => {
  const seen = new Set();
  const queue = [{ phase: 'loading' }];
  let steps = 0;
  while (queue.length && steps < 200) {
    const state = queue.shift();
    if (seen.has(state.phase)) continue;
    seen.add(state.phase);
    steps++;
    for (const type of CONFIRM_EVENTS) {
      const result = confirmStep(state, { type, ready: true });
      if (result.ok) queue.push(result.state);
    }
  }
  for (const phase of CONFIRM_PHASES) assert.equal(seen.has(phase), true, phase);
  const terminals = CONFIRM_PHASES.filter(phase => CONFIRM_EVENTS.every(type => {
    const result = confirmStep({ phase }, { type, ready: true });
    return !result.ok || result.state.phase === phase;
  }));
  assert.deepEqual(terminals, ['failed']);
  for (const phase of terminals) assert.equal(seen.has(phase), true, phase);
});
