// Journey erasure matches the subject saveJourney wrote. A later lowercased sign-in must not leave that row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { saveJourney } from '../src/journey.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOTE = 'Each store reports only what this request removed for this subject and tenant. A failure returns an error and removes nothing. Other tenants, other people, and blank-tenant rows are not counted. Stories, staffing, invitations, and audit history are not deleted. Quarantine is not deletion. Vendor deletion is not-asserted. This is not a GDPR certification.';

function lib() {
  return new Library(memorySql(), { now: () => '2026-11-08T00:00:00.000Z' });
}

async function erase(library, email) {
  const response = await libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', {
    method: 'POST', body: '{}',
    headers: { 'x-atlas-user': email, 'x-atlas-role': 'user', 'x-atlas-email': email.toLowerCase(), 'x-atlas-tenant': TENANT, 'x-atlas-tenant-enforced': '1' },
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
  return response.json();
}

test('delete removes the journey saveJourney stored for that same email', async () => {
  const library = lib();
  const user = { email: 'Ada@Example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
  await saveJourney(library, user, { stage: 'project', fields: { title: { value: 'Alias', source: 'you', confirmed: true } } });
  assert.equal(library.rows('SELECT subject FROM journey')[0].subject, 'Ada@Example.test');
  const body = await erase(library, 'Ada@Example.test');
  assert.equal(body.note, NOTE);
  assert.equal(body.outcomes.find(item => item.store === 'journey').removed, 1);
  assert.equal(library.rows('SELECT COUNT(*) AS n FROM journey')[0].n, 0);
});

test('a lowercased sign-in removes a journey whose subject saveJourney stored in mixed case', async () => {
  const library = lib();
  const user = { email: 'Ada@Example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
  await saveJourney(library, user, { stage: 'project', fields: { title: { value: 'Alias', source: 'you', confirmed: true } } });
  assert.equal(library.rows('SELECT subject FROM journey')[0].subject, 'Ada@Example.test');
  const exported = await (await libraryRoutes(new Request('https://atlas.test/api/library/privacy/export', {
    headers: { 'x-atlas-user': 'ada@example.test', 'x-atlas-role': 'user', 'x-atlas-email': 'ada@example.test', 'x-atlas-tenant': TENANT, 'x-atlas-tenant-enforced': '1' },
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } })).json();
  assert.equal(exported.journey[0].fields.title.value, 'Alias');
  const body = await erase(library, 'ada@example.test');
  assert.equal(body.note, NOTE);
  assert.equal(body.outcomes.find(item => item.store === 'journey').removed, 1);
  assert.equal(library.rows('SELECT COUNT(*) AS n FROM journey')[0].n, 0);
});
