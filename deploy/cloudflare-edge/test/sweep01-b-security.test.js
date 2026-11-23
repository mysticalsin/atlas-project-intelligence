// Sweep 01 security findings. Each test encodes the behaviour main should have.
// They fail on main. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { eraseMine } from '../src/subject-rights.js';
import * as outreach from '../src/outreach.js';

const TENANT = 'abcdefab-cdef-4abc-8def-0123456789ab';
const DIRECTORY = '11111111-2222-4333-8444-555555555555';
const person = (email, role = 'user') => ({ email, mail: email, role, tenant: TENANT, tenantEnforced: true });
const store = () => new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });
const story = (title, extra = {}) => ({
  title,
  consultant: { name: 'Ada Example', role: 'Lead' },
  answers: ['The queue was slow.', 'I owned the routing change.', 'We kept a manual fallback.', 'The board moved.', 'The dashboard export.', 'A similar desk.'],
  ...extra,
});

test('B1 erasing a merged contributor removes their access to the surviving story', async () => {
  const lib = store();
  const ada = person('ada@example.test');
  const kim = person('kim@example.test');
  const reviewer = person('rev@example.test', 'reviewer');
  const kept = await lib.upsert(kim, { localId: 'kept', reference: story('Kept story') });
  await lib.upsert(ada, { localId: 'ada-story', reference: story('Ada story') });
  const gone = lib.rows("SELECT id FROM refs WHERE owner = ?", ada.email)[0];
  await lib.merge(reviewer, { keep: kept.id, merge: gone.id });
  assert.ok((lib.row(kept.id).state.sharedWith || []).includes(ada.email));
  eraseMine(lib, ada, 'ab'.repeat(16));
  assert.throws(() => lib.get(ada, kept.id), (error) => error.status === 404);
});

test('B2 erasing a person removes their Teams conversation even when the directory tenant differs', () => {
  const lib = store();
  outreach.ensure(lib);
  sqlOf(lib).exec(
    `INSERT INTO teams_conversations (subject, aad_object_id, tenant_id, teams_user_id, conversation_id, service_url, email, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'synthetic-subject', '99999999-8888-4777-8666-555555555555', DIRECTORY, 'synthetic-teams-user',
    'synthetic-conversation', 'https://teams.example.test/emea/', 'ada@example.test', 'active', '2026-11-21T00:00:00.000Z',
  );
  eraseMine(lib, person('ada@example.test'), 'ab'.repeat(16));
  const left = sqlOf(lib).exec('SELECT email FROM teams_conversations WHERE email = ?', 'ada@example.test').toArray();
  assert.equal(left.length, 0);
});

test('B3 erasure removes an address from story text, contacts, and team notes', async () => {
  const lib = store();
  const kim = person('kim@example.test');
  const ada = person('ada@example.test');
  const saved = await lib.upsert(kim, {
    localId: 'mentions',
    reference: story('Mentioned', {
      answers: ['Mail ada@example.test about the dashboard.', '', '', '', '', ''],
      details: { consultants: [{ name: 'Ada Example', email: 'ada@example.test', role: 'Lead' }] },
      sheet: { exec: { contacts: 'ada@example.test' }, sections: { team: 'Lead ada@example.test' } },
    }),
  });
  eraseMine(lib, ada, 'ab'.repeat(16));
  assert.equal(JSON.stringify(lib.row(saved.id).data).includes('ada@example.test'), false);
  const revisions = sqlOf(lib).exec('SELECT data FROM revisions WHERE id = ?', saved.id).toArray();
  assert.equal(revisions.some(row => String(row.data).includes('ada@example.test')), false);
});

test('B3 erasure removes an address that appears only inside a sentence', async () => {
  const lib = store();
  const saved = await lib.upsert(person('kim@example.test'), {
    localId: 'sentence',
    reference: story('Sentence', {
      answers: ['The note says to mail ada@example.test about the dashboard.', '', '', '', '', ''],
    }),
  });
  eraseMine(lib, person('ada@example.test'), 'ab'.repeat(16));
  assert.equal(JSON.stringify(lib.row(saved.id).data).includes('ada@example.test'), false);
});

test('B5 a staffing address that starts like a spreadsheet formula is not returned live', async () => {
  const lib = store();
  const reviewer = { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer', tenant: '', tenantEnforced: false };
  const csv = [
    'project_id,consultant_email,manager_email,manager_name,project_title,end_date',
    'PRJ-1,=sum(1)@example.com,sam@example.test,Sam Example,Queue pilot,',
  ].join('\n');
  const url = new URL('https://atlas.example.test/api/library/staffing');
  const imported = await outreach.routes({ parts: ['staffing', 'import'], method: 'POST', user: reviewer, lib, body: { csv }, url });
  assert.equal(imported.status || 200, 200, imported.body?.error || 'import');
  const page = await outreach.routes({ parts: ['staffing'], method: 'GET', user: reviewer, lib, url });
  const items = page.body.items || [];
  const dangerous = /^[=+\-@\t\r]/;
  if (!items.length) {
    assert.ok((imported.body.rejected || []).length >= 1);
    return;
  }
  for (const item of items) {
    for (const value of Object.values(item)) assert.equal(dangerous.test(String(value)), false);
  }
});
