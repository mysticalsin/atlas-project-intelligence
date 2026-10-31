// Agent Brain v2.1 T10: checkpoint.js on its own. serialize/restore round trip (ledger, history, machine, asked log, speech-recognition doubt, pause
// clock), chunks of at most 100 KiB even for a large transcript, a version or a tampered state refused without touching the session, and the store
// (owner, expiry, purge, the alarm). The Session-level behaviour (suspend, resume, discard) is in session-reconnect.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InterviewLedger } from '../src/ledger.js';
import { Machine } from '../src/conversation-state.js';
import { serialize, restore, restoreView, split, CheckpointStore, CheckpointError, checkpointRoutes, checkpointEnabled, VERSION, CHUNK_BYTES, TTL_MS } from '../src/checkpoint.js';
import { FakeStorage, clock, rig, interviewing, talked, until, cleanup, QUESTION, USER, send } from './reconnect-harness.js';

test.afterEach(cleanup);
const words = spec => spec.split(' ').map((t, i) => { const [w, c] = t.split(':'); return { w, c: c ? Number(c) : 0.95, s: Math.round(i * 400) / 1000, e: Math.round(i * 400 + 350) / 1000 }; });
const heard = (spec, text = spec.replace(/:[0-9.]+/g, '')) => ({ text, language: 'en', words: words(spec) });
const SPEC2 = 'The median handling time dropped from fourteen:0.3 minutes to nine minutes after the pilot measured over six weeks across the claims team';

// A second turn that carries an uncertain number, a paused-and-resumed stretch, and a typed turn: every kind of state the checkpoint keeps.
async function populated() {
  const h = await interviewing({ said: [heard(SPEC2)] });
  talked(h); await until(() => h.calls.talker.length === 3 && !h.s.busy());
  await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  h.advance(30);
  await send(h, { type: 'resume' }); await until(() => !h.s.busy());
  h.advance(5);
  return h;
}
// A Session that has not started, with an empty ledger: what start() builds before it calls restore().
function blank(clk) {
  const h = rig({ clk, store: false }); h.s.ledger = new InterviewLedger('Pilot'); return h.s;
}
const ledgerState = L => ({ transcripts: [...L.transcripts], details: L.details, probes: L.probes, deferred: L.deferred, updates: L.updates, stage: L.stage, inspect: L.inspect() });

test('round trip: ledger, history, machine, asked log, asr meta and the pause clock come back equal', async () => {
  const h = await populated(), a = h.s;
  assert.ok(a.ledger.transcripts.size >= 2 && a.ledger.details.length >= 2 && a.humane.asked.length >= 2, 'a real interview to keep');
  assert.ok(Object.values(a.asrMeta).some(m => m.spans.length), 'with speech-recognition doubt in it');
  assert.equal(a.pauseCount, 1); assert.equal(a.resumeCount, 1); assert.ok(a.pausedTotal >= 30);
  const doc = JSON.parse(JSON.stringify(serialize(a))); // through JSON, as the store does
  assert.equal(doc.version, VERSION); assert.equal(doc.sessionId, a.sessionId);
  const clk = clock(h.clk.t + 7200), b = blank(clk), info = restore(b, doc); // two hours later
  assert.equal(info.from, 'discovery');
  assert.deepEqual(ledgerState(b.ledger), ledgerState(a.ledger), 'ledger: transcripts, details, probes, deferred, updates and the plan it computes');
  assert.deepEqual(b.history, a.history.slice(-40)); assert.deepEqual(b.humane.asked, a.humane.asked);
  assert.deepEqual([...b.humane.covered], [...a.humane.covered]); assert.deepEqual({ ...b.humane, covered: 0 }, { ...a.humane, covered: 0 });
  assert.deepEqual(b.asrMeta, a.asrMeta); assert.deepEqual(b.asrIdents, a.asrIdents); assert.deepEqual(b.asrDone, a.asrDone); assert.deepEqual(b.asrCorrections, a.asrCorrections);
  assert.equal(b.lastQuestion.text, a.lastQuestion.text); assert.equal(b.lastQuestion.turn, a.lastQuestion.turn);
  assert.ok(b.humane.asked.includes(b.lastQuestion.move), 'its move is the one in the asked log (found by identity again)');
  // the machine: the same audit trail plus the loss of the connection, suspended until `reconnect`
  const m = b.machine.toDict(); assert.equal(m.state, 'suspended');
  assert.deepEqual(m.audit.slice(0, a.machine.audit.length), a.machine.audit);
  assert.deepEqual(m.audit.at(-1).event, 'disconnect');
  b.machine.fire('reconnect', 'system'); assert.equal(b.machine.state, a.machine.state);
  // the pause clock: the two hours down are neither interview time nor wall time
  assert.equal(b.pausedTotal, a.pausedTotal); assert.equal(b.pauseCount, 1); assert.equal(b.resumeCount, 1); assert.equal(b.paused, false);
  assert.ok(Math.abs(b.activeSeconds() - a.activeSeconds()) < 0.001, `${b.activeSeconds()} vs ${a.activeSeconds()}`);
  assert.ok(Math.abs((clk.t - b.startedAt) - (h.clk.t - a.startedAt)) < 0.001);
  assert.equal(b.turns, a.turns); assert.equal(b.replies, a.replies); assert.equal(b.spokenMs, a.spokenMs); assert.equal(b.identNow, a.identNow);
  assert.equal(b.language, a.language); assert.deepEqual(b.project, a.project); assert.deepEqual(b.prefill, a.prefill);
});

test('a paused interview comes back paused: the paused stretch in progress is kept as a duration', async () => {
  const h = await interviewing();
  await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  h.advance(40);
  const doc = serialize(h.s), clk = clock(h.clk.t + 3600), b = blank(clk); restore(b, doc);
  assert.equal(b.paused, true); assert.ok(Math.abs((clk.t - b.pausedAt) - 40) < 0.001);
  assert.ok(Math.abs(b.activeSeconds() - h.s.activeSeconds()) < 0.001);
  assert.equal(b.machine.returns.at(-1), 'paused');
});

test('the checkpoint is a copy: later changes to the session never alter it', async () => {
  const h = await interviewing(), doc = serialize(h.s), before = JSON.stringify(doc);
  h.s.history.push({ role: 'user', content: 'later' }); h.s.humane.asked.push({ kind: 'ask' }); h.s.ledger.details[0].quote = 'changed'; h.s.humane.covered.add('x');
  assert.equal(JSON.stringify(doc), before);
});

test('history is kept to its last 40 entries', async () => {
  const h = await interviewing();
  for (let i = 0; i < 60; i++) h.s.history.push({ role: i % 2 ? 'assistant' : 'user', content: 'entry ' + i });
  const doc = serialize(h.s); assert.equal(doc.history.length, 40); assert.equal(doc.history.at(-1).content, 'entry 59');
});

test('a version mismatch is refused, and the session is left exactly as it was', async () => {
  const h = await interviewing(), doc = JSON.parse(JSON.stringify(serialize(h.s))), b = blank(clock());
  const snapshot = JSON.stringify([b.turns, b.history, b.humane.asked, [...b.ledger.transcripts], b.machine.state, b.sessionId]);
  for (const version of [VERSION + 1, 0, '1', undefined, null]) {
    assert.throws(() => restore(b, { ...doc, version }), e => e instanceof CheckpointError && e.code === 'version_mismatch', String(version));
  }
  assert.throws(() => restore(b, { ...doc, machine: { ...doc.machine, workflow_version: 'other' } }), e => e.code === 'version_mismatch', 'another workflow version is not guessed at');
  assert.equal(JSON.stringify([b.turns, b.history, b.humane.asked, [...b.ledger.transcripts], b.machine.state, b.sessionId]), snapshot);
});

test('a tampered, truncated or inconsistent checkpoint is corrupt and changes nothing', async () => {
  const h = await populated(), doc = JSON.parse(JSON.stringify(serialize(h.s))), b = blank(clock());
  const clone = () => JSON.parse(JSON.stringify(doc));
  const cases = {
    'not an object': null, 'no machine': { ...clone(), machine: null }, 'machine state edited': { ...clone(), machine: { ...clone().machine, state: 'summary_confirmed' } },
    'audit truncated': (() => { const d = clone(); d.machine.audit.pop(); return d; })(), 'gap mode': { ...clone(), mode: 'gap' }, 'session id': { ...clone(), sessionId: 'nope' },
    'history entry': { ...clone(), history: [{ role: 'system', content: 'x' }] }, 'history too long': { ...clone(), history: Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' })) },
    'ledger missing': { ...clone(), ledger: null }, 'detail without quote': (() => { const d = clone(); delete d.ledger.details[0].quote; return d; })(),
    'pause flag disagrees with the machine': (() => { const d = clone(); d.clock.paused = true; return d; })(),
    'last question points outside the log': (() => { const d = clone(); d.lastQuestion.moveAt = 999; return d; })(),
    'clock not a number': (() => { const d = clone(); d.clock.wall = 'x'; return d; })(),
  };
  for (const [name, bad] of Object.entries(cases)) {
    assert.throws(() => restore(b, bad), e => e instanceof CheckpointError && ['corrupt', 'version_mismatch'].includes(e.code), name);
    assert.equal(b.turns, 0, name); assert.equal(b.history.length, 0, name); assert.equal(b.ledger.transcripts.size, 0, name); assert.equal(b.sessionId, null, name);
  }
  const done = new Machine('interview'); for (const [e, a] of [['start', 'atlas'], ['consent_given', 'user'], ['withdraw', 'user']]) done.fire(e, a, e === 'withdraw' ? { reason: 'x' } : {});
  assert.throws(() => restore(b, { ...clone(), machine: done.toDict() }), e => e.code === 'corrupt', 'an interview that had already ended is not resumable');
});

test('a checkpoint taken while the connection was still up (a crash) is moved to suspended by a system disconnect', async () => {
  const h = await interviewing(), doc = serialize(h.s);
  assert.equal(doc.machine.state, 'discovery');
  const b = blank(clock(h.clk.t + 5)); restore(b, doc);
  assert.equal(b.machine.state, 'suspended'); assert.equal(b.machine.audit.at(-1).actor, 'system');
});

test('chunks: a large transcript is stored in pieces of at most 100 KiB and read back whole', async () => {
  const h = await interviewing();
  // about 100 000 characters of transcript (the ledger budget) in multi-byte text, and 40 long replies: far more than one chunk
  const long = 'Décision clé: nous avons réduit le délai de traitement des sinistres — ' + 'résultat mesuré sur six semaines. '.repeat(5);
  let i = 0; while ([...h.s.ledger.transcripts.values()].reduce((n, t) => n + t.length, 0) + long.length < 99000 && i < 170) h.s.ledger.addTranscript('user-big-' + i++, long + i);
  for (let n = 0; n < 40; n++) h.s.history.push({ role: n % 2 ? 'assistant' : 'user', content: ('Réponse très longue numéro ' + n + '. ').repeat(300) });
  const doc = serialize(h.s), json = JSON.stringify(doc), bytes = new TextEncoder().encode(json).length;
  assert.ok(bytes > 3 * CHUNK_BYTES, 'a checkpoint of ' + bytes + ' bytes');
  const storage = new FakeStorage(), store = new CheckpointStore(storage, { owner: USER, now: () => 1e12 });
  const r = await store.save(doc);
  assert.ok(r.chunks >= 4 && r.bytes === bytes);
  const chunks = storage.keys().filter(k => /^cp:[a-f0-9]{32}:\d+$/.test(k));
  assert.equal(chunks.length, r.chunks);
  for (const k of chunks) assert.ok((await storage.get(k)).length <= CHUNK_BYTES, k + ' is over 100 KiB');
  assert.ok(storage.keys().includes(`cp:${doc.sessionId}:meta`) && storage.keys().includes('cp:current'));
  assert.deepEqual(await store.load(doc.sessionId), JSON.parse(json), 'the same document, whole');
  assert.equal(storage.puts.length, 1, 'chunks and meta in ONE put: all or nothing');
  // a shorter write later leaves no stale chunk behind
  await store.save({ ...doc, history: doc.history.slice(-2), ledger: { ...doc.ledger, transcripts: doc.ledger.transcripts.slice(0, 2) } });
  assert.ok(storage.keys().filter(k => /:\d+$/.test(k)).length < chunks.length);
  assert.equal((await store.load(doc.sessionId)).history.length, 2);
});

test('split: exact sizes, nothing lost, an empty document still has one chunk', () => {
  const b = Uint8Array.from({ length: 250000 }, (_, i) => i % 251), parts = split(b);
  assert.deepEqual(parts.map(p => p.length), [CHUNK_BYTES, CHUNK_BYTES, 250000 - 2 * CHUNK_BYTES]);
  const joined = new Uint8Array(250000); let at = 0; for (const p of parts) { joined.set(p, at); at += p.length; }
  assert.deepEqual(joined, b);
  assert.equal(split(new Uint8Array(0)).length, 1);
});

test('the store: owner, expiry after 24 hours, purge and the alarm', async () => {
  const h = await interviewing(), doc = serialize(h.s), storage = new FakeStorage(); let t = 5e12;
  const mine = new CheckpointStore(storage, { owner: USER, now: () => t }), theirs = new CheckpointStore(storage, { owner: 'someone@else.example', now: () => t });
  assert.equal(await mine.info(), null, 'nothing stored yet');
  await mine.save(doc);
  assert.equal(storage.alarm, t + TTL_MS, 'the purge alarm is armed for 24 hours');
  assert.deepEqual(await mine.info(), { sessionId: doc.sessionId, savedAt: t, expiresAt: t + TTL_MS, input: 'voice' });
  assert.equal(JSON.stringify(await mine.info()).includes(doc.history[0].content), false, 'never any content');
  assert.equal(await theirs.info(), null, 'another identity sees nothing');
  await assert.rejects(theirs.load(doc.sessionId), e => e.code === 'missing', 'and cannot read it, with the right id');
  await assert.rejects(mine.load('f'.repeat(32)), e => e.code === 'missing');
  assert.equal((await mine.load(doc.sessionId)).sessionId, doc.sessionId);
  t += TTL_MS - 1000; assert.equal(await mine.expire(), false, 'not yet'); assert.equal(storage.alarm, 5e12 + TTL_MS, 'the alarm stays armed');
  assert.ok(await mine.info());
  t += 1000;
  assert.equal(await mine.info(), null, 'expired: nothing offered'); assert.equal(storage.keys().length, 0, 'and purged on the way');
  await mine.save(doc); t += TTL_MS + 5; assert.equal(await mine.expire(), true, 'the alarm purges it'); assert.equal(storage.keys().length, 0); assert.equal(storage.alarm, null);
  await mine.save(doc); assert.ok(await mine.purge() >= 3); assert.equal(storage.keys().length, 0); assert.equal(storage.alarm, null);
  assert.equal(await mine.purge(), 0, 'purging nothing is fine');
});

test('a missing chunk or a changed version in storage is refused', async () => {
  const h = await interviewing(), doc = serialize(h.s), storage = new FakeStorage(), store = new CheckpointStore(storage, { owner: USER, now: () => 1e12 });
  await store.save(doc);
  const meta = await storage.get(`cp:${doc.sessionId}:meta`);
  await storage.delete(`cp:${doc.sessionId}:0`);
  await assert.rejects(store.load(doc.sessionId), e => e.code === 'corrupt');
  await storage.put({ [`cp:${doc.sessionId}:meta`]: { ...meta, version: 99 } });
  await assert.rejects(store.load(doc.sessionId), e => e.code === 'version_mismatch');
  assert.equal(await store.info(), null, 'a checkpoint of another format is not offered');
});

test('checkpoint routes: GET says whether one exists, POST discard deletes only the caller\'s own', async () => {
  const h = await interviewing(), doc = serialize(h.s), storage = new FakeStorage(), now = () => 1e12;
  await new CheckpointStore(storage, { owner: USER, now }).save(doc);
  const call = (method, path, user) => checkpointRoutes(new Request('https://x.example' + path, { method, headers: user === undefined ? {} : { 'x-atlas-user': user } }), { storage, now });
  assert.equal((await call('GET', '/api/checkpoint')).status, 401, 'no verified identity: nothing');
  assert.deepEqual(await (await call('GET', '/api/checkpoint', 'x@y.example')).json(), { resumable: null });
  const own = await (await call('GET', '/api/checkpoint', USER)).json(); assert.deepEqual(Object.keys(own.resumable).sort(), ['expiresAt', 'input', 'savedAt', 'sessionId']);
  assert.deepEqual(await (await call('POST', '/api/checkpoint/discard', 'x@y.example')).json(), { discarded: false }); assert.ok(storage.keys().length, 'someone else cannot delete it');
  assert.deepEqual(await (await call('POST', '/api/checkpoint/discard', USER)).json(), { discarded: true }); assert.equal(storage.keys().length, 0);
  assert.equal((await call('GET', '/api/other', USER)).status, 404);
});

test('restoreView carries what the browser needs and nothing the screens cannot show', async () => {
  const h = await populated(), v = restoreView(h.s);
  assert.deepEqual(v.user.map(u => u.item_id), [...h.s.ledger.transcripts.keys()]);
  assert.ok(v.user.every(u => u.provenance === 'unverified_speech_recognition'));
  assert.ok(v.agent.length >= 2 && v.agent.every(t => typeof t === 'string'));
  assert.equal(v.lastQuestion, h.s.lastQuestion.text); assert.equal(v.lastQuestion, QUESTION); assert.equal(v.state, 'discovery'); assert.equal(v.paused, false);
  assert.equal(v.quality.analyst_status, 'restored'); assert.ok(Array.isArray(v.quality.candidate_details));
  assert.ok(v.activeSeconds > 0 && v.turns === 2);
  assert.ok(!('csrf' in v) && !JSON.stringify(v).includes('tok'));
});

test('ATLAS_CHECKPOINT=off is the rollback switch; anything else keeps checkpoints on', () => {
  assert.equal(checkpointEnabled({}), true); assert.equal(checkpointEnabled(undefined), true); assert.equal(checkpointEnabled({ ATLAS_CHECKPOINT: 'on' }), true);
  assert.equal(checkpointEnabled({ ATLAS_CHECKPOINT: 'OFF' }), false); assert.equal(checkpointEnabled({ ATLAS_CHECKPOINT: 'maybe' }), true);
});

test('serialize needs no model, no network and no browser: only the session', async () => {
  const h = await interviewing(), calls = h.calls.talker.length + h.calls.analyst;
  serialize(h.s); restore(blank(clock()), serialize(h.s)); restoreView(h.s);
  assert.equal(h.calls.talker.length + h.calls.analyst, calls);
});
