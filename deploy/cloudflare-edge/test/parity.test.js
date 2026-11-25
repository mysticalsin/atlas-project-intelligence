// Python ↔ JavaScript ledger parity: same operations, identical results or errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InterviewLedger } from '../src/ledger.js';

const vectors = JSON.parse(readFileSync(new URL('./parity.vectors.json', import.meta.url)));
for (const [name, v] of Object.entries(vectors)) {
  test('ledger parity: ' + name, () => {
    const l = new InterviewLedger(v.stage);
    v.ops.forEach((op, i) => {
      let got;
      try {
        if (op[0] === 't') { l.addTranscript(op[1], op[2]); got = { ok: null }; }
        else if (op[0] === 'call') got = { ok: l.call(op[1], op[2], op[3]) };
        else if (op[0] === 'plan') got = { ok: l.planProbe() };
        else if (op[0] === 'inspect') got = { ok: l.inspect() };
        else if (op[0] === 'notes') got = { ok: l.notes() };
      } catch (e) { got = { error: e.message }; }
      assert.deepEqual(JSON.parse(JSON.stringify(got)), v.expected[i], `${name} op ${i} ${JSON.stringify(op).slice(0, 80)}`);
    });
  });
}

test('a quote inside a longer word or number is not an excerpt', () => {
  const inside = new InterviewLedger();
  inside.addTranscript('u1', 'The account was closed after the handover to the team.');
  assert.throws(() => inside.record({ details: [{ field: 'outcome', item_id: 'u1', quote: 'count' }] }), /Quote is not in the consultant transcript/);
  assert.equal(inside.details.length, 0);
  inside.record({ details: [{ field: 'outcome', item_id: 'u1', quote: 'The account was closed' }] });
  inside.addTranscript('u2', 'The open count was twelve after the handover.');
  inside.record({ details: [{ field: 'outcome', item_id: 'u2', quote: 'count' }] });
  assert.ok(inside.notes().some(part => part.split('\n').includes('count')));
  const digits = new InterviewLedger();
  digits.addTranscript('u1', 'The queue handled 100000 tickets in the quarter.');
  assert.throws(() => digits.record({ details: [{ field: 'outcome', item_id: 'u1', quote: '10000' }] }), /Quote is not in the consultant transcript/);
});
