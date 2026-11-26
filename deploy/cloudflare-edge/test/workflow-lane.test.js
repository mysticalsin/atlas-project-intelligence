// The admin cards say "Awaiting manager" and "Awaiting pre-sales".
// Those counts follow the same rule as the journey list: a story is waiting on
// pre-sales only while its status is awaiting_validation, the manager has
// approved, and pre-sales has not. A needs-work story, or one where pre-sales
// already asked for changes, is not still waiting on that lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { queryMetrics } from '../src/telemetry.js';

const OWNER = { email: 'ada@example.test', role: 'user', tenant: 'tenant-a' };
const MGR = { email: 'sam@example.test', role: 'user', tenant: 'tenant-a' };
const PRE = { email: 'noor@example.test', role: 'presales', tenant: 'tenant-a' };
const ADMIN = { email: 'avery@example.test', role: 'admin', tenant: 'tenant-a' };
const SYS = { email: 'directory', role: 'system', tenant: 'tenant-a' };

function reference(title) {
  return {
    title, stage: 'Pilot', sector: 'Insurance', consultant: { name: 'Ada', role: 'Consultant' },
    client: { name: 'Northwind Mutual', location: 'Lyon', contact: 'Ops' },
    details: { projectId: 'PRJ-SYN', country: 'France', consultants: [{ name: 'Jo', email: 'jo@example.test', role: 'PO' }] },
    answers: [
      'The client had a slow queue.',
      'I rebuilt the routing step.',
      'We kept a manual fallback.',
      'The queue was shorter on the team dashboard.',
      'Dashboard export v1.',
      'Similar service desks.',
    ],
    validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: true },
  };
}

function library() {
  return new Library(memorySql(), {
    now: () => '2026-11-08T00:00:00.000Z',
    complete: async () => JSON.stringify({ score: 90, client_value_clear: true, issues: [], recommendations: [], summary: 'Enough.' }),
  });
}

async function withReadyQuality(lib, localId, title) {
  const saved = await lib.upsert(OWNER, { localId, reference: reference(title) });
  const row = lib.row(saved.id);
  lib.setState(row, { ...row.state, quality: { status: 'ready', score: 90 } }, 'test', 'reviewed', '');
  return saved.id;
}

test('a story is awaiting pre-sales only while that lane is still open', async () => {
  const lib = library();
  lib.bindTrust(SYS, { owner: OWNER.email, email: MGR.email, source: 'directory', tenant: 'tenant-a' });

  const needsWork = await withReadyQuality(lib, 'needs-work', 'Both approved then needs work');
  lib.validate(MGR, needsWork, { lane: 'manager', decision: 'validate' });
  lib.validate(PRE, needsWork, { lane: 'presales', decision: 'validate' });
  {
    const row = lib.row(needsWork);
    lib.setState(row, { ...row.state, quality: { status: 'needs_work', score: 40 } }, 'test', 'reviewed', '');
    assert.equal(lib.row(needsWork).status, 'needs_work');
  }

  const changes = await withReadyQuality(lib, 'changes', 'Pre-sales already asked for changes');
  lib.validate(MGR, changes, { lane: 'manager', decision: 'validate' });
  lib.validate(PRE, changes, { lane: 'presales', decision: 'request_changes', note: 'Name the queue source.' });
  assert.equal(lib.row(changes).status, 'changes_requested');

  const waitingPresales = await withReadyQuality(lib, 'presales', 'Manager approved, pre-sales still open');
  lib.validate(MGR, waitingPresales, { lane: 'manager', decision: 'validate' });
  assert.equal(lib.row(waitingPresales).status, 'awaiting_validation');

  const waitingManager = await withReadyQuality(lib, 'manager', 'Neither lane has approved');
  assert.equal(lib.row(waitingManager).status, 'awaiting_validation');

  const published = await withReadyQuality(lib, 'published', 'Both lanes approved and ready');
  lib.validate(MGR, published, { lane: 'manager', decision: 'validate' });
  lib.validate(PRE, published, { lane: 'presales', decision: 'validate' });
  assert.equal(lib.row(published).status, 'published');

  const workflow = queryMetrics(lib, ADMIN, {}, {}).workflow;
  assert.deepEqual(workflow, {
    draft: 0,
    awaiting_manager: 1,
    awaiting_presales: 1,
    published: 1,
    admin_test: 0,
    withdrawn: 0,
  });
});
