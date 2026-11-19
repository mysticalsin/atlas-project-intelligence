// Inspector J05r. Reinstate does not read the body. An empty POST and {}
// must reach the same role check. The route is the real libraryRoutes handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { libraryRoutes } from '../src/library-routes.js';

const STAMP = '2026-11-17T05:00:00.000Z';

test('reinstate with no body matches {} for an owner and a reviewer', async () => {
  const lib = new Library(memorySql(), { now: () => STAMP });
  const owner = { email: 'ada@example.test', role: 'user' };
  const first = await lib.upsert(owner, { localId: 'one', reference: { title: 'One' } });
  const second = await lib.upsert(owner, { localId: 'two', reference: { title: 'Two' } });
  lib.withdraw(owner, first.id, { note: 'pause' });
  lib.withdraw(owner, second.id, { note: 'pause' });

  async function post(role, id, body) {
    const headers = {
      'x-atlas-user': role === 'reviewer' ? 'rev@example.test' : 'ada@example.test',
      'x-atlas-role': role,
    };
    const init = { method: 'POST', headers };
    if (body !== undefined) init.body = body;
    const res = await libraryRoutes(new Request('https://atlas.test/api/library/' + id + '/reinstate', init), lib);
    return res.status;
  }

  const ownerNone = await post('user', first.id, undefined);
  const ownerEmpty = await post('user', first.id, '{}');
  assert.equal(ownerNone, ownerEmpty);
  assert.equal(ownerNone, 403);

  const reviewerNone = await post('reviewer', first.id, undefined);
  const reviewerEmpty = await post('reviewer', second.id, '{}');
  assert.equal(reviewerNone, reviewerEmpty);
  assert.equal(reviewerEmpty, 200);

  const missingNone = await post('user', 'missing-id', undefined);
  const missingEmpty = await post('user', 'missing-id', '{}');
  assert.equal(missingNone, missingEmpty);
  assert.equal(missingNone, 404);

  assert.equal(await post('user', first.id, '{'), 400);
});
