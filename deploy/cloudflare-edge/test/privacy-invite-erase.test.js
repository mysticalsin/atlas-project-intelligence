// Privacy delete removes this subject's invitations in the same transaction.
// A later six-month scan does not create another one, and the receipt says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { privacyRoutes } from '../src/operate.js';
import { memorySql } from './sqlite.js';

const NOW = '2026-11-18T00:00:00.000Z';
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EMAIL = 'ada@example.test';
const USER = { email: EMAIL, mail: EMAIL, role: 'user', tenant: TENANT, tenantEnforced: true };
const REF = () => ({
  title: 'Claims triage alias', stage: 'Production', sector: 'Insurance',
  consultant: { name: 'Ada', role: 'Data engineer' },
  client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', start: '2024-03', end: '2024-11', teamSize: 6, teamRoles: ['Data engineer'], technologies: ['Python'], deliverables: ['Routing model'], serviceLines: ['Data & AI'], consultants: [], links: [] },
  answers: ['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.', 'I designed and built the routing model and ran the pilot with two teams.',
    'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.', 'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
    'Operations dashboard export v3, before and after quarters.', 'Any insurer or service desk with manual routing and a measurable queue would benefit.'],
  validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: false },
});

function open() {
  return new Library(memorySql(), { now: () => NOW, auditKey: 'synthetic-log-salt' });
}
const inviteCount = lib => lib.rows('SELECT COUNT(*) AS n FROM invitations WHERE lower(email) = ? AND lower(COALESCE(tenant, \'\')) = ?', EMAIL, TENANT)[0].n;

async function deleted(lib) {
  const saved = await lib.upsert(USER, { localId: 'p1', reference: REF() });
  lib.sql.exec('UPDATE refs SET next_review = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', saved.id);
  lib.invite(EMAIL, { email: EMAIL, reason: 'manual', projectId: 'PRJ-1', title: 'Open', tenant: TENANT }, USER);
  const response = await privacyRoutes({ method: 'POST', parts: ['privacy', 'delete'], user: USER, lib, env: {}, body: {} });
  return response.body;
}

test('the privacy delete receipt does not say invitations are kept', async () => {
  const body = await deleted(open());
  assert.equal(body.note.includes('invitations, and audit history are not deleted'), false);
  assert.match(body.note, /Invitations for this subject in this tenant are removed/);
});

test('privacy delete removes the subject invitations, and scanStale does not create another', async () => {
  const lib = open();
  await deleted(lib);
  assert.equal(inviteCount(lib), 0);
  assert.equal(lib.scanStale(USER), 0);
  assert.equal(inviteCount(lib), 0);
  assert.throws(() => lib.invite(EMAIL, { email: EMAIL, reason: 'manual', projectId: 'PRJ-2', title: 'Again', tenant: TENANT }, USER), err => err.code === 'SUBJECT_ERASED');
  assert.equal(inviteCount(lib), 0);
});

test('a privacy delete that fails keeps the invitation and the erasure mark', async () => {
  const lib = open();
  const saved = await lib.upsert(USER, { localId: 'p2', reference: REF() });
  lib.sql.exec('UPDATE refs SET next_review = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', saved.id);
  lib.invite(EMAIL, { email: EMAIL, reason: 'manual', projectId: 'PRJ-1', title: 'Open', tenant: TENANT }, USER);
  const orig = lib.log.bind(lib);
  lib.log = (...args) => { if (args[2] === 'privacy delete') throw new Error('stop'); return orig(...args); };
  await assert.rejects(() => privacyRoutes({ method: 'POST', parts: ['privacy', 'delete'], user: USER, lib, env: {}, body: {} }));
  assert.equal(inviteCount(lib), 1);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM invitation_erasure WHERE email = ? AND tenant = ?', EMAIL, TENANT)[0].n, 0);
});
