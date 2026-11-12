// Story-rating breaker: every legal pair, the full cross product of the rest, both sides of each guard,
// and the half-open trial (the bug in rating.js before probing). The breaker is not stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BREAKER_EVENTS, BREAKER_FAILS, BREAKER_OPEN_MS, BREAKER_PHASES, authKeyMatches, blocked, initialBreaker, transition, windowStillOpen } from '../src/breaker.js';

const closed = (fails = 0, authKey = null) => ({ phase: 'closed', fails, until: 0, authKey });
const open = (until, fails = 0, authKey = null) => ({ phase: 'open', fails, until, authKey });
const probing = (fails = 0, authKey = null) => ({ phase: 'probing', fails, until: 0, authKey });
const quiet = { log: () => {} };

const samples = () => [closed(0), closed(1), closed(2), closed(0, 'old-key'), open(1_000_000), open(1_000_000, 1), probing()];

function legal(phase, type) {
  if (type === 'begin') return phase === 'closed' || phase === 'open';
  if (type === 'succeed') return phase === 'closed' || phase === 'probing';
  return ['fail', 'auth_fail', 'ignore'].includes(type);
}

test('every legal transition, and every other (phase, event) pair is rejected and logged', () => {
  const logged = [];
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  let legalCount = 0, illegalCount = 0;
  try {
  for (const state of samples()) {
    for (const type of BREAKER_EVENTS) {
      const event = { type, now: 2_000_000, key: 'other-key', trial: false };
      const result = transition(state, event);
      if (legal(state.phase, type)) {
        legalCount++;
        assert.equal(result.ok, true, state.phase + ' ' + type);
        assert.equal(result.illegal, false);
        assert.equal(result.rejection, undefined);
      } else {
        illegalCount++;
        assert.equal(result.ok, false, state.phase + ' ' + type);
        assert.equal(result.illegal, true);
        assert.equal(result.state, state, 'an illegal move does not change state');
        assert.equal(result.reason, type === 'begin' ? 'circuit_open' : 'illegal');
        logged.push(result.rejection);
      }
    }
  }
  } finally { console.warn = original; }
  assert.equal(warns.length, 0, 'the transition does not log');
  assert.equal(illegalCount, samples().filter(s => s.phase === 'probing').length + samples().filter(s => s.phase === 'open').length);
  assert.equal(legalCount, samples().length * BREAKER_EVENTS.length - illegalCount);
  assert.equal(logged.length, illegalCount);
  assert.ok(logged.every(l => l.atlas_metric === 'breaker' && l.illegal === true && !('key' in l) && !('authKey' in l)));
  // The phase list the cross product walks is the machine's own list, so a new phase fails this test until it is classified.
  assert.deepEqual(BREAKER_PHASES, ['closed', 'open', 'probing']);
});

test('guards: auth key and the open window, allow and deny', () => {
  assert.equal(authKeyMatches(closed(0, 'k'), 'k'), true);
  assert.equal(authKeyMatches(closed(0, 'k'), 'other'), false);
  assert.equal(authKeyMatches(closed(0, null), 'k'), false);
  const deniedAuth = transition(closed(0, 'k'), { type: 'begin', key: 'k', now: 0 }, quiet);
  assert.equal(deniedAuth.denied, true); assert.equal(deniedAuth.guard, 'authKeyMatches'); assert.equal(deniedAuth.reason, 'auth');
  assert.deepEqual(deniedAuth.state, closed(0, 'k'));
  const allowedAuth = transition(closed(0, 'k'), { type: 'begin', key: 'other', now: 0 }, quiet);
  assert.equal(allowedAuth.ok, true); assert.equal(allowedAuth.trial, false);

  const still = open(5000);
  assert.equal(windowStillOpen(still, 4999), true);
  assert.equal(windowStillOpen(still, 5000), false);
  const deniedWindow = transition(still, { type: 'begin', key: 'k', now: 4999 }, quiet);
  assert.equal(deniedWindow.denied, true); assert.equal(deniedWindow.guard, 'windowStillOpen'); assert.equal(deniedWindow.reason, 'circuit_open');
  const allowedWindow = transition(still, { type: 'begin', key: 'k', now: 5000 }, quiet);
  assert.equal(allowedWindow.ok, true); assert.equal(allowedWindow.trial, true); assert.equal(allowedWindow.state.phase, 'probing');
  assert.equal(blocked(allowedWindow.state, 'k', 5000), 'circuit_open', 'the in-flight trial blocks the next admit');
});

test('fail counting matches the old note(): three failures open, a trial failure reopens, a second note keeps the window', () => {
  let s = initialBreaker();
  s = transition(s, { type: 'fail', now: 10, trial: false }, quiet).state;
  assert.deepEqual(s, closed(1));
  s = transition(s, { type: 'fail', now: 20, trial: false }, quiet).state;
  assert.deepEqual(s, closed(2));
  s = transition(s, { type: 'fail', now: 30, trial: false }, quiet).state;
  assert.deepEqual(s, open(30 + BREAKER_OPEN_MS, 0));
  // The failure that opened it can be followed by another note in the same request. The window stays, fails becomes 1.
  s = transition(s, { type: 'fail', now: 40, trial: false }, quiet).state;
  assert.equal(s.phase, 'open'); assert.equal(s.fails, 1); assert.equal(s.until, 30 + BREAKER_OPEN_MS);
  const trial = transition(open(100), { type: 'begin', now: 100, key: 'k' }, quiet);
  const reopened = transition(trial.state, { type: 'fail', now: 110, trial: true }, quiet).state;
  assert.deepEqual(reopened, open(110 + BREAKER_OPEN_MS, 0));
  const closedAgain = transition(trial.state, { type: 'succeed' }, quiet).state;
  assert.deepEqual(closedAgain, closed(0));
  assert.equal(BREAKER_FAILS, 3);
});

test('a probing fail re-opens even when the trial flag is absent', () => {
  const result = transition(probing(0), { type: 'fail', now: 110, trial: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state, open(110 + BREAKER_OPEN_MS, 0));
  assert.equal(result.rejection, undefined, 'a legal probing fail is not a rejection');
  const later = transition(probing(2), { type: 'fail', now: 200 }, quiet);
  assert.equal(later.state.phase, 'open');
  assert.equal(later.state.fails, 0);
  assert.equal(later.state.until, 200 + BREAKER_OPEN_MS);
});

test('a probing ignore does not close and does not open a fresh window', () => {
  const before = probing(2, 'k');
  const result = transition(before, { type: 'ignore', now: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.illegal, false);
  assert.equal(result.state.phase, 'probing');
  assert.equal(result.state.fails, 2);
  assert.equal(result.state.until, before.until);
  assert.equal(result.state.authKey, 'k');
  assert.notEqual(result.state.until, 500 + BREAKER_OPEN_MS);
});

test('open plus succeed is stale: it is logged and the breaker stays open', () => {
  const before = open(5_000, 1);
  const result = transition(before, { type: 'succeed', now: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.illegal, true);
  assert.equal(result.state, before);
  assert.equal(result.state.phase, 'open');
  assert.equal(result.state.until, 5_000);
  assert.equal(result.rejection.atlas_metric, 'breaker');
  assert.equal(result.rejection.phase, 'open');
  assert.equal(result.rejection.event, 'succeed');
  assert.equal('key' in result.rejection, false);
});

test('a 429 does not count, auth sticks until the key changes, and success does not clear a recorded key', () => {
  const after429 = transition(closed(1), { type: 'ignore' }, quiet).state;
  assert.deepEqual(after429, closed(1));
  const authed = transition(closed(1), { type: 'auth_fail', key: 'k' }, quiet).state;
  assert.equal(authed.authKey, 'k'); assert.equal(authed.fails, 1);
  assert.equal(blocked(authed, 'k', 0), 'auth');
  assert.equal(blocked(authed, 'new', 0), null);
  const success = transition(authed, { type: 'succeed' }, quiet).state;
  assert.equal(success.authKey, 'k'); assert.equal(success.phase, 'closed'); assert.equal(success.fails, 0);
});

