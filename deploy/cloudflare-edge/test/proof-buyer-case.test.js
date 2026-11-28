// The local proof stand-in fills customer.buyer from a role title in the brief.
// "Head of claims" was kept. "Head of Claims", "Director of Operations", and "ceo" were not.
// The same sentence is already stored as the constraint. An empty buyer is a missing customer field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fake } from '../dev/fakes/proof.mjs';
import { REQUIREMENTS_POLICY, parseRequirements } from '../src/bids.js';

const briefFor = title => 'A regional insurer needs proven experience in insurance. The ' + title + ' owns the budget within this quarter.';

test('a capitalised role title is the bid buyer', () => {
  const brief = 'A regional insurer needs a proven claims reference before renewal. The Head of Claims owns the budget within a twelve month deadline. The goal is faster payouts.';
  const raw = fake(REQUIREMENTS_POLICY, brief);
  const body = JSON.parse(raw);
  assert.equal(body.customer.buyer, 'Head of Claims');
  assert.equal(body.customer.constraints, 'The Head of Claims owns the budget within a twelve month deadline.');
  assert.equal(body.customer.desired_outcome, 'The goal is faster payouts.');
  assert.equal(parseRequirements(raw).customer.buyer, 'Head of Claims');
});

test('role titles keep the letters the brief used', () => {
  const buyer = title => JSON.parse(fake(REQUIREMENTS_POLICY, briefFor(title))).customer.buyer;
  assert.equal(buyer('Head of claims'), 'Head of claims');
  assert.equal(buyer('director of data'), 'director of data');
  assert.equal(buyer('Head of Claims'), 'Head of Claims');
  assert.equal(buyer('Director of Operations'), 'Director of Operations');
  assert.equal(buyer('Head of IT'), 'Head of IT');
  assert.equal(buyer('CEO'), 'CEO');
  assert.equal(buyer('ceo'), 'ceo');
  assert.equal(buyer('CIO'), 'CIO');
  const plain = 'A regional insurer needs a proven claims reference before renewal.';
  assert.equal(JSON.parse(fake(REQUIREMENTS_POLICY, plain)).customer.buyer, '');
  assert.equal(buyer('coordination office'), '');
});
