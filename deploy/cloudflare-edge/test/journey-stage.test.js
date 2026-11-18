// An unknown journey stage is rejected. The stored stage stays as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { saveJourney } from '../src/journey.js';
import { memorySql } from './sqlite.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = { email: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };

test('an unknown journey stage is rejected and the stored stage stays', async () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-18T00:00:00.000Z', auditKey: 'synthetic-log-salt' });
  await saveJourney(lib, USER, { stage: 'project', fields: { title: { value: 'Alias', source: 'you', confirmed: true } } });
  await assert.rejects(() => saveJourney(lib, USER, { stage: 'Nope' }), err => err.status === 400);
  const payload = JSON.parse(lib.rows('SELECT payload FROM journey')[0].payload);
  assert.equal(payload.stage, 'project');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM journey')[0].n, 1);
});
