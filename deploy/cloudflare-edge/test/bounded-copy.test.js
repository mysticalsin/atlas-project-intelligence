// A request body can reuse one buffer for the next chunk. The bytes already
// accepted have to be copied before that happens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedBytes } from '../src/bounded.js';

test('a reused body buffer keeps the bytes from the earlier read', async () => {
  const buf = new Uint8Array([1, 2, 3, 4]);
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 1) buf.set([9, 9, 9, 9]);
      controller.enqueue(buf);
      if (pulls > 1) controller.close();
    },
  });
  const request = new Request('https://atlas.test/upload', { method: 'POST', body, duplex: 'half' });
  const out = await boundedBytes(request, 20);
  assert.deepEqual([...out], [1, 2, 3, 4, 9, 9, 9, 9]);
});

test('a body past the cap is still refused', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
      controller.enqueue(new Uint8Array(3));
      controller.close();
    },
  });
  const request = new Request('https://atlas.test/upload', { method: 'POST', body, duplex: 'half' });
  assert.equal(await boundedBytes(request, 6), null);
});
