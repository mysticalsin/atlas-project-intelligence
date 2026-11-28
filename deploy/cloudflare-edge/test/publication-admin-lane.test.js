// An admin bypass stays in force when a lane approves. A change request ends it.
// Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationStatus, publicationTransition } from '../src/publication.js';

const ready = { status: 'ready', score: 90 };
const at = '2026-11-12T00:00:00.000Z';

function bypass(extra = {}) {
  return {
    version: 1,
    withdrawn: false,
    test: false,
    quality: ready,
    validation: {
      status: 'admin_bypass',
      managerDecision: 'pending',
      presalesDecision: 'pending',
      by: 'admin@example.test',
      at: '2026-11-01T00:00:00.000Z',
      note: 'admin publish',
    },
    ...extra,
  };
}

function decide(state, lane, decision, note = '') {
  return publicationTransition(state, {
    type: 'decided', id: 'story-1', lane, decision, by: 'sam@example.test', at, note,
  });
}

test('one lane approval keeps an admin-published story published', () => {
  const result = decide(bypass(), 'manager', 'approved');
  assert.equal(result.ok, true);
  assert.equal(result.state.validation.status, 'admin_bypass');
  assert.equal(result.state.validation.managerDecision, 'approved');
  assert.equal(result.state.validation.presalesDecision, 'pending');
  assert.equal(result.status, 'published');
  assert.equal(publicationStatus(result.state), 'published');
});

test('both lane approvals keep an admin-published story published', () => {
  const first = decide(bypass(), 'manager', 'approved');
  const second = decide(first.state, 'presales', 'approved');
  assert.equal(second.ok, true);
  assert.equal(second.state.validation.status, 'admin_bypass');
  assert.equal(second.state.validation.presalesDecision, 'approved');
  assert.equal(second.status, 'published');
});

test('a change request ends an admin bypass', () => {
  const result = decide(bypass(), 'manager', 'changes_requested', 'Name the source.');
  assert.equal(result.ok, true);
  assert.equal(result.state.validation.status, 'changes_requested');
  assert.equal(result.status, 'changes_requested');
});

test('lane approvals keep an admin test copy out of the customer pool', () => {
  const copy = bypass({ test: true, quality: null, validation: {
    status: 'admin_bypass', managerDecision: 'pending', presalesDecision: 'pending', by: 'admin@example.test', at: '2026-11-01T00:00:00.000Z', note: 'admin test',
  } });
  assert.equal(publicationStatus(copy), 'admin_test');
  const first = decide(copy, 'manager', 'approved');
  assert.equal(first.status, 'admin_test');
  assert.equal(first.state.test, true);
  assert.equal(first.state.validation.status, 'admin_bypass');
  const readyCopy = { ...first.state, quality: ready };
  const second = decide(readyCopy, 'presales', 'approved');
  assert.equal(second.state.validation.status, 'admin_bypass');
  assert.equal(second.state.validation.managerDecision, 'approved');
  assert.equal(second.state.validation.presalesDecision, 'approved');
  assert.equal(second.status, 'admin_test');
  assert.notEqual(second.status, 'published');
});

test('a story that is not an admin bypass still needs both lanes', () => {
  const state = {
    version: 1,
    withdrawn: false,
    test: false,
    quality: ready,
    validation: { status: 'pending', managerDecision: 'pending', presalesDecision: 'pending', by: '', at: '', note: '' },
  };
  const first = decide(state, 'manager', 'approved');
  assert.equal(first.state.validation.status, 'pending');
  assert.equal(first.status, 'awaiting_validation');
  const second = decide(first.state, 'presales', 'approved');
  assert.equal(second.state.validation.status, 'validated');
  assert.equal(second.status, 'published');
});
