// A gap result keeps a quote that is its own word, even when the answer window
// only contains that word inside a longer word. Synthetic speech only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';
import { InterviewLedger } from '../src/ledger.js';

function result(ledger, answer) {
  const s = new Session({ io: { send() {}, sendBytes() {}, close() {} }, ai: {}, csrf: 'tok', voice: 'asteria', model: 'test' });
  s.gapAsks = [{ id: 'G1', field: 'outcome', label: 'Observed outcome', ask: 'What changed in practice?' }];
  s.gapAttempts = { G1: 1 };
  s.gapAnswers = { G1: [[answer]] };
  s.ledger = ledger;
  return s.gapResults()[0];
}

test('a quote that is its own word survives an answer that only has it inside a longer word', () => {
  const ledger = new InterviewLedger('Pilot');
  ledger.addTranscript('u1', 'The account stayed with the local team after the handover.');
  ledger.addTranscript('u2', 'The open count was twelve after the change.');
  ledger.record({ details: [{ field: 'outcome', item_id: 'u2', quote: 'count' }] });
  const row = result(ledger, 'The account stayed with the local team after the handover.');
  assert.equal(row.quotes[0], 'The account stayed with the local team after the handover.');
  assert.ok(row.quotes.includes('count'));
});

test('a quote that is its own word in the answer is not repeated', () => {
  const ledger = new InterviewLedger('Pilot');
  ledger.addTranscript('u2', 'The open count was twelve after the change.');
  ledger.record({ details: [{ field: 'outcome', item_id: 'u2', quote: 'count' }] });
  const row = result(ledger, 'The open count was twelve after the change.');
  assert.deepEqual(row.quotes, ['The open count was twelve after the change.']);
});

test('a digit slice inside a longer number is not copied into the gap result', () => {
  const ledger = new InterviewLedger('Pilot');
  ledger.addTranscript('u3', 'The queue handled 100000 tickets in the quarter.');
  ledger.record({ details: [{ field: 'outcome', item_id: 'u3', quote: '10000' }] });
  const same = result(ledger, 'The queue handled 100000 tickets in the quarter.');
  assert.deepEqual(same.quotes, ['The queue handled 100000 tickets in the quarter.']);
  const other = result(ledger, 'The account stayed with the local team after the handover.');
  assert.deepEqual(other.quotes, ['The account stayed with the local team after the handover.']);
});
