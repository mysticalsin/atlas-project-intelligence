// A gap answer in a script that does not space its words still counts.
// Synthetic phrases only. No provider, Entra, Hindsight, or Teams calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gapGuidance, gapStatus } from '../src/gap-policy.js';

const ASKS = [{ id: 'G1', field: 'outcome', label: 'Observed outcome', ask: 'Proof the bid needs: a measured change' }];

function status(text, attempts = 0) {
  return gapStatus(ASKS, attempts ? { G1: attempts } : {}, { G1: [text] }, [])[0].status;
}

test('chinese, japanese and thai answers count letters', () => {
  const chinese = '\u5904\u7406\u65f6\u95f4\u4ece\u4e5d\u5929\u964d\u5230\u4e86\u56db\u5929';
  const japanese = '\u51e6\u7406\u6642\u9593\u3092\u4e5d\u65e5\u304b\u3089\u56db\u65e5\u306b\u77ed\u7e2e\u3057\u307e\u3057\u305f';
  const thai = '\u0e40\u0e27\u0e25\u0e32\u0e08\u0e31\u0e14\u0e01\u0e32\u0e23\u0e25\u0e14\u0e08\u0e32\u0e01\u0e40\u0e01\u0e49\u0e32\u0e27\u0e31\u0e19\u0e40\u0e1b\u0e47\u0e19\u0e2a\u0e35\u0e48\u0e27\u0e31\u0e19';
  for (const text of [chinese, japanese, thai]) {
    assert.equal(text.includes(' '), false);
    assert.equal(status(text), 'answered_unverified');
  }
  const rows = gapStatus(ASKS, {}, { G1: [japanese] }, []);
  const plan = gapGuidance(ASKS, rows);
  assert.equal(plan.action, 'reflect_and_confirm');
  assert.equal(plan.askId, null);
});

test('a short unspaced reply stays open', () => {
  assert.equal(status('\u306f\u3044'), 'open');
  assert.equal(status('\u7ed3\u679c\u662f\u4e5d\u65e5'), 'open');
  assert.equal(status('\u7ed3\u679c\u662f\u4e5d\u65e5\u4e86'), 'answered_unverified');
  assert.equal(status('\u306f\u3044', 2), 'deferred');
});

test('spaced languages keep the whitespace count', () => {
  assert.equal(status('one two three four five'), 'open');
  assert.equal(status('one two three four five six'), 'answered_unverified');
  assert.equal(status('\uac00 \ub098 \ub2e4 \ub77c \ub9c8'), 'open');
  assert.equal(status('\uac00 \ub098 \ub2e4 \ub77c \ub9c8 \ubc14'), 'answered_unverified');
});

test('an unknown phrase still beats a long unspaced answer', () => {
  const japanese = '\u51e6\u7406\u6642\u9593\u3092\u4e5d\u65e5\u304b\u3089\u56db\u65e5\u306b\u77ed\u7e2e\u3057\u307e\u3057\u305f';
  assert.equal(status(japanese + ' unknown'), 'unknown');
});
