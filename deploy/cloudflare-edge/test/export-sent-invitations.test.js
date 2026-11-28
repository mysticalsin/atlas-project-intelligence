// A subject export used to read invitations only by recipient address.
// An invitation this person sent (source) was left out of the copy, while erasure still scrubbed it.
// A 60-character prefix is not a sender. Another tenant, a blank tenant, and another person stay out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { exportMine } from '../src/subject-rights.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = 'ada@example.test';
const ALT = 'ada.alt@example.test';
const OTHER = 'kim@example.test';
const LONG = 'a'.repeat(70) + '@example.test';

function open() {
  return new Library(memorySql(), { now: () => '2026-11-25T00:00:00.000Z' });
}

function seed(lib, row) {
  sqlOf(lib).exec(
    `INSERT INTO invitations (id, email, project_id, title, reason, slot, reference_id, status, created_at, source, tenant)
     VALUES (?, ?, ?, ?, 'manual', '', '', 'open', ?, ?, ?)`,
    row.id, row.email, row.project, row.title, row.at, row.source, row.tenant,
  );
}

test('a subject export includes invitations this person sent and received', () => {
  const lib = open();
  seed(lib, { id: 'received', email: SUBJECT, project: 'PRJ-IN', title: 'Received', at: '2026-11-01T00:00:00.000Z', source: OTHER, tenant: A });
  seed(lib, { id: 'sent', email: OTHER, project: 'PRJ-OUT', title: 'Sent', at: '2026-11-02T00:00:00.000Z', source: SUBJECT, tenant: A });
  seed(lib, { id: 'sent-case', email: OTHER, project: 'PRJ-CASE', title: 'Case', at: '2026-11-03T00:00:00.000Z', source: 'Ada@example.test', tenant: A });
  seed(lib, { id: 'sent-mail', email: OTHER, project: 'PRJ-MAIL', title: 'Mail', at: '2026-11-04T00:00:00.000Z', source: ALT, tenant: A });
  seed(lib, { id: 'self', email: SUBJECT, project: 'PRJ-SELF', title: 'Self', at: '2026-11-05T00:00:00.000Z', source: SUBJECT, tenant: A });
  seed(lib, { id: 'other-tenant', email: OTHER, project: 'PRJ-B', title: 'Other tenant', at: '2026-11-06T00:00:00.000Z', source: SUBJECT, tenant: B });
  seed(lib, { id: 'blank-tenant', email: OTHER, project: 'PRJ-BLANK', title: 'Blank', at: '2026-11-07T00:00:00.000Z', source: SUBJECT, tenant: '' });
  seed(lib, { id: 'stranger', email: OTHER, project: 'PRJ-STR', title: 'Stranger', at: '2026-11-08T00:00:00.000Z', source: 'sam@example.test', tenant: A });

  const user = { email: SUBJECT, mail: ALT, role: 'user', tenant: A, tenantEnforced: true };
  const rows = exportMine(lib, user, 'ab'.repeat(16)).invitations;
  assert.deepEqual(rows.map(row => row.id), ['received', 'sent', 'sent-case', 'sent-mail', 'self']);
  const sent = rows.find(row => row.id === 'sent');
  assert.equal(sent.email, OTHER);
  assert.equal(sent.source, SUBJECT);
  assert.equal(sent.projectId, 'PRJ-OUT');
  assert.equal(JSON.stringify(rows).includes('PRJ-B'), false);
  assert.equal(JSON.stringify(rows).includes('PRJ-BLANK'), false);
  assert.equal(JSON.stringify(rows).includes('sam@example.test'), false);
});

test('a 60-character prefix of a longer sender is not treated as that sender', () => {
  const lib = open();
  seed(lib, { id: 'prefix', email: OTHER, project: 'PRJ-PRE', title: 'Prefix', at: '2026-11-09T00:00:00.000Z', source: LONG.slice(0, 60), tenant: A });
  seed(lib, { id: 'whole', email: OTHER, project: 'PRJ-WHOLE', title: 'Whole', at: '2026-11-10T00:00:00.000Z', source: LONG, tenant: A });
  const rows = exportMine(lib, { email: LONG, mail: '', role: 'user', tenant: A, tenantEnforced: true }, 'ab'.repeat(16)).invitations;
  assert.deepEqual(rows.map(row => row.id), ['whole']);
  assert.equal(rows[0].source, LONG);
});
