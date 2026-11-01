// Agent Brain v2.1 T11: the summary read-back and correction revisions inside a live Session (plan 3h, D19, Tony Q2). Same fakes as the other session
// suites (reconnect-harness.js): scripted speech recognition, voice, talker and analyst, a clock moved by hand. The draft goes to a REAL evidence store
// (node:sqlite) through the real postDraftFromInterview, so "owner only" and "never submitted" are checked where they are enforced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_LINES, SUMMARY_UNAVAILABLE, nextMoveNote } from '../src/session.js';
import { SUMMARY_QUESTION } from '../src/summary.js';
import { analyzeTurn } from '../src/turns.js';
import { InterviewLedger } from '../src/ledger.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { evidence, postDraftFromInterview } from '../src/evidence.js';
import { CheckpointStore, serialize, restore, VERSION } from '../src/checkpoint.js';
import { memorySql } from './sqlite.js';
import { rig, opened, talked, send, until, settle, cleanup, named, FakeStorage, clock, USER, PROJECT } from './reconnect-harness.js';

test.afterEach(cleanup);

const OWNER = { email: USER, role: 'user' }, OTHER = { email: 'kim@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' };
const SAID1 = 'We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.';
const FIRST = [{ field: 'problem', quote: 'the claims intake process for the insurance client' }, { field: 'contribution', quote: 'We rebuilt the claims intake process' }, { field: 'outcome', quote: 'a big change for the whole team' }];
const SAID_DONE = 'That is everything, I am done.';
const OK_REPLY = ['I heard that you rebuilt the claims intake process. ', 'What have I misunderstood or missed?'];

// The evidence analyst: for each consultant turn it files what `byItem` says (exact quotes), nothing otherwise.
const analystOf = byItem => async messages => {
  const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment, details = (byItem[seg.item_id] || []).map(x => ({ ...x, item_id: seg.item_id }));
  return details.length ? [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details }) }] : [];
};

// A real library behind a fake Worker binding, and the hook the Interview DO builds from it.
function library() {
  let t = 0, n = 0;
  const lib = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') }), requests = [];
  const env = { LIBRARY: { idFromName: name => name, get: () => ({ fetch: async req => { requests.push([req.method, new URL(req.url).pathname, req.headers.get('x-atlas-user')]); return libraryRoutes(req, lib, {}); } }) } };
  return { lib, ev: evidence(lib), env, requests, hook: (identity = { user: USER, role: 'user', mail: USER }) => notes => postDraftFromInterview(env, identity, notes) };
}

// A session in which the read-back is open: one answer analysed, then "that is everything" (the selector's stop), so the second reply is the summary.
async function atSummary({ said1 = SAID1, details = FIRST, talk = null, session = {}, extra = {}, metrics = [] } = {}) {
  const h = rig({ said: [said1, SAID_DONE, ...(extra.said || [])], metrics, session,
    talk: (n, m) => n === 0 ? ['Right. ', 'What was the project?'] : n === 1 ? ['Thanks. ', 'What was the baseline?'] : talk ? talk(n, m) : OK_REPLY });
  h.s.ai.analyst = analystOf({ 'user-1': details, ...(extra.analyst || {}) });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  if (!['problem', 'contribution', 'outcome'].every(f => details.some(d => d.field === f))) h.advance(960); // U2: with an essential missing "I am done" is respected at once only when the planned time is nearly used
  talked(h); await until(() => h.events.some(e => e.type === 'summary') && h.calls.talker.length === 3 && !h.s.busy());
  return h;
}
const summaries = h => h.events.filter(e => e.type === 'summary');
const lastCard = h => summaries(h).at(-1);
const audit = h => h.s.machine.audit.map(a => a.event);
const spokenText = h => h.calls.tts.join(' ');
const detailOf = (h, field) => h.s.ledger.details.find(d => d.field === field && d.active);

test('the read-back: a summary event with the card and its open points; the talker gets a few facts and the one question; the machine asks for the summary', async () => {
  const h = await atSummary();
  const card = lastCard(h);
  assert.deepEqual(card.items.map(i => i.field), ['problem', 'contribution', 'outcome']);
  assert.deepEqual(card.items.map(i => i.detail_id), ['D-001', 'D-002', 'D-003']);
  assert.deepEqual(Object.keys(card.items[0]).sort(), ['asr_unconfirmed', 'detail_id', 'field', 'label', 'lang', 'provenance', 'quote', 'status']); // (lang: v2.2 L1, the language each quote was said in)
  assert.ok(Array.isArray(card.unknowns) && card.state === 'summary' && card.round === 1);
  assert.equal(h.s.machine.state, 'summary'); assert.ok(audit(h).includes('request_summary'));
  const note = h.calls.talker[2].find(m => m.role === 'system' && m.content.startsWith('SUMMARY FACTS (server'));
  assert.ok(note, 'the talker is given SUMMARY FACTS'); assert.ok(note.content.includes(SUMMARY_QUESTION));
  const facts = note.content.split('SUMMARY FACTS')[1].split('Read back ONLY')[0].match(/\d\) /g);
  assert.ok(facts.length >= 1 && facts.length <= 4, 'at most four facts');
  const next = h.calls.talker[2].find(m => m.role === 'system' && m.content.startsWith('NEXT MOVE')).content;
  assert.ok(next.includes('kind: summary') && next.includes(SUMMARY_QUESTION) && !/two short sentences/.test(next), 'the read-back replaces the talker\'s own recap');
  assert.ok(spokenText(h).includes('What have I misunderstood or missed?'));
  assert.ok(named(h.metrics, 'summary').length === 1);
});

test('an adversarial talker: invented figures and a second question never reach the voice or the screen; only figures from the facts survive', async () => {
  const h = await atSummary({ said1: 'The median handling time dropped from 14 minutes to 9 minutes after the pilot.',
    details: [{ field: 'problem', quote: 'The median handling time' }, { field: 'outcome', quote: 'dropped from 14 minutes to 9 minutes' }],
    talk: () => ['Amazing! Triage fell from 14 minutes to 9 minutes. ', 'That is a saving of 5 minutes, 99 percent and 1200 hours. ', 'What have I misunderstood or missed? ', 'Also, is there anything else? '] });
  const say = spokenText(h), shown = h.events.filter(e => e.type === 'agent_text').map(e => e.text).join('');
  for (const text of [say, shown]) {
    assert.ok(!/\b(99|1200)\b/.test(text) && !/saving of 5/.test(text), 'a figure that is in no fact is dropped');
    assert.ok(text.includes('Triage fell from 14 minutes to 9 minutes.') && text.includes('What have I misunderstood or missed?'));
    assert.ok(!text.includes('is there anything else') && !text.includes('Also,'), 'one question, then nothing');
  }
  const guard = named(h.metrics, 'reply_guard').at(-1);
  assert.ok(guard.dropped_unknown_number >= 1 && guard.dropped_after_question >= 1, JSON.stringify(guard));
  assert.ok(!/\bAmazing\b/.test(say), 'and no empty praise');
});

test('a read-back whose talker never asks still ends in the question; the guard\'s facts hold even when the talker says nothing useful', async () => {
  const h = await atSummary({ talk: () => ['Here is what I heard so far. '] });
  assert.ok(spokenText(h).includes(SUMMARY_QUESTION)); assert.equal(named(h.metrics, 'summary_question_added').length, 1);
  assert.equal(h.s.lastQuestion.text, SUMMARY_QUESTION, 'repeat and resume say it again');
});

test('a short reply to the read-back means nothing to add: ATLAS points to the Confirm button (no model call), files nothing and the interview waits', async () => {
  const evidenceCalls = [], h = await atSummary({ session: { evidence: async n => { evidenceCalls.push(n); return { status: 201, body: { id: 'x', revision: 1 } }; } }, extra: { said: ['No, that is right.'] } });
  const talkerCalls = h.calls.talker.length;
  talked(h); await until(() => h.calls.tts.includes(SUMMARY_LINES.prompt.en[0]) && !h.s.busy());
  assert.equal(h.calls.talker.length, talkerCalls, 'no model call');
  assert.equal(h.s.machine.state, 'summary'); assert.equal(h.s.summary.open, true); assert.deepEqual(evidenceCalls, []);
  assert.ok(!h.events.some(e => e.type === 'evidence_draft' || e.type === 'wrap_up' || e.type === 'summary_closed'));
  assert.match(SUMMARY_LINES.prompt.en[0], /Confirm summary.*private draft.*nothing goes to a reviewer until you submit it/);
});

test('more to say after the read-back: the interview goes back to discovery and the card closes', async () => {
  const h = await atSummary({ extra: { said: ['We also changed the escalation path and trained two leads in March last year.'] } });
  talked(h); await until(() => h.calls.talker.length === 4 && !h.s.busy());
  const trail = audit(h); assert.ok(trail.indexOf('continue_discovery') > trail.indexOf('request_summary') && !trail.includes('state_error'));
  assert.equal(h.s.machine.state, 'discovery');
  assert.ok(h.events.some(e => e.type === 'summary_closed' && e.reason === 'continue')); assert.equal(h.s.summary.open, false);
  await send(h, { type: 'confirm_summary' }); await settle(20);
  assert.ok(!h.events.some(e => e.type === 'summary_confirmed'), 'a closed card cannot be confirmed');
});

test('a typed correction supersedes the item: a new transcript item user-typed-N, provenance consultant_typed, the old detail inactive and kept in the history', async () => {
  const h = await atSummary(), old = detailOf(h, 'outcome');
  await send(h, { type: 'correct', detail_id: old.id, text: 'It was a modest change, limited to one queue.' });
  const fresh = detailOf(h, 'outcome');
  assert.notEqual(fresh.id, old.id); assert.equal(fresh.supersedes, old.id); assert.equal(fresh.provenance, 'consultant_typed'); assert.equal(fresh.quote, 'It was a modest change, limited to one queue.');
  assert.match(fresh.item_id, /^user-typed-\d+$/); assert.equal(h.s.ledger.transcripts.get(fresh.item_id), 'It was a modest change, limited to one queue.');
  const was = h.s.ledger.details.find(d => d.id === old.id);
  assert.equal(was.active, false); assert.equal(was.quote, 'a big change for the whole team', 'the old detail stays in the history, unchanged');
  const card = lastCard(h), ids = card.items.map(i => i.detail_id);
  assert.ok(ids.includes(fresh.id) && !ids.includes(old.id)); assert.equal(card.items.find(i => i.detail_id === fresh.id).provenance, 'consultant_typed');
  assert.ok(h.events.some(e => e.type === 'user_text' && e.item_id === fresh.item_id && e.provenance === 'consultant_typed'));
  assert.deepEqual(audit(h).slice(-3), ['request_summary', 'correct', 'request_summary']); assert.equal(h.s.machine.state, 'summary');
  await until(() => h.calls.tts.includes(SUMMARY_LINES.corrected.en[0]) && !h.s.busy()); // a stock thank-you and the question again, no model call
  assert.equal(h.calls.talker.length, 3);
  // a second correction of the new item chains; the ids never collide
  await send(h, { type: 'correct', detail_id: fresh.id, text: 'Correction again: one queue in one office.' });
  const third = detailOf(h, 'outcome'); assert.equal(third.supersedes, fresh.id); assert.notEqual(third.item_id, fresh.item_id);
  assert.equal(h.s.ledger.details.filter(d => d.field === 'outcome').length, 3);
});

test('corrections and keep-private only reach an open card and a known, active item; anything else is refused with one message and changes nothing', async () => {
  const early = rig({ said: [SAID1] }); await opened(early);
  await send(early, { type: 'confirm_summary' }); await send(early, { type: 'correct', detail_id: 'D-001', text: 'It was different.' }); await send(early, { type: 'withhold', detail_id: 'D-001' });
  assert.equal(early.events.filter(e => e.type === 'quality_warning' && e.message === SUMMARY_UNAVAILABLE).length, 3);
  const h = await atSummary(), before = JSON.stringify(h.s.ledger.details), warnings = () => h.events.filter(e => e.type === 'quality_warning').length, w0 = warnings();
  for (const m of [{ type: 'correct', detail_id: 'D-099', text: 'It was different.' }, { type: 'correct', detail_id: 'D-001', text: 'ok' }, { type: 'correct', detail_id: 'x', text: 'It was different.' },
    { type: 'withhold', detail_id: 'D-099' }, { type: 'withhold', detail_id: '../D-001' }]) await send(h, m);
  assert.equal(warnings(), w0 + 5); assert.equal(JSON.stringify(h.s.ledger.details), before); assert.equal(h.s.machine.state, 'summary');
  await send(h, { type: 'withhold', detail_id: 'D-001' }); await send(h, { type: 'withhold', detail_id: 'D-001' }); // the second finds it already gone from the card
  assert.equal(warnings(), w0 + 6);
  // a message with other keys is not a card action: the contract is exact
  await send(h, { type: 'correct', detail_id: 'D-002', text: 'It was different, really.', extra: 1 });
  assert.ok(h.events.some(e => e.type === 'error' && e.code === 'voice-contract'));
});

test('keep private: the item leaves the card, the notes sections and the quality board; it stays in the ledger history, and its field is not asked again', async () => {
  const h = await atSummary(), secret = detailOf(h, 'problem');
  await send(h, { type: 'withhold', detail_id: secret.id });
  const card = lastCard(h); assert.ok(!card.items.some(i => i.detail_id === secret.id) && card.items.length === 2);
  assert.ok(!h.s.ledger.notes().some(s => s.includes('for the insurance client')), 'not in notes.sections');
  const w = h.s.ledger.details.find(d => d.id === secret.id); assert.equal(w.withheld, true); assert.equal(w.active, true); assert.equal(w.quote, secret.quote, 'kept in the history');
  const quality = h.events.filter(e => e.type === 'quality').at(-1); assert.ok(!quality.candidate_details.some(d => d.id === secret.id) && quality.unresolved_fields.includes('problem'));
  assert.ok(!h.s.evidenceNotes().details.some(d => d.id === secret.id), 'and not in what a draft is made of');
});

test('confirm: ONE owner-only evidence draft from the active, non-withheld details; never submitted; a second click saves nothing more', async () => {
  const L = library(), h = await atSummary({ session: { evidence: L.hook() } });
  await send(h, { type: 'withhold', detail_id: detailOf(h, 'problem').id });
  await send(h, { type: 'correct', detail_id: detailOf(h, 'outcome').id, text: 'It was a modest change, limited to one queue.' });
  await until(() => !h.s.busy());
  await send(h, { type: 'confirm_summary' }); await send(h, { type: 'confirm_summary' }); // a double click
  await until(() => h.events.some(e => e.type === 'evidence_draft'));
  const posted = L.requests.filter(r => r[0] === 'POST' && r[1] === '/api/evidence');
  assert.equal(posted.length, 1, 'exactly one post'); assert.deepEqual(L.requests.map(r => r[1]), ['/api/evidence'], 'and nothing else: no submit, no review');
  const e = h.events.find(x => x.type === 'evidence_draft'); assert.equal(e.revision, 1); assert.equal(e.visibility, 'owner_only'); assert.equal(e.state, 'evidence_draft'); assert.match(e.id, /^id\d+$/);
  assert.deepEqual(audit(h).slice(-1), ['confirm_summary']); assert.equal(h.s.machine.state, 'summary_confirmed'); assert.equal(h.events.filter(x => x.type === 'summary_confirmed').length, 1);
  // what the library holds
  const v = L.ev.get(OWNER, e.id);
  assert.deepEqual([v.state, v.status, v.revision, v.mine, v.actions.includes('submit')], ['evidence_draft', 'evidence_draft', 1, true, true]);
  assert.ok(!v.history.some(x => x.event === 'submit' || x.event === 'enqueue'), 'not submitted');
  assert.deepEqual(v.claims.map(c => c.source_refs[0].field).sort(), ['contribution', 'outcome']);
  const outcome = v.claims.find(c => c.source_refs[0].field === 'outcome');
  assert.equal(outcome.statement, 'It was a modest change, limited to one queue.');
  assert.equal(outcome.source_refs[0].provenance, 'consultant_typed'); assert.match(outcome.source_refs[0].item_id, /^user-typed-\d+$/);
  assert.ok(!JSON.stringify(v).includes('for the insurance client'), 'the withheld words are nowhere in the draft');
  assert.ok(!JSON.stringify(v).includes('a big change for the whole team'), 'neither are the replaced ones');
  for (const who of [OTHER, REV, { email: 'other@mantu.com', role: 'admin' }]) assert.throws(() => L.ev.get(who, e.id), x => x.status === 404, who.email + ' cannot see an unsubmitted draft');
  assert.deepEqual(L.ev.list(OTHER), []); assert.deepEqual(L.ev.list(REV), []);
  // ATLAS says where it went, then the interview wraps up
  await until(() => h.calls.tts.includes(SUMMARY_LINES.saved.en[0])); await until(() => h.events.some(x => x.type === 'wrap_up'), 6000);
  assert.ok(!h.calls.talker.slice(3).length, 'no model call for the goodbye');
  assert.equal(h.s.summary.draft.id, e.id);
});

test('the notes posted for the draft have exactly the T13 shape: session id, project, active non-withheld details with their provenance and speech doubt', async () => {
  let notes = null; const h = await atSummary({ session: { evidence: async n => { notes = JSON.parse(JSON.stringify(n)); return { status: 201, body: { id: 'id1', revision: 1 } }; } } });
  await send(h, { type: 'withhold', detail_id: detailOf(h, 'contribution').id });
  await send(h, { type: 'confirm_summary' }); await until(() => notes);
  assert.equal(notes.session_id, h.s.sessionId); assert.equal(notes.project_ref, PROJECT.id);
  assert.deepEqual(notes.details.map(d => d.id), ['D-001', 'D-003']);
  for (const d of notes.details) {
    assert.deepEqual(Object.keys(d).sort(), ['active', 'asr_min_conf', 'audio_offset_ms', 'field', 'id', 'item_id', 'lang', 'provenance', 'quote', 'status', 'supersedes', 'withheld']); // (v2.2 L1: the language each quote was said in)
    assert.equal(d.lang, 'en');
    assert.equal(d.active, true); assert.equal(d.withheld, false); assert.equal(d.provenance, 'unverified_speech_recognition');
  }
  assert.ok(!notes.details.some(d => d.quote === 'We rebuilt the claims intake process'), 'the kept-private detail never leaves the session');
});

test('confirming with nothing to file, no workflow, no library or a refusal still confirms: the browser is told why, ATLAS never claims a save', async () => {
  const cases = [
    ['workflow_off', null, [], 'unsaved'],
    ['library_unavailable', async () => ({ status: 0, body: {} }), [], 'unsaved'],
    ['already_captured', async () => ({ status: 409, body: { error: 'x' } }), [], 'unsaved'],
    ['refused', async () => ({ status: 403, body: { error: 'x' } }), [], 'unsaved'],
    ['library_unavailable', async () => { throw new Error('down'); }, [], 'unsaved'],
    ['nothing_to_save', async () => ({ status: 201, body: { id: 'x', revision: 1 } }), ['D-001', 'D-002', 'D-003'], 'unsaved'],
  ];
  for (const [reason, hook, hide, line] of cases) {
    const h = await atSummary({ session: { evidence: hook } });
    for (const id of hide) await send(h, { type: 'withhold', detail_id: id });
    await send(h, { type: 'confirm_summary' }); await until(() => h.events.some(e => e.type === 'evidence_draft_unavailable'));
    const e = h.events.find(x => x.type === 'evidence_draft_unavailable');
    assert.equal(e.reason, reason); assert.ok(e.message && !/[A-Za-z0-9]{20,}/.test(e.message));
    assert.ok(!h.events.some(x => x.type === 'evidence_draft')); assert.equal(h.s.machine.state, 'summary_confirmed');
    await until(() => h.calls.tts.includes(SUMMARY_LINES[line].en[0]));
    assert.ok(!h.calls.tts.includes(SUMMARY_LINES.saved.en[0]), 'never "saved" when nothing was');
    await cleanup();
  }
});

test('the same notes confirmed again (a resumed interview) give the same draft: the store is idempotent on the session', async () => {
  const L = library(), h = await atSummary({ session: { evidence: L.hook() } });
  await send(h, { type: 'confirm_summary' }); await until(() => h.events.some(e => e.type === 'evidence_draft'));
  const first = h.events.find(e => e.type === 'evidence_draft'), again = await L.hook()(h.s.evidenceNotes());
  assert.deepEqual([again.status, again.body.id], [200, first.id]); assert.equal(L.ev.list(OWNER).length, 1);
});

test('voice: a spoken correction while the card is open moves the machine to user_correction (the selector and the analyst take the correction), and the card keeps working', async () => {
  const h = await atSummary({ extra: { said: ['Correction: it was a modest change, limited to one queue.'] } });
  talked(h); await until(() => h.calls.talker.length === 4 && !h.s.busy());
  assert.deepEqual(audit(h).slice(-2), ['request_summary', 'correct']); assert.equal(h.s.machine.state, 'user_correction'); assert.equal(h.s.summaryActive(), true);
  // the card still corrects from user_correction, and the loop returns to the summary
  await send(h, { type: 'correct', detail_id: detailOf(h, 'outcome').id, text: 'It was a modest change, limited to one queue.' });
  assert.deepEqual(audit(h).slice(-2), ['correct', 'request_summary']); assert.equal(audit(h).filter(e => e === 'correct').length, 2, 'the spoken one and the card\'s');
  assert.equal(h.s.machine.state, 'summary');
});

test('the audited path: request_summary, correct, request_summary, confirm_summary, with their actors and no text of the consultant in the trail', async () => {
  const h = await atSummary({ session: { evidence: async () => ({ status: 201, body: { id: 'id1', revision: 1 } }) } });
  await send(h, { type: 'correct', detail_id: detailOf(h, 'outcome').id, text: 'SECRET-WORDS about the outcome.' });
  await send(h, { type: 'confirm_summary' }); await until(() => h.events.some(e => e.type === 'summary_confirmed'));
  const trail = h.s.machine.audit.filter(a => ['request_summary', 'correct', 'confirm_summary'].includes(a.event)).map(a => [a.event, a.actor]);
  assert.deepEqual(trail, [['request_summary', 'atlas'], ['correct', 'user'], ['request_summary', 'atlas'], ['confirm_summary', 'user']]);
  assert.ok(!JSON.stringify(h.s.machine.audit).includes('SECRET-WORDS'));
  assert.deepEqual(h.events.filter(e => e.type === 'state').map(e => e.event).slice(-4), ['request_summary', 'correct', 'request_summary', 'confirm_summary']);
  assert.equal(named(h.metrics, 'state_error').length, 0);
});

test('nothing closes before the confirmation: a selector close (not the time limit, not their own stop) becomes another read-back', async () => {
  const h = await atSummary(), asked = h.s.humane.asked;
  assert.ok(asked.some(m => m.kind === 'summary'));
  const move = h.s.decide(analyzeTurn('ok fine then', 'en', {}));
  assert.deepEqual([move.kind, move.why], ['summary', 'summary:before_close']); assert.equal(named(h.metrics, 'summary_before_close').length, 1);
  const stop = h.s.decide(analyzeTurn(SAID_DONE, 'en', {})); assert.equal(stop.kind, 'close', 'their own wish to stop is honoured');
  assert.match(nextMoveNote(move), /SUMMARY FACTS \(next note\)/);
});

test('a reflection uses the same read-back with at most two facts: no card, no state change, and the guard blocks invented figures', async () => {
  const h = rig({ said: ['The median handling time dropped from 14 minutes to 9 minutes after the pilot, and we rebuilt the intake.'],
    talk: n => n === 0 ? ['Right. ', 'What was the project?'] : n === 1 ? ['Thanks. ', 'What was the baseline?'] : ['So far you said it fell from 14 minutes to 9 minutes, and then 77 percent. ', 'What important thing have we missed?'] });
  h.s.ai.analyst = analystOf({ 'user-1': [{ field: 'problem', quote: 'The median handling time' }, { field: 'contribution', quote: 'we rebuilt the intake' }, { field: 'outcome', quote: 'dropped from 14 minutes to 9 minutes' }] });
  await opened(h); talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const cards = summaries(h).length, state = h.s.machine.state;
  h.s.startReply(undefined, { move: { kind: 'reflect', intent: 'reflect', field: null, rung: null, say: 'So far we have covered the problem. What important thing have we missed?', why: 'reflect:depth', reaction: 'none', ack_category: null }, turn: h.s.turns });
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  const note = h.calls.talker[2].find(m => m.role === 'system' && m.content.startsWith('REFLECTION FACTS'));
  assert.ok(note && (note.content.split('REFLECTION FACTS')[1].split('Say back')[0].match(/\d\) /g) || []).length === 2, 'two facts');
  assert.equal(summaries(h).length, cards); assert.equal(h.s.machine.state, state); assert.equal(h.s.summary.open, false);
  const say = h.calls.tts.join(' '); assert.ok(!/\b77\b/.test(say) && say.includes('What important thing have we missed?'));
});

test('the card is checkpointed: summary state round-trips, restoreView carries the open card, and a resumed interview confirms into the same single draft', async () => {
  const storage = new FakeStorage(), clk = clock(), L = library();
  const h = rig({ storage, clk, said: [SAID1, SAID_DONE], session: { evidence: L.hook() }, talk: (n) => n === 0 ? ['Right. ', 'What was the project?'] : n === 1 ? ['Thanks. ', 'What was the baseline?'] : OK_REPLY });
  h.s.ai.analyst = analystOf({ 'user-1': FIRST });
  await opened(h); talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy()); talked(h); await until(() => h.events.some(e => e.type === 'summary') && !h.s.busy());
  await send(h, { type: 'withhold', detail_id: detailOf(h, 'problem').id });
  await send(h, { type: 'correct', detail_id: detailOf(h, 'outcome').id, text: 'It was a modest change, limited to one queue.' }); await until(() => !h.s.busy());
  const doc = JSON.parse(JSON.stringify(serialize(h.s)));
  assert.equal(doc.version, VERSION); assert.ok(VERSION >= 2);
  const { read, ...rest } = doc.summary;
  assert.deepEqual(rest, { open: true, rounds: 1, corrections: 1, confirmed: false, draft: null, prompts: 0 });
  assert.ok(Array.isArray(read) && read.length > 0 && read.every(id => /^D-\d+$/.test(id)), 'H2: the details already read back are kept (a second read-back says only what is new)');
  assert.ok(doc.ledger.details.some(d => d.withheld === true) && doc.ledger.details.some(d => d.provenance === 'consultant_typed'));
  // tampered summary state is refused whole
  for (const bad of [{ ...doc, summary: undefined }, { ...doc, summary: { ...doc.summary, open: 'yes' } }, { ...doc, summary: { ...doc.summary, rounds: -1 } }, { ...doc, summary: { ...doc.summary, draft: { id: 5 } } }]) {
    const fresh = rig({ store: false }); fresh.s.ledger = new InterviewLedger('Pilot');
    assert.throws(() => restore(fresh.s, bad), e => e.code === 'corrupt');
  }
  // an interview that was suspended and resumed in another connection
  await h.s.suspend(); await until(() => h.s.finished);
  const h2 = rig({ storage, clk, said: [], session: { evidence: L.hook() }, talk: () => OK_REPLY });
  h2.s.ai.analyst = analystOf({});
  clk.advance(60);
  await h2.s.onText(JSON.stringify({ type: 'start', consent: { transcription: true, draft: true, checkpoint: true }, csrf: 'tok', project: PROJECT, capture: true, voice: 'asteria', memory: false, resume: h.s.sessionId }));
  await until(() => h2.events.some(e => e.type === 'restore'));
  const view = h2.events.find(e => e.type === 'restore').summary;
  assert.ok(view && view.items.length === 2 && view.state === 'summary', 'the open card comes back with the screens');
  assert.ok(!view.items.some(i => i.field === 'problem'), 'the withheld item is still withheld');
  assert.equal(h2.s.summary.open, true); assert.equal(h2.s.summary.corrections, 1); assert.equal(h2.s.summaryActive(), true);
  assert.equal(h2.events.find(e => e.type === 'ready').resumed, true); assert.equal(typeof h2.events.find(e => e.type === 'ready').activeSeconds, 'number');
  await until(() => !h2.s.busy());
  // a further typed correction takes the next free item id: no collision with the first
  await send(h2, { type: 'correct', detail_id: detailOf(h2, 'outcome').id, text: 'Correction after the reconnect: one queue only.' });
  assert.equal(detailOf(h2, 'outcome').provenance, 'consultant_typed');
  assert.equal(new Set(h2.s.ledger.details.map(d => d.item_id)).size, 3);
  await send(h2, { type: 'confirm_summary' }); await until(() => h2.events.some(e => e.type === 'evidence_draft'));
  assert.equal(L.ev.list(OWNER).length, 1);
  assert.ok(!JSON.stringify(L.ev.get(OWNER, h2.events.find(e => e.type === 'evidence_draft').id)).includes('for the insurance client'));
});

test('a confirmed summary is terminal: it is never checkpointed as resumable and a checkpoint of it cannot be resumed', async () => {
  const storage = new FakeStorage(), clk = clock();
  const h = rig({ storage, clk, said: [SAID1, SAID_DONE], session: { evidence: async () => ({ status: 201, body: { id: 'id1', revision: 1 } }) }, talk: n => n === 0 ? ['Right. ', 'What was the project?'] : n === 1 ? ['Thanks. ', 'What was the baseline?'] : OK_REPLY });
  h.s.ai.analyst = analystOf({ 'user-1': FIRST });
  await opened(h); talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy()); talked(h); await until(() => h.events.some(e => e.type === 'summary') && !h.s.busy());
  await send(h, { type: 'confirm_summary' }); await until(() => h.events.some(e => e.type === 'wrap_up'), 6000);
  assert.equal(h.s.canSuspend(), false);
  const doc = JSON.parse(JSON.stringify(serialize(h.s))); assert.equal(doc.summary.confirmed, true); assert.deepEqual(doc.summary.draft, { id: 'id1', revision: 1 });
  const fresh = rig({ store: false }); fresh.s.ledger = new InterviewLedger('Pilot');
  assert.throws(() => restore(fresh.s, doc), e => e.code === 'corrupt' && /already ended/.test(e.message));
  await send(h, { type: 'end' }); await until(() => h.events.some(e => e.type === 'ended'));
  assert.deepEqual(await new CheckpointStore(storage, { owner: USER, now: () => clk.t * 1000 }).info(), null, 'a clean end purges the stored interview');
});

test('what was kept private never reaches the report or the notes event, and the history keeps it', async () => {
  let reportInput = null;
  const h = await atSummary({ talk: () => OK_REPLY });
  h.s.ai.report = async messages => { reportInput = messages; return 'Report:\n' + JSON.stringify({ headline: 'Intake rebuilt', summary: 'The intake was rebuilt.', topics: {}, highlights: [], gaps: [], follow_ups: [] }); };
  await send(h, { type: 'withhold', detail_id: detailOf(h, 'problem').id });
  await send(h, { type: 'end' }); await until(() => h.events.some(e => e.type === 'ended'));
  const notes = h.events.find(e => e.type === 'notes');
  assert.ok(reportInput && !JSON.stringify(reportInput).includes('for the insurance client') && JSON.stringify(reportInput).includes('[kept private]'));
  assert.ok(!notes.transcript.includes('for the insurance client') && notes.transcript.includes('[kept private]'));
  assert.ok(!notes.sections.join('\n').includes('for the insurance client'));
  assert.ok(h.s.ledger.transcripts.get('user-1').includes('for the insurance client'), 'the ledger history still has the words');
});

test('the summary needs the humane selector: legacy and admin interviews never open a card, and the controls are announced', async () => {
  const h = rig({ said: [SAID1, SAID_DONE], flags: { selector: 'legacy' } }); await opened(h);
  assert.ok(h.events.find(e => e.type === 'ready').controls.includes('confirm_summary'));
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy()); talked(h); await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.equal(summaries(h).length, 0); assert.equal(h.s.machine.state, 'discovery');
  await send(h, { type: 'confirm_summary' }); assert.ok(h.events.some(e => e.type === 'quality_warning' && e.message === SUMMARY_UNAVAILABLE));
});

test('paused and suspended interviews refuse the card\'s buttons (the machine has no such move there) and nothing changes', async () => {
  const h = await atSummary(); await send(h, { type: 'pause' }); await until(() => h.s.paused && !h.s.busy());
  const before = JSON.stringify(h.s.ledger.details);
  await send(h, { type: 'correct', detail_id: 'D-003', text: 'It was different, really.' }); await send(h, { type: 'withhold', detail_id: 'D-003' }); await send(h, { type: 'confirm_summary' });
  assert.equal(JSON.stringify(h.s.ledger.details), before); assert.equal(h.s.summary.confirmed, false);
  await send(h, { type: 'resume' }); await until(() => !h.s.paused && !h.s.busy());
  assert.equal(h.s.machine.state, 'summary'); assert.equal(h.s.summaryActive(), true);
});
