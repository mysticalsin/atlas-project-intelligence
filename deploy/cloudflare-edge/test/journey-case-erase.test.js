// Mixed-case spellings of one subject are one journey. Erasure removes every spelling.
// Another subject's row stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { ensureJourney, journeyChosen, journeyMatches, JOURNEY_READ_SQL } from '../src/journey.js';
import { eraseJourneyFor } from '../src/operate.js';
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
    sqlOf(lib).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', subject, TENANT, '{}', '2026-11-18T00:00:00.000Z');
  }
  sqlOf(lib).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', OTHER, TENANT, '{}', '2026-11-18T00:00:00.000Z');
  sqlOf(lib).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', MINE[0], OTHER_TENANT, '{}', '2026-11-18T00:00:00.000Z');
}

function subjects(lib) {
  return sqlOf(lib).exec('SELECT subject, tenant FROM journey ORDER BY tenant, subject').toArray();
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

test('an uppercase tenant id is the same journey for read and erase', () => {
  const lib = library();
  ensureJourney(lib);
  const upper = TENANT.toUpperCase();
  const otherUpper = OTHER_TENANT.toUpperCase();
  sqlOf(lib).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', MINE[0], upper, '{"version":1}', '2026-11-18T00:00:00.000Z');
  sqlOf(lib).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', MINE[0], otherUpper, '{}', '2026-11-18T00:00:00.000Z');
  sqlOf(lib).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', MINE[0], '', '{}', '2026-11-18T00:00:00.000Z');
  const seen = journeyMatches(lib, MINE[0], TENANT);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tenant, upper);
  assert.equal(journeyChosen(lib, MINE[0], TENANT).id, seen[0].id);
  assert.equal(lib.recorded(() => eraseJourneyFor(lib, { email: MINE[0], tenant: TENANT })), 1);
  assert.deepEqual(subjects(lib), [
    { subject: MINE[0], tenant: '' },
    { subject: MINE[0], tenant: otherUpper },
  ]);
});

test('an older tenant column index is rebuilt and the case fold does not scan', () => {
  const lib = library();
  ensureJourney(lib);
  sqlOf(lib).exec('DROP INDEX journey_tenant_subject');
  sqlOf(lib).exec('CREATE INDEX journey_tenant_subject ON journey(tenant, lower(subject))');
  ensureJourney(lib);
  const plan = lib.rows('EXPLAIN QUERY PLAN ' + JOURNEY_READ_SQL, MINE[0], TENANT).map(row => row.detail).join('\n');
  assert.equal(plan.includes('SCAN journey'), false, plan);
  assert.equal(plan.includes('journey_tenant_subject'), true, plan);
  const stored = lib.rows("SELECT sql FROM sqlite_master WHERE name = 'journey_tenant_subject'")[0].sql;
  assert.match(String(stored).toLowerCase(), /lower\(tenant\)/);
});
