// Sweep 01 group 2 (publication, M2). Copied from the red tests at 96712474.
// Fails on main. Not skipped and not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationTransition, initialPublication } from '../src/publication.js';

test('M2 a later approval keeps an earlier change-request note', () => {
  const asked = publicationTransition(initialPublication(), {
    type: 'decided', lane: 'manager', decision: 'changes_requested',
    note: 'Name the dashboard and the period.', by: 'manager@example.test', at: '2026-11-21T00:00:00.000Z',
  });
  assert.equal(asked.ok, true);
  const approved = publicationTransition(asked.state, {
    type: 'decided', lane: 'presales', decision: 'approved', note: '',
    by: 'presales@example.test', at: '2026-11-21T00:01:00.000Z',
  });
  assert.equal(approved.ok, true);
  assert.match(JSON.stringify(approved.state), /Name the dashboard and the period/);
});
