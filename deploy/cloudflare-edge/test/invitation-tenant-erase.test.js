// ATLAS-INVITE-TENANT-UNENFORCED and ATLAS-ERASE-LEAVES-INVITATIONS.
// Harness: test/sqlite.js memorySql, the Durable Object SQL stand-in.
// Round 1 creates the sender through Library.invite and erases through
// POST /api/library/privacy/delete and POST /api/me/erase.
// Round 3 tests below are pinning (characterization) tests: they pass on
// 5e5c5bb. They fail if the 60-character gate, the 200-character store, or
// the changes() count is altered. There is no admin whole-tenant invitation
// erase and no invite-revoke erase in this tree.
// workerd 2026-10-23 is not required for this file. The full edge
// suite still runs the workerd probes when that binary is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { str } from '../src/util.js';
import { session, ENV as ACCESS_ENV, ORIGIN } from './security-harness.js';

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

const ENTRA = '11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TWIN = '11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb';
const LONG_MAIL = 'alexandra.consultant.security.review@corporate-division.example.test';
const LONG_COM = 'alexandra.consultant.security.review@corporate-division.example.com';
const ALT_MAIL = 'ada.alt@example.test';
const ERASED = /^erased:[0-9a-f]{12}$/;

function privacyDelete(lib, email, mail = email, tenant = A) {
  return libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', {
    method: 'POST', body: '{}',
    headers: {
      'x-atlas-user': email, 'x-atlas-role': 'user', 'x-atlas-email': mail,
      'x-atlas-tenant': tenant, 'x-atlas-tenant-enforced': '1',
    },
  }), lib, { env: ENV });
}

function caller(email, mail, tenant = A, enforced = true) {
  return { email, mail, role: 'user', tenant, tenantEnforced: enforced };
}

function boundLibrary(sql) {
  const door = { DATA_MODE: 'production', ORIGIN, CSRF_SECRET: ACCESS_ENV.CSRF_SECRET };
  return {
    idFromName: () => 'global',
    get() {
      const live = new Library(sql, { now: () => STAMP });
      return { fetch: request => libraryRoutes(request, live, { env: door }) };
    },
  };
}

function limitOk() {
  return { idFromName: () => 'i', get: () => ({ fetch: async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }) }) };
}

async function scrubbedSender(actor, mail, project) {
  const lib = open();
  const sent = lib.invite(actor, { email: OTHER, title: 'Sent', projectId: project }, caller(actor, mail));
  assert.equal(sent.source, str(actor, 200));
  assert.equal(sent.source, actor);
  const response = await privacyDelete(lib, actor, mail);
  const body = await response.json();
  assert.equal(response.status, 200);
  const stored = lib.rows('SELECT source FROM invitations WHERE id = ?', sent.id)[0];
  assert.match(stored.source, ERASED);
  assert.equal(stored.source.startsWith(A), false);
  const counted = body.outcomes.find(row => row.store === 'invitations');
  assert.ok(counted, 'receipt counts invitations');
  assert.equal(counted.scrubbed >= 1, true);
}

test('a privacy delete scrubs the sender invite stored for a 73-character Entra id', async () => {
  assert.equal(ENTRA.length, 73);
  await scrubbedSender(ENTRA, ALT_MAIL, 'PRJ-ENTRA-SENT');
});

test('a privacy delete scrubs the sender invite stored for a 68-character email', async () => {
  assert.equal(LONG_MAIL.length, 68);
  await scrubbedSender(LONG_MAIL, LONG_MAIL, 'PRJ-LONG-SENT');
});

test('POST /api/me/erase deletes an Entra subject\'s received invitations and scrubs the stored sender', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP });
  const who = caller(ENTRA, ALT_MAIL);
  const sent = lib.invite(ENTRA, { email: OTHER, title: 'Sent', projectId: 'PRJ-ME-SENT' }, who);
  const toMail = lib.invite(OTHER, { email: ALT_MAIL, title: 'To mail', projectId: 'PRJ-ME-MAIL' }, caller(OTHER, OTHER));
  // invite() refuses a tid:oid: it is not an email. The row is still that subject address.
  seed(lib, { id: 'recv-entra-id', email: ENTRA, project: 'PRJ-ME-ID', title: 'To id', source: OTHER, tenant: A });
  assert.equal(sent.source, ENTRA);
  const env = {
    ...ACCESS_ENV, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: A,
    LIBRARY: boundLibrary(sql), INTERVIEW: limitOk(),
  };
  const me = await session(env, { email: ALT_MAIL, custom: { tid: A, oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: [] } });
  const response = await me.go('/api/me/erase', { method: 'POST', body: '{"confirmed":true}', headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 200);
  const stored = lib.rows('SELECT source FROM invitations WHERE id = ?', sent.id)[0];
  assert.match(stored.source, ERASED);
  assert.equal(stored.source.startsWith(A), false);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM invitations WHERE id = ?', toMail.id)[0].n, 0);
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM invitations WHERE id = 'recv-entra-id'")[0].n, 0);
});

test('POST /api/me/erase scrubs the sender invite stored for a long email', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP });
  const who = caller(LONG_MAIL, LONG_MAIL);
  const sent = lib.invite(LONG_MAIL, { email: OTHER, title: 'Sent', projectId: 'PRJ-ME-LONG' }, who);
  const received = lib.invite(OTHER, { email: LONG_MAIL, title: 'To long', projectId: 'PRJ-ME-LONG-IN' }, caller(OTHER, OTHER));
  assert.equal(sent.source, LONG_MAIL);
  const env = { ...ACCESS_ENV, LIBRARY: boundLibrary(sql), INTERVIEW: limitOk() };
  const me = await session(env, { sub: ENTRA, email: LONG_MAIL });
  const response = await me.go('/api/me/erase', { method: 'POST', body: '{"confirmed":true}', headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 200);
  const stored = lib.rows('SELECT source FROM invitations WHERE id = ?', sent.id)[0];
  assert.match(stored.source, ERASED);
  assert.equal(stored.source.startsWith(A), false);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM invitations WHERE id = ?', received.id)[0].n, 0);
});

test('a privacy delete audit line records scrubbed 0', async () => {
  const empty = open();
  const quiet = await privacyDelete(empty, 'ada@example.test');
  assert.equal(quiet.status, 200);
  const quietAudit = empty.rows("SELECT detail FROM audit WHERE action = 'privacy delete'");
  assert.equal(quietAudit.length, 1);
  assert.match(quietAudit[0].detail, /invitations 0 scrubbed 0/);

  const received = open();
  seed(received, { id: 'recv-only', email: 'ada@example.test', project: 'PRJ-RECV-ONLY', title: 'Received', source: OTHER, tenant: A });
  const response = await privacyDelete(received, 'ada@example.test');
  assert.equal(response.status, 200);
  assert.equal(received.rows("SELECT COUNT(*) AS n FROM invitations WHERE id = 'recv-only'")[0].n, 0);
  const audit = received.rows("SELECT detail FROM audit WHERE action = 'privacy delete'");
  assert.match(audit[0].detail, /invitations 1 scrubbed 0/);
});

test('a privacy delete erases an invitation whose stored tenant has a trailing space', async () => {
  const lib = open();
  const padded = A + ' ';
  const owner = caller('ada@example.test', 'ada@example.test', padded, false);
  const received = lib.invite(OTHER, { email: 'ada@example.test', title: 'Padded in', projectId: 'PRJ-PAD-IN' }, caller(OTHER, OTHER, padded, false));
  const sent = lib.invite('ada@example.test', { email: OTHER, title: 'Padded out', projectId: 'PRJ-PAD-OUT' }, owner);
  assert.equal(received.tenant, padded);
  assert.equal(sent.tenant, padded);
  const response = await privacyDelete(lib, 'ada@example.test', 'ada@example.test', A);
  assert.equal(response.status, 200);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM invitations WHERE id = ?', received.id)[0].n, 0);
  const stored = lib.rows('SELECT source, tenant FROM invitations WHERE id = ?', sent.id)[0];
  assert.match(stored.source, ERASED);
  assert.equal(stored.tenant, padded);
});

test('one privacy delete gives each sent invitation its own erased token', async () => {
  const lib = open();
  const owner = caller('ada@example.test', 'ada@example.test');
  const first = lib.invite('ada@example.test', { email: OTHER, title: 'One', projectId: 'PRJ-TOK-1' }, owner);
  const second = lib.invite('ada@example.test', { email: 'sam@example.test', title: 'Two', projectId: 'PRJ-TOK-2' }, owner);
  const response = await privacyDelete(lib, 'ada@example.test');
  assert.equal(response.status, 200);
  const rows = lib.rows('SELECT source FROM invitations WHERE id IN (?, ?) ORDER BY id', first.id, second.id);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row.source, ERASED);
  assert.notEqual(rows[0].source, rows[1].source);
});

test('a privacy delete removes a received invitation that is scheduled, done, or dismissed', async () => {
  const lib = open();
  for (const status of ['scheduled', 'done', 'dismissed']) {
    seed(lib, { id: 'recv-' + status, email: SUBJECT, project: 'PRJ-' + status.toUpperCase(), title: status, source: OTHER, tenant: A });
    sqlOf(lib).exec('UPDATE invitations SET status = ? WHERE id = ?', status, 'recv-' + status);
  }
  const response = await erase(lib);
  assert.equal(response.status, 200);
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM invitations WHERE id IN ('recv-scheduled', 'recv-done', 'recv-dismissed')")[0].n, 0);
});

test('a privacy delete that throws from the audit log returns no counts and leaves the rows unchanged', async () => {
  const lib = open();
  seed(lib, { id: 'recv-roll', email: SUBJECT, project: 'PRJ-ROLL', title: 'Received', source: OTHER, tenant: A });
  seed(lib, { id: 'sent-roll', email: OTHER, project: 'PRJ-ROLL-S', title: 'Sent', source: SUBJECT, tenant: A });
  const before = lib.rows('SELECT * FROM invitations ORDER BY id');
  const orig = lib.log.bind(lib);
  lib.log = (id, actor, action, detail) => {
    if (action === 'privacy delete') throw new Error('disk');
    return orig(id, actor, action, detail);
  };
  const response = await erase(lib);
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.error, 'The deletion did not finish. Nothing was removed.');
  assert.equal(Object.hasOwn(body, 'outcomes'), false);
  assert.equal(Object.hasOwn(body, 'removed'), false);
  assert.equal(Object.hasOwn(body, 'scrubbed'), false);
  assert.deepEqual(lib.rows('SELECT * FROM invitations ORDER BY id'), before);
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM audit WHERE action = 'privacy delete'")[0].n, 0);
});

async function eraseOneSender(lib, subject, mail, ownId) {
  const response = await privacyDelete(lib, subject, mail);
  const body = await response.json();
  assert.equal(response.status, 200);
  const stored = lib.rows('SELECT source FROM invitations WHERE id = ?', ownId)[0];
  assert.match(stored.source, ERASED);
  const counted = body.outcomes.find(row => row.store === 'invitations');
  assert.equal(counted.removed, 0);
  assert.equal(counted.scrubbed, 1);
}

test('a privacy delete scrubs one 73-character Entra id and leaves a tid:oid twin', async () => {
  assert.equal(ENTRA.length, 73);
  assert.equal(TWIN.length, 73);
  assert.equal(ENTRA.slice(0, 60), TWIN.slice(0, 60));
  assert.notEqual(ENTRA, TWIN);
  const lib = open();
  const sent = lib.invite(ENTRA, { email: OTHER, title: 'Mine', projectId: 'PRJ-TWIN-A' }, caller(ENTRA, ALT_MAIL));
  const twin = lib.invite(TWIN, { email: 'sam@example.test', title: 'Twin', projectId: 'PRJ-TWIN-B' }, caller(TWIN, 'twin.mail@example.test'));
  const twinBefore = twin.source;
  await eraseOneSender(lib, ENTRA, ALT_MAIL, sent.id);
  assert.equal(lib.rows('SELECT source FROM invitations WHERE id = ?', twin.id)[0].source, twinBefore);
});

test('a privacy delete scrubs one long email and leaves the address that differs after 60 characters', async () => {
  assert.ok(LONG_MAIL.length > 60);
  assert.ok(LONG_COM.length > 60);
  assert.equal(LONG_MAIL.slice(0, 60), LONG_COM.slice(0, 60));
  assert.notEqual(LONG_MAIL, LONG_COM);
  const lib = open();
  const sent = lib.invite(LONG_MAIL, { email: OTHER, title: 'Test', projectId: 'PRJ-LONG-A' }, caller(LONG_MAIL, LONG_MAIL));
  const twin = lib.invite(LONG_COM, { email: 'sam@example.test', title: 'Com', projectId: 'PRJ-LONG-B' }, caller(LONG_COM, LONG_COM));
  const twinBefore = twin.source;
  await eraseOneSender(lib, LONG_MAIL, LONG_MAIL, sent.id);
  assert.equal(lib.rows('SELECT source FROM invitations WHERE id = ?', twin.id)[0].source, twinBefore);
});

test('a privacy delete still scrubs a sender whose alias is at most 60 characters', async () => {
  const actor = 'ada@example.test';
  assert.ok(actor.length <= 60);
  const lib = open();
  const sent = lib.invite(actor, { email: OTHER, title: 'Short', projectId: 'PRJ-SHORT' }, caller(actor, actor));
  assert.equal(sent.source, actor);
  await eraseOneSender(lib, actor, actor, sent.id);
});

test('a privacy delete leaves a stored 60-character prefix of a longer sender', async () => {
  const lib = open();
  const prefix = str(ENTRA, 60);
  assert.equal(prefix.length, 60);
  assert.notEqual(prefix, ENTRA.toLowerCase());
  seed(lib, { id: 'legacy-prefix', email: OTHER, project: 'PRJ-LEGACY', title: 'Legacy', source: prefix, tenant: A });
  const response = await privacyDelete(lib, ENTRA, ALT_MAIL);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(lib.rows('SELECT source FROM invitations WHERE id = ?', 'legacy-prefix')[0].source, prefix);
  assert.equal(body.outcomes.find(row => row.store === 'invitations').scrubbed, 0);
});

test('POST /api/me/erase leaves a tid:oid twin and does not count that row', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP });
  const sent = lib.invite(ENTRA, { email: OTHER, title: 'Mine', projectId: 'PRJ-ME-TWIN' }, caller(ENTRA, ALT_MAIL));
  const twin = lib.invite(TWIN, { email: 'sam@example.test', title: 'Twin', projectId: 'PRJ-ME-TWIN-B' }, caller(TWIN, 'twin.mail@example.test'));
  const twinBefore = twin.source;
  const env = {
    ...ACCESS_ENV, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: A,
    LIBRARY: boundLibrary(sql), INTERVIEW: limitOk(),
  };
  const me = await session(env, { email: ALT_MAIL, custom: { tid: A, oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: [] } });
  const response = await me.go('/api/me/erase', { method: 'POST', body: '{"confirmed":true}', headers: { 'content-type': 'application/json' } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(lib.rows('SELECT source FROM invitations WHERE id = ?', sent.id)[0].source, ERASED);
  assert.equal(lib.rows('SELECT source FROM invitations WHERE id = ?', twin.id)[0].source, twinBefore);
  assert.equal(body.counts.invitationSources, 1);
});

// Pinning. An alias of exactly 60 characters is matched through str(alias, 60)
// when that string is not the alias. invite stores the collapsed form, so the
// full-alias comparison misses it. A gate of < 60 leaves this row in place.
test('pinning: an alias of exactly 60 characters scrubs the source str collapses', async () => {
  const alias = 'a'.repeat(28) + '  ' + 'b'.repeat(30);
  assert.equal(alias.length, 60);
  const collapsed = str(alias, 60);
  assert.notEqual(collapsed, alias);
  assert.ok(collapsed.length < 60);
  const lib = open();
  const sent = lib.invite(alias, { email: OTHER, title: 'Sixty', projectId: 'PRJ-LEN-60' }, caller(alias, alias));
  assert.equal(sent.source, collapsed);
  const response = await privacyDelete(lib, alias, alias);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(lib.rows('SELECT source FROM invitations WHERE id = ?', sent.id)[0].source, ERASED);
  const counted = body.outcomes.find(row => row.store === 'invitations');
  assert.equal(counted.removed, 0);
  assert.equal(counted.scrubbed, 1);
});

// Pinning. An alias of exactly 61 characters matches its own stored source.
// Its 60-character prefix is a different sender and stays. A gate of <= 61
// scrubs that prefix.
test('pinning: an alias of exactly 61 characters leaves a different 60-character prefix', async () => {
  const alias = 'c'.repeat(61);
  const prefix = str(alias, 60);
  assert.equal(alias.length, 61);
  assert.equal(prefix.length, 60);
  assert.notEqual(prefix, alias);
  const lib = open();
  const sent = lib.invite(alias, { email: OTHER, title: 'Sixty one', projectId: 'PRJ-LEN-61' }, caller(alias, 'ada@example.test'));
  seed(lib, { id: 'prefix-61', email: 'sam@example.test', project: 'PRJ-LEN-61-PREFIX', title: 'Prefix', source: prefix, tenant: A });
  assert.equal(sent.source, alias);
  const response = await privacyDelete(lib, alias, 'ada@example.test');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(lib.rows('SELECT source FROM invitations WHERE id = ?', sent.id)[0].source, ERASED);
  assert.equal(lib.rows('SELECT source FROM invitations WHERE id = ?', 'prefix-61')[0].source, prefix);
  const counted = body.outcomes.find(row => row.store === 'invitations');
  assert.equal(counted.removed, 0);
  assert.equal(counted.scrubbed, 1);
});

// Pinning. invite caps the actor at 200. Exactly 200 is stored whole.
// Changing the cap to 199 stores a shorter source.
test('pinning: invite stores an actor of exactly 200 characters whole', () => {
  const actor = 'd'.repeat(200);
  assert.equal(actor.length, 200);
  const lib = open();
  const sent = lib.invite(actor, { email: OTHER, title: 'Two hundred', projectId: 'PRJ-CAP-200' }, caller(actor, 'ada@example.test'));
  assert.equal(sent.source, actor);
  assert.equal(sent.source.length, 200);
});

// Pinning. Exactly 201 is stored as the first 200 characters. Removing the cap
// stores the whole actor.
test('pinning: invite stores the first 200 characters of a 201-character actor', () => {
  const actor = 'e'.repeat(201);
  assert.equal(actor.length, 201);
  const lib = open();
  const sent = lib.invite(actor, { email: OTHER, title: 'Two hundred one', projectId: 'PRJ-CAP-201' }, caller(actor, 'ada@example.test'));
  assert.equal(sent.source, str(actor, 200));
  assert.equal(sent.source.length, 200);
  assert.notEqual(sent.source, actor);
});

// Pinning. The select finds two sent rows. A trigger ignores the update of one,
// so changes() sums to 1 and the select length is 2. The receipt uses changes().
test('pinning: the scrub count is changes() when that differs from the pre-write select', async () => {
  const lib = open();
  const actor = 'ada@example.test';
  const owner = caller(actor, actor);
  const first = lib.invite(actor, { email: OTHER, title: 'Counted', projectId: 'PRJ-CHG-1' }, owner);
  const second = lib.invite(actor, { email: 'sam@example.test', title: 'Skipped', projectId: 'PRJ-CHG-2' }, owner);
  assert.match(second.id, /^[0-9a-f]{32}$/);
  sqlOf(lib).exec(
    `CREATE TRIGGER invitations_skip_one BEFORE UPDATE ON invitations WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(IGNORE); END`,
  );
  const response = await privacyDelete(lib, actor);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(lib.rows('SELECT source FROM invitations WHERE id = ?', first.id)[0].source, ERASED);
  assert.equal(lib.rows('SELECT source FROM invitations WHERE id = ?', second.id)[0].source, actor);
  const counted = body.outcomes.find(row => row.store === 'invitations');
  assert.equal(counted.removed, 0);
  assert.equal(counted.scrubbed, 1);
});

async function meErase(sql, email) {
  const env = { ...ACCESS_ENV, LIBRARY: boundLibrary(sql), INTERVIEW: limitOk() };
  const me = await session(env, { sub: ENTRA, email });
  const response = await me.go('/api/me/erase', { method: 'POST', body: '{"confirmed":true}', headers: { 'content-type': 'application/json' } });
  const body = await response.json();
  return { response, body };
}

// Pinning. /api/me/erase of a short alias scrubs that sender.
test('pinning: POST /api/me/erase scrubs a short alias', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP });
  const actor = 'ada@example.test';
  assert.ok(actor.length < 60);
  const sent = lib.invite(actor, { email: OTHER, title: 'Short', projectId: 'PRJ-ME-SHORT' }, caller(actor, actor));
  assert.equal(sent.source, actor);
  const { response, body } = await meErase(sql, actor);
  assert.equal(response.status, 200);
  assert.match(lib.rows('SELECT source FROM invitations WHERE id = ?', sent.id)[0].source, ERASED);
  assert.equal(body.counts.invitationSources, 1);
});

// Pinning. The long-email twin differs after 60 characters and is not scrubbed.
test('pinning: POST /api/me/erase scrubs one long email and leaves the twin', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP });
  const sent = lib.invite(LONG_MAIL, { email: OTHER, title: 'Test', projectId: 'PRJ-ME-TWIN-LONG' }, caller(LONG_MAIL, LONG_MAIL));
  const twin = lib.invite(LONG_COM, { email: 'sam@example.test', title: 'Com', projectId: 'PRJ-ME-TWIN-COM' }, caller(LONG_COM, LONG_COM));
  const twinBefore = twin.source;
  const { response, body } = await meErase(sql, LONG_MAIL);
  assert.equal(response.status, 200);
  assert.match(lib.rows('SELECT source FROM invitations WHERE id = ?', sent.id)[0].source, ERASED);
  assert.equal(lib.rows('SELECT source FROM invitations WHERE id = ?', twin.id)[0].source, twinBefore);
  assert.equal(body.counts.invitationSources, 1);
});

// Pinning. The same sender in another tenant is not touched.
test('pinning: POST /api/me/erase leaves the same sender in another tenant', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP });
  const actor = 'ada@example.test';
  const sent = lib.invite(actor, { email: OTHER, title: 'Here', projectId: 'PRJ-ME-TENANT-A' }, caller(actor, actor));
  seed(lib, { id: 'me-other-tenant', email: OTHER, project: 'PRJ-ME-TENANT-B', title: 'There', source: actor, tenant: B });
  const { response, body } = await meErase(sql, actor);
  assert.equal(response.status, 200);
  assert.match(lib.rows('SELECT source FROM invitations WHERE id = ?', sent.id)[0].source, ERASED);
  assert.equal(lib.rows('SELECT source, tenant FROM invitations WHERE id = ?', 'me-other-tenant')[0].source, actor);
  assert.equal(lib.rows('SELECT tenant FROM invitations WHERE id = ?', 'me-other-tenant')[0].tenant, B);
  assert.equal(body.counts.invitationSources, 1);
});

// Pinning. A legacy row stored as the 60-character prefix of a longer sender
// stays, and the receipt does not count it. That is the documented residual.
test('pinning: POST /api/me/erase leaves a legacy 60-character prefix and does not count it', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP });
  const prefix = str(LONG_MAIL, 60);
  assert.equal(prefix.length, 60);
  assert.notEqual(prefix, LONG_MAIL);
  seed(lib, { id: 'me-legacy', email: OTHER, project: 'PRJ-ME-LEGACY', title: 'Legacy', source: prefix, tenant: A });
  const { response, body } = await meErase(sql, LONG_MAIL);
  assert.equal(response.status, 200);
  assert.equal(lib.rows('SELECT source FROM invitations WHERE id = ?', 'me-legacy')[0].source, prefix);
  assert.equal(Object.hasOwn(body.counts, 'invitationSources'), false);
  assert.equal(Object.hasOwn(body.counts, 'invitations'), false);
});

test('with enforcement off, a blank tenant can update its invitation and a present tenant cannot', () => {
  const lib = open();
  seed(lib, { id: 'blank-own', email: 'ada@example.test', project: 'PRJ-BLANK-OWN', title: 'Blank', source: 'ada@example.test', tenant: '' });
  const sandbox = user('', false);
  assert.equal(lib.updateInvitation(sandbox, 'blank-own', { action: 'schedule', slot: '2026-11-20T09:00' }).status, 'scheduled');
  assert.equal(statusOf(lib, 'blank-own'), 'scheduled');

  seed(lib, { id: 'blank-cross', email: 'ada@example.test', project: 'PRJ-BLANK-CROSS', title: 'Blank cross', source: 'pm', tenant: '' });
  assert.equal(lib.updateInvitation(sandbox, 'blank-cross', { action: 'schedule', slot: '2026-11-20T10:00' }).status, 'scheduled');
  assert.throws(
    () => lib.updateInvitation(user(A, false), 'blank-cross', { action: 'dismiss' }),
    err => err.status === 404 && err.message === 'Invitation not found.',
  );
  assert.equal(statusOf(lib, 'blank-cross'), 'scheduled');
});
