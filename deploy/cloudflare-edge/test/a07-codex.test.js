// Codex findings on PR #1 that are absent from main. These fail until the port
// keeps a withheld utterance private, lists every read-back detail, and refuses
// a replaced interview's checkpoint write. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { InterviewLedger, buildMessages } from '../src/ledger.js';
import { Session } from '../src/session.js';

const SECRET = 'forty two percent for the synthetic cohort';
const SECRET_UTTERANCE = 'forty two percent for the synthetic cohort over the pilot window';
const CORRECTION = 'thirty percent for the synthetic cohort';
const CORRECTION_UTTERANCE = 'thirty percent for the synthetic cohort over the pilot window';

function supersedeAfterWithhold() {
  const ledger = new InterviewLedger('Pilot');
  ledger.addTranscript('u1', SECRET_UTTERANCE);
  ledger.record({ details: [{ field: 'outcome', item_id: 'u1', quote: SECRET }] });
  ledger.withhold('D-001');
  ledger.addTranscript('u2', CORRECTION_UTTERANCE);
  ledger.record({ details: [{ field: 'outcome', item_id: 'u2', quote: CORRECTION, supersedes: 'D-001' }] });
  return ledger;
}

test('a withheld detail stays out of notes and the analyst context after it is superseded', () => {
  const ledger = supersedeAfterWithhold();
  const old = ledger.details.find(d => d.id === 'D-001');
  assert.equal(old.active, false);
  assert.equal(old.withheld, true);
  const notes = ledger.notes().join('\n');
  assert.equal(notes.includes('forty two'), false);
  assert.ok(notes.includes('thirty percent'));
  assert.equal(ledger.publicTranscript().includes('forty two'), false);
  assert.ok(ledger.publicTranscript().includes('thirty percent'));
  const blob = JSON.stringify(buildMessages(ledger, 'u2'));
  assert.equal(blob.includes('forty two'), false);
  assert.ok(blob.includes('thirty percent'));
});

test('inspect withholds an active detail that was marked private', () => {
  const ledger = new InterviewLedger('Pilot');
  ledger.addTranscript('u1', SECRET_UTTERANCE);
  ledger.record({ details: [{ field: 'outcome', item_id: 'u1', quote: SECRET }] });
  const row = ledger.details.find(d => d.id === 'D-001');
  assert.equal(row.active, true);
  row.withheld = true;
  const seen = ledger.inspect();
  assert.equal(seen.candidate_details.some(d => d.id === 'D-001' || String(d.quote).includes('forty two')), false);
  assert.equal(ledger.publicTranscript().includes('forty two'), false);
  assert.equal(ledger.transcripts.get('u1'), '[withheld]');
});

test('session notes and the read-back omit a withheld utterance after supersession', async () => {
  const events = [];
  const s = new Session({
    io: { send: e => events.push(e), sendBytes() {}, close() {} },
    ai: { async transcribe() { return ''; }, async synthesize() { return new Uint8Array(); }, async *chatStream() {} },
    csrf: 'tok', voice: 'asteria', model: 'test-talker', now: () => 1000, sleep: async () => {},
  });
  s.capture = true;
  s.ledger = supersedeAfterWithhold();
  await s.end(true);
  const notes = events.find(e => e.type === 'notes');
  assert.ok(notes);
  assert.equal(notes.transcript.includes('forty two'), false);
  assert.ok(notes.transcript.includes('thirty percent'));
  const summary = events.find(e => e.type === 'summary');
  assert.ok(summary && Array.isArray(summary.items));
  assert.equal(summary.items.some(i => String(i.quote).includes('forty two')), false);
  assert.ok(summary.items.some(i => String(i.quote).includes('thirty percent')));
});

test('the confirmation read-back includes every active detail past forty', async () => {
  const { buildSummary, MAX_ITEMS } = await import('../src/summary.js');
  assert.equal(MAX_ITEMS, 100);
  const details = [];
  for (let i = 1; i <= 45; i++) {
    details.push({ id: 'D-' + String(i).padStart(3, '0'), field: 'outcome', active: true, withheld: false,
      quote: 'synthetic outcome number ' + i + ' for the cohort' });
  }
  details.push({ id: 'D-046', field: 'outcome', active: true, withheld: true, quote: 'forty two percent for the synthetic cohort kept private' });
  details.push({ id: 'D-047', field: 'outcome', active: false, withheld: false, quote: 'synthetic outcome that was superseded' });
  const items = buildSummary({ details });
  assert.equal(items.length, 45);
  assert.ok(items.some(x => x.quote.includes('number 41')));
  assert.ok(items.some(x => x.quote.includes('number 45')));
  assert.equal(items.some(x => x.quote.includes('forty two')), false);
  assert.equal(items.some(x => x.quote.includes('superseded')), false);
});

test('a replaced interview cannot overwrite the checkpoint id', async () => {
  const { CheckpointStore, handoffInterview } = await import('../src/checkpoint.js');
  const mem = new Map();
  const storage = { async get(k) { return mem.get(k); }, async put(k, v) { mem.set(k, v); } };
  const holder = { session: null, checkpointOwner: Symbol('first') };
  const first = holder.checkpointOwner;
  const oldStore = new CheckpointStore(storage, { isCurrent: () => holder.checkpointOwner === first });
  const kept = 'ab'.repeat(16);
  const abandoned = 'cd'.repeat(16);
  await oldStore.save({ sessionId: kept });
  let release;
  const parked = new Promise(r => { release = r; });
  holder.session = {
    finished: false,
    async fail() {
      await parked;
      await assert.rejects(oldStore.save({ sessionId: abandoned }), err => err && err.code === 'replaced');
    },
  };
  const pending = handoffInterview(holder, session => session.fail());
  await release();
  await pending;
  assert.equal(mem.get('cp:current'), kept);
  assert.notEqual(holder.checkpointOwner, first);
});

test('the worker revokes checkpoint ownership before it installs the replacement', () => {
  const src = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const call = src.indexOf('handoffInterview(this');
  const assign = src.indexOf('this.session = session');
  assert.ok(call > 0 && assign > call, 'handoffInterview must run before the new session is installed');
});
