// invite() stores the caller's tenant. invitations() must list that same tenant
// when enforcement is off, and a blank tenant still lists only blank rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

test('an unenforced invitation list uses the tenant invite stored', () => {
  const l = new Library(memorySql(), { now: () => '2026-11-08T00:00:00.000Z' });
  const user = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: false };
  const created = l.invite(user.email, { email: user.email, reason: 'manual', projectId: 'PRJ-LOCAL', title: 'Local' }, user);
  assert.equal(String(created.tenant).toLowerCase(), TENANT);
  assert.equal(l.invitations(user).some(row => row.id === created.id), true);
  const reviewer = { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer', tenant: TENANT, tenantEnforced: false, all: true };
  assert.equal(l.invitations(reviewer).some(row => row.id === created.id), true);
  const blank = { email: 'bea@example.test', mail: 'bea@example.test', role: 'user', tenant: '', tenantEnforced: false };
  const blankRow = l.invite(blank.email, { email: blank.email, reason: 'manual', projectId: 'PRJ-BLANK', title: 'Blank' }, blank);
  assert.equal(blankRow.tenant, '');
  assert.equal(l.invitations(blank).some(row => row.id === blankRow.id), true);
  assert.equal(l.invitations(user).some(row => row.id === blankRow.id), false);
  assert.equal(l.invitations(blank).some(row => row.id === created.id), false);
  assert.equal(l.invitations({ ...reviewer, tenant: '' }).some(row => row.id === blankRow.id), true);
  assert.equal(l.invitations({ ...reviewer, tenant: '' }).some(row => row.id === created.id), false);
});
