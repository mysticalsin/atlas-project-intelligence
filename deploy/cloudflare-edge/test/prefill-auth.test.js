// v2.2 W1/W2 prefill authorisation: the business Project ID that routes an interview (the report's project_ref, Project Review) is kept only when
// it is one of the signed-in person's own staffing rows, read server-side under the verified identity; rows without it, or a failed lookup, drop it
// (fail closed); a person with no rows at all keeps it as self-declared (not verified). W2 (decided 2 Nov 2026): role, sector and stage are derived
// server-side from the person's own projects (the staffing feed and the published reference under the same Project ID); only derived values are prefilled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { staffingForInterview, ensure } from '../src/outreach.js';
import { memorySql } from './sqlite.js';
import { rig, opened, until, cleanup, PROJECT, ANSWER, USER } from './reconnect-harness.js';

test.afterEach(cleanup);
const withId = projectId => ({ project: { ...PROJECT, projectId } });

test('W1/W2: a Project ID from the person\'s own staffing rows is kept (case-insensitive) and routes the interview', async () => {
  const h = rig({ said: [ANSWER], session: { staffing: async () => ['MTU-4411', 'MTU-9'] } });
  await opened(h, withId('mtu-4411'));
  assert.equal(h.s.projectVerified, true); assert.equal(h.s.evidenceNotes().project_ref, 'mtu-4411');
});

test('W1/W2: a Project ID that is not among the person\'s own staffing rows is dropped; the page\'s own id files the interview', async () => {
  const metrics = [], h = rig({ said: [ANSWER], metrics, session: { staffing: async () => ['MTU-1'] } });
  await opened(h, withId('MTU-4411'));
  assert.equal(h.s.projectVerified, false); assert.equal(h.s.project.projectId, undefined);
  assert.equal(h.s.evidenceNotes().project_ref, PROJECT.id, 'never someone else\'s project');
  assert.ok(metrics.some(([n, v]) => n === 'project_unverified' && v.lookup === 1 && v.kept === 0));
  assert.ok(!JSON.stringify(metrics).includes('MTU'), 'metrics carry no project content');
});

test('W1/W2: a person with no staffing rows at all keeps the Project ID as self-declared (not verified), as before the feed', async () => {
  const metrics = [], h = rig({ said: [ANSWER], metrics, session: { staffing: async () => [] } });
  await opened(h, withId('MTU-4411'));
  assert.equal(h.s.projectVerified, false); assert.equal(h.s.project.projectId, 'MTU-4411'); assert.equal(h.s.evidenceNotes().project_ref, 'MTU-4411');
  assert.ok(metrics.some(([n, v]) => n === 'project_unverified' && v.rows === 0 && v.kept === 1));
  assert.ok(!JSON.stringify(metrics).includes('MTU'), 'metrics carry no project content');
});

for (const [name, staffing] of [['an error', async () => { throw new Error('down'); }], ['no answer', async () => null], ['a malformed answer', async () => ({ items: ['MTU-4411'] })], ['a timeout', () => new Promise(() => {})]]) {
  test(`W1/W2: the lookup failing (${name}) fails closed`, async () => {
    const h = rig({ said: [ANSWER], session: { staffing, gapTimeout: 0 } });
    await opened(h, withId('MTU-4411')); await new Promise(r => setTimeout(r, 20)); // (a real timer: the lookup's timeout)
    await until(() => h.s.projectVerified !== undefined && !h.s.busy() && h.bytes.length >= 1);
    assert.equal(h.s.projectVerified, false); assert.equal(h.s.project.projectId, undefined); assert.equal(h.s.evidenceNotes().project_ref, PROJECT.id);
  });
}

test('W1/W2: no Project ID asks nothing; with no lookup configured (local tools) the page is used as before', async () => {
  let asked = 0;
  const h = rig({ said: [ANSWER], session: { staffing: async () => { asked++; return []; } } }); await opened(h);
  assert.equal(asked, 0); assert.equal(h.s.projectVerified, undefined); cleanup();
  const k = rig({ said: [ANSWER] }); await opened(k, withId('MTU-4411')); assert.equal(k.s.project.projectId, 'MTU-4411');
});

test('W1/W2: staffingForInterview reads only the verified identity\'s own rows from the LibraryStore', async () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-02T00:00:00.000Z', newId: () => 'x' }); ensure(lib);
  const row = (project_id, consultant_email) => lib.sql.exec('INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source) VALUES (?, ?, ?, ?, ?, ?, ?)', project_id, consultant_email, '', '', '', '', 'test');
  try { row('MTU-4411', USER); row('MTU-7', 'someone@example.com'); } catch (e) { assert.fail('staffing insert: ' + e.message); }
  const env = { LIBRARY: { idFromName: n => n, get: () => ({ fetch: async req => libraryRoutes(req, lib, {}) }) } };
  assert.deepEqual(await staffingForInterview(env, { user: USER, role: 'user', mail: USER }), [{ projectId: 'MTU-4411', role: '', sector: '', stage: '' }]);
  assert.deepEqual(await staffingForInterview(env, { user: 'nobody@example.com', role: 'user', mail: 'nobody@example.com' }), []);
  assert.equal(await staffingForInterview(env, { user: '', role: 'user', mail: '' }), null);
  assert.equal(await staffingForInterview({}, { user: USER }), null);
  assert.equal(await staffingForInterview({ LIBRARY: { idFromName: n => n, get: () => ({ fetch: async () => new Response('no', { status: 500 }) }) } }, { user: USER, mail: USER }), null);
});

// ---- W2: role, sector and stage derived from the person's own projects ----
const ORIGIN = 'https://atlas.example';
const who = (email, role = 'user') => ({ email, mail: email, role });
function store(now = '2026-11-02T12:00:00.000Z') {
  const lib = new Library(memorySql(), { now: () => now });
  const call = async (u, method, path, body) => {
    const r = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, { method, headers: { 'x-atlas-user': u.email, 'x-atlas-role': u.role, 'x-atlas-email': u.mail, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), lib, { env: { ORIGIN } });
    return { status: r.status, body: await r.json() };
  };
  const env = { LIBRARY: { idFromName: n => n, get: () => ({ fetch: async req => libraryRoutes(req, lib, { env: { ORIGIN } }) }) } };
  return { lib, call, env };
}
const REV = who('rev@mantu.com', 'reviewer'), ME = who(USER);
const W2_HEADER = 'project_id,consultant_email,manager_email,manager_name,project_title,end_date,role,customer_sector,project_stage,Client Name';

test('W2: the feed\'s role, customer sector and stage are read (the client name column is still ignored) and derived per project', async () => {
  const s = store();
  const csv = [W2_HEADER, `MTU-4411,${USER},sam@mantu.com,Sam,Claims triage,2026-12-01,Data engineer,Insurance,pilot,Zebracorp SA`,
    `MTU-9,${USER},,,Grid analytics,2026-03-01,,,,Zebracorp SA`, `MTU-10,${USER},,,Open,,,,,Zebracorp SA`, `MTU-11,${USER},,,Bad stage,,,,Rollout,Zebracorp SA`].join('\n');
  const r = await s.call(REV, 'POST', 'staffing/import', { csv });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.ignoredColumns, ['Client Name']);
  assert.deepEqual(r.body.rejected.map(x => x.line), [5]); assert.match(r.body.rejected[0].error, /project_stage must be one of/);
  const items = Object.fromEntries((await s.call(ME, 'GET', 'staffing/mine')).body.items.map(x => [x.projectId, x]));
  assert.deepEqual([items['MTU-4411'].role, items['MTU-4411'].sector, items['MTU-4411'].stage], ['Data engineer', 'Insurance', 'Pilot']);
  assert.deepEqual(items['MTU-4411'].derivedFrom, { role: 'staffing', sector: 'staffing', stage: 'staffing' }); assert.deepEqual(items['MTU-4411'].confirm, []);
  assert.deepEqual([items['MTU-9'].role, items['MTU-9'].sector, items['MTU-9'].stage], ['', '', 'Lessons learned'], 'an ended project is in lessons learned');
  assert.deepEqual(items['MTU-9'].derivedFrom, { stage: 'end_date' }); assert.deepEqual(items['MTU-9'].confirm, ['role', 'sector']);
  assert.deepEqual(items['MTU-10'].confirm, ['role', 'sector', 'stage']);
  const dump = JSON.stringify(s.lib.sql.exec('SELECT * FROM staffing_facts').toArray()) + JSON.stringify(s.lib.sql.exec('SELECT * FROM staffing').toArray());
  assert.ok(!dump.includes('Zebracorp'), 'the client name is never stored');
  assert.deepEqual(await staffingForInterview(s.env, { user: USER, role: 'user', mail: USER }).then(x => x.find(y => y.projectId === 'MTU-4411')),
    { projectId: 'MTU-4411', role: 'Data engineer', sector: 'Insurance', stage: 'Pilot' });
});

test('W2: a later import without the optional columns keeps the derived facts; one with an empty cell clears that fact', async () => {
  const s = store();
  await s.call(REV, 'POST', 'staffing/import', { csv: [W2_HEADER, `MTU-4411,${USER},,,Claims,,Data engineer,Insurance,Pilot,x`].join('\n') });
  await s.call(REV, 'POST', 'staffing/import', { csv: ['project_id,consultant_email,manager_email,manager_name,project_title,end_date', `MTU-4411,${USER},,,Claims,2026-12-01`].join('\n') });
  let it = (await s.call(ME, 'GET', 'staffing/mine')).body.items[0];
  assert.deepEqual([it.role, it.sector, it.stage], ['Data engineer', 'Insurance', 'Pilot']);
  await s.call(REV, 'POST', 'staffing/import', { csv: ['project_id,consultant_email,manager_email,manager_name,project_title,end_date,role', `MTU-4411,${USER},,,Claims,2026-12-01,`].join('\n') });
  it = (await s.call(ME, 'GET', 'staffing/mine')).body.items[0];
  assert.deepEqual([it.role, it.sector, it.stage], ['', 'Insurance', 'Pilot']); assert.deepEqual(it.confirm, ['role']);
});

test('W2: with no customer sector in the feed, the industry of a PUBLISHED reference under the same Project ID is used; a draft never is', async () => {
  const s = store();
  await s.call(REV, 'POST', 'staffing/import', { csv: ['project_id,consultant_email,manager_email,manager_name,project_title,end_date', `MTU-4411,${USER},,,Claims,2026-12-01`, `MTU-5,${USER},,,Other,2026-12-01`].join('\n') });
  s.lib.sql.exec(`INSERT INTO refs (id, owner, title, status, industry, data) VALUES ('r1', 'x@mantu.com', 't', 'published', 'Utilities', ?)`, JSON.stringify({ details: { projectId: 'mtu-4411' } }));
  s.lib.sql.exec(`INSERT INTO refs (id, owner, title, status, industry, data) VALUES ('r2', 'x@mantu.com', 't', 'draft', 'Banking', ?)`, JSON.stringify({ details: { projectId: 'MTU-5' } }));
  const items = Object.fromEntries((await s.call(ME, 'GET', 'staffing/mine')).body.items.map(x => [x.projectId, x]));
  assert.equal(items['MTU-4411'].sector, 'Utilities'); assert.deepEqual(items['MTU-4411'].derivedFrom, { sector: 'library' });
  assert.equal(items['MTU-5'].sector, ''); assert.ok(items['MTU-5'].confirm.includes('sector'));
});

test('W2: only the derived values are prefilled and the page\'s own role, sector and stage are replaced by them (verified)', async () => {
  const metrics = [], h = rig({ said: [ANSWER], metrics, session: { staffing: async () => [{ projectId: 'MTU-4411', role: 'Data engineer', sector: 'Utilities', stage: 'Lessons learned' }] } });
  await opened(h, withId('MTU-4411'));
  assert.deepEqual([h.s.prefill.role, h.s.prefill.sector, h.s.prefill.stage], ['Data engineer', 'Utilities', 'Lessons learned']);
  assert.deepEqual([h.s.project.role, h.s.project.sector, h.s.project.stage], ['Data engineer', 'Utilities', 'Lessons learned']);
  assert.deepEqual(h.s.prefillStatus, { role: 'verified', sector: 'verified', stage: 'verified' });
  assert.ok(metrics.some(([n, v]) => n === 'prefill_derived' && v.role === 1 && v.sector === 1 && v.stage === 1));
});

test('W2: a field with nothing derived is not prefilled: the page\'s value is to_confirm, a missing one unknown, and nothing self-declared is verified', async () => {
  const h = rig({ said: [ANSWER], session: { staffing: async () => [{ projectId: 'MTU-4411', role: '', sector: 'Utilities', stage: '' }] } });
  await opened(h, { project: { ...PROJECT, stage: '', projectId: 'MTU-4411' } });
  assert.equal(h.s.prefill.role, undefined); assert.equal(h.s.prefill.stage, undefined); assert.equal(h.s.prefill.sector, 'Utilities');
  assert.deepEqual(h.s.prefillStatus, { role: 'to_confirm', sector: 'verified', stage: 'unknown' });
});

for (const [name, staffing, project] of [['no staffing rows at all', async () => [], withId('MTU-4411')], ['a Project ID not on the rows', async () => [{ projectId: 'MTU-1', role: 'Lead', sector: 'Banking', stage: 'Pilot' }], withId('MTU-4411')],
  ['no Project ID', async () => [{ projectId: 'MTU-1', role: 'Lead', sector: 'Banking', stage: 'Pilot' }], undefined], ['a failed lookup', async () => null, withId('MTU-4411')]]) {
  test(`W2: ${name}: role, sector and stage are never prefilled from the page and read to_confirm, never another project's values`, async () => {
    const h = rig({ said: [ANSWER], session: { staffing } });
    await opened(h, project);
    for (const k of ['role', 'sector', 'stage']) assert.equal(h.s.prefill[k], undefined, k);
    assert.deepEqual(h.s.prefillStatus, { role: 'to_confirm', sector: 'to_confirm', stage: 'to_confirm' });
    assert.notEqual(h.s.project.role, 'Lead'); assert.notEqual(h.s.project.sector, 'Banking');
  });
}

test('W2: with no lookup configured (local tools) the prefill is the page\'s, as before, and no status is reported', async () => {
  const h = rig({ said: [ANSWER] }); await opened(h, withId('MTU-4411'));
  assert.equal(h.s.prefill.role, PROJECT.role); assert.equal(h.s.prefillStatus, undefined);
});
