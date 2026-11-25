import test from 'node:test';
import assert from 'node:assert/strict';
import { timingSafe } from '../src/timing-safe.js';

test('equal strings match, including empty', () => {
  assert.equal(timingSafe('secret', 'secret'), true);
  assert.equal(timingSafe('', ''), true);
  assert.equal(timingSafe('cafe', 'cafe'), true);
});

test('a shorter left side does not match a longer value', () => {
  assert.equal(timingSafe('secret', 'secret-extra'), false);
  assert.equal(timingSafe('ab', 'abc'), false);
  assert.equal(timingSafe('ab', 'ab\u0000'), false);
});

test('a longer left side does not match a shorter value', () => {
  assert.equal(timingSafe('secret-extra', 'secret'), false);
  assert.equal(timingSafe('abc', 'ab'), false);
});

test('the same length with a different character does not match', () => {
  assert.equal(timingSafe('secret', 'secreT'), false);
  assert.equal(timingSafe('aaaa', 'aaab'), false);
});
