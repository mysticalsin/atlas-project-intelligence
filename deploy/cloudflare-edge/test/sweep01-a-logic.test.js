// Sweep 01 group 9. L5 is copied from PR #31 at 96712474b59d6b058ef00479f2bb2d4eb065801e.
// The other tests in that file belong to other groups and are not on this branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as profile from '../src/profile.js';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';

const lib = () => new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });

test('L5 profile retention compares instants, and keeps a seen_at it cannot parse', () => {
  const store = lib();
  const tenant = 'abcdefab-cdef-4abc-8def-0123456789ab';
  profile.ensure(store);
  const now = '2026-11-21T00:00:00.000Z';
  const cutoff = new Date(Date.parse(now) - 395 * 86400000).toISOString();
  const sameInstant = cutoff.replace(/Z$/, '+00:00');
  assert.equal(Date.parse(cutoff), Date.parse(sameInstant));
  const older = new Date(Date.parse(cutoff) - 86400000).toISOString();
  const insert = (subject, seen) => sqlOf(store).exec(
    'INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    subject, tenant, subject, '{}', '{}', '{}', seen, seen, seen,
  );
  insert('same-z@example.test', cutoff);
  insert('same-offset@example.test', sameInstant);
  insert('older@example.test', older);
  insert('unparsed@example.test', 'not-a-date');
  profile.daily(store, now, { tenantEnforced: true, tenant });
  const left = store.rows('SELECT email FROM profiles').map(r => r.email);
  assert.ok(left.includes('same-offset@example.test'));
  assert.ok(left.includes('same-z@example.test'));
  assert.ok(left.includes('unparsed@example.test'));
  assert.equal(left.includes('older@example.test'), false);
});
