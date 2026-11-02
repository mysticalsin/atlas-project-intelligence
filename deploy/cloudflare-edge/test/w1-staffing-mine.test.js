// v2.2 W1: GET /api/library/staffing/mine, the project picker's list. A person sees only their own staffing rows, only the picker's fields; the reviewer-only full list is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';

const ORIGIN = 'https://atlas.example', HEADER = 'project_id,consultant_email,manager_email,manager_name,project_title,end_date';
const who = (email, role = 'user') => ({ email, mail: email, role });
const ALEX = who('alex@mantu.com'), JO = who('jo@mantu.com'), REV = who('rev@mantu.com', 'reviewer');
function setup() {
  const l = new Library(memorySql(), {});
  const call = async (u, method, path, body) => {
    const r = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, { method, headers: { 'x-atlas-user': u.email, 'x-atlas-role': u.role, 'x-atlas-email': u.mail, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), l, { env: { ORIGIN } });
    return { status: r.status, body: await r.json() };
  };
  return { call };
}
const CSV = [HEADER, 'PRJ-1,alex@mantu.com,sam@mantu.com,Sam Lead,Claims triage rebuild,2026-11-20', 'PRJ-2,ALEX@mantu.com,,,Grid analytics,2026-03-01', 'PRJ-3,jo@mantu.com,sam@mantu.com,Sam Lead,Someone else,2026-12-01', 'PRJ-4,alex@mantu.com,,,No end date,'].join('\n');

test('a person gets their own rows (newest end first, undated last) with only the picker fields, never another person\'s', async () => {
  const s = setup(); assert.equal((await s.call(REV, 'POST', 'staffing/import', { csv: CSV })).status, 200);
  const r = await s.call(ALEX, 'GET', 'staffing/mine');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map(x => x.projectId), ['PRJ-1', 'PRJ-2', 'PRJ-4']);
  assert.deepEqual(Object.keys(r.body.items[0]).sort(), ['confirm', 'derivedFrom', 'endDate', 'managerEmail', 'managerName', 'projectId', 'projectTitle', 'role', 'sector', 'stage']);
  assert.equal(r.body.items[0].projectTitle, 'Claims triage rebuild'); assert.equal(r.body.items[0].managerName, 'Sam Lead');
  assert.ok(!JSON.stringify(r.body).includes('Someone else') && !JSON.stringify(r.body).includes('jo@mantu.com'));
  assert.deepEqual((await s.call(JO, 'GET', 'staffing/mine')).body.items.map(x => x.projectId), ['PRJ-3']);
});
test('nobody on the list: an empty list, not an error; no email: empty; the system role never reads it', async () => {
  const s = setup();
  assert.deepEqual((await s.call(ALEX, 'GET', 'staffing/mine')).body, { items: [] });
  assert.deepEqual((await s.call({ email: 'opaque-oid', mail: '', role: 'user' }, 'GET', 'staffing/mine')).body, { items: [] });
  assert.notEqual((await s.call({ email: 'pm-system', mail: '', role: 'system' }, 'GET', 'staffing/mine')).status, 200);
});
test('the reviewer-only list and import are unchanged: a person still cannot read the full list or import', async () => {
  const s = setup(); await s.call(REV, 'POST', 'staffing/import', { csv: CSV });
  assert.equal((await s.call(ALEX, 'GET', 'staffing')).status, 403); assert.equal((await s.call(ALEX, 'POST', 'staffing/import', { csv: CSV })).status, 403);
  assert.equal((await s.call(REV, 'GET', 'staffing')).body.items.length, 4);
});
