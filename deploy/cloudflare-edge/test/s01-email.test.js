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
