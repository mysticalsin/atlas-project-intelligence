// The pre-sales card counts stories still waiting on pre-sales. A manager approval
// while the story needs work, or a later request for changes, is not that queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { queryMetrics } from '../src/telemetry.js';

const NOW = '2026-11-08T00:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';

function library() {
  return new Library(memorySql(), {
    now: () => NOW,
    complete: async () => JSON.stringify({ score: 90, client_value_clear: true, issues: [], recommendations: [], summary: 'Enough.' }),
  });
}

function reference() {
  return {
    title: 'Northwind pilot alias', stage: 'Pilot', sector: 'Insurance',
    consultant: { name: 'Ada', role: 'Consultant' },
    client: { name: 'Northwind Mutual', location: 'Lyon', contact: 'Ops' },
    details: { projectId: 'PRJ-SYN', country: 'France', consultants: [{ name: 'Jo', email: 'jo@example.test', role: 'PO' }] },
    answers: ['The client had a slow queue.', 'I rebuilt the routing step.', 'We kept a manual fallback.', 'The queue was shorter on the team dashboard.', 'Dashboard export v1.', 'Similar service desks.'],
    validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: true },
  };
}

const owner = { email: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
const manager = { email: 'sam@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
const presales = { email: 'noor@example.test', role: 'presales', tenant: TENANT, tenantEnforced: true };
const admin = { email: 'avery@example.test', role: 'admin', tenant: TENANT, tenantEnforced: true };

function queue(lib) {
  return queryMetrics(lib, admin, {}, {}).workflow;
}

test('manager approval counts as awaiting pre-sales only while validation is still open', async () => {
  const lib = library();
  const saved = await lib.upsert(owner, { localId: 'p', reference: reference() });
  lib.bindTrust({ role: 'system', tenant: TENANT, tenantEnforced: true }, { owner: owner.email, email: manager.email, source: 'directory', tenant: TENANT, tenantEnforced: true });
  await lib.review(owner, saved.id);
  lib.validate(manager, saved.id, { lane: 'manager', decision: 'validate' });
  assert.equal(lib.row(saved.id).status, 'needs_work');
  assert.equal(lib.row(saved.id).state.validation.managerDecision, 'approved');
  assert.equal(queue(lib).awaiting_presales, 0);
  assert.equal(queue(lib).awaiting_manager, 1);

  lib.setState(lib.row(saved.id), { ...lib.row(saved.id).state, quality: { status: 'ready', score: 90 } }, 'test', 'reviewed', '');
  assert.equal(lib.row(saved.id).status, 'awaiting_validation');
  assert.equal(queue(lib).awaiting_presales, 1);
  assert.equal(queue(lib).awaiting_manager, 0);

  lib.validate(presales, saved.id, { lane: 'presales', decision: 'request_changes', note: 'Name the source.' });
  assert.equal(lib.row(saved.id).status, 'changes_requested');
  assert.equal(lib.row(saved.id).state.validation.presalesDecision, 'changes_requested');
  assert.equal(queue(lib).awaiting_presales, 0);
  assert.equal(queue(lib).awaiting_manager, 1);
  assert.equal(queue(lib).published, 0);
});
