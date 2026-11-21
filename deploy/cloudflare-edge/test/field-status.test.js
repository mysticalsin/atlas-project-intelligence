import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DETAIL_PHASES, PROBE_PHASES, DEFER_SENTENCE, classifyDetail, detailTransition, probeTransition } from '../src/field-status.js';

const UNKNOWN = new RegExp("\\b(?:don.t know|not measured|no baseline|no measurement|unknown|not yet known|cannot share|can.t share|under NDA|not authorized to disclose)\\b", 'i');
const UNCERTAIN = new RegExp('\\b(?:guess|roughly|about|approximately|estimate|not sure|maybe|think|probably)\\b', 'i');

test('detail status is one write and the labels match Python', () => {
  let legal = 0, illegal = 0;
  for (const phase of DETAIL_PHASES) {
    const before = { phase };
    const result = detailTransition(before, { type: 'classify', kind: 'reported' });
    if (phase === 'unset') {
      legal += 1;
      assert.equal(result.ok, true);
      assert.equal(result.state.phase, 'reported');
      assert.notEqual(result.state, before);
    } else {
      illegal += 1;
      assert.equal(result.illegal, true);
      assert.equal(result.state, before);
      assert.deepEqual(result.rejection, { id: 'detail-status', phase, event: 'classify' });
    }
  }
  assert.equal(legal, 1);
  assert.equal(illegal, 3);
  const cases = [
    ['the team shipped the change last spring', false, 'reported'],
    ["we don't know the baseline yet", false, 'unknown'],
    ['about twelve minutes of delay', false, 'uncertain'],
    ['the team shipped the change last spring', true, 'uncertain'],
  ];
  for (const [quote, uncertain, label] of cases) {
    assert.equal(classifyDetail(quote, uncertain, UNKNOWN, UNCERTAIN), label);
  }
});

test('the probe budget asks twice and then defers with the shared sentence', () => {
  const first = probeTransition({ phase: 'open', plans: 0 }, { type: 'plan' });
  assert.deepEqual(first.effects, ['ask']);
  assert.deepEqual(first.state, { phase: 'asking', plans: 1 });
  const second = probeTransition(first.state, { type: 'plan' });
  assert.deepEqual(second.state, { phase: 'asking', plans: 2 });
  const third = probeTransition(second.state, { type: 'plan' });
  assert.deepEqual(third.effects, ['defer']);
  assert.equal(third.state.phase, 'deferred');
  const again = probeTransition(third.state, { type: 'plan' });
  assert.deepEqual(again.effects, ['defer']);
  assert.notEqual(again.state, third.state);
  const refused = probeTransition({ phase: 'open', plans: 1 }, { type: 'plan' });
  assert.equal(refused.illegal, true);
  assert.equal(refused.state.plans, 1);
  assert.equal(DEFER_SENTENCE, 'Two clarification plans did not resolve this point; offer to collect it later.');
  const seen = new Set();
  const phases = new Set();
  const queue = [['open', 0]];
  while (queue.length && seen.size < 200) {
    const [phase, plans] = queue.shift();
    const key = phase + ':' + plans;
    if (seen.has(key)) continue;
    seen.add(key);
    phases.add(phase);
    const result = probeTransition({ phase, plans }, { type: 'plan' });
    if (result.ok) queue.push([result.state.phase, result.state.plans]);
  }
  assert.deepEqual([...phases].sort(), [...PROBE_PHASES].sort());
});

test('both ledgers call the status and probe reducers', () => {
  const ledger = readFileSync(new URL('../src/ledger.js', import.meta.url), 'utf8');
  const quality = readFileSync(new URL('../../../atlas_voice/quality.py', import.meta.url), 'utf8');
  assert.match(ledger, /classifyDetail\(/);
  assert.match(ledger, /probeTransition\(/);
  assert.match(quality, /classify_detail\(/);
  assert.match(quality, /probe_transition\(/);
});
