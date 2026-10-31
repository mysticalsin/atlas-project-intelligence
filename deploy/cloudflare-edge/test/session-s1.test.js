// v2.1 S1: session and checkpoint correctness plus privacy fixes from two independent reviews (REVIEW_BUGS items 1, 3-8 and three minor items;
// REVIEW_GOVERNANCE L5, L6, L7). Each test is the reviewers' probe turned into a regression test: it fails on the code before the fix.
// Same fakes as the other session suites (reconnect-harness.js): scripted speech recognition, voice, talker and analyst, a clock moved by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPED_MIN_INTERVAL_S, TYPED_RATE_LIMITED, CORRECTIONS_PER_MINUTE, CORRECTION_RATE_LIMITED, RESUME_UNAVAILABLE, RESUME_PROJECT, PRIVATE_MARK } from '../src/session.js';
import { CheckpointStore, CheckpointError, TTL_MS } from '../src/checkpoint.js';
import { analyzeTurn } from '../src/turns.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { evidence, postDraftFromInterview } from '../src/evidence.js';
import { memorySql } from './sqlite.js';
import { rig, opened, interviewing, startMsg, sessionIdOf, talked, until, settle, send, cleanup, screen, named, written, FakeStorage, clock, PROJECT, ANSWER, ANSWER2, QUESTION, USER } from './reconnect-harness.js';

test.afterEach(cleanup);
const errorsOf = h => h.events.filter(e => e.type === 'error');
const cpKeys = h => h.storage.keys().filter(k => k.startsWith('cp:'));
const storeOf = (h, extra = {}) => new CheckpointStore(h.storage, { owner: USER, now: () => h.clk.t * 1000, ...extra });
const SUMMARY = { kind: 'summary', intent: 'summary', field: null, rung: null, say: 'Is there anything I have misunderstood or missed?', why: 'summary:test', reaction: 'none', ack_category: null };

// ---------- bug 1: a project that does not exist yet is no project ----------
function library() {
  let t = 0, n = 0;
  const lib = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') });
  const env = { LIBRARY: { idFromName: name => name, get: () => ({ fetch: async req => libraryRoutes(req, lib, {}) }) } };
  return { lib, ev: evidence(lib), hook: (identity = { user: USER, role: 'user', mail: USER }) => notes => postDraftFromInterview(env, identity, notes) };
}
const NEW_PROJECT = { ...PROJECT, id: 'new', title: 'New project, not yet named' };
test('bug 1: an interview of a project that does not exist yet sends project_ref null (never the placeholder "new"); a known project keeps its id', async () => {
  const L = library(), h = rig({ said: [ANSWER], session: { evidence: L.hook() } });
  h.s.ai.analyst = async messages => { const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment; return [{ id: 'c1', name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'problem', item_id: seg.item_id, quote: seg.text.slice(0, 31) }] }) }]; };
  await h.s.onText(startMsg({ project: NEW_PROJECT })); await until(() => !h.s.busy() && h.bytes.length >= 1);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy() && h.s.ledger.details.length === 1);
  assert.equal(h.s.project.id, 'new'); assert.equal(h.s.evidenceNotes().project_ref, null);
  assert.equal(await h.s.saveDraft(), true);
  const rows = L.lib.sql.exec('SELECT project_ref FROM evidence_records').toArray(), claims = L.lib.sql.exec('SELECT subject_type, subject_id FROM evidence_claims').toArray();
  assert.deepEqual(rows, [{ project_ref: null }]); assert.ok(claims.length >= 1);
  assert.ok(claims.every(c => c.subject_id !== 'new'), 'no claim is about the shared fake project: ' + JSON.stringify(claims));
  const rec = L.lib.sql.exec('SELECT * FROM evidence_records').toArray()[0];
  assert.equal(L.ev.n1(rec), '', 'no manager is resolved from a project that is not there: the reviewer role takes it');
  const known = rig({ said: [ANSWER] }); await opened(known); assert.equal(known.s.evidenceNotes().project_ref, 'p-falcon');
});

// ---------- bug 3 and 7: a resume answers a pending answer, and never re-answers a pause ----------
test('bug 3: after a reconnect, the first Resume of a spoken pause continues the interview (it does not pause again)', async () => {
  const storage = new FakeStorage(), clk = clock();
  const h = await interviewing({ storage, clk, said: ['Can we pause for a moment?'] });
  talked(h); await until(() => h.s.paused); await settle(400); await written(h);
  const id = sessionIdOf(h); await h.s.suspend();
  const h2 = rig({ storage, clk, talk: () => ['Thanks. ', 'What was ', 'the baseline?'] });
  await h2.s.onText(startMsg({ resume: id })); await settle(300);
  assert.equal(h2.s.paused, true); assert.equal(h2.s.afterRestore, true);
  await send(h2, { type: 'resume' }); await settle(600);
  assert.equal(h2.s.paused, false, 'still paused after pressing Resume');
  assert.deepEqual(h2.events.filter(e => e.type === 'state').map(e => e.event), ['reconnect', 'resume']);
  assert.equal(named(h2.metrics, 'pause').length, 0);
  assert.ok(screen(h2).includes(QUESTION), 'the question in front of them is said again'); assert.equal(h2.calls.talker.length, 0, 'with no model call');
});

test('bug 7: pausing while the answer is still being transcribed: Resume answers it (a talker call), it does not re-ask the question just answered', async () => {
  const h = await interviewing({ said: [ANSWER2] });
  talked(h); await send(h, { type: 'pause' }); await settle(400);
  const talker = h.calls.talker.length; assert.ok(h.s.history.at(-1).content === ANSWER2 || h.s.history.at(-1).role === 'assistant');
  await send(h, { type: 'resume' }); await settle(600);
  assert.equal(h.calls.talker.length - talker, 1, 'the answer got its reply');
  assert.ok(h.s.history.some(m => m.role === 'user' && m.content === ANSWER2), 'recorded');
  assert.equal(h.s.history.at(-1).role, 'assistant');
  assert.equal(h.s.turns, 2); assert.equal(h.s.paused, false);
});

test('bug 7: a spoken pause is still a control after a UI resume (no answer is made of it), and a repeat of the same question when nothing is pending', async () => {
  const h = await interviewing(); const talker = h.calls.talker.length;
  await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  await send(h, { type: 'resume' }); await until(() => !h.s.busy() && h.s.paused === false); await settle(50);
  assert.equal(h.calls.talker.length, talker, 'nothing pending: the question is said again with no model call');
  assert.ok(screen(h).split(QUESTION).length >= 3, 'asked, then again');
});

// ---------- bug 4: an interrupted read-back opens no card and does not strand the machine ----------
test('bug 4: a read-back interrupted while the analyst is still filing opens no card, counts no round, and the machine is back in discovery', async () => {
  const h = await interviewing(); await settle(200);
  let release; h.s.turnJob = new Promise(r => { release = r; });
  h.s.startReply(undefined, { move: { ...SUMMARY }, turn: h.s.turns });
  assert.equal(h.s.machine.state, 'summary');
  h.s.interrupt(); release(); await settle(400);
  assert.equal(h.events.filter(e => e.type === 'summary').length, 0, 'no card'); assert.equal(h.s.summary.open, false); assert.equal(h.s.summary.rounds, 0);
  assert.equal(h.s.machine.state, 'discovery', 'not left in summary'); assert.ok(!h.s.humane.asked.some(m => m.kind === 'summary'));
  assert.deepEqual(h.s.machine.audit.slice(-2).map(a => a.event), ['request_summary', 'continue_discovery']);
  assert.ok(h.s.machine.canFire('skip', 'user'), 'skip is legal again');
});

test('bug 4: a read-back withdrawn (the consultant carried on) after its card opened closes the card and goes back to discovery', async () => {
  const h = await interviewing(); await settle(200);
  h.s.startReply(undefined, { move: { ...SUMMARY }, turn: h.s.turns });
  await until(() => h.events.some(e => e.type === 'summary'));
  const item = h.s.replyItem; h.s.discarded.add(item); h.s.gen += 1; h.s.uncommit(item);
  assert.equal(h.s.summary.open, false); assert.ok(h.events.some(e => e.type === 'summary_closed'));
  assert.equal(h.s.machine.state, 'discovery');
});

// ---------- bug 5 / L6: a finished interview is never stored, offered, or kept ----------
async function confirmed(opts = {}) {
  const storage = new FakeStorage(), clk = clock();
  const h = await interviewing({ storage, clk, session: { evidence: async () => ({ status: 201, body: { id: 'ev-1', revision: 1 } }) }, ...opts });
  h.s.startReply(undefined, { move: { ...SUMMARY }, turn: h.s.turns });
  await until(() => h.s.summary.open && !h.s.busy());
  await send(h, { type: 'confirm_summary' }); await until(() => h.s.summary.confirmed);
  await settle(50); await written(h).catch(() => {});
  return h;
}
test('bug 5 / L6: a confirmed interview whose connection drops before the goodbye leaves nothing stored; a resume is refused and the prompt is gone', async () => {
  const h = await confirmed(); const id = sessionIdOf(h);
  assert.equal(h.s.machine.terminal, true);
  await h.s.suspend();
  assert.deepEqual(cpKeys(h), [], 'purged');
  assert.equal(await storeOf(h).info(), null, 'bootstrap offers nothing');
  const h2 = rig({ storage: h.storage, clk: h.clk }); await h2.s.onText(startMsg({ resume: id })); await settle(200);
  assert.deepEqual(errorsOf(h2).map(e => e.message), [RESUME_UNAVAILABLE]); assert.equal(await storeOf(h).info(), null);
});

test('bug 5: nothing is written once the interview is in a terminal state', async () => {
  const h = await confirmed(); const puts = h.storage.puts.length;
  h.s.checkpointSoon(); await settle(100); await h.s.saveCheckpoint();
  assert.equal(h.storage.puts.length, puts, 'no write after confirm');
  await assert.rejects(storeOf(h).save({ version: 2, sessionId: 'ab'.repeat(16), machine: { state: 'summary_confirmed' } }), e => e instanceof CheckpointError && e.code === 'terminal');
});

test('bug 5: the bootstrap does not offer a terminal checkpoint that an older write left behind, and removes it', async () => {
  const storage = new FakeStorage(), id = 'cd'.repeat(16), store = new CheckpointStore(storage, { owner: USER, now: () => 5e6 });
  await store.save({ version: 2, sessionId: id, machine: { state: 'discovery' } }); assert.ok(await store.info(), 'a live one is offered');
  const meta = storage.m.get(`cp:${id}:meta`); storage.m.set(`cp:${id}:meta`, { ...meta, state: 'summary_confirmed' });
  assert.equal(await store.info(), null); assert.deepEqual(storage.keys().filter(k => k.startsWith('cp:')), []);
});

test('bug 5: a resume refused as corrupt purges the checkpoint; a refusal for another project keeps it for the right one', async () => {
  const storage = new FakeStorage(), clk = clock(), id = 'ef'.repeat(16);
  await new CheckpointStore(storage, { owner: USER, now: () => clk.t * 1000 }).save({ version: 2, sessionId: id, project: { id: 'p-falcon' }, machine: { state: 'discovery' } }); // well-formed envelope, junk inside
  const h = rig({ storage, clk }); await h.s.onText(startMsg({ resume: id })); await settle(200);
  assert.deepEqual(errorsOf(h).map(e => e.message), [RESUME_UNAVAILABLE]); assert.deepEqual(cpKeys(h), [], 'a checkpoint that can never be resumed is not offered again');
  // another project: the stored interview stays
  const a = await interviewing({ storage, clk }); await written(a); const real = sessionIdOf(a); await a.s.suspend(); assert.ok(cpKeys(a).length);
  const b = rig({ storage, clk }); await b.s.onText(startMsg({ resume: real, project: { ...PROJECT, id: 'p-other' } })); await settle(200);
  assert.deepEqual(errorsOf(b).map(e => e.message), [RESUME_PROJECT]); assert.ok(cpKeys(b).length, 'kept for its own project');
});

test('L6: an end that is not a suspend (the connection fails while not suspendable) purges what was stored', async () => {
  const h = await interviewing(); await written(h); assert.ok(cpKeys(h).length);
  h.s.fireState('withdraw', 'user', { reason: 'test' }); // a state a dropped connection cannot come back to
  assert.equal(h.s.canSuspend(), false);
  await h.s.suspend(); assert.deepEqual(cpKeys(h), []);
});

test('L6: the 24 hours are absolute from the first capture: later writes and reconnects never extend them, the alarm keeps the first deadline', async () => {
  const storage = new FakeStorage(), clk = clock();
  const h = await interviewing({ storage, clk }); await written(h);
  const first = storage.m.get(`cp:${sessionIdOf(h)}:meta`).capturedAt, deadline = first + TTL_MS; assert.equal(storage.alarm, deadline);
  h.advance(3600); h.s.checkpointSoon(); await settle(100); await h.s.suspend();
  assert.equal(storage.alarm, deadline, 'a later save leaves the deadline where it was');
  let prev = h;
  for (let i = 0; i < 4; i++) { // reconnect every 5 hours, suspend again each time
    prev.advance(5 * 3600);
    const r = rig({ storage, clk }); await r.s.onText(startMsg({ resume: sessionIdOf(h) })); await until(() => r.s.finished || r.events.some(e => e.type === 'restore'));
    assert.deepEqual(errorsOf(r), [], 'resumable inside the window'); await r.s.suspend(); assert.equal(storage.alarm, deadline, 'resume ' + i);
    prev = r;
  }
  prev.advance(5 * 3600); // 21 h + 1 h + ... past the first capture's 24 h
  const store = storeOf(prev); assert.equal(await store.expire(), true, 'the alarm purges at the first deadline'); assert.deepEqual(cpKeys(h), []);
  const late = rig({ storage, clk }); await late.s.onText(startMsg({ resume: sessionIdOf(h) })); await settle(30);
  assert.deepEqual(errorsOf(late).map(e => e.message), [RESUME_UNAVAILABLE]);
});

test('L6: a live session past its 24 hours writes nothing more and deletes what is stored (no fresh 24 hours after the alarm purged it)', async () => {
  const h = await interviewing(); await written(h);
  h.advance(24 * 3600 + 1); // the alarm purged it while the session was still connected
  await h.s.checkpoint.purge(); h.s.checkpointSoon(); await settle(100);
  assert.deepEqual(cpKeys(h), [], 'not written again'); assert.equal(named(h.metrics, 'checkpoint_expired').length, 1);
  await assert.rejects(storeOf(h).save({ version: 2, sessionId: 'aa'.repeat(16), machine: { state: 'discovery' } }).then(() => storeOf(h, { now: () => h.clk.t * 1000 + 25 * 3600 * 1000 }).save({ version: 2, sessionId: 'aa'.repeat(16), machine: { state: 'discovery' } })), e => e.code === 'expired');
});

// ---------- bug 6: a playback ack while the checkpoint is being read ----------
test('bug 6: a well-formed playback report while a resume is being read is ignored (the reconnect is not killed); anything else still is refused', async () => {
  const storage = new FakeStorage(), clk = clock();
  const h = await interviewing({ storage, clk }); await settle(200); await written(h);
  const id = sessionIdOf(h); await h.s.suspend();
  const slow = new CheckpointStore(storage, { owner: USER, now: () => clk.t * 1000 }), load = slow.load.bind(slow);
  slow.load = async x => { await new Promise(r => setTimeout(r, 20)); return load(x); };
  const h2 = rig({ storage, clk, store: slow });
  const started = h2.s.onText(startMsg({ resume: id }));
  h2.s.onText(JSON.stringify({ type: 'playback', item_id: 'agent-2', played_ms: 1200 }));
  await started; await settle(100);
  assert.deepEqual(errorsOf(h2), [], 'no "Unsupported client event"'); assert.ok(h2.events.some(e => e.type === 'ready' && e.resumed === true));
  const h3 = rig({ storage: new FakeStorage(), clk, store: slow }); const s3 = h3.s.onText(startMsg({ resume: id }));
  h3.s.onText(JSON.stringify({ type: 'playback', item_id: 'x', played_ms: -5 })); await s3; // malformed: still a contract error
  assert.ok(errorsOf(h3).some(e => e.code === 'voice-contract'));
});

// ---------- bug 8 and minor a: resolveAsr ----------
const span = (text, status = 'open') => ({ text, kind: 'number', min_conf: 0.3, start: 0, end: 1, audio_offset_ms: 0, status });
async function asrSession(spans, say) {
  const h = rig(); await opened(h);
  h.s.turns = 3; h.s.identNow = 'user-3';
  h.s.asrMeta = Object.fromEntries(Object.entries(spans).map(([ident, list]) => [ident, { spans: list, minConf: 0.3, audioOffsetMs: 0 }]));
  h.s.humane.asked.push({ kind: 'confirm_asr', intent: 'confirm_asr', field: 'outcome', say, why: 'asr' });
  return h;
}
test('bug 8: when a misheard value is corrected in the same breath, the turn is no longer a bare no and no longer a correction (the next question follows the answer)', async () => {
  const h = await asrSession({ 'user-2': [span('twenty five')] }, 'Did you say twenty five?');
  const text = 'No, it was thirty five minutes', turn = analyzeTurn(text, 'en', { asked_field: 'outcome' });
  assert.deepEqual(turn.intents, ['correction', 'deny']);
  const out = h.s.resolveAsr(turn, text);
  assert.equal(h.s.asrMeta['user-2'].spans[0].status, 'corrected'); assert.equal(h.s.asrMeta['user-2'].spans[0].corrected_to, 'thirty five');
  assert.deepEqual(out.intents, [], 'neither deny nor correction is left for the selector');
  assert.deepEqual(h.s.resolveAsr(turn, text).intents, [], 'and the same when the answer is processed again');
});

test('minor a: only the span that was asked about is settled: an older open "5" is not confirmed by "was that 15 percent?"', async () => {
  const h = await asrSession({ 'user-1': [span('5')], 'user-2': [span('15')] }, 'Was that 15 percent?');
  const turn = analyzeTurn('Yes, that is right', 'en', { asked_field: 'outcome' });
  h.s.resolveAsr(turn, 'Yes, that is right');
  assert.equal(h.s.asrMeta['user-2'].spans[0].status, 'confirmed'); assert.equal(h.s.asrMeta['user-1'].spans[0].status, 'open', 'the old one is untouched');
  const h2 = await asrSession({ 'user-1': [span('5')] }, 'Was that 15 percent?'); // nothing was asked about "5" itself: no span is settled at all
  h2.s.resolveAsr(turn, 'Yes, that is right'); assert.equal(h2.s.asrMeta['user-1'].spans[0].status, 'open');
});

// ---------- minor b: a failed typed correction does not lock out the next ----------
async function atCard() {
  const h = rig({ said: [ANSWER], talk: (n) => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', 'What was the baseline?'] });
  h.s.ai.analyst = async messages => { const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
    return [{ id: 'c1', name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'problem', item_id: seg.item_id, quote: 'the claims intake process for the insurance client' }, { field: 'outcome', item_id: seg.item_id, quote: 'a big change for the whole team' }] }) }]; };
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy() && h.s.ledger.details.length === 2);
  h.s.startReply(undefined, { move: { ...SUMMARY }, turn: h.s.turns });
  await until(() => h.s.summary.open && !h.s.busy());
  return h;
}
test('minor b: one failed typed correction leaves its item id free: the next correction still works', async () => {
  const h = await atCard(), d = h.s.ledger.details.find(x => x.field === 'outcome');
  const record = h.s.ledger.record.bind(h.s.ledger); let fail = true; h.s.ledger.record = (...a) => { if (fail) { fail = false; throw new Error('Candidate budget reached'); } return record(...a); };
  await send(h, { type: 'correct', detail_id: d.id, text: 'It was a modest change, limited to one queue.' });
  assert.ok(h.events.some(e => e.type === 'quality_warning' && /could not be added/.test(e.message)));
  assert.equal(h.s.ledger.transcripts.has('user-typed-1001'), false, 'the orphan transcript is taken back'); assert.equal(h.s.summary.corrections, 0);
  await until(() => !h.s.busy()); h.advance(0.1);
  await send(h, { type: 'correct', detail_id: d.id, text: 'It was a modest change, limited to one queue.' });
  assert.equal(h.s.summary.corrections, 1); assert.ok(h.s.ledger.details.some(x => x.supersedes === d.id && x.provenance === 'consultant_typed'));
  assert.ok(!h.events.filter(e => e.type === 'quality_warning').some(e => /Transcript item changed/.test(e.message)));
});

test('minor b: an id that is already taken is skipped, never reused', async () => {
  const h = await atCard(), d = h.s.ledger.details.find(x => x.field === 'outcome');
  h.s.ledger.addTranscript('user-typed-1001', 'something else that is already there');
  await send(h, { type: 'correct', detail_id: d.id, text: 'It was a modest change, limited to one queue.' });
  assert.equal(h.s.summary.corrections, 1); assert.ok(h.s.ledger.transcripts.has('user-typed-1002'));
});

// ---------- L5: rate limits ----------
test('L5: typed turns are taken one at a time and not faster than 1.5 s; a refused one is counted and the browser is told', async () => {
  const h = rig({ talk: n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', 'What was the baseline?'] }); await opened(h);
  await send(h, { type: 'text', text: ANSWER }); assert.equal(h.s.turns, 1);
  await send(h, { type: 'text', text: 'a second one straight after' }); // a reply is in flight
  assert.equal(h.s.turns, 1); assert.equal(named(h.metrics, 'typed_rate_limited').length, 1);
  assert.ok(h.events.some(e => e.type === 'quality_warning' && e.message === TYPED_RATE_LIMITED));
  await until(() => !h.s.busy());
  await send(h, { type: 'text', text: 'too soon after the first' }); // not busy, but under 1.5 s since the last
  assert.equal(h.s.turns, 1); assert.equal(named(h.metrics, 'typed_rate_limited').length, 2); assert.deepEqual(named(h.metrics, 'typed_rate_limited').map(m => m.busy), [1, 0]);
  h.advance(TYPED_MIN_INTERVAL_S + 0.1);
  await send(h, { type: 'text', text: 'and now it is fine to answer again' }); assert.equal(h.s.turns, 2);
  assert.equal(h.calls.talker.length, 3, 'opening + two replies: a refused turn gets none');
  assert.equal(h.s.history.filter(m => m.role === 'user').length, 2);
});

test('L5: corrections are bounded per minute (attempts count), and the window moves on', async () => {
  const h = await atCard(), d = () => h.s.ledger.details.find(x => x.field === 'outcome' && x.active && !x.withheld);
  for (let i = 0; i < CORRECTIONS_PER_MINUTE; i++) { await send(h, { type: 'correct', detail_id: d().id, text: 'Correction number ' + i + ' of the outcome.' }); await until(() => !h.s.busy()); }
  assert.equal(h.s.summary.corrections, CORRECTIONS_PER_MINUTE);
  await send(h, { type: 'correct', detail_id: d().id, text: 'One correction too many in this minute.' });
  assert.ok(h.events.some(e => e.type === 'quality_warning' && e.message === CORRECTION_RATE_LIMITED)); assert.equal(named(h.metrics, 'correction_rate_limited').length, 1);
  assert.equal(h.s.summary.corrections, CORRECTIONS_PER_MINUTE);
  h.advance(61); await send(h, { type: 'correct', detail_id: d().id, text: 'A correction in the next minute is fine.' });
  assert.equal(h.s.summary.corrections, CORRECTIONS_PER_MINUTE + 1);
});

// ---------- L7: "keep private" covers the whole utterance ----------
const SECRET_SAID = 'We rebuilt the claims intake for Zebracorp and the secret margin was nineteen percent which nobody outside the team knows.';
test('L7: keeping a detail private removes the WHOLE utterance from the notes transcript, the report input, the talker history and the draft asr; the audit stays without the words', async () => {
  let reportInput = null;
  const h = rig({ said: [SECRET_SAID], talk: n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', 'What was the baseline?'] });
  h.s.ai.analyst = async messages => { const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
    return [{ id: 'c1', name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'outcome', item_id: seg.item_id, quote: 'the secret margin was nineteen percent' }, { field: 'problem', item_id: seg.item_id, quote: 'the claims intake' }] }) }]; };
  h.s.ai.report = async messages => { reportInput = messages; return 'Report:\n' + JSON.stringify({ headline: 'Intake rebuilt', summary: 'The intake was rebuilt.', topics: {}, highlights: [], gaps: [], follow_ups: [] }); };
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy() && h.s.ledger.details.length === 2);
  h.s.startReply(undefined, { move: { ...SUMMARY }, turn: h.s.turns }); await until(() => h.s.summary.open && !h.s.busy());
  const secret = h.s.ledger.details.find(d => d.field === 'outcome');
  await send(h, { type: 'withhold', detail_id: secret.id });
  // the talker's history: the utterance is a marker, not "We rebuilt ... for Zebracorp ... which nobody outside the team knows"
  const user = h.s.history.filter(m => m.role === 'user'); assert.deepEqual(user.map(m => m.content), [PRIVATE_MARK]);
  h.s.ai.transcribe = async () => 'Nothing more to add on that point from my side, thank you.'; talked(h);
  await until(() => h.calls.talker.length === 4 && !h.s.busy()); // (the read-back itself was the third call)
  const seen = h.calls.talker.at(-1).map(m => m.content).filter(c => /Zebracorp|nineteen/.test(c)); assert.deepEqual(seen, [], 'future talker calls never see it');
  assert.ok(!JSON.stringify(h.s.asrNotes()).includes('Zebracorp'));
  await send(h, { type: 'end' }); await until(() => h.events.some(e => e.type === 'ended'));
  const notes = h.events.find(e => e.type === 'notes');
  for (const where of [notes.transcript, JSON.stringify(reportInput), JSON.stringify(notes.sections)]) assert.ok(!/Zebracorp|nineteen|nobody outside the team/.test(where), where.slice(0, 200));
  assert.ok(notes.transcript.includes(PRIVATE_MARK), 'a marker stands where it was');
  // the audit: the withheld detail and the history remain (T11: the owner-only ledger record), and say it was withheld
  const w = h.s.ledger.details.find(d => d.id === secret.id); assert.equal(w.withheld, true);
  assert.ok(h.s.machine.audit.length && named(h.metrics, 'summary_withhold').length === 1);
});

test('L7: only the utterance of the withheld detail is replaced: the other utterances are kept as they were said', async () => {
  const h = rig({ said: [SECRET_SAID, 'The median handling time dropped a lot after the pilot across the whole claims team.'], talk: () => ['Thanks. ', 'What was the baseline?'] });
  h.s.ai.analyst = async messages => { const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
    return [{ id: 'c' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details: [{ field: seg.item_id === 'user-1' ? 'outcome' : 'measurement', item_id: seg.item_id, quote: seg.text.slice(0, 31) }] }) }]; };
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  talked(h); await until(() => h.calls.talker.length === 3 && !h.s.busy() && h.s.ledger.details.length === 2);
  h.s.startReply(undefined, { move: { ...SUMMARY }, turn: h.s.turns }); await until(() => h.s.summary.open && !h.s.busy());
  await send(h, { type: 'withhold', detail_id: h.s.ledger.details.find(d => d.item_id === 'user-1').id });
  assert.deepEqual(h.s.history.filter(m => m.role === 'user').map(m => m.content), [PRIVATE_MARK, 'The median handling time dropped a lot after the pilot across the whole claims team.']);
});
