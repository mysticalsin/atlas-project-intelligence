// Forget must delete the document id the caller named. A rewritten id is a different memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hindsight } from '../src/memory.js';
import { memoryRoutes } from '../src/memory-routes.js';

const ENV = {
  HINDSIGHT_URL: 'https://hs.example/',
  HINDSIGHT_API_KEY: 'hs-key',
  HINDSIGHT_OPT_IN: '1',
  CSRF_SECRET: 'csrf',
  ATLAS_TENANT_ISOLATION: 'local-synthetic',
};

function fakeHS() {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    return new Response('{}', { status: 200 });
  };
  return { calls, fetcher };
}

function store() {
  const m = new Map();
  return { get: async k => m.get(k), put: async (k, v) => m.set(k, v) };
}

function req(body) {
  return new Request('https://atlas.test/api/memory/forget', {
    method: 'POST',
    headers: { 'x-atlas-bank': 'atlas-x', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ctxFor(fetcher) {
  return { storage: store(), hs: hindsight(ENV, fetcher), env: ENV };
}

test('forget deletes the named document and no other', async () => {
  const { calls, fetcher } = fakeHS();
  const res = await memoryRoutes(req({ documentId: 'project-p-123' }), ctxFor(fetcher));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { forgotten: 'project-p-123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(new URL(calls[0].url).pathname, '/v1/default/banks/atlas-x/documents/project-p-123');
});

test('forget refuses an id that is not the stored token', async () => {
  const samples = ['../project-p-123', 'project-p-123 ', 'project.p-123', 'x'.repeat(101), {}];
  for (const documentId of samples) {
    const { calls, fetcher } = fakeHS();
    const res = await memoryRoutes(req({ documentId }), ctxFor(fetcher));
    assert.equal(res.status, 400, JSON.stringify(documentId));
    assert.equal((await res.json()).error, 'Which memory?');
    assert.equal(calls.length, 0, JSON.stringify(documentId));
  }
});

test('forget all still clears the bank when the body also names a bad id', async () => {
  const { calls, fetcher } = fakeHS();
  const res = await memoryRoutes(req({ all: true, documentId: '../project-p-123' }), ctxFor(fetcher));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { forgotten: 'all' });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/v1/default/banks/atlas-x');
});
