// Sweep 01 group 5 (email bounds, L1). Copied from the red tests at 96712474.
// Fails on main. Not skipped and not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { email } from '../src/util.js';

test('L1 two long addresses that differ after 200 characters stay distinct', () => {
  const local = 'a'.repeat(64);
  const host = 'b'.repeat(130);
  const first = `${local}@${host}.example.com`;
  const second = `${local}@${host}.example.org`;
  assert.ok(first.length > 200 && first.length <= 254);
  assert.ok(second.length > 200 && second.length <= 254);
  const storedFirst = email(first);
  const storedSecond = email(second);
  if (storedFirst === '' && storedSecond === '') return;
  assert.equal(storedFirst, first);
  assert.equal(storedSecond, second);
});

test('L1 an address at 254 characters is stored whole and 255 is refused', () => {
  const ofLength = n => 'a@' + 'b'.repeat(n - 6) + '.com';
  for (const n of [7, 20, 200, 201, 254]) {
    const value = ofLength(n);
    assert.equal(value.length, n);
    assert.equal(email('  ' + value.toUpperCase() + ' '), value);
  }
  assert.equal(ofLength(255).length, 255);
  assert.equal(email(ofLength(255)), '');
  assert.equal(email('=sum(1)@example.com'), '=sum(1)@example.com');
});
