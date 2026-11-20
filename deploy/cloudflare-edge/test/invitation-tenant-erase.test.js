// ATLAS-INVITE-TENANT-UNENFORCED and ATLAS-ERASE-LEAVES-INVITATIONS.
// Harness: test/sqlite.js memorySql, the Durable Object SQL stand-in.
// workerd 2026-10-23 is not required for these four tests. The full edge
// suite still runs the workerd probes when that binary is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const STAMP = '2026-11-08T00:00:00.000Z';
const SUBJECT = 'Ada@Example.test';
const MAIL = 'Ada.Alt@Example.test';
const OTHER = 'kim@example.test';
const ENV = { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' };

function open() {
  return new Library(memorySql(), { now: () => STAMP });
}

function seed(lib, row) {
  sqlOf(lib).exec(
    `INSERT INTO invitations (id, email, project_id, title, reason, slot, reference_id, status, created_at, source, tenant)
     VALUES (?, ?, ?, ?, 'manual', '', '', 'open', ?, ?, ?)`,
    row.id, row.email, row.project, row.title, STAMP, row.source, row.tenant,
  );
}

function statusOf(lib, id) {
  return lib.rows('SELECT status FROM invitations WHERE id = ?', id)[0].status;
}

function user(tenant, enforced, extra = {}) {
  return { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant, tenantEnforced: enforced, ...extra };
}

test('with enforcement off, a caller from tenant B cannot update tenant A\'s invitation', () => {
  const lib = open();
  seed(lib, { id: 'own', email: 'ada@example.test', project: 'PRJ-OWN', title: 'Own', source: 'ada@example.test', tenant: A });
  const owner = user(A, false);
  assert.equal(lib.updateInvitation(owner, 'own', { action: 'schedule', slot: '2026-11-20T09:00' }).status, 'scheduled');

  seed(lib, { id: 'cross', email: 'ada@example.test', project: 'PRJ-CROSS', title: 'Cross', source: 'pm', tenant: A });
  const intruder = user(B, false);
  assert.throws(
    () => lib.updateInvitation(intruder, 'cross', { action: 'dismiss' }),
    err => err.status === 404 && err.message === 'Invitation not found.',
  );
  assert.equal(statusOf(lib, 'cross'), 'open');

  seed(lib, { id: 'review', email: 'ada@example.test', project: 'PRJ-REV', title: 'Review', source: 'pm', tenant: A });
  const reviewer = user(B, false, { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer' });
  assert.throws(
    () => lib.updateInvitation(reviewer, 'review', { action: 'dismiss' }),
    err => err.status === 404 && err.message === 'Invitation not found.',
  );
  assert.equal(statusOf(lib, 'review'), 'open');
});

test('with enforcement on, a caller from tenant B cannot update tenant A\'s invitation', () => {
  const lib = open();
  seed(lib, { id: 'own-on', email: 'ada@example.test', project: 'PRJ-OWN-ON', title: 'Own', source: 'ada@example.test', tenant: A });
  assert.equal(lib.updateInvitation(user(A, true), 'own-on', { action: 'schedule', slot: '2026-11-20T09:30' }).status, 'scheduled');

  seed(lib, { id: 'cross-on', email: 'ada@example.test', project: 'PRJ-CROSS-ON', title: 'Cross', source: 'pm', tenant: A });
  assert.throws(
    () => lib.updateInvitation(user(B, true), 'cross-on', { action: 'dismiss' }),
    err => err.status === 404 && err.message === 'Invitation not found.',
  );
  assert.equal(statusOf(lib, 'cross-on'), 'open');

  seed(lib, { id: 'review-on', email: 'ada@example.test', project: 'PRJ-REV-ON', title: 'Review', source: 'pm', tenant: A });
  const reviewer = user(B, true, { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer' });
  assert.throws(
    () => lib.updateInvitation(reviewer, 'review-on', { action: 'dismiss' }),
    err => err.status === 404 && err.message === 'Invitation not found.',
  );
  assert.equal(statusOf(lib, 'review-on'), 'open');
});

function erase(lib) {
  return libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', {
    method: 'POST', body: '{}',
    headers: {
      'x-atlas-user': SUBJECT, 'x-atlas-role': 'user', 'x-atlas-email': MAIL,
      'x-atlas-tenant': A, 'x-atlas-tenant-enforced': '1',
    },
  }), lib, { env: ENV });
}

test('a privacy erase removes or scrubs the subject\'s sent and received invitations and the receipt counts them', async () => {
  const lib = open();
  seed(lib, { id: 'recv-email', email: SUBJECT, project: 'PRJ-RECV', title: 'Received', source: OTHER, tenant: A });
  seed(lib, { id: 'recv-mail', email: MAIL, project: 'PRJ-MAIL', title: 'Mail alias', source: OTHER, tenant: A });
  seed(lib, { id: 'sent-email', email: OTHER, project: 'PRJ-SENT', title: 'Sent', source: SUBJECT, tenant: A });
  seed(lib, { id: 'sent-mail', email: 'sam@example.test', project: 'PRJ-SENT-MAIL', title: 'Sent mail', source: MAIL, tenant: A });

  const response = await erase(lib);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM invitations WHERE id IN ('recv-email', 'recv-mail')")[0].n, 0);
  const sent = lib.rows("SELECT id, email, source, status, tenant FROM invitations WHERE id IN ('sent-email', 'sent-mail') ORDER BY id");
  assert.equal(sent.length, 2);
  for (const row of sent) {
    assert.equal(row.status, 'open');
    assert.equal(row.tenant, A);
    assert.match(row.source, /^erased:[0-9a-f]{12}$/);
    assert.equal(row.source.toLowerCase().includes('ada'), false);
  }
  assert.equal(sent.find(row => row.id === 'sent-email').email, OTHER);
  assert.equal(sent.find(row => row.id === 'sent-mail').email, 'sam@example.test');

  const counted = body.outcomes.find(item => item.store === 'invitations');
  assert.ok(counted, 'receipt counts invitations');
  assert.equal(counted.removed, 2);
  assert.equal(counted.scrubbed, 2);
  assert.equal(counted.error, null);
  assert.equal(body.note.includes('invitations'), false);
  const audit = lib.rows("SELECT detail FROM audit WHERE action = 'privacy delete'");
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail, /invitations 2 scrubbed 2/);
});

test('a privacy erase leaves other subjects\' invitations untouched', async () => {
  const lib = open();
  seed(lib, { id: 'recv-email', email: SUBJECT, project: 'PRJ-RECV', title: 'Received', source: OTHER, tenant: A });
  seed(lib, { id: 'other-same', email: OTHER, project: 'PRJ-OTHER', title: 'Kim', source: OTHER, tenant: A });
  seed(lib, { id: 'other-tenant', email: SUBJECT, project: 'PRJ-B', title: 'Other tenant', source: SUBJECT, tenant: B });
  seed(lib, { id: 'blank', email: SUBJECT, project: 'PRJ-BLANK', title: 'Blank', source: SUBJECT, tenant: '' });
  const before = lib.rows("SELECT * FROM invitations WHERE id IN ('other-same', 'other-tenant', 'blank') ORDER BY id");

  const response = await erase(lib);
  assert.equal(response.status, 200);
  const after = lib.rows("SELECT * FROM invitations WHERE id IN ('other-same', 'other-tenant', 'blank') ORDER BY id");
  assert.deepEqual(after, before);
});
