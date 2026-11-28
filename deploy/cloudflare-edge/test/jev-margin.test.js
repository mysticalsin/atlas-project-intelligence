// A half-point lead is the margin choose() accepts. Decimal scores that are
// not binary fractions were compared as if the lead were smaller, so the
// ledger kept the weaker question.
import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, choose } from '../src/jev.js';
import { InterviewLedger, guidance } from '../src/ledger.js';

function planAfter(quotes) {
  const ledger = new InterviewLedger('Delivery');
  let n = 0;
  for (const [field, text] of quotes) {
    n += 1;
    ledger.addTranscript('u' + n, text);
    ledger.call('c' + n, 'record_details', { details: [{ field, item_id: 'u' + n, quote: text }] });
  }
  return ledger.planProbe();
}

test('an exact half-point lead still replaces the ledger question', () => {
  const plan = planAfter([
    ['problem', 'Tickets bounced between three teams'],
    ['contribution', 'I personally rebuilt the routing rules'],
  ]);
  const guide = guidance(plan);
  const [current, other] = candidates(plan);
  const picked = choose(plan, guide, {
    [current]: { score: 0.07, confidence: 0.9 },
    [other]: { score: 0.57, confidence: 0.9 },
  });
  assert.equal(picked && picked.field, other);
  assert.equal(choose(plan, guide, {
    [current]: { score: 0.07, confidence: 0.9 },
    [other]: { score: 0.56, confidence: 0.9 },
  }), null);
  assert.equal(choose(plan, guide, {
    [current]: { score: 2, confidence: 0.9 },
    [other]: { score: 2.3, confidence: 0.9 },
  }), null);
});
