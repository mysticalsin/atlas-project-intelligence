// The retention cutoff uses the clock captured at load.
// A later Date.parse or toISOString must not delete a finished invitation
// that is still inside the outreach period. Synthetic addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { sweep } from '../src/retention.js';
import { memorySql } from './sqlite.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = { email: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
const NOW = '2026-11-08T00:00:00.000Z';
const OLD = '2026-05-01T00:00:00.000Z';

function library(clock) {
  return new Library(memorySql(), { now: () => clock() });
}

function dismiss(lib, projectId) {
  const row = lib.invite(OWNER.email, { email: OWNER.email, reason: 'manual', projectId, title: 'Fictional queue' }, OWNER);
  return lib.updateInvitation(OWNER, row.id, { action: 'dismiss' });
}

function ids(lib) {
  return lib.rows('SELECT id FROM invitations ORDER BY id').map(row => row.id);
}

test('a patched clock does not delete a dismissed invitation inside the outreach period', () => {
  let clock = NOW;
  const lib = library(() => clock);
  const fresh = dismiss(lib, 'PRJ-FRESH');
  clock = OLD;
  const aged = dismiss(lib, 'PRJ-AGED');
  const open = lib.invite(OWNER.email, { email: 'cy@example.test', reason: 'manual', projectId: 'PRJ-OPEN', title: 'Still open' }, OWNER);
  clock = NOW;
  const honest = sweep(lib, { now: NOW, tenant: TENANT });
  assert.equal(honest.invitations, 1);
  assert.deepEqual(ids(lib), [fresh.id, open.id].sort());

  const realParse = Date.parse;
  const realIso = Date.prototype.toISOString;
  Date.parse = () => realParse('2099-01-01T00:00:00.000Z');
  Date.prototype.toISOString = function () { return '2099-01-01T00:00:00.000Z'; };
  try {
    const patched = sweep(lib, { now: NOW, tenant: TENANT });
    assert.equal(patched.invitations, undefined);
    assert.deepEqual(ids(lib), [fresh.id, open.id].sort());
    assert.equal(lib.rows('SELECT status FROM invitations WHERE id = ?', fresh.id)[0].status, 'dismissed');
    assert.equal(lib.rows('SELECT status FROM invitations WHERE id = ?', open.id)[0].status, 'open');
    assert.equal(lib.rows('SELECT id FROM invitations WHERE id = ?', aged.id).length, 0);
  } finally {
    Date.parse = realParse;
    Date.prototype.toISOString = realIso;
  }
});
