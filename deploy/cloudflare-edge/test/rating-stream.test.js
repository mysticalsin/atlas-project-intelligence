// S1 rating stream. The interactive attempt lifecycle is a reducer. Effects run in storyRater, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RATING_STREAM_EVENTS, RATING_STREAM_PHASES, initialRatingStream, ratingStreamTransition } from '../src/rating-stream.js';

const LEGAL = {
  'idle:launch': 'running',
  'idle:deadline': 'settled',
  'running:launch': 'running',
  'running:succeed': 'settled',
  'running:retryable': 'running',
  'running:terminal': 'settled',
  'running:deadline': 'settled',
  'settled:observe': 'settled',
};

function sample(phase) {
  if (phase === 'idle') return initialRatingStream();
  if (phase === 'running') return { phase: 'running', attempts: 1, pending: 1, hedged: 0, max: 2 };
  return { phase: 'settled', attempts: 1, pending: 0, hedged: 0, max: 2 };
}

test('every legal rating-stream pair, and every other pair is refused', () => {
  let legal = 0;
  let illegal = 0;
  for (const phase of RATING_STREAM_PHASES) {
    for (const type of RATING_STREAM_EVENTS) {
      const before = sample(phase);
      const result = ratingStreamTransition(before, { type, max: 2, room: true });
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
        assert.deepEqual(result.rejection, { id: 'rating-stream', phase, event: type }, key);
      }
    }
  }
  assert.equal(legal, Object.keys(LEGAL).length);
  assert.equal(legal + illegal, RATING_STREAM_PHASES.length * RATING_STREAM_EVENTS.length);
  assert.equal(illegal, 10);
});

test('room and budget guards allow one request and refuse the next without a new phase', () => {
  const idle = initialRatingStream();
  const noRoom = ratingStreamTransition(idle, { type: 'launch', max: 2, room: false });
  assert.equal(noRoom.ok, true);
  assert.equal(noRoom.illegal, false);
  assert.equal(noRoom.guard, 'room');
  assert.equal(noRoom.state, idle);
  assert.deepEqual(noRoom.effects, []);
  const noBudget = ratingStreamTransition(idle, { type: 'launch', max: 0, room: true });
  assert.equal(noBudget.guard, 'budget');
  assert.equal(noBudget.state, idle);

  const running = sample('running');
  const allowed = ratingStreamTransition(running, { type: 'launch', max: 2, room: true });
  assert.equal(allowed.state.phase, 'running');
  assert.equal(allowed.state.attempts, 2);
  assert.equal(allowed.state.pending, 2);
  assert.equal(allowed.state.hedged, 1);
  assert.deepEqual(allowed.effects, ['request']);
  const blocked = ratingStreamTransition({ ...running, attempts: 2, max: 2 }, { type: 'launch', max: 2, room: true });
  assert.equal(blocked.guard, 'budget');
  assert.equal(blocked.state.attempts, 2);
  assert.deepEqual(blocked.effects, []);
});

test('a retryable result follows only while room and budget remain', () => {
  const running = sample('running');
  const follow = ratingStreamTransition(running, { type: 'retryable', room: true });
  assert.equal(follow.state.phase, 'running');
  assert.equal(follow.state.attempts, 2);
  assert.equal(follow.state.pending, 1);
  assert.deepEqual(follow.effects, ['request']);
  const settle = ratingStreamTransition(running, { type: 'retryable', room: false });
  assert.equal(settle.state.phase, 'settled');
  assert.equal(settle.state.attempts, 1);
  assert.equal(settle.state.pending, 0);
  assert.deepEqual(settle.effects, ['resolve', 'observe']);
  const wait = ratingStreamTransition({ ...running, pending: 2 }, { type: 'retryable', room: false });
  assert.equal(wait.state.phase, 'running');
  assert.equal(wait.state.pending, 1);
  assert.equal(wait.state.attempts, 1);
  assert.deepEqual(wait.effects, []);
});

test('an unknown phase or event is refused and the stored state is kept', () => {
  const before = { phase: 'archived', attempts: 1, pending: 0, hedged: 0, max: 2 };
  const result = ratingStreamTransition(before, { type: 'launch', max: 2, room: true });
  assert.equal(result.state, before);
  assert.equal(result.rejection.phase, 'unknown');
  assert.equal(result.rejection.event, 'launch');
  const named = ratingStreamTransition(sample('running'), { type: 'reopen' });
  assert.equal(named.rejection.event, 'unknown');
  assert.equal(named.rejection.phase, 'running');
});

test('no rating-stream phase is unreachable, and every terminal phase is reachable', () => {
  const seen = new Set();
  const queue = [initialRatingStream()];
  let steps = 0;
  while (queue.length && steps < 200) {
    const state = queue.shift();
    const key = JSON.stringify(state);
    if (seen.has(key)) continue;
    seen.add(key);
    steps++;
    for (const type of RATING_STREAM_EVENTS) {
      const result = ratingStreamTransition(state, { type, max: 2, room: true });
      if (result.ok) queue.push(result.state);
    }
  }
  const phases = new Set([...seen].map(key => JSON.parse(key).phase));
  for (const phase of RATING_STREAM_PHASES) assert.equal(phases.has(phase), true, phase);
  const terminals = RATING_STREAM_PHASES.filter(phase => RATING_STREAM_EVENTS.every(type => {
    const result = ratingStreamTransition(sample(phase), { type, max: 2, room: true });
    return !result.ok || result.state.phase === phase;
  }));
  assert.deepEqual(terminals, ['settled']);
  for (const phase of terminals) assert.equal(phases.has(phase), true, phase);
});
