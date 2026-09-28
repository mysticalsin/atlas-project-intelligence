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
