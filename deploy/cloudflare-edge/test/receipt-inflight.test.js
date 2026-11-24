// A consent receipt can be inserted while its HTTP response is still in flight.
// The commit timeout must not leave that row behind a rejected grant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';
import { applyState, loadState, postReceipts } from '../src/privacy.js';
import { libraryRoutes } from '../src/library-routes.js';

const SUBJ = 'ab'.repeat(16);
const WHO = { user: 'ada@example.test', role: 'user', mail: 'ada@example.test', subj: SUBJ };

function receiptRows(sql) {
  const names = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'consent_receipts'").toArray();
  if (!names.length) return [];
  return sql.exec('SELECT purpose, granted FROM consent_receipts').toArray();
}

function memoryStorage() {
  let stored;
  return {
    async get() { return stored ? structuredClone(stored) : undefined; },
    async put(_key, next) { stored = structuredClone(next); },
    read() { return stored; },
  };
}

function libraryEnv(fetch) {
  return {
    LIBRARY: {
      idFromName() { return 'id'; },
      get() { return { fetch }; },
    },
  };
}

test('an insert that lands while the receipt response is in flight commits with that grant', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => '2026-11-21T00:00:00.000Z' });
  const storage = memoryStorage();
  const env = libraryEnv(async request => {
    const res = await libraryRoutes(request, lib);
    assert.equal(receiptRows(sql).length, 1, 'the insert lands before the response is delivered');
    await new Promise(resolve => {
      if (request.signal?.aborted) resolve();
      else request.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return res;
  });
  const out = await applyState(storage, { transcription: true }, {
    commitTimeoutMs: 25,
    channel: 'api',
    beforeCommit: (changes, signal) => postReceipts(env, WHO, changes, 'api', signal),
  });
  assert.equal(out.state.purposes.transcription.granted, true);
  assert.equal(receiptRows(sql).length, 1);
  assert.equal(receiptRows(sql)[0].purpose, 'transcription');
  const state = await loadState(storage);
  assert.equal(state.purposes.transcription.granted, true);
});

test('a commit timeout before the receipt insert stores nothing', async () => {
  const storage = memoryStorage();
  let wrote = 0;
  const env = libraryEnv(async request => {
    await new Promise(resolve => setTimeout(resolve, 80));
    if (request.signal?.aborted) return new Response('late', { status: 499 });
    wrote += 1;
    return new Response('ok', { status: 200 });
  });
  await assert.rejects(
    applyState(storage, { transcription: true }, {
      commitTimeoutMs: 20,
      channel: 'api',
      beforeCommit: (changes, signal) => postReceipts(env, WHO, changes, 'api', signal),
    }),
    err => err && err.code === 'commit-timeout',
  );
  assert.equal(wrote, 0);
  assert.equal(storage.read(), undefined);
  await applyState(storage, { draft: true }, {
    commitTimeoutMs: 50,
    channel: 'api',
    beforeCommit: (changes, signal) => postReceipts(libraryEnv(async () => new Response('ok', { status: 200 })), WHO, changes, 'api', signal),
  });
  const state = await loadState(storage);
  assert.equal(state.purposes.draft.granted, true);
  assert.notEqual(state.purposes.transcription?.granted, true);
});
