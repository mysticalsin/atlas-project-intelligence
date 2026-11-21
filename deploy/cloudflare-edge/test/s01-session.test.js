// Sweep 01 group 6 (session fillers, L2). Copied from the red tests at 96712474.
// Fails on main. Not skipped and not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';

test('L2 acknowledgements rotate through the whole English list', () => {
  const session = Object.create(Session.prototype);
  session.admin = false;
  session.timeUp = false;
  session.fillerTurn = -2;
  session.lastFiller = -1;
  session.spoken = () => 'en';
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  const heard = [];
  for (let turn = 1; turn <= 8; turn++) {
    session.turns = turn;
    const filler = session.pickFiller(text);
    if (filler) heard.push(filler);
  }
  assert.deepEqual(heard, ['Okay.', 'Right.', 'I see.', 'Yeah.']);
});

test('L2 the next acknowledgement wraps, and a short line or a question stays silent', () => {
  const session = Object.create(Session.prototype);
  session.admin = false;
  session.timeUp = false;
  session.fillerTurn = -2;
  session.lastFiller = -1;
  session.spoken = () => 'en';
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  const heard = [];
  for (let turn = 1; turn <= 10; turn++) {
    session.turns = turn;
    const filler = session.pickFiller(text);
    if (filler) heard.push(filler);
  }
  assert.deepEqual(heard, ['Okay.', 'Right.', 'I see.', 'Yeah.', 'Okay.']);
  session.turns = 12;
  assert.equal(session.pickFiller('too short'), '');
  assert.equal(session.pickFiller(text + '?'), '');
});
