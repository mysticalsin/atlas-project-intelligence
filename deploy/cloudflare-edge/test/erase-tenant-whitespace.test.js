// ATLAS-ERASE-TENANT-WHITESPACE.
// Invitation erase compared tenants with SQLite trim(), which removes U+0020 only.
// journeyTenant folds the caller with JavaScript trim. A tab, newline, or other
// JavaScript space around the same tenant id was left in place.
// A different tenant, a blank tenant, a tenant with space in the middle, and a
// pad that JavaScript trim keeps (U+0085) stay. Counts still come from changes().
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { eraseSubjectInvitations } from '../src/operate.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const STAMP = '2026-11-25T00:00:00.000Z';
const SUBJECT = 'ada@example.test';
const ALT = 'ada.alt@example.test';
const OTHER = 'kim@example.test';

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

function rowOf(lib, id) {
  return lib.rows('SELECT id, email, source, tenant, status FROM invitations WHERE id = ?', id)[0];
}

test('invitation erase folds the same JavaScript whitespace journeyTenant folds', () => {
  const lib = open();
  seed(lib, { id: 'tab-in', email: SUBJECT, project: 'PRJ-TAB', title: 'Tab', source: 'pm@example.test', tenant: '\t' + A });
  seed(lib, { id: 'nl-out', email: OTHER, project: 'PRJ-NL', title: 'Newline', source: SUBJECT, tenant: A + '\n' });
  seed(lib, { id: 'sp-in', email: ALT, project: 'PRJ-SP', title: 'Spaces', source: 'pm@example.test', tenant: ' ' + A + ' ' });
  seed(lib, { id: 'nbsp-out', email: OTHER, project: 'PRJ-NB', title: 'Nbsp', source: ALT, tenant: '\u00a0' + A });
  seed(lib, { id: 'other', email: SUBJECT, project: 'PRJ-B', title: 'Other', source: SUBJECT, tenant: '\t' + B });
  seed(lib, { id: 'blank', email: SUBJECT, project: 'PRJ-BLANK', title: 'Blank', source: SUBJECT, tenant: '\t' });
  seed(lib, { id: 'mid', email: SUBJECT, project: 'PRJ-MID', title: 'Middle', source: SUBJECT, tenant: A.slice(0, 8) + '\t' + A.slice(8) });
  seed(lib, { id: 'nel', email: SUBJECT, project: 'PRJ-NEL', title: 'Nel', source: SUBJECT, tenant: '\u0085' + A });

  const result = lib.recorded(() => eraseSubjectInvitations(lib, { email: SUBJECT, mail: ALT }, A));

  assert.equal(result.removed, 2);
  assert.equal(result.scrubbed, 2);
  assert.equal(rowOf(lib, 'tab-in'), undefined);
  assert.equal(rowOf(lib, 'sp-in'), undefined);
  assert.match(rowOf(lib, 'nl-out').source, /^erased:[0-9a-f]{12}$/);
  assert.match(rowOf(lib, 'nbsp-out').source, /^erased:[0-9a-f]{12}$/);
  assert.notEqual(rowOf(lib, 'nl-out').source, rowOf(lib, 'nbsp-out').source);
  assert.equal(rowOf(lib, 'nl-out').email, OTHER);
  assert.equal(rowOf(lib, 'nbsp-out').email, OTHER);
  assert.equal(rowOf(lib, 'other').tenant, '\t' + B);
  assert.equal(rowOf(lib, 'other').source, SUBJECT);
  assert.equal(rowOf(lib, 'blank').tenant, '\t');
  assert.equal(rowOf(lib, 'blank').source, SUBJECT);
  assert.equal(rowOf(lib, 'mid').source, SUBJECT);
  assert.equal(rowOf(lib, 'nel').tenant, '\u0085' + A);
  assert.equal(rowOf(lib, 'nel').source, SUBJECT);
});
