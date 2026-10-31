// Agent Brain v2.1 T10: checkpoint and reconnect inside a live Session. A dropped socket suspends the interview (persisted, 24 hours); `start` with `resume`
// brings it back and says the last UNANSWERED question again with no model call; checkpoints exist only with transcript consent; discard, a clean end and
// a fresh start purge; the alarm purges after 24 hours; a proof request (gap) is never resumed; storage is per Durable Object and needs the same identity.
// Same fakes as session-pause.test.js (reconnect-harness.js): scripted speech recognition, voice, talker and analyst, a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RESUME_UNAVAILABLE, RESUME_PROJECT, CHECKPOINT_DEBOUNCE_MS } from '../src/session.js';
import { RESUME_LINES } from '../src/policy.generated.js';
import { CheckpointStore, TTL_MS } from '../src/checkpoint.js';
import { FakeStorage, rig, opened, interviewing, talked, until, settle, cleanup, send, screen, named, startMsg, written, sessionIdOf, PROJECT, ANSWER, ANSWER2, QUESTION, USER } from './reconnect-harness.js';

test.afterEach(cleanup);
const cpKeys = h => h.storage.keys().filter(k => k.startsWith('cp:'));
const errorsOf = h => h.events.filter(e => e.type === 'error');
// The same person, a moment later: a new Session (a new socket) on the same Durable Object storage and clock.
const again = (h, opts = {}) => rig({ storage: h.storage, clk: h.clk, ...opts });
async function resumed(prev, opts = {}, extra = {}) {
  const id = sessionIdOf(prev), h = again(prev, opts);
  await h.s.onText(startMsg({ resume: id, ...extra }));
  await until(() => h.s.finished || h.events.some(e => e.type === 'restore'));
  await until(() => h.s.finished || h.s.paused || (!h.s.busy() && h.bytes.length > 0));
  return h;
}

test('ready announces the interview id only when the interview is resumable', async () => {
  const h = await interviewing(), ready = h.events.find(e => e.type === 'ready');
  assert.match(ready.sessionId, /^[a-f0-9]{32}$/); assert.equal(ready.resumable, true); assert.ok(!('resumed' in ready));
  const off = rig({ store: false }); await opened(off);
  assert.ok(!('sessionId' in off.events.find(e => e.type === 'ready')), 'no store, no id');
});

test('a dropped socket suspends the interview: persisted in the person\'s own storage, alarm armed for 24 hours', async () => {
  const h = await interviewing(); await written(h);
  const id = sessionIdOf(h);
  await h.s.suspend();
  assert.ok(h.s.finished && h.s.ending);
  assert.ok(cpKeys(h).includes('cp:' + id + ':meta') && cpKeys(h).includes('cp:' + id + ':0') && cpKeys(h).includes('cp:current'));
  assert.equal(h.storage.alarm, h.clk.t * 1000 + TTL_MS, 'the purge alarm: 24 h after the last write');
  const stored = await new CheckpointStore(h.storage, { owner: USER, now: () => h.clk.t * 1000 }).load(id);
  assert.equal(stored.machine.state, 'suspended'); assert.equal(stored.machine.audit.at(-1).event, 'disconnect');
  assert.ok(h.events.some(e => e.type === 'state' && e.state === 'suspended' && e.event === 'disconnect'), 'the machine recorded the loss');
  assert.ok(!h.events.some(e => e.type === 'notes' || e.type === 'ended'), 'a suspension delivers no notes: the interview is not over');
  assert.equal(named(h.metrics, 'suspend').length, 1);
  await h.s.suspend(); assert.equal(named(h.metrics, 'suspend').length, 1, 'once');
});

test('resume: the last UNANSWERED question is said again from the stored text, with zero talker calls; the answered one is never re-asked', async () => {
  const h = await interviewing(); await h.s.suspend();
  const r = await resumed(h);
  assert.ok(!errorsOf(r).length, JSON.stringify(errorsOf(r)));
  const ready = r.events.find(e => e.type === 'ready');
  assert.equal(ready.resumed, true); assert.equal(ready.sessionId, sessionIdOf(h), 'the same interview id');
  assert.equal(r.calls.talker.length, 0, 'zero talker calls for the re-ask'); assert.equal(r.calls.analyst, 0);
  const said = screen(r);
  assert.ok(said.includes(QUESTION), said);
  assert.ok(RESUME_LINES.en.some(l => said.includes(l)), 'after a welcome-back line');
  assert.ok(!said.includes('What was the project?'), 'the question the consultant already answered is not asked again');
  assert.equal(r.s.machine.state, 'discovery'); assert.ok(r.events.some(e => e.type === 'state' && e.event === 'reconnect' && e.actor === 'system'));
  assert.equal(r.s.humane.asked.length, h.s.humane.asked.length, 'one question, one entry in the asked log');
  assert.equal(r.s.turns, h.s.turns); assert.equal(r.s.lastQuestion.text, QUESTION);
  const view = r.events.find(e => e.type === 'restore');
  assert.equal(view.lastQuestion, QUESTION); assert.equal(view.user.length, 1); assert.equal(view.user[0].text, 'We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.');
  assert.ok(view.agent.length >= 2 && view.quality.candidate_details.length >= 1);
  assert.deepEqual(r.events.map(e => e.type).filter(t => ['ready', 'state', 'restore'].includes(t)).slice(0, 3), ['ready', 'state', 'restore'], 'ready, then the machine, then the screens');
  // and the interview simply carries on: the next answer gets a normal reply with the whole history
  r.s.playedMs[r.s.currentItem] = 1e9;
  const before = r.s.turns;
  r.s.ai.transcribe = async () => ANSWER2;
  talked(r); await until(() => r.s.turns === before + 1 && r.calls.talker.length === 1 && !r.s.busy());
  const history = r.calls.talker[0].filter(m => m.role !== 'system').map(m => m.content).join('\n');
  assert.ok(history.includes('claims intake process') && history.includes(QUESTION) && history.includes(ANSWER2.slice(0, 40)), 'the talker sees the whole conversation across the drop');
  assert.ok(r.s.ledger.transcripts.has('user-' + (before + 1)) && r.s.ledger.transcripts.has('user-1'), 'ledger ids continue');
});

test('resume after a reply that never reached a question: the move\'s own question is asked, not the answered one', async () => {
  let hold;
  const h = rig({ said: [ANSWER, ANSWER2], talk: n => n === 0 ? ['Right. ', 'What was the project?'] : n === 1 ? ['Thanks. ', QUESTION] : (async function* () { await new Promise(r => { hold = r; }); yield 'Never said. '; })() });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  h.s.playedMs[h.s.currentItem] = 1e9;
  talked(h); await until(() => h.calls.talker.length === 3 && h.s.busy()); // the consultant answered the baseline question; her reply is still being composed
  assert.equal(h.s.lastQuestion.text, QUESTION);
  await h.s.suspend(); hold?.();
  const r = await resumed(h);
  const said = screen(r);
  assert.ok(!said.includes(QUESTION), 'the baseline question was answered: never asked again\n' + said);
  assert.ok(/\?/.test(said), 'a next question is asked');
  assert.equal(r.calls.talker.length, 0, 'still no model call: the selector\'s own question, spoken from the stored move');
  assert.equal(r.s.history.filter(m => m.role === 'user').length, 2, 'both answers are in the history');
});

test('resume when the answer was heard but nothing was composed: the answer gets its reply, the answered question is not repeated', async () => {
  const h = await interviewing();
  // the consultant's second answer is in the history, ATLAS never began to reply: the stored question is older than the answer
  h.s.turns += 1; h.s.history.push({ role: 'user', content: ANSWER2 }); h.s.ledger.addTranscript('user-2', ANSWER2);
  await h.s.suspend();
  const r = await resumed(h, { talk: () => ['Thanks. ', 'Which team measured it?'] });
  assert.ok(!errorsOf(r).length);
  const said = screen(r);
  assert.ok(!said.includes(QUESTION) && said.includes('Which team measured it?'), said);
  assert.equal(r.calls.talker.length, 1, 'one reply, to the answer that had none');
});

test('resume before anything was asked speaks the opening again', async () => {
  const h = rig({ talk: n => n === 0 ? (async function* () { await new Promise(() => {}); })() : ['Welcome back. ', 'Where shall we start?'] });
  await h.s.onText(startMsg()); await until(() => h.calls.talker.length === 1);
  await h.s.suspend();
  const r = await resumed(h, { talk: () => ['Hello again. ', 'What was the project?'] });
  assert.equal(r.s.turns, 0); assert.equal(r.calls.talker.length, 1); assert.ok(screen(r).includes('What was the project?'));
});

test('a checkpoint left by a crash (no suspend, the socket just vanished) can be resumed too', async () => {
  const h = await interviewing(); await written(h);
  // the Durable Object was evicted: no close handler ran. The last debounced write is all there is.
  const stored = await new CheckpointStore(h.storage, { owner: USER, now: () => h.clk.t * 1000 }).load(sessionIdOf(h));
  assert.equal(stored.machine.state, 'discovery');
  const r = await resumed(h);
  assert.ok(!errorsOf(r).length); assert.equal(r.calls.talker.length, 0); assert.ok(screen(r).includes(QUESTION));
  assert.deepEqual(r.s.machine.audit.map(a => a.event).slice(-2), ['disconnect', 'reconnect']);
});

test('transcript consent is the gate: capture off writes nothing, and a resume without it is refused', async () => {
  const off = rig(); await opened(off, { capture: false });
  assert.equal(off.s.capture, false); assert.ok(!('sessionId' in off.events.find(e => e.type === 'ready')));
  off.s.history.push({ role: 'user', content: 'hello' }); off.s.checkpointSoon(); await settle(50);
  await off.s.suspend();
  assert.equal(off.storage.keys().length, 0, 'nothing persisted'); assert.equal(off.storage.alarm, null); assert.equal(off.s.canSuspend(), false);
  assert.ok(off.events.some(e => e.type === 'ended'), 'without a checkpoint a dropped socket ends as it always did');
  // a stored interview is not resumable by a start that declines transcription
  const h = await interviewing(); await h.s.suspend(); const keys = cpKeys(h).length;
  const r = again(h); await r.s.onText(startMsg({ resume: sessionIdOf(h), capture: false })); await settle(20);
  assert.deepEqual(errorsOf(r).map(e => [e.code, e.message]), [['resume-unavailable', RESUME_UNAVAILABLE]]);
  assert.equal(cpKeys(h).length, keys, 'refusing the resume leaves the stored interview for another try');
});

test('refused resumes all say the same thing: unknown id, malformed id, nothing stored, other project, no store', async () => {
  const h = await interviewing(); await h.s.suspend();
  const cases = [['an id that is not stored', { resume: 'a'.repeat(32) }], ['a malformed id', { resume: 'nope' }], ['a number', { resume: 7 }]];
  for (const [name, extra] of cases) {
    const r = again(h); await r.s.onText(startMsg(extra)); await settle(20);
    assert.deepEqual(errorsOf(r).map(e => e.message), [RESUME_UNAVAILABLE], name);
    assert.ok(!r.events.some(e => e.type === 'ready') && r.calls.talker.length === 0, name);
  }
  const empty = rig({ storage: new FakeStorage() }); await empty.s.onText(startMsg({ resume: sessionIdOf(h) })); await settle(20);
  assert.deepEqual(errorsOf(empty).map(e => e.message), [RESUME_UNAVAILABLE], 'nothing stored in this storage');
  const none = rig({ storage: h.storage, store: false, clk: h.clk }); await none.s.onText(startMsg({ resume: sessionIdOf(h) })); await settle(20);
  assert.deepEqual(errorsOf(none).map(e => e.message), [RESUME_UNAVAILABLE], 'ATLAS_CHECKPOINT=off: no store, no resume');
  const other = again(h); await other.s.onText(startMsg({ resume: sessionIdOf(h), project: { ...PROJECT, id: 'another' } })); await settle(20);
  assert.deepEqual(errorsOf(other).map(e => [e.code, e.message]), [['resume-project', RESUME_PROJECT]]); assert.ok(!other.events.some(e => e.type === 'ready'));
  assert.ok(cpKeys(h).length, 'none of these deleted the stored interview');
});

test('discard purges at once; so does a clean end', async () => {
  const h = await interviewing(); await written(h);
  assert.ok(cpKeys(h).length && h.storage.alarm);
  await send(h, { type: 'discard' });
  assert.equal(cpKeys(h).length, 0); assert.equal(h.storage.alarm, null);
  assert.ok(h.s.machine.audit.some(a => a.event === 'withdraw'));
  const e = await interviewing(); await written(e);
  await send(e, { type: 'end' });
  assert.equal(cpKeys(e).length, 0, 'ended cleanly: notes were delivered, nothing is kept'); assert.equal(e.storage.alarm, null);
  assert.ok(e.events.some(x => x.type === 'notes'));
});

test('discard while a resume is being read purges too, and no write races the purge', async () => {
  const h = await interviewing(); await h.s.suspend();
  const r = again(h); let release; const real = r.store.load.bind(r.store); r.store.load = async id => { await new Promise(x => { release = x; }); return real(id); };
  const started = r.s.onText(startMsg({ resume: sessionIdOf(h) })); await until(() => !!release);
  await send(r, { type: 'discard' }); release(); await started; await settle(20);
  assert.equal(cpKeys(h).length, 0);
});

test('a start that does not resume purges whatever was stored', async () => {
  const h = await interviewing(); await h.s.suspend();
  assert.ok(cpKeys(h).length);
  const r = again(h); await opened(r);
  assert.ok(!errorsOf(r).length);
  const old = sessionIdOf(h), now = sessionIdOf(r);
  assert.notEqual(old, now);
  assert.ok(!cpKeys(r).some(k => k.includes(old)), 'the old interview is gone');
  // the old id cannot be resumed any more
  const late = again(h); await late.s.onText(startMsg({ resume: old })); await settle(20);
  assert.deepEqual(errorsOf(late).map(e => e.message), [RESUME_UNAVAILABLE]);
});

test('the alarm purges a stored interview after 24 hours (fake clock); until then it can be resumed', async () => {
  const h = await interviewing(); await h.s.suspend();
  const store = new CheckpointStore(h.storage, { now: () => h.clk.t * 1000 }), alarm = h.storage.alarm;
  h.advance(23 * 3600);
  assert.equal(await store.expire(), false); assert.equal(h.storage.alarm, alarm); assert.ok(cpKeys(h).length, 'not yet');
  const ok = await resumed(h); assert.ok(!errorsOf(ok).length, 'resumable at 23 hours'); await ok.s.suspend();
  const alarm2 = h.storage.alarm; assert.ok(alarm2 > alarm, 'a new suspension starts a new 24 hours');
  h.advance(24 * 3600 + 1);
  assert.equal(await store.expire(), true, 'the alarm handler purges');
  assert.equal(cpKeys(h).length, 0); assert.equal(h.storage.alarm, null);
  const late = again(h); await late.s.onText(startMsg({ resume: sessionIdOf(h) })); await settle(20);
  assert.deepEqual(errorsOf(late).map(e => e.message), [RESUME_UNAVAILABLE], 'gone');
});

test('an interview past 24 hours is refused even if the alarm has not run yet, and is purged by the attempt', async () => {
  const h = await interviewing(); await h.s.suspend();
  h.advance(24 * 3600 + 5);
  const r = again(h); await r.s.onText(startMsg({ resume: sessionIdOf(h) })); await settle(20);
  assert.deepEqual(errorsOf(r).map(e => e.message), [RESUME_UNAVAILABLE]); assert.equal(cpKeys(h).length, 0);
});

test('gap mode (a proof request) is never checkpointed and a resume of it is refused cleanly', async () => {
  const GAP = 'ab'.repeat(16), RESOLVED = { asks: [{ id: 'G1', field: 'evidence', label: 'x', ask: 'Proof the bid needs: a report' }], bidAlias: 'bid', referenceId: 'r', projectId: 'p' };
  const g = rig({ session: { gaps: async () => RESOLVED } });
  await g.s.onText(startMsg({ gap: GAP })); await until(() => !g.s.busy() && g.bytes.length > 0);
  assert.equal(g.s.mode, 'gap'); assert.ok(!('sessionId' in g.events.find(e => e.type === 'ready')) && g.s.checkpointable() === false);
  g.s.checkpointSoon(); await settle(50); await g.s.suspend();
  assert.equal(g.storage.keys().length, 0, 'gap interviews write nothing');
  assert.ok(g.events.some(e => e.type === 'ended'), 'and end as before');
  // a stored FULL interview, then a start that names both a gap and the stored interview
  const h = await interviewing(); await h.s.suspend(); const keys = cpKeys(h).length;
  let resolved = 0; const r = again(h, { session: { gaps: async () => { resolved += 1; return RESOLVED; } } });
  await r.s.onText(startMsg({ gap: GAP, resume: sessionIdOf(h) })); await settle(20);
  assert.deepEqual(errorsOf(r).map(e => [e.code, e.message]), [['resume-unavailable', RESUME_UNAVAILABLE]]);
  assert.equal(resolved, 0, 'the request was not even looked up'); assert.equal(cpKeys(h).length, keys, 'and the stored interview is untouched');
});

test('another person cannot read it: storage is per Durable Object, and a resume needs the same identity', async () => {
  const alice = await interviewing(); await alice.s.suspend(); const id = sessionIdOf(alice);
  // 1. another person has another Durable Object, hence other storage: nothing there to resume
  const bob = rig({ storage: new FakeStorage(), owner: 'bob@example.com' }); await bob.s.onText(startMsg({ resume: id })); await settle(20);
  assert.deepEqual(errorsOf(bob).map(e => e.message), [RESUME_UNAVAILABLE]);
  // 2. even if the very same storage were reached under another identity (a misrouted request), the owner recorded with it must match
  const mallory = rig({ storage: alice.storage, clk: alice.clk, owner: 'mallory@example.com' }); await mallory.s.onText(startMsg({ resume: id })); await settle(20);
  assert.deepEqual(errorsOf(mallory).map(e => e.message), [RESUME_UNAVAILABLE]); assert.ok(!mallory.events.some(e => e.type === 'ready' || e.type === 'restore'));
  assert.equal(mallory.calls.stt + mallory.calls.talker.length, 0);
  assert.equal(await new CheckpointStore(alice.storage, { owner: 'mallory@example.com', now: () => alice.clk.t * 1000 }).info(), null);
  assert.ok(cpKeys(alice).length, 'and the attempt deleted nothing');
  // 3. only the owner's identity reads it
  const me = await resumed(alice); assert.ok(!errorsOf(me).length && me.events.some(e => e.type === 'restore'));
});

test('the newest window still wins: the older session is failed, kept, and the newer window can resume it', async () => {
  const old = await interviewing(); await written(old);
  // worker.js: a new connection arrives while the older session is live
  await old.s.fail('This interview continued in another window. Nothing was approved.', 'voice-contract');
  assert.ok(old.s.finished); assert.deepEqual(errorsOf(old).map(e => e.code), ['voice-contract']);
  assert.ok(cpKeys(old).length, 'kept, not lost: the newer window is the same person');
  const win = await resumed(old); assert.ok(!errorsOf(win).length && screen(win).includes(QUESTION));
  // the same newer-window rule without a resume: the older one is gone and the new start deletes what it left
  const older = await interviewing(); await older.s.fail('This interview continued in another window.', 'voice-contract');
  const fresh = again(older); await opened(fresh); assert.ok(!cpKeys(fresh).some(k => k.includes(sessionIdOf(older))));
});

test('suspend keeps what the consultant said in the last moments: the utterance still being transcribed is in the stored ledger', async () => {
  const h = rig({ said: [ANSWER, ANSWER2], talk: n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', QUESTION] });
  await opened(h); talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy()); h.s.playedMs[h.s.currentItem] = 1e9;
  let release; h.s.ai.transcribe = async () => { await new Promise(r => { release = r; }); return ANSWER2; };
  talked(h); await until(() => !!release && h.s.sttBusy > 0);
  const closing = h.s.suspend(); release(); await closing;
  const stored = await h.store.load(sessionIdOf(h));
  assert.ok(stored.ledger.transcripts.some(([, t]) => t === ANSWER2), 'the last words are kept');
  assert.equal(h.calls.talker.length, 2, 'and nobody replied to a closed socket');
});

test('writes are debounced and never concurrent; a failed write never stops the interview', async () => {
  const h = rig({ talk: n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', QUESTION], said: [ANSWER] });
  let inflight = 0, peak = 0, saves = 0; const real = h.store.save.bind(h.store);
  h.store.save = async doc => { inflight += 1; peak = Math.max(peak, inflight); saves += 1; await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); try { return await real(doc); } finally { inflight -= 1; } };
  await opened(h); talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy()); await written(h);
  for (let i = 0; i < 20; i++) h.s.checkpointSoon(); await settle(100);
  assert.equal(peak, 1, 'one write at a time'); assert.ok(saves >= 1 && saves <= 6, 'coalesced: ' + saves);
  assert.ok(CHECKPOINT_DEBOUNCE_MS > 0);
  h.store.save = async () => { throw new Error('storage unavailable'); };
  h.s.checkpointSoon(); await settle(100);
  assert.ok(named(h.metrics, 'checkpoint_error').length >= 1); assert.ok(!h.s.finished && !errorsOf(h).length, 'the interview goes on');
  assert.ok(named(h.metrics, 'checkpoint').length >= 1 && Object.keys(named(h.metrics, 'checkpoint')[0]).sort().join() === 'bytes,chunks,ms', 'numbers only');
});

test('a checkpoint is written after the committed turn, with the question and the ledger in it', async () => {
  const h = await interviewing(); await written(h);
  const stored = await h.store.load(sessionIdOf(h));
  assert.equal(stored.lastQuestion.text, QUESTION); assert.equal(stored.counters.turns, 1); assert.equal(stored.ledger.transcripts.length, 1);
  assert.ok(stored.ledger.details.length >= 1);
});

test('paused: the interview comes back paused, says nothing until Resume, and the time away is not interview time', async () => {
  const h = await interviewing();
  await send(h, { type: 'pause' }); await until(() => !h.s.busy()); await h.s.suspend();
  const active = h.s.activeSeconds(); h.advance(3 * 3600);
  const r = await resumed(h);
  assert.ok(!errorsOf(r).length); assert.equal(r.s.paused, true); assert.equal(r.s.machine.state, 'paused');
  assert.ok(r.events.some(e => e.type === 'state' && e.state === 'paused' && e.paused === true));
  assert.equal(r.bytes.length, 0, 'nothing is said while paused'); assert.equal(r.calls.talker.length, 0);
  assert.ok(Math.abs(r.s.activeSeconds() - active) < 1, 'the three hours are not interview time');
  const wall = r.clk.t - r.s.startedAt; assert.ok(wall < 600, 'nor wall-cap time: ' + wall);
  const talker = r.calls.talker.length;
  await send(r, { type: 'resume' }); await until(() => !r.s.busy() && screen(r).includes(QUESTION));
  assert.equal(r.calls.talker.length, talker, 'the question again, no model call'); assert.equal(r.s.paused, false);
  assert.ok(RESUME_LINES.en.some(l => screen(r).includes(l)));
});

test('the 45-minute wall cap and the 15-minute limit keep counting from the interview, not from the reconnect', async () => {
  const h = await interviewing({ session: { maxSeconds: 100 } });
  h.advance(60); h.s.lastInput = h.clk.t; await h.s.suspend();
  const used = h.s.activeSeconds();
  h.advance(5 * 3600);
  const r = await resumed(h, { session: { maxSeconds: 100 } });
  assert.ok(Math.abs(r.s.activeSeconds() - used) < 1, 'the five hours away are not interview time');
  r.s.lastInput = r.clk.t; r.advance(30); r.s.lastInput = r.clk.t; r.s.watch();
  assert.ok(!r.events.some(e => e.type === 'time_up'), '90 s of 100 used');
  r.advance(15); r.s.lastInput = r.clk.t; r.s.watch();
  assert.ok(r.events.some(e => e.type === 'time_up'), 'the limit still applies across the drop');
});

test('a second drop of a resumed interview is resumable again, with the same id', async () => {
  const h = await interviewing(); await h.s.suspend();
  const r = await resumed(h); await r.s.suspend();
  const r2 = await resumed(r);
  assert.ok(!errorsOf(r2).length); assert.equal(sessionIdOf(r2), sessionIdOf(h)); assert.ok(screen(r2).includes(QUESTION));
  assert.deepEqual(r2.s.machine.audit.map(a => a.event).filter(e => ['disconnect', 'reconnect'].includes(e)), ['disconnect', 'reconnect', 'disconnect', 'reconnect']);
});

test('without a checkpoint store everything is as before: a dropped socket ends the session, no resume', async () => {
  const h = rig({ store: false }); await opened(h); await h.s.suspend();
  assert.ok(h.s.finished && h.events.some(e => e.type === 'audio_stopped') && h.events.some(e => e.type === 'ended'));
  assert.equal(h.storage.keys().length, 0);
});

test('a refused resume ends the socket without a model call, a transcript or a state change', async () => {
  const h = await interviewing(); await h.s.suspend();
  const r = again(h); await r.s.onText(startMsg({ resume: 'c'.repeat(32) })); await settle(20);
  assert.ok(r.s.finished && !r.s.started); assert.equal(r.calls.talker.length + r.calls.stt + r.calls.analyst, 0); assert.equal(r.bytes.length, 0);
});
