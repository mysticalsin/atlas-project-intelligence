// A closed invitation is not scheduled again. Re-opening one against the open-scope index is a refusal, not a 500.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { INVITATION_EVENTS, INVITATION_STATUSES, invitationTransition, noteInvitation } from '../src/invitation.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = { email: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
const REFUSAL = 'This invitation is closed. Nothing was changed.';
const ref = () => ({ title: 'Northwind pilot alias', stage: 'Pilot', sector: 'Insurance', consultant: { name: 'Ada', role: 'Consultant' },
  client: { name: 'Northwind Mutual', location: 'Lyon', contact: 'Ops' },
  answers: ['The client had a slow queue.', 'I rebuilt the routing step.', 'We kept a manual fallback.', 'The queue was shorter on the team dashboard.', 'Dashboard export v1.', 'Similar service desks.'] });
const lib = () => new Library(memorySql(), { now: () => '2026-11-08T00:00:00.000Z' });

function statusOf(library, id) {
  return library.rows('SELECT status FROM invitations WHERE id = ?', id)[0].status;
}

test('a done invitation and a dismissed invitation are not scheduled again', async () => {
  const library = lib();
  const story = await library.upsert(OWNER, { localId: 'closed-invite', reference: ref() });
  const done = library.invite(OWNER.email, { email: OWNER.email, reason: 'manual', projectId: 'PRJ-DONE', referenceId: story.id, title: 'Done' }, OWNER);
  assert.equal(library.updateInvitation(OWNER, done.id, { action: 'done' }).status, 'done');
  await assert.rejects(async () => library.updateInvitation(OWNER, done.id, { action: 'schedule', slot: '2026-11-12T09:00' }), error => error.status === 409 && error.message === REFUSAL);
  assert.equal(statusOf(library, done.id), 'done');

  const dismissed = library.invite(OWNER.email, { email: OWNER.email, reason: 'manual', projectId: 'PRJ-DISMISS', title: 'Dismissed' }, OWNER);
  assert.equal(library.updateInvitation(OWNER, dismissed.id, { action: 'dismiss' }).status, 'dismissed');
  await assert.rejects(async () => library.updateInvitation(OWNER, dismissed.id, { action: 'schedule', slot: '2026-11-12T09:30' }), error => error.status === 409 && error.message === REFUSAL);
  assert.equal(statusOf(library, dismissed.id), 'dismissed');
});

test('re-opening a dismissed invitation against the open-scope index is a refusal, not a 500', async () => {
  const library = lib();
  const closed = library.invite(OWNER.email, { email: OWNER.email, reason: 'manual', projectId: 'PRJ-SCOPE', title: 'First' }, OWNER);
  assert.equal(library.updateInvitation(OWNER, closed.id, { action: 'dismiss' }).status, 'dismissed');
  const again = library.invite(OWNER.email, { email: OWNER.email, reason: 'manual', projectId: 'PRJ-SCOPE', title: 'Second' }, OWNER);
  assert.notEqual(again.id, closed.id);
  assert.equal(again.status, 'open');
  const response = await libraryRoutes(new Request('https://atlas.test/api/library/invitations/' + closed.id, {
    method: 'POST',
    body: JSON.stringify({ action: 'schedule', slot: '2026-11-12T11:00' }),
    headers: { 'content-type': 'application/json', 'x-atlas-user': OWNER.email, 'x-atlas-role': 'user', 'x-atlas-tenant': TENANT, 'x-atlas-tenant-enforced': '1' },
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, REFUSAL);
  assert.equal(statusOf(library, closed.id), 'dismissed');
  assert.equal(statusOf(library, again.id), 'open');
});

test('an open invitation can still be scheduled, and a rejected schedule logs id, phase and event only', async () => {
  const library = lib();
  const open = library.invite(OWNER.email, { email: OWNER.email, reason: 'manual', projectId: 'PRJ-OPEN', title: 'Open' }, OWNER);
  assert.equal(library.updateInvitation(OWNER, open.id, { action: 'schedule', slot: '2026-11-12T09:00' }).status, 'scheduled');
  const story = await library.upsert(OWNER, { localId: 'log-invite', reference: ref() });
  const done = library.invite(OWNER.email, { email: OWNER.email, reason: 'manual', projectId: 'PRJ-LOG', referenceId: story.id, title: 'Logged' }, OWNER);
  library.updateInvitation(OWNER, done.id, { action: 'done' });
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  try {
    await assert.rejects(async () => library.updateInvitation(OWNER, done.id, { action: 'schedule', slot: '2026-11-12T09:00' }), error => error.status === 409);
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, 1);
  const line = JSON.parse(warns[0][0]);
  assert.deepEqual(Object.keys(line).sort(), ['event', 'id', 'phase']);
  assert.deepEqual(line, { id: done.id, phase: 'done', event: 'schedule' });
  assert.equal(JSON.stringify(line).includes('@'), false);
});

const LEGAL = new Set(['open:schedule', 'open:dismiss', 'open:done', 'scheduled:schedule', 'scheduled:dismiss', 'scheduled:done']);

test('every legal invitation transition, and every other pair is rejected with id, phase and event only', () => {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  let legal = 0;
  let illegal = 0;
  try {
    for (const status of INVITATION_STATUSES) {
      for (const type of INVITATION_EVENTS) {
        const before = { id: 'inv-1', status, email: 'ada@example.test' };
        const result = invitationTransition(before, { type, email: 'ada@example.test' });
        if (LEGAL.has(status + ':' + type)) {
          legal++;
          assert.equal(result.ok, true, status + ' ' + type);
          assert.equal(result.rejection, undefined);
          assert.equal(result.state.status, type === 'schedule' ? 'scheduled' : type === 'dismiss' ? 'dismissed' : 'done');
        } else {
          illegal++;
          assert.equal(result.illegal, true, status + ' ' + type);
          assert.equal(result.state, before);
          assert.deepEqual(result.effects, []);
          assert.deepEqual(result.rejection, { id: 'inv-1', phase: status, event: type });
          noteInvitation(result, line => warns.push([JSON.stringify(line)]));
        }
      }
    }
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, illegal);
  assert.equal(legal, LEGAL.size);
  assert.equal(legal + illegal, INVITATION_STATUSES.length * INVITATION_EVENTS.length);
  assert.equal(invitationTransition({ id: 'inv-1', status: 'archived' }, { type: 'schedule' }).rejection.phase, 'unknown');
  assert.equal(invitationTransition({ id: 'inv-1', status: 'open' }, { type: 'reopen' }).rejection.event, 'unknown');
  const logged = JSON.parse(warns[0][0]);
  assert.deepEqual(Object.keys(logged).sort(), ['event', 'id', 'phase']);
});
