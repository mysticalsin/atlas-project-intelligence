// Adaptive interview length inside a live Session (Tony, 2026-10-31: "20-30 min to get everything we need"). 20 minutes of active time are planned, 30 is the hard cap.
// With the planned end near and an essential question still unasked, ATLAS asks ONCE whether the consultant can give a few more minutes on that point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SECONDS, SUMMARY_LINES } from '../src/session.js';
import { serialize } from '../src/checkpoint.js';
import { rig, opened, talked, send, until, cleanup, ANSWER } from './reconnect-harness.js';

test.afterEach(cleanup);

// An answer that covers none of the essentials still open after the first one (what they personally did): the selector's closing question is still there.
const FILLER = 'The weather was nice that spring in Lisbon.';
const OFFER = /We've covered most of it\. Could we take a few more minutes on/;
const noteOf = (h, n) => h.calls.talker[n].filter(m => m.role === 'system' && m.content.startsWith('NEXT MOVE')).map(m => m.content).join('\n');
const offers = h => h.s.humane.asked.filter(m => m.intent === 'offer_extension');
// A session that has heard one answer (an outcome only: the essentials are not covered), with `said` as the later answers.
async function interviewing(said, extra = {}) {
  const h = rig({ said: [ANSWER, ...said], talk: n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', 'What was the baseline?'], ...extra });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  return h;
}
const nextTurn = async (h, n) => { talked(h); await until(() => h.calls.talker.length === n && !h.s.busy()); };

test('20 minutes planned, 30 hard: the clock the browser gets runs to the hard cap and names the planned end; a short test session scales the same way', async () => {
  assert.equal(MAX_SECONDS, 1200);
  const h = rig(); await opened(h);
  const ready = h.events.find(e => e.type === 'ready');
  assert.equal(ready.maxSeconds, 1800); assert.equal(ready.softSeconds, 1200); assert.deepEqual(ready.timePlan, { depthAt: 540, closingAt: 930 });
  assert.equal(h.s.maxSeconds, 1200, 'the session ends at the planned end unless the consultant agrees to more');
  const small = rig({ session: { maxSeconds: 120 } }); await opened(small);
  assert.equal(small.events.find(e => e.type === 'ready').maxSeconds, 180);
});

test('with the planned end near and something essential unasked, ATLAS asks once for a few more minutes, naming the point; earlier in the interview it does not', async () => {
  const early = await interviewing([FILLER]);
  early.advance(600); await nextTurn(early, 3);                                  // 10 minutes in: an ordinary question
  assert.doesNotMatch(noteOf(early, 2), OFFER); assert.equal(offers(early).length, 0);
  await cleanup();
  const h = await interviewing([FILLER]);
  h.advance(940); await nextTurn(h, 3);                                          // 15:40: less than 270 s of the planned end are left
  assert.match(noteOf(h, 2), OFFER); assert.equal(offers(h).length, 1);
  assert.match(noteOf(h, 2), /kind: offer_extension/);
  assert.match(offers(h)[0].say, /^We've covered most of it\. Could we take a few more minutes on what the problem was\?$/, 'it names the missing point in plain words');
  assert.equal(h.s.maxSeconds, 1200, 'nothing is extended until they say yes');
});

test('a yes extends the end to the 30-minute hard cap, tells the browser, and the offer is never made again', async () => {
  const h = await interviewing([FILLER, 'Yes, that is fine.', 'We also changed the routing rules for the team.', 'The pilot ran with two regional teams.', 'It went live in March.'], {});
  h.advance(940); await nextTurn(h, 3);
  assert.match(noteOf(h, 2), OFFER);
  await nextTurn(h, 4);                                                          // "Yes, that is fine."
  assert.equal(h.s.maxSeconds, 1800); assert.equal(offers(h)[0].ext, 'accepted');
  const ev = h.events.find(e => e.type === 'time_extended');
  assert.deepEqual(ev, { type: 'time_extended', maxSeconds: 1800, timePlan: { depthAt: 810, closingAt: 1530 } });
  assert.doesNotMatch(noteOf(h, 3), /kind: summary/, 'the interview goes on with the missing point');
  h.advance(560); await nextTurn(h, 5);                                          // 25:00: past the old planned end, inside the new one
  assert.equal(h.s.finished, false); assert.equal(offers(h).length, 1);
  h.advance(300); await nextTurn(h, 6);                                          // 30:00 is near: the closing window of the NEW end, and still no second offer
  assert.equal(offers(h).length, 1); assert.doesNotMatch(noteOf(h, 5), OFFER);
  assert.ok(serialize(h.s).humane.asked.some(m => m.intent === 'offer_extension' && m.ext === 'accepted'), 'a checkpoint keeps the agreement');
});

test('a no (or anything that is not a clear yes) goes straight to the read-back, keeps the planned end, and asks no more for time', async () => {
  const h = await interviewing([FILLER, 'No, sorry, I do not have the time.', 'Nothing more to add.']);
  h.advance(940); await nextTurn(h, 3);
  assert.match(noteOf(h, 2), OFFER);
  await nextTurn(h, 4);
  assert.equal(offers(h)[0].ext, 'refused'); assert.equal(h.s.maxSeconds, 1200); assert.ok(!h.events.some(e => e.type === 'time_extended'));
  assert.match(noteOf(h, 3), /kind: summary/); assert.ok(h.events.some(e => e.type === 'summary'), 'the read-back card is open');
  assert.equal(offers(h).length, 1);
});

test('a consultant in a hurry is never asked to stay longer', async () => {
  const h = await interviewing(['I am in a hurry, we need to be quick.', FILLER]);
  await nextTurn(h, 3);
  assert.equal(h.s.humane.rushed, true);
  h.advance(940); await nextTurn(h, 4);
  assert.equal(offers(h).length, 0); assert.doesNotMatch(noteOf(h, 3), OFFER);
});

test('a reply to the offer that is a hurry or a stop is a refusal too', async () => {
  for (const said of ['I am short on time, can we speed up?', 'Hmm, maybe.']) {
    const h = await interviewing([FILLER, said]);
    h.advance(940); await nextTurn(h, 3); assert.match(noteOf(h, 2), OFFER);
    await nextTurn(h, 4); assert.equal(offers(h)[0].ext, 'refused', said); assert.equal(h.s.maxSeconds, 1200);
    await cleanup();
  }
});

test('when the essentials are covered before the planned end, the interview closes early with its read-back and never asks for more time', async () => {
  const h = rig({ said: ['We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.', 'That is everything, I am done.'],
    talk: n => n === 0 ? ['Right. ', 'What was the project?'] : n === 1 ? ['Thanks. ', 'What was the baseline?'] : ['I heard that you rebuilt the claims intake process. ', 'What have I misunderstood or missed?'] });
  h.s.ai.analyst = async messages => {
    const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
    return seg.item_id === 'user-1' ? [{ id: 'c1', name: 'record_details', arguments: JSON.stringify({ details: [
      { field: 'problem', item_id: 'user-1', quote: 'the claims intake process for the insurance client' }, { field: 'contribution', item_id: 'user-1', quote: 'We rebuilt the claims intake process' },
      { field: 'outcome', item_id: 'user-1', quote: 'a big change for the whole team' }] }) }] : [];
  };
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  talked(h); await until(() => h.events.some(e => e.type === 'summary') && !h.s.busy());
  assert.ok(h.s.activeSeconds() < 60, 'a few seconds in: far before the planned end');
  assert.equal(offers(h).length, 0); assert.ok(!h.events.some(e => e.type === 'time_extended'));
});

test('the hard cap holds: an extended interview still ends at 30 minutes of active time, and paused time does not count', async () => {
  const h = await interviewing([FILLER]);
  h.advance(940); await nextTurn(h, 3);
  h.s.humane.asked.findLast(m => m.intent === 'offer_extension').ext = 'accepted'; h.s.extend();
  h.advance(600); h.s.lastInput = h.s.now(); h.s.watch();
  assert.equal(h.s.finished, false, '25:40 of active time: still going');
  h.advance(300); h.s.lastInput = h.s.now(); h.s.watch();
  await until(() => h.events.some(e => e.type === 'time_up'));
  assert.match(h.events.find(e => e.type === 'time_up').message, /The 30 minutes are up/);
});
