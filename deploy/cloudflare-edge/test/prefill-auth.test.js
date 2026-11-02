// v2.2 W1/W2 prefill authorisation: the business Project ID that routes an interview (the report's project_ref, Project Review) is kept only when
// it is one of the signed-in person's own staffing rows, read server-side under the verified identity; otherwise it is dropped (fail closed).
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

test('W1/W2: a Project ID that is not the person\'s own, or with no rows, is dropped; the page\'s own id files the interview', async () => {
  for (const rows of [['MTU-1'], []]) {
    const metrics = [], h = rig({ said: [ANSWER], metrics, session: { staffing: async () => rows } });
    await opened(h, withId('MTU-4411'));
    assert.equal(h.s.projectVerified, false); assert.equal(h.s.project.projectId, undefined);
    assert.equal(h.s.evidenceNotes().project_ref, PROJECT.id, 'never someone else\'s project');
    assert.ok(metrics.some(([n, v]) => n === 'project_unverified' && v.lookup === 1));
    assert.ok(!JSON.stringify(metrics).includes('MTU'), 'metrics carry no project content');
    cleanup();
  }
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
  assert.deepEqual(await staffingForInterview(env, { user: USER, role: 'user', mail: USER }), ['MTU-4411']);
  assert.deepEqual(await staffingForInterview(env, { user: 'nobody@example.com', role: 'user', mail: 'nobody@example.com' }), []);
  assert.equal(await staffingForInterview(env, { user: '', role: 'user', mail: '' }), null);
  assert.equal(await staffingForInterview({}, { user: USER }), null);
  assert.equal(await staffingForInterview({ LIBRARY: { idFromName: n => n, get: () => ({ fetch: async () => new Response('no', { status: 500 }) }) } }, { user: USER, mail: USER }), null);
});
