// The tenant comparison is not optional, and a status write matches the status that was read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const STAMP = '2026-11-18T00:00:00.000Z';
const ada = tenant => ({ email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant, tenantEnforced: false });

function open() {
  return new Library(memorySql(), { now: () => STAMP, auditKey: 'synthetic-log-salt' });
}

test('an invitation update in another tenant is refused even when tenant enforcement is off', () => {
  const lib = open();
  const inv = lib.invite(ada(A).email, { email: ada(A).email, reason: 'manual', projectId: 'PRJ-1', title: 'Cross' }, ada(A));
  assert.equal(inv.tenant, A);
  assert.throws(() => lib.updateInvitation(ada(B), inv.id, { action: 'dismiss' }), err => err.status === 404);
  assert.equal(lib.rows('SELECT status FROM invitations WHERE id = ?', inv.id)[0].status, 'open');
});

test('a status write compares against the status that was read', () => {
  const lib = open();
  const inv = lib.invite(ada(A).email, { email: ada(A).email, reason: 'manual', projectId: 'PRJ-2', title: 'Race' }, ada(A));
  const orig = lib.exec.bind(lib);
  lib.exec = (sql, ...params) => {
    if (String(sql).includes('UPDATE invitations') && !String(sql).includes("status = 'scheduled'")) {
      lib.sql.exec("UPDATE invitations SET status = 'scheduled' WHERE id = ?", inv.id);
    }
    return orig(sql, ...params);
  };
  assert.throws(() => lib.updateInvitation(ada(A), inv.id, { action: 'dismiss' }), err => err.status === 409);
  assert.equal(lib.rows('SELECT status FROM invitations WHERE id = ?', inv.id)[0].status, 'scheduled');
});
