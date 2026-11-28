// The project trigger caps the body that is actually read, not only Content-Length.
// A streamed POST with no length must stop just past 16 KiB and must not be forwarded.
// Synthetic data only. No provider, Entra, Hindsight, or Teams call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';

const ORIGIN = 'https://atlas.example.workers.dev';
const TENANT = '11111111-1111-4111-8111-111111111111';
const SMALL = '{"email":"ada@example.test","reason":"project_end"}';

function envFor(capture) {
  return {
    ORIGIN,
    CSRF_SECRET: 'test-secret',
    LOG_SALT: 'synthetic-log-salt',
    TRIGGER_SECRET: 's3cret-value',
    ATLAS_SYSTEM_TENANT: TENANT,
    LIBRARY: {
      idFromName: name => name,
      get: () => ({
        fetch: async request => {
          capture.req = request;
          capture.body = await request.text();
          return new Response('{"id":"x"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
        },
      }),
    },
  };
}

function post(env, body, headers = {}) {
  return handle(new Request(ORIGIN + '/api/triggers', {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { Authorization: 'Bearer s3cret-value', ...headers },
  }), env, '');
}

test('a small trigger body is still forwarded to the library', async () => {
  const capture = { req: null, body: '' };
  const response = await post(envFor(capture), SMALL);
  assert.equal(response.status, 201);
  assert.equal(capture.body, SMALL);
  assert.equal(new URL(capture.req.url).pathname, '/api/library/trigger');
  assert.equal(capture.req.headers.get('x-atlas-role'), 'system');
  assert.equal(capture.req.headers.get('x-atlas-tenant'), TENANT);
});

test('a streamed trigger body with no Content-Length stops just past 16 KiB', async () => {
  const capture = { req: null, body: '' };
  const CHUNK = 1 << 16;
  const pulled = { n: 0 };
  const chunk = new Uint8Array(CHUNK).fill(120);
  const body = new ReadableStream({
    pull(controller) {
      if (pulled.n >= 2 * (1 << 20)) return controller.close();
      pulled.n += CHUNK;
      controller.enqueue(chunk);
    },
  });
  const request = new Request(ORIGIN + '/api/triggers', {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { Authorization: 'Bearer s3cret-value' },
  });
  assert.equal(request.headers.get('Content-Length'), null);
  const response = await handle(request, envFor(capture), '');
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request too large.' });
  assert.equal(capture.req, null);
  assert.ok(pulled.n <= 16384 + 2 * CHUNK, 'read stopped just past 16 KiB, pulled ' + pulled.n);
});

test('a trigger body over 16 KiB is refused before the library', async () => {
  const capture = { req: null, body: '' };
  const body = '{"email":"ada@example.test","note":"' + 'x'.repeat(20000) + '"}';
  const response = await post(envFor(capture), body);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request too large.' });
  assert.equal(capture.req, null);
});
