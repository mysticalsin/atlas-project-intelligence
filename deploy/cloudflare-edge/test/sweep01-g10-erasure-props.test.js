// Sweep 01 group 10 properties. Each test encodes the behaviour main should have.
// They fail on main. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { eraseMine } from '../src/subject-rights.js';
import * as outreach from '../src/outreach.js';

const TENANT = 'abcdefab-cdef-4abc-8def-0123456789ab';
const OTHER = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
const DIRECTORY = '11111111-2222-4333-8444-555555555555';
const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const STAMP = '2026-11-21T00:00:00.000Z';
const ORIGIN = 'https://atlas.example.test';
const HEADER = 'project_id,consultant_email,manager_email,manager_name,project_title,end_date';
const person = (email, tenant = TENANT, role = 'user') => ({ email, mail: email, role, tenant, tenantEnforced: true });
const fresh = () => new Library(memorySql(), { now: () => STAMP });
const story = (title, extra = {}) => ({
  title,
  consultant: { name: 'Ada Example', role: 'Lead' },
  answers: ['The queue was slow.', 'I owned the routing change.', 'We kept a manual fallback.', 'The board moved.', 'The dashboard export.', 'A similar desk.'],
  ...extra,
});
const reviewer = (tenant = TENANT) => ({ email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer', tenant, tenantEnforced: false });

function plantConversation(lib, { subject, email, directory = DIRECTORY, atlas = null, oid = OID }) {
  outreach.ensure(lib);
  const sql = sqlOf(lib);
  const cols = sql.exec("SELECT name FROM pragma_table_info('teams_conversations')").toArray().map(row => row.name);
  if (!cols.includes('atlas_tenant')) sql.exec('ALTER TABLE teams_conversations ADD COLUMN atlas_tenant TEXT');
  sql.exec(
    `INSERT INTO teams_conversations (subject, aad_object_id, tenant_id, teams_user_id, conversation_id, service_url, email, status, updated_at, atlas_tenant)
     VALUES (?, ?, ?, '29:user', ?, ?, ?, 'active', ?, ?)`,
    subject, oid, directory, 'a:' + subject, SERVICE, email, STAMP, atlas,
  );
}

function queueTeams(lib, { email, tenant }) {
  const inv = lib.invite('atlas', { email, reason: 'manual', projectId: 'PRJ-G10', title: 'Pilot', source: 'test', tenant });
  outreach.queue(lib, { kind: 'interview_invite', subjectId: inv.id, toEmail: email, tenant, preview: { title: 'Pilot', text: 'A short interview.' } });
  return lib.rows("SELECT * FROM outreach WHERE channel = 'teams' AND lower(to_email) = ?", email.toLowerCase())[0];
}

function approve(lib, id, user = reviewer()) {
  const calls = [];
  lib.services = { teams: { async send(ref) { calls.push(ref); return { id: 'activity-' + calls.length }; } } };
  const result = outreach.routes({
    method: 'POST', parts: ['outreach', id], user, lib, body: { action: 'approve' },
    env: { ORIGIN }, url: new URL(ORIGIN + '/api/library/outreach/' + id),
  });
  return result.then(body => ({ body, calls }));
}

test('M1 sendTeams skips an unstamped row', async () => {
  const lib = fresh();
  const email = 'ada@example.test';
  const row = queueTeams(lib, { email, tenant: TENANT });
  plantConversation(lib, { subject: `${DIRECTORY}:${OID}`, email, atlas: null });
  const first = await approve(lib, row.id);
  assert.equal(first.calls.length, 0);
  assert.equal(first.body.item.status, 'blocked_external');
  await outreach.system({
    lib,
    user: { email: 'teams-bot', role: 'system', tenant: TENANT, tenantEnforced: false },
    body: {
      kind: 'install', activityId: 'restamp-1', tenantId: DIRECTORY, aadObjectId: OID,
      teamsUserId: '29:ada', conversationId: 'a:' + `${DIRECTORY}:${OID}`, serviceUrl: SERVICE, email,
    },
  });
  const second = await approve(lib, row.id);
  assert.equal(second.calls.length, 1);
  assert.equal(second.body.item.status, 'sent');
  assert.equal(second.calls[0].tenantId, DIRECTORY);
});

test('M1 sendTeams skips a stamp for another atlas tenant', async () => {
  const lib = fresh();
  const email = 'ada@example.test';
  const row = queueTeams(lib, { email, tenant: TENANT });
  plantConversation(lib, { subject: `${DIRECTORY}:${OID}`, email, atlas: OTHER });
  const skipped = await approve(lib, row.id);
  assert.equal(skipped.calls.length, 0);
  assert.notEqual(skipped.body.item.status, 'sent');
  const other = queueTeams(lib, { email: 'bea@example.test', tenant: TENANT });
  plantConversation(lib, { subject: 'bea-subject', email: 'bea@example.test', directory: DIRECTORY, atlas: TENANT, oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  const sent = await approve(lib, other.id);
  assert.equal(sent.calls.length, 1);
  assert.equal(sent.body.item.status, 'sent');
});

test('M2 whitespace atlas_tenant is null and an empty tenant install is refused', async () => {
  for (const tenant of ['', '   ', '\u00a0']) {
    const lib = fresh();
    const before = sqlOf(lib).exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'teams_conversations'").toArray().length;
    await assert.rejects(
      () => outreach.system({
        lib,
        user: { email: 'teams-bot', role: 'system', tenant, tenantEnforced: false },
        body: {
          kind: 'install', activityId: 'blank-' + tenant.length, tenantId: DIRECTORY, aadObjectId: OID,
          teamsUserId: '29:ada', conversationId: 'a:blank', serviceUrl: SERVICE, email: 'ada@example.test',
        },
      }),
      error => error.status === 403 && error.message === 'A verified tenant is required.',
    );
    const after = sqlOf(lib).exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'teams_conversations'").toArray().length;
    assert.equal(after, before);
    if (after) assert.equal(sqlOf(lib).exec('SELECT COUNT(*) AS n FROM teams_conversations').toArray()[0].n, 0);
  }
});

test('M3 a formula address with a leading space or NBSP is rejected', async () => {
  const lib = fresh();
  const user = reviewer('');
  const csv = [
    HEADER,
    'PRJ-1,=sum(1)@example.com,sam@example.test,Sam,Pilot,',
    'PRJ-2, =sum(1)@example.com,sam@example.test,Sam,Pilot,',
    'PRJ-3,\u00a0=sum(1)@example.com,sam@example.test,Sam,Pilot,',
    'PRJ-4,sam@example.test,sam2@example.test,Sam,Pilot,',
  ].join('\n');
  const imported = await outreach.routes({ parts: ['staffing', 'import'], method: 'POST', user, lib, body: { csv }, url: new URL(ORIGIN + '/api/library/staffing/import') });
  assert.equal(imported.status || 200, 200);
  assert.ok((imported.body.rejected || []).length >= 3);
  const page = await outreach.routes({ parts: ['staffing'], method: 'GET', user, lib, url: new URL(ORIGIN + '/api/library/staffing') });
  const items = page.body.items || [];
  assert.equal(items.some(item => item.consultantEmail === 'sam@example.test'), true);
  assert.equal(items.some(item => /^=/.test(String(item.consultantEmail || ''))), false);
});

test('L1 an empty alias list deletes no rows', () => {
  const lib = fresh();
  const sql = sqlOf(lib);
  const saved = lib.upsert(person('kim@example.test'), { localId: 'kept', reference: story('Kept', { answers: ['Mail ada@example.test about the dashboard.', '', '', '', '', ''] }) });
  return saved.then(row => {
    sql.exec('CREATE TABLE staffing (project_id TEXT, consultant_email TEXT, manager_email TEXT, tenant TEXT)');
    sql.exec('INSERT INTO staffing (project_id, consultant_email, manager_email, tenant) VALUES (?, ?, ?, ?)', 'p', 'ada@example.test', '', TENANT);
    sql.exec('CREATE TABLE teams_conversations (subject TEXT PRIMARY KEY, email TEXT, tenant_id TEXT)');
    sql.exec('INSERT INTO teams_conversations (subject, email, tenant_id) VALUES (?, ?, ?)', 'subj', 'ada@example.test', DIRECTORY);
    const result = eraseMine(lib, { email: '', mail: '   ', role: 'user', tenant: TENANT, tenantEnforced: true }, 'ab'.repeat(16));
    assert.equal(result.erased, true);
    assert.equal(JSON.stringify(lib.row(row.id).data).includes('ada@example.test'), true);
    assert.equal(sql.exec('SELECT COUNT(*) AS n FROM staffing').toArray()[0].n, 1);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM teams_conversations WHERE email = 'ada@example.test'").toArray()[0].n, 1);
  });
});

test('L2 address match is case-insensitive and the selector does not use instr', async () => {
  const lib = fresh();
  const sql = sqlOf(lib);
  const ada = person('Ada@Example.TEST');
  const saved = await lib.upsert(person('kim@example.test'), {
    localId: 'case',
    reference: story('Case', { answers: ['Mail Ada@Example.TEST and keep ada@example.test.au.', '', '', '', '', ''] }),
  });
  plantConversation(lib, { subject: 'exact', email: 'Ada@Example.TEST', directory: DIRECTORY, atlas: null });
  plantConversation(lib, { subject: 'longer', email: 'ada@example.test.au', directory: DIRECTORY, atlas: null, oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  const queries = [];
  const inner = sql.exec.bind(sql);
  sql.exec = (query, ...params) => { queries.push(String(query)); return inner(query, ...params); };
  eraseMine(lib, ada, 'ab'.repeat(16));
  assert.equal(queries.some(query => /\binstr\s*\(/i.test(query)), false);
  assert.equal(JSON.stringify(lib.row(saved.id).data).includes('Ada@Example.TEST'), false);
  assert.equal(JSON.stringify(lib.row(saved.id).data).includes('ada@example.test.au'), true);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM teams_conversations WHERE lower(email) = 'ada@example.test'").toArray()[0].n, 0);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM teams_conversations WHERE email = 'ada@example.test.au'").toArray()[0].n, 1);
});

test('L3 a non-object revision loses the address', async () => {
  const lib = fresh();
  const saved = await lib.upsert(person('kim@example.test'), { localId: 'rev', reference: story('Revision') });
  const sql = sqlOf(lib);
  sql.exec('INSERT INTO revisions (id, revision, data, author, at) VALUES (?, 2, ?, ?, ?)', saved.id, JSON.stringify('mail ada@example.test please'), 'kim@example.test', STAMP);
  sql.exec('INSERT INTO revisions (id, revision, data, author, at) VALUES (?, 3, ?, ?, ?)', saved.id, JSON.stringify(['ada@example.test is here']), 'kim@example.test', STAMP);
  eraseMine(lib, person('ada@example.test'), 'ab'.repeat(16));
  const revisions = sql.exec('SELECT data FROM revisions WHERE id = ? ORDER BY revision', saved.id).toArray();
  assert.equal(revisions.some(row => String(row.data).includes('ada@example.test')), false);
});

test('D1 an unstamped teams row is deleted by exact email and a stamped other-tenant row remains', () => {
  const lib = fresh();
  plantConversation(lib, { subject: 'unstamped', email: 'ada@example.test', directory: DIRECTORY, atlas: null });
  plantConversation(lib, { subject: 'stamped', email: 'ada@example.test', directory: '99999999-9999-4999-8999-999999999999', atlas: OTHER, oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  eraseMine(lib, person('ada@example.test'), 'ab'.repeat(16));
  const left = sqlOf(lib).exec('SELECT subject, atlas_tenant FROM teams_conversations ORDER BY subject').toArray();
  assert.deepEqual(left, [{ subject: 'stamped', atlas_tenant: OTHER }]);
});

test('L1 an nbsp-only atlas_tenant is blank for erase and send', async () => {
  const lib = fresh();
  const email = 'ada@example.test';
  const row = queueTeams(lib, { email, tenant: TENANT });
  plantConversation(lib, { subject: 'nbsp', email, directory: DIRECTORY, atlas: '\u00a0' });
  plantConversation(lib, { subject: 'spaces', email: 'bea@example.test', directory: DIRECTORY, atlas: ' \u00a0 ', oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  const sent = await approve(lib, row.id);
  assert.equal(sent.calls.length, 0);
  eraseMine(lib, person(email), 'ab'.repeat(16));
  eraseMine(lib, person('bea@example.test'), 'cd'.repeat(16));
  assert.equal(sqlOf(lib).exec('SELECT COUNT(*) AS n FROM teams_conversations').toArray()[0].n, 0);
});

test('L4 an apostrophe-prefixed cell stays inert', async () => {
  const lib = fresh();
  const user = reviewer('');
  const csv = [HEADER, "PRJ-1,'=1+1@example.com,sam@example.test,Sam,Pilot,"].join('\n');
  const imported = await outreach.routes({ parts: ['staffing', 'import'], method: 'POST', user, lib, body: { csv }, url: new URL(ORIGIN + '/api/library/staffing/import') });
  assert.equal(imported.status || 200, 200);
  assert.ok((imported.body.rejected || []).length >= 1);
  const stored = lib.rows('SELECT consultant_email FROM staffing');
  assert.equal(stored.length, 0);
  assert.equal(stored.some(row => String(row.consultant_email).startsWith('=')), false);
});

test('B1 sharedWith drops every case of the subject', async () => {
  const lib = fresh();
  const ada = person('ada@example.test');
  const kim = person('kim@example.test');
  const saved = await lib.upsert(kim, { localId: 'shared', reference: story('Shared') });
  const state = lib.row(saved.id).state;
  sqlOf(lib).exec('UPDATE refs SET state = ? WHERE id = ?', JSON.stringify({ ...state, sharedWith: ['ada@example.test', 'sam@example.test', 'ADA@EXAMPLE.TEST'] }), saved.id);
  assert.equal(lib.get(ada, saved.id).access, 'full');
  eraseMine(lib, ada, 'ab'.repeat(16));
  assert.deepEqual(lib.row(saved.id).state.sharedWith, ['sam@example.test']);
  assert.throws(() => lib.get(ada, saved.id), error => error.status === 404);
  assert.equal(lib.get(kim, saved.id).id, saved.id);
});

test('B3 a sentence, sheet fields, and another tenant stay in their lanes', async () => {
  const lib = fresh();
  const sentence = 'Mail ada@example.test about the dashboard, and leave ada@example.test.au alone.';
  const saved = await lib.upsert(person('kim@example.test'), {
    localId: 'sheet',
    reference: story('Sheet', {
      answers: [sentence, '', '', '', '', ''],
      sheet: { exec: { contacts: 'ada@example.test' }, sections: { team: 'Lead ada@example.test' } },
    }),
  });
  sqlOf(lib).exec('INSERT INTO revisions (id, revision, data, author, at) VALUES (?, 2, ?, ?, ?)', saved.id, JSON.stringify({ note: 'see ada@example.test' }), 'kim@example.test', STAMP);
  const other = await lib.upsert(person('kim@example.test', OTHER), {
    localId: 'other-tenant',
    reference: story('Other', { answers: [sentence, '', '', '', '', ''] }),
  });
  eraseMine(lib, person('ada@example.test'), 'ab'.repeat(16));
  const live = JSON.stringify(lib.row(saved.id).data);
  assert.equal(live.includes('ada@example.test'), false);
  assert.equal(live.includes('ada@example.test.au'), true);
  const revision = sqlOf(lib).exec('SELECT data FROM revisions WHERE id = ? AND revision = 2', saved.id).toArray()[0];
  assert.equal(String(revision.data).includes('ada@example.test'), false);
  assert.equal(JSON.stringify(lib.row(other.id).data).includes('ada@example.test'), true);
});

test('B5 each formula lead is rejected and an embedded equals sign imports', async () => {
  const lib = fresh();
  const user = reviewer('');
  const leads = ['=cmd@example.test', '+cmd@example.test', '-cmd@example.test', '@cmd@example.test', '\tcmd@example.test', '\rcmd@example.test'];
  const lines = leads.map((address, index) => `PRJ-${index},${address},sam@example.test,Sam,Pilot,`);
  lines.push('PRJ-OK,sam=boss@example.test,sam@example.test,Sam,Pilot,');
  const imported = await outreach.routes({
    parts: ['staffing', 'import'], method: 'POST', user, lib,
    body: { csv: [HEADER, ...lines].join('\n') },
    url: new URL(ORIGIN + '/api/library/staffing/import'),
  });
  assert.equal(imported.status || 200, 200);
  assert.ok((imported.body.rejected || []).length >= leads.length);
  const stored = lib.rows('SELECT consultant_email FROM staffing').map(row => row.consultant_email);
  assert.deepEqual(stored, ['sam=boss@example.test']);
});

test('an erasure with nothing to remove still returns erased', () => {
  const lib = fresh();
  const result = eraseMine(lib, person('ada@example.test'), 'ab'.repeat(16));
  assert.equal(result.erased, true);
});
