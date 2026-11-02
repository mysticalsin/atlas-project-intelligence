// v2.2 Q1 (live Chrome QA): a non-answer is never evidence (item 2) and every consultant turn reaches the transcript and the analyst before the read-back (item 8).
// Same fakes as the other session suites (reconnect-harness.js): a typed interview (the QA ran typed), a scripted talker, an evidence analyst, a clock moved by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InterviewLedger, Analyst } from '../src/ledger.js';
import { buildSummary, buildUnknowns } from '../src/summary.js';
import { rig, startMsg, until, settle, send, cleanup, screen } from './reconnect-harness.js';

test.afterEach(cleanup);

const ANSWERS = ['We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.',
  'I personally wrote the routing rules and ran the weekly review with the claims leads for three months.',
  'The median handling time dropped from fourteen minutes to nine minutes after the pilot, measured over six weeks.'];
const IDK = "I don't know";
const analystOf = (byItem, { slow = 0, fail = () => false, seen = [] } = {}) => async messages => {
  const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
  seen.push(seg.item_id);
  if (slow) await new Promise(r => setTimeout(r, slow));
  if (fail(seg.item_id, seen.filter(x => x === seg.item_id).length)) throw new Error('analyst down');
  const details = (byItem[seg.item_id] || []).map(x => ({ ...x, item_id: seg.item_id }));
  return details.length ? [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details }) }] : [];
};
const TALK = n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', 'What happened next?'];
// A typed interview, opened (the greeting and the opening question are on the screen as text).
async function typedRig({ analyst, said = [], talk = TALK, session = {} } = {}) {
  const h = rig({ talk, said, session }); if (analyst) h.s.ai.analyst = analyst;
  await h.s.onText(startMsg({ mode: 'text' }));
  await until(() => h.s.finished || (!h.s.busy() && screen(h).includes('What was the project?')));
  return h;
}
// (real time: the slow analyst of these tests takes tens of milliseconds a turn)
const untilMs = async (cond, ms = 6000) => { for (let t = 0; t < ms && !cond(); t += 5) await new Promise(r => setTimeout(r, 5)); if (!cond()) throw new Error('condition not reached'); };
// One typed answer, and wait until ATLAS has replied to it.
async function typed(h, text) {
  const n = h.calls.talker.length; h.advance(2);
  await send(h, { type: 'text', text });
  await untilMs(() => h.calls.talker.length > n && !h.s.busy());
}
const noIdk = items => items.every(i => !/don'?t know/i.test(i.quote));

// ---- item 2: "I don't know" is never saved as evidence ----
test('item 2: the ledger never files a non-answer, in any language, whatever the analyst proposes; the transcript keeps it', () => {
  const l = new InterviewLedger();
  for (const [i, t] of [["I don't know", 'a'], ['No idea.', 'b'], ['Je ne sais pas', 'c'], ['No sé', 'd'], ['Ich weiß nicht', 'e'], ['skip this question', 'f'], ["I can't share", 'g']].entries()) {
    l.addTranscript('u' + i, t[0]);
    l.record({ details: [{ field: 'problem', item_id: 'u' + i, quote: t[0] }] });
  }
  assert.equal(l.details.length, 0, 'nothing filed'); assert.equal(l.transcripts.size, 7, 'but every word is in the transcript');
  l.addTranscript('u9', "I don't know the exact figure but it was around forty minutes");
  l.record({ details: [{ field: 'outcome', item_id: 'u9', quote: "I don't know the exact figure but it was around forty minutes" }] });
  assert.equal(l.details.length, 1, 'an answer that merely contains "I don\'t know" is still an answer');
});

test('item 2: a turn that is a non-answer never calls the analyst model and files nothing; an answer still does', async () => {
  let calls = 0;
  const a = new Analyst(async () => { calls += 1; return []; });
  await a.hear('u1', IDK); await a.hear('u2', 'Pass'); await a.hear('u3', 'ok');
  assert.equal(calls, 0, 'no model call for a non-answer'); assert.equal(a.ledger.transcripts.size, 3);
  const r = await a.hear('u4', ANSWERS[0]);
  assert.equal(calls, 1); assert.equal(r.analyst_status, 'analysed');
});

test('item 2: a legacy "unknown" detail made of a non-answer is not a card item or an open-point quote; a real unknown still is', () => {
  const ledger = { details: [{ id: 'D-001', field: 'problem', item_id: 'u1', quote: IDK, status: 'unknown', active: true },
    { id: 'D-002', field: 'measurement', item_id: 'u2', quote: 'the baseline was not measured', status: 'unknown', active: true }], deferred: {} };
  assert.deepEqual(buildSummary(ledger).map(i => i.detail_id), ['D-002']);
  assert.deepEqual(buildUnknowns(ledger, {}).map(u => u.field), ['measurement']);
});

test('item 2 (Haiku S1): three answers, "I don\'t know", then "that\'s all": the read-back has no item or quote "I don\'t know" and the point is still listed open', async () => {
  const proposals = { 'user-typed-1': [{ field: 'problem', quote: 'the claims intake process for the insurance client' }],
    'user-typed-2': [{ field: 'contribution', quote: 'I personally wrote the routing rules' }], 'user-typed-3': [{ field: 'outcome', quote: 'dropped from fourteen minutes to nine minutes' }],
    'user-typed-4': [{ field: 'stakes', quote: IDK }] }; // a keyword analyst (the offline fake) files the non-answer under whatever it matched
  const h = await typedRig({ analyst: analystOf(proposals) });
  for (const t of ANSWERS) await typed(h, t);
  const askedField = h.s.humane.asked.at(-1).field;
  await typed(h, IDK);
  h.advance(960);
  await typed(h, "That's all, thank you.");
  await until(() => h.events.some(e => e.type === 'summary'));
  const card = h.events.filter(e => e.type === 'summary').at(-1);
  assert.ok(noIdk(card.items), 'no read-back item says "I don\'t know": ' + JSON.stringify(card.items.map(i => i.quote)));
  assert.ok(noIdk(h.s.ledger.details), 'and none is in the ledger');
  assert.ok(card.unknowns.some(u => u.field === askedField), 'the point is open: ' + askedField + ' in ' + JSON.stringify(card.unknowns));
  assert.ok(h.s.transcriptHas?.(IDK) ?? [...h.s.ledger.transcripts.values()].includes(IDK), 'the words stay in the transcript');
});

// ---- item 8: every consultant turn reaches the transcript and the analyst ----
test('item 8: five typed turns back to back with a slow analyst: the notes transcript has all five, and the late ones are analysed too', async () => {
  const said = ANSWERS.concat(['We also trained two team leads in March and moved the escalation path.', 'The pilot ran for six weeks across the claims team.']);
  const proposals = Object.fromEntries(said.map((t, i) => ['user-typed-' + (i + 1), [{ field: ['problem', 'contribution', 'outcome', 'adoption', 'measurement'][i], quote: t.slice(0, 30) }]]));
  const h = await typedRig({ analyst: analystOf(proposals, { slow: 60 }) });
  for (const t of said) await typed(h, t);
  assert.ok(h.s.pending.size >= 1, 'the analyst is behind the conversation (that is the point of the test)');
  await h.s.end(true);
  const notes = h.events.find(e => e.type === 'notes');
  for (const t of said) assert.ok(notes.transcript.includes(t), 'the transcript lacks: ' + t);
  assert.equal(h.s.ledger.transcripts.size, 5);
});

test('item 8: the read-back waits for the whole analyst backlog (bounded) and retries a turn whose analyst call failed', async () => {
  const proposals = { 'user-typed-1': [{ field: 'problem', quote: 'the claims intake process for the insurance client' }], 'user-typed-2': [{ field: 'contribution', quote: 'I personally wrote the routing rules' }],
    'user-typed-3': [{ field: 'outcome', quote: 'dropped from fourteen minutes to nine minutes' }] };
  // the analyst is down the first time it sees turn 2 and answers when asked again
  const h = await typedRig({ analyst: analystOf(proposals, { slow: 40, fail: (item, n) => item === 'user-typed-2' && n === 1 }) });
  h.s.sleep = ms => ms >= 2000 ? new Promise(r => setTimeout(r, 1500)) : new Promise(r => setImmediate(r)); // the read-back's own bound is real time here
  for (const t of ANSWERS) await typed(h, t);
  h.advance(960);
  await typed(h, "That's all, thank you.");
  await untilMs(() => h.events.some(e => e.type === 'summary'));
  const card = h.events.filter(e => e.type === 'summary').at(-1);
  assert.deepEqual(['problem', 'contribution', 'outcome'].filter(f => !card.items.some(i => i.field === f)), [], 'every analysed answer is on the first card: ' + JSON.stringify(card.items.map(i => i.field)));
});

test('item 8: ending the interview asks again about a turn whose analyst call failed, so the notes hold every answer that can be filed', async () => {
  const proposals = { 'user-typed-1': [{ field: 'problem', quote: 'the claims intake process for the insurance client' }], 'user-typed-2': [{ field: 'contribution', quote: 'I personally wrote the routing rules' }] };
  const h = await typedRig({ analyst: analystOf(proposals, { fail: (item, n) => item === 'user-typed-2' && n === 1 }) });
  await typed(h, ANSWERS[0]); await typed(h, ANSWERS[1]);
  assert.ok(!h.s.ledger.details.some(d => d.field === 'contribution'), 'the analyst missed turn 2');
  await h.s.end(true);
  const notes = h.events.find(e => e.type === 'notes');
  assert.ok(notes.sections.join('\n').includes('I personally wrote the routing rules'), 'the retry filed it before the notes were written');
});
