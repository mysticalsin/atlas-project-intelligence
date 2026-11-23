// Sweep 01 group 14 stress findings, copied from PR #31 at 96712474.
// F1, F2, F5, F6 and F7 belong to other groups and are not in this file.
// These tests fail on main. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { consume } from '../src/ratelimit.js';
import { applyState, loadState } from '../src/privacy.js';

function counter() {
  const data = new Map();
  return {
    async get(keys) {
      await new Promise(resolve => setImmediate(resolve));
      const out = new Map();
      for (const key of keys) if (data.has(key)) out.set(key, structuredClone(data.get(key)));
      return out;
    },
    async put(entries) {
      await new Promise(resolve => setImmediate(resolve));
      for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value));
    },
  };
}

test('F3 a shared limit cannot be passed by overlapping consumes', async () => {
  const storage = counter();
  const check = [{ bucket: 'inbound', max: 5, windowMs: 60000 }];
  const now = 1_700_000_030_000;
  const results = await Promise.all(Array.from({ length: 40 }, () => consume(storage, check, { now, subj: 'person' })));
  const allowed = results.filter(result => result.ok).length;
  assert.ok(allowed <= 5, String(allowed));
});

test('F4 overlapping consent writes keep every purpose that was granted', async () => {
  let value;
  const storage = {
    async get() {
      await new Promise(resolve => setImmediate(resolve));
      return value ? structuredClone(value) : undefined;
    },
    async put(_key, next) {
      await new Promise(resolve => setImmediate(resolve));
      value = structuredClone(next);
    },
  };
  const pause = async () => { await new Promise(resolve => setImmediate(resolve)); };
  await Promise.all([
    applyState(storage, { transcription: true }, { beforeCommit: pause }),
    applyState(storage, { draft: true }, { beforeCommit: pause }),
  ]);
  const state = await loadState(storage);
  assert.equal(state.purposes.transcription?.granted, true);
  assert.equal(state.purposes.draft?.granted, true);
});

test('F8 a clock that moves backward does not open a fresh rate-limit window', async () => {
  const storage = counter();
  const check = [{ bucket: 'inbound', max: 3, windowMs: 60000 }];
  const now = 1_700_000_030_000;
  for (let i = 0; i < 3; i++) assert.equal((await consume(storage, check, { now, subj: 'person' })).ok, true);
  assert.equal((await consume(storage, check, { now, subj: 'person' })).ok, false);
  const earlier = await consume(storage, check, { now: now - 60000, subj: 'person' });
  assert.equal(earlier.ok, false);
});
