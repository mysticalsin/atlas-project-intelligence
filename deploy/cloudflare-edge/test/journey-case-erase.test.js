// Mixed-case spellings of one subject are one journey. Erasure removes every spelling.
// Another subject's row stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { ensureJourney } from '../src/journey.js';
import { eraseMine } from '../src/subject-rights.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const MINE = ['ada@example.test', 'Ada@Example.test', 'ADA@example.test'];
const OTHER = 'other@example.test';

function library() {
  return new Library(memorySql(), { now: () => '2026-11-18T00:00:00.000Z' });
}

function seed(lib) {
  ensureJourney(lib);
  for (const subject of MINE) {
    lib.sql.exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', subject, TENANT, '{}', '2026-11-18T00:00:00.000Z');
  }
  lib.sql.exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', OTHER, TENANT, '{}', '2026-11-18T00:00:00.000Z');
  lib.sql.exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', MINE[0], OTHER_TENANT, '{}', '2026-11-18T00:00:00.000Z');
}

function subjects(lib) {
  return lib.sql.exec('SELECT subject, tenant FROM journey ORDER BY tenant, subject').toArray();
}

test('mixed-case journey rows for one subject are removed by eraseMine and by privacy delete', async () => {
  const mine = library();
  seed(mine);
  eraseMine(mine, { email: MINE[0], mail: MINE[0], role: 'user', tenant: TENANT, tenantEnforced: true }, 'ab'.repeat(16));
  assert.deepEqual(subjects(mine), [
    { subject: OTHER, tenant: TENANT },
    { subject: MINE[0], tenant: OTHER_TENANT },
  ]);

  const privacy = library();
  seed(privacy);
  const response = await libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', {
    method: 'POST', body: '{}',
    headers: {
      'x-atlas-user': MINE[0], 'x-atlas-role': 'user', 'x-atlas-email': MINE[0],
      'x-atlas-tenant': TENANT, 'x-atlas-tenant-enforced': '1',
    },
  }), privacy, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
  assert.equal(response.status, 200);
  assert.deepEqual(subjects(privacy), [
    { subject: OTHER, tenant: TENANT },
    { subject: MINE[0], tenant: OTHER_TENANT },
  ]);
});
