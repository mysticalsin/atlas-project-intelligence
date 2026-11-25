// An address longer than the stored cap is refused whole.
// Cutting it to 200 characters stores a different address, and two consultants can share that prefix.
// Synthetic addresses only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { email } from '../src/util.js';

const stem = 'a'.repeat(190);

test('a 200-character address is kept, and a longer one is not chopped to a shared prefix', () => {
  const exact = 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.example';
  const one = stem + '@example.com';
  const two = stem + '@example.co';
  const prefix = one.slice(0, 200);
  assert.equal(exact.length, 200);
  assert.equal(one.length, 202);
  assert.equal(two.length, 201);
  assert.equal(prefix, two.slice(0, 200));
  assert.notEqual(prefix, one);
  assert.notEqual(prefix, two);
  assert.equal(email('  ' + exact.toUpperCase() + '  '), exact);
  assert.equal(email(prefix), prefix);
  assert.equal(email(one), '');
  assert.equal(email(two), '');
  assert.equal(email(' A@B.CO '), 'a@b.co');
  assert.equal(email('a'.repeat(250) + '@x.co'), '');
  assert.equal(email('not-an-email'), '');
});
