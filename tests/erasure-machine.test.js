// Privacy erasure: every legal transition, the full cross product of the rest, and the in-flight guard.
// The view is not stored. The transition does not log and does not touch the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ERASURE_EVENTS, ERASURE_ID, ERASURE_STATES, erasureTransition, initialErasure } from '../src/erasure-machine.js';

const LEGAL = new Set([
  'idle:ask',
  'confirming:cancel',
  'confirming:confirm',
  'in_flight:succeed',
  'in_flight:fail',
  'receipt:ask',
  'failed:ask',
]);

const NEXT = {
  'idle:ask': 'confirming',
  'confirming:cancel': 'idle',
  'confirming:confirm': 'in_flight',
  'in_flight:succeed': 'receipt',
  'in_flight:fail': 'failed',
  'receipt:ask': 'confirming',
  'failed:ask': 'confirming',
};

const EFFECTS = {
  ask: ['show_confirm'],
  cancel: ['dismiss_confirm'],
  confirm: ['post_delete'],
  succeed: ['show_receipt'],
  fail: ['show_error'],
};

test('every legal erasure transition, and every other pair is rejected with id, phase and event only', () => {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  const logged = [];
  let legal = 0;
  let illegal = 0;
  try {
    for (const status of ERASURE_STATES) {
      for (const type of ERASURE_EVENTS) {
        const before = { status };
        const result = erasureTransition(before, { type, email: 'Ada@Example.test', note: 'secret' });
        if (LEGAL.has(status + ':' + type)) {
          legal++;
          assert.equal(result.ok, true, status + ' ' + type);
          assert.equal(result.illegal, false);
          assert.equal(result.rejection, undefined);
          assert.equal(result.state.status, NEXT[status + ':' + type]);
          assert.notEqual(result.state, before);
          assert.deepEqual(result.effects, EFFECTS[type]);
        } else {
          illegal++;
          assert.equal(result.ok, false, status + ' ' + type);
          assert.equal(result.illegal, true);
          assert.equal(result.state, before);
          assert.deepEqual(result.effects, []);
          assert.deepEqual(Object.keys(result.rejection).sort(), ['event', 'id', 'phase']);
          assert.deepEqual(result.rejection, { id: ERASURE_ID, phase: status, event: type });
          logged.push(result.rejection);
        }
      }
    }
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, 0, 'the transition does not log');
  assert.equal(legal + illegal, ERASURE_STATES.length * ERASURE_EVENTS.length);
  assert.equal(legal, LEGAL.size);
  assert.equal(logged.length, illegal);
  assert.ok(illegal > 0);
});

test('a second ask or confirm while the request is in flight is rejected', () => {
  const flying = erasureTransition(initialErasure(), { type: 'ask' });
  const posted = erasureTransition(flying.state, { type: 'confirm' });
  assert.equal(posted.state.status, 'in_flight');
  assert.deepEqual(posted.effects, ['post_delete']);
  for (const type of ['ask', 'confirm']) {
    const again = erasureTransition(posted.state, { type, email: 'ada@example.test' });
    assert.equal(again.illegal, true, type);
    assert.equal(again.state, posted.state);
    assert.deepEqual(again.effects, []);
    assert.deepEqual(again.rejection, { id: ERASURE_ID, phase: 'in_flight', event: type });
  }
  const done = erasureTransition(posted.state, { type: 'succeed' });
  assert.equal(done.state.status, 'receipt');
  assert.equal(erasureTransition(done.state, { type: 'ask' }).state.status, 'confirming');
});

test('confirm is legal only while confirming, and cancel returns to idle', () => {
  assert.equal(erasureTransition(initialErasure(), { type: 'confirm' }).illegal, true);
  assert.equal(erasureTransition(initialErasure(), { type: 'cancel' }).illegal, true);
  const open = erasureTransition(initialErasure(), { type: 'ask' });
  assert.deepEqual(open.effects, ['show_confirm']);
  assert.equal(erasureTransition(open.state, { type: 'ask' }).illegal, true);
  const back = erasureTransition(open.state, { type: 'cancel' });
  assert.equal(back.state.status, 'idle');
  assert.deepEqual(back.effects, ['dismiss_confirm']);
  const failed = erasureTransition({ status: 'in_flight' }, { type: 'fail' });
  assert.equal(failed.state.status, 'failed');
  assert.deepEqual(failed.effects, ['show_error']);
  assert.equal(erasureTransition(failed.state, { type: 'ask' }).state.status, 'confirming');
});

test('an unknown phase rejects every event and is not rewritten', () => {
  const stored = { status: 'pendingDelete', receipt: 'old' };
  for (const type of ERASURE_EVENTS) {
    const result = erasureTransition(stored, { type });
    assert.equal(result.illegal, true, type);
    assert.equal(result.state, stored);
    assert.deepEqual(result.rejection, { id: ERASURE_ID, phase: 'unknown', event: type });
  }
  assert.equal(erasureTransition(null, { type: 'ask' }).rejection.phase, 'unknown');
  assert.equal(erasureTransition({ status: 'idle' }, { type: 'other' }).rejection.event, 'unknown');
});
