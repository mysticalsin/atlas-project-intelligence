// Sweep 01 external review (HAM-02). The test encodes the behaviour main should have.
// It fails on main. It is not skipped and it is not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';
import { impact as serverImpact } from '../src/classify.js';

const user = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user' };

test('HAM-02 a client-supplied library impact is ignored and the server score is stored', async () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });
  const scores = {
    business_impact: { score: 2 },
    evidence: { score: 2 },
    reusability: { score: 2 },
    differentiation: { score: 2 },
    showcase: { score: 2 },
  };
  const saved = await lib.upsert(user, {
    localId: 'impact',
    reference: {
      title: 'Impact story',
      jev: { primary: { key: 'data_ai', label: 'Data & AI' }, also: [], scores, impact: 99 },
    },
  });
  const expected = serverImpact(scores);
  const stored = lib.row(saved.id).data.jev.impact;
  assert.equal(stored, expected);
  assert.equal(saved.impact, expected);
});
