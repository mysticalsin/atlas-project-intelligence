// Sentinel loop 2 on the read-back slice. One test per finding. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Analyst, InterviewLedger, buildMessages } from '../src/ledger.js';
import { buildSummary } from '../src/summary.js';
import { Session, talkerMessages } from '../src/session.js';
import { reportMessages } from '../src/report.js';
import { CheckpointStore } from '../src/checkpoint.js';

const SECRET = 'forty two percent for the synthetic cohort';
const UTTERANCE = 'forty two percent for the synthetic cohort over the pilot window';
const OTHER = 'over the pilot window';

function secret(value) {
  return JSON.stringify(value).includes('forty two');
}

test('M-1 a withheld utterance stays out of a second detail, a later record, and an in-flight analyst result', async () => {
  const ledger = new InterviewLedger('Pilot');
  ledger.addTranscript('u1', UTTERANCE);
  ledger.record({ details: [
    { field: 'outcome', item_id: 'u1', quote: SECRET },
    { field: 'contribution', item_id: 'u1', quote: OTHER },
  ] });
  ledger.withhold('D-001');
  assert.equal(ledger.details.every(d => d.item_id !== 'u1' || d.withheld === true), true);
  assert.equal(secret(ledger.notes()), false);
  assert.equal(secret(ledger.publicTranscript()), false);
  assert.equal(secret(buildSummary(ledger)), false);
  assert.equal(secret(ledger.inspect().candidate_details), false);
  assert.equal(secret(buildMessages(ledger, 'u1')), false);
  assert.throws(
    () => ledger.record({ details: [{ field: 'problem', item_id: 'u1', quote: SECRET }] }),
    /private/,
  );

  let release;
  const analyst = new Analyst(() => new Promise(resolve => { release = resolve; }));
  analyst.ledger.addTranscript('u1', UTTERANCE);
  analyst.ledger.record({ details: [{ field: 'outcome', item_id: 'u1', quote: SECRET }] });
  const pending = analyst.hear('u1', UTTERANCE);
  await new Promise(resolve => setImmediate(resolve));
  analyst.ledger.withhold('D-001');
  release([{ id: 'c-race', name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'contribution', item_id: 'u1', quote: OTHER }] }) }]);
  const result = await pending;
  assert.equal(secret(result), false);
  assert.equal(secret(analyst.ledger.notes()), false);
  assert.equal(secret(buildSummary(analyst.ledger)), false);
  assert.equal(analyst.ledger.details.some(d => d.item_id === 'u1' && d.withheld !== true && d.active), false);
});

test('M-2 withhold is reachable and erases the utterance from every session sink', async () => {
  const story = fs.readFileSync(new URL('../../../src/storyboard-ui.js', import.meta.url), 'utf8');
  const voice = fs.readFileSync(new URL('../../../src/voice-client.js', import.meta.url), 'utf8');
  assert.match(story, /dataset\.action='withhold'/);
  assert.match(voice, /type:'withhold'/);

  const ledger = new InterviewLedger('Pilot');
  ledger.addTranscript('u1', UTTERANCE);
  ledger.call('c1', 'record_details', { details: [{ field: 'outcome', item_id: 'u1', quote: SECRET }] });
  const events = [];
  const s = new Session({
    io: { send: e => events.push(e), sendBytes() {}, close() {} },
    ai: { async transcribe() { return ''; }, async synthesize() { return new Uint8Array(); }, async *chatStream() {} },
    csrf: 'tok', voice: 'asteria', now: () => 1000, sleep: async () => {},
  });
  s.started = true;
  s.capture = true;
  s.ledger = ledger;
  s.project = { title: 'Synthetic pilot' };
  s.history = [{ role: 'user', content: UTTERANCE }];
  s.mode = 'gap';
  s.gapAsks = [{ id: 'ask1', field: 'outcome', label: 'Outcome', ask: 'What changed?' }];
  s.gapAnswers = { ask1: [[UTTERANCE]] };
  s.gapAttempts = { ask1: 1 };
  await s.onText(JSON.stringify({ type: 'withhold', detail_id: 'D-001' }));

  assert.equal(secret([...ledger.transcripts.values()]), false);
  assert.equal(secret(ledger.details.map(d => d.quote)), false);
  assert.equal(secret([...ledger.callInputs.values()]), false);
  assert.equal(secret([...ledger.calls.values()]), false);
  assert.equal(secret(ledger.inspect()), false);
  assert.equal(secret(s.history), false);
  assert.equal(secret(s.gapAnswers), false);
  assert.equal(secret(s.gapStatuses()), false);
  assert.equal(secret(s.gapResults()), false);
  assert.equal(secret(talkerMessages(s.project, s.guidance, s.history, '')), false);
  assert.equal(secret(reportMessages(s.history, ledger.notes(), ledger.stage)), false);
  assert.equal(events.some(e => e.type === 'error'), false);
});

test('L-1 a live session writes the checkpoint id and nothing else', async () => {
  const src = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(src, /new CheckpointStore\(/);
  const mem = new Map();
  const storage = { async get(k) { return mem.get(k); }, async put(k, v) { mem.set(k, v); } };
  const s = new Session({
    io: { send() {}, sendBytes() {}, close() {} },
    ai: { async transcribe() { return ''; }, async synthesize() { return new Uint8Array(480); }, async *chatStream() { yield 'Hello.'; } },
    csrf: 'tok', voice: 'asteria', checkpoint: new CheckpointStore(storage), now: () => 1000, sleep: async () => {},
  });
  try {
    await s.onText(JSON.stringify({ type: 'start', csrf: 'tok', consent: true, capture: true, project: { title: 'Synthetic pilot', stage: 'Pilot', answers: [] } }));
    assert.match(String(mem.get('cp:current') || ''), /^[a-f0-9]{32}$/);
    assert.equal(JSON.stringify([...mem.values()]).includes('forty two'), false);
    assert.equal([...mem.keys()].every(k => k === 'cp:current'), true);
  } finally {
    await s.end(false);
  }
});
