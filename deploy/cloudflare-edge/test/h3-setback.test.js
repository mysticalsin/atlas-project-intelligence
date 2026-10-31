// v2.1 H3: never leave a setback unacknowledged. Persona C (failed pilot), third answer: "It was really frustrating, the team was exhausted ..."
// got no acknowledgement (the H2 plain-uptake alternation silenced it) and then a business-stakes question. The rule, ported from atlas_voice/selector.py:
// a setback turn always gets at least a plain, non-judging uptake, and after the setback question was just asked the next move goes forward, not to stakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAck } from '../src/ack.js';
import { analyzeTurn } from '../src/turns.js';
import { select } from '../src/selector.js';
import { ACKS } from '../src/policy.generated.js';
import { rig, opened, talked, until, settle, cleanup } from './reconnect-harness.js';

test.afterEach(cleanup);

const turn = (text, asked_field = null) => analyzeTurn(text, 'en', asked_field ? { asked_field } : null);
const mv = (t, asked = []) => select({}, t, asked, {}, 'breadth', 800, null, false, 'en');
const voiced = h => h.events.filter(e => e.type === 'agent_text').map(e => e.text.trim()).filter(Boolean);
const SAID = ['Honestly the pilot failed. The client kept changing scope and in the end they cancelled it after three months.',
  'I was the delivery lead, I tried to hold the scope with weekly steering meetings but the sponsor left halfway.',
  'It was really frustrating, the team was exhausted and the new sponsor did not care about the project at all.'];

test('H3-1 a setback turn always gets a plain uptake: after another plain one, after a short answer, from any category; only admin, a question and the time limit silence it', () => {
  const cues = ['describes_setback'];
  for (const prevCategory of [null, 'setback_neutral', 'setback_plain', 'neutral', 'thanks_detail']) for (const category of ['setback_neutral', 'setback_plain', 'neutral', 'thanks_detail', 'earned_result']) {
    const a = pickAck({ category, cues, words: 18, prevCategory, seed: 3 });
    assert.ok(a && (a.category === 'setback_neutral' || a.category === 'setback_plain'), JSON.stringify({ category, prevCategory, a }));
    assert.ok(a.text && !a.text.includes('?') && !/sounds|tough|hard|difficult|great|glad/.test(a.category === 'setback_plain' ? a.text : ''), a.text);
  }
  const short = pickAck({ category: 'setback_plain', cues, words: 3, prevCategory: 'setback_plain', seed: 1 });
  assert.ok(short && ACKS.setback_plain.en.includes(short.text), 'a short setback answer still gets the uptake');
  assert.equal(pickAck({ category: 'setback_plain', cues, words: 18, admin: true }), null);
  assert.equal(pickAck({ category: 'setback_plain', cues, words: 18, afterQuestion: true }), null);
  assert.equal(pickAck({ category: 'setback_plain', cues, words: 18, timeUp: true }), null);
  // the other gates are unchanged without the cue: still alternating, still needs a real answer
  assert.equal(pickAck({ category: 'neutral', cues: [], words: 18, prevCategory: 'neutral' }), null);
  assert.equal(pickAck({ category: 'neutral', cues: [], words: 3 }), null);
  // no repeat within the last four lines, on a setback too
  const recent = [];
  for (let i = 0; i < 12; i++) { const a = pickAck({ category: 'setback_plain', cues, words: 18, prevCategory: 'setback_plain', recent: recent.slice(-4), seed: i }); assert.ok(a && !recent.slice(-4).includes(a.text), a && a.text); recent.push(a.text); }
});

test('H3-2 persona C turn 3: a plain uptake and a forward question, not stakes', () => {
  const t = turn(SAID[2], 'intervention');
  assert.ok(t.cues.includes('describes_setback'));
  const m1 = mv(turn(SAID[0])), m2 = mv(turn(SAID[1], 'decision'), [m1]), m3 = mv(t, [m1, m2]);
  assert.deepEqual([m1.intent, m2.intent], ['setback_response', 'example_follow']);
  assert.deepEqual([m3.intent, m3.say, m3.reaction, m3.ack_category], ['keep_going', 'What helped you keep going?', 'ack', 'setback_plain']);
  assert.ok(!['stakes', 'customer_fit'].includes(m3.intent));
  const a = pickAck({ category: m3.ack_category, cues: t.cues, words: t.words, prevCategory: 'setback_plain', seed: 2 });
  assert.ok(a && ACKS.setback_plain.en.includes(a.text));
  // then the lesson, once; stakes only afterwards
  const m4 = mv(t, [m3, m1]);   // the setback question is still within the last two replies, the keep-going question has been asked
  assert.deepEqual([m4.intent, m4.field], ['lessons', 'limitations']);
  assert.equal(m4.say, 'What would you do differently next time?');
  const m5 = mv(t, [m3, m1, m4]);
  assert.ok(m5.intent !== 'keep_going' && m5.intent !== 'lessons');
});

test('H3-3 the forward move needs the throttle: with no setback question just asked the setback question comes first; no setback cue, no forward move', () => {
  const t = turn(SAID[0]);
  assert.equal(mv(t).intent, 'setback_response');
  const plain = mv(turn('The client wanted a dashboard for the support team and we had two months to deliver it.'));
  assert.ok(!['keep_going', 'setback_response'].includes(plain.intent));
  assert.ok(!['keep_going', 'setback_response'].includes(mv(turn('The client wanted a dashboard for the support team and we had two months to deliver it.'), [mv(t)]).intent));
});

test('H3-4 live: the three answers of persona C each get an acknowledgement, and the third is followed by "What helped you keep going?"', async () => {
  const h = rig({ said: SAID, talk: () => ['Okay. ', 'Next?'] });
  await opened(h);
  for (let i = 1; i <= 3; i++) { talked(h); await until(() => h.calls.talker.length === i + 1 && !h.s.busy()); await settle(); }
  const asked = h.s.humane.asked;
  assert.ok(asked.slice(0, 3).every(m => m.reaction === 'ack' && /^setback_/.test(m.ack_category)), JSON.stringify(asked.map(m => m.ack_category)));
  const heard = voiced(h);
  assert.ok(ACKS.setback_neutral.en.some(x => heard.includes(x)), JSON.stringify(heard));
  assert.equal(h.s.humane.acks.length, 3, 'one acknowledgement per answer: ' + JSON.stringify(h.s.humane.acks));
  assert.ok(ACKS.setback_neutral.en.includes(h.s.humane.acks[0]) && h.s.humane.acks.slice(1).every(x => ACKS.setback_plain.en.includes(x)), JSON.stringify(h.s.humane.acks));
  assert.equal(asked[2].intent, 'keep_going');
  assert.ok(!asked.some(m => m.intent === 'stakes'));
});
