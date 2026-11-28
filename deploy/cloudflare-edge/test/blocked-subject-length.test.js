// The live subject key is 32 hex characters. A block entry may be that key or the
// longer HMAC it was cut from. A longer entry still has to block that subject.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedSubject } from '../src/kill-switches.js';

const key = 'ab'.repeat(16);
const full = key + 'cd'.repeat(16);

test('a block entry longer than the subject key still blocks that subject', () => {
  assert.equal(key.length, 32);
  assert.equal(full.length, 64);
  assert.equal(blockedSubject({ ATLAS_BLOCKED_SUBS: full }, key), true);
  assert.equal(blockedSubject({ ATLAS_BLOCKED_SUBS: full.toUpperCase() }, key), true);
  assert.equal(blockedSubject({ ATLAS_BLOCKED_SUBS: 'ff'.repeat(32) }, key), false);
  assert.equal(blockedSubject({ ATLAS_BLOCKED_SUBS: key.slice(0, 16) }, key), true);
  assert.equal(blockedSubject({ ATLAS_BLOCKED_SUBS: key.slice(0, 11) }, key), false);
  assert.equal(blockedSubject({ ATLAS_BLOCKED_SUBS: full }, 'a'), false);
});
