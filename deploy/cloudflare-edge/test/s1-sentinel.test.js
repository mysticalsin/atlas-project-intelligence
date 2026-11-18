// Sentinel delta on cdb55bcc. These fail on that tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { verifyChain } from '../src/audit-chain.js';
import * as profile from '../src/profile.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
const EMAIL = 'ada@example.test';
const ENV = { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' };

function store() {
  const lib = new Library(memorySql(), { now: () => '2026-11-16T00:00:00.000Z' });
  profile.ensure(lib);
  return lib;
}
function privacyDelete(lib) {
  return libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', {
    method: 'POST', body: '{}',
    headers: { 'x-atlas-user': EMAIL, 'x-atlas-role': 'user', 'x-atlas-email': EMAIL, 'x-atlas-tenant': A, 'x-atlas-tenant-enforced': '1' },
  }), lib, { env: ENV });
}

test('verifyChain compares prev_hash with the shared timing-safe helper', () => {
  const src = verifyChain.toString();
  assert.equal(/r\.prev_hash\s*!==/.test(src), false);
  assert.match(src, /sameText\(\s*r\.prev_hash\s*,\s*prevHash\s*\)/);
});

test('tenant privacy delete removes a manager-only trust row, as on main', async () => {
  const lib = store();
  const stamp = '2026-11-16T00:00:00.000Z';
  lib.sql.exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', 'kim@example.test', EMAIL, 'directory', A, stamp);
  lib.sql.exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', EMAIL, 'sam@example.test', 'directory', A, stamp);
  lib.sql.exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', 'kim@example.test', EMAIL, 'directory', B, stamp);
  const res = await privacyDelete(lib);
  assert.equal(res.status, 200);
  assert.equal(lib.sql.exec('SELECT owner FROM manager_trust WHERE tenant = ? AND owner = ?', A, 'kim@example.test').toArray().length, 0);
  assert.equal(lib.sql.exec('SELECT owner FROM manager_trust WHERE tenant = ? AND owner = ?', A, EMAIL).toArray().length, 0);
  assert.equal(lib.sql.exec('SELECT email FROM manager_trust WHERE tenant = ?', B).toArray()[0].email, EMAIL);
});

test('tenant privacy delete leaves another person\'s directory manager address, as on main', async () => {
  const lib = store();
  lib.sql.exec('INSERT INTO directory (key, source, name, manager_email, tenant) VALUES (?, ?, ?, ?, ?)', 'kim@example.test', 'dna', 'Kim', EMAIL, A);
  lib.sql.exec('INSERT INTO directory (key, source, name, manager_email, tenant) VALUES (?, ?, ?, ?, ?)', EMAIL, 'dna', 'Ada', 'sam@example.test', A);
  lib.sql.exec('INSERT INTO directory (key, source, name, manager_email, tenant) VALUES (?, ?, ?, ?, ?)', 'kim@example.test', 'dna', 'Kim', EMAIL, B);
  const res = await privacyDelete(lib);
  assert.equal(res.status, 200);
  const kim = lib.sql.exec('SELECT key, manager_email FROM directory WHERE tenant = ? AND key = ?', A, 'kim@example.test').toArray()[0];
  assert.equal(kim.key, 'kim@example.test');
  assert.equal(kim.manager_email, EMAIL);
  assert.equal(lib.sql.exec('SELECT key FROM directory WHERE tenant = ? AND key = ?', A, EMAIL).toArray().length, 0);
  assert.equal(lib.sql.exec('SELECT manager_email FROM directory WHERE tenant = ?', B).toArray()[0].manager_email, EMAIL);
});
