// v2.2 W2: the reviewer's queue. GET /api/library/evidence/queue is read-only and role-gated; it names the project and the consultant from the owner's
// library reference only once that reference has left its private draft (G2), lists oldest first, never lists the reviewer's own records, and drops a
// record the moment it leaves the queue. Same harness as evidence.test.js (node:sqlite).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { evidence } from '../src/evidence.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' }, OTHER = { email: 'kim@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' }, ADMIN = { email: 'ad@mantu.com', role: 'admin' };
const NOTES = (session, ref = 'PRJ-1') => ({ session_id: session, project_ref: ref, details: [
  { id: 'D-001', field: 'problem', item_id: 'item-1', quote: 'Claims were bouncing between three teams.', status: 'reported' },
  { id: 'D-002', field: 'contribution', item_id: 'item-2', quote: 'I designed and built the routing model.', status: 'reported' }] });
const REF = (title = 'Claims triage rebuild', projectId = 'PRJ-1') => ({ title, stage: 'Pilot', sector: 'Insurance', consultant: { name: 'Alex Martin', role: 'Data engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId, country: 'France', consultants: [] }, answers: ['a', 'b', 'c', 'd', 'e', 'f'], validation: { manager: { name: 'Sam', email: 'sam@mantu.com' }, managerStaff: false } });
function setup() {
  let t = 0, n = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') });
  return { l, ev: evidence(l) };
}
const queued = async (ev, owner, session, ref) => { const d = await ev.createDraftFromNotes(owner.email, NOTES(session, ref)); return ev.submit(owner.email, d.id, d.revision); };

test('only reviewers and admins get a queue; everyone else gets an empty list, never an error and never a row', async () => {
  const { ev } = setup(); await queued(ev, OWNER, 's1');
  assert.equal(ev.queue(REV).length, 1); assert.equal(ev.queue(ADMIN).length, 1);
  for (const who of [OWNER, OTHER, { email: 'x@mantu.com', role: 'external' }, { email: '', role: 'reviewer' }, 'rev@mantu.com']) assert.deepEqual(ev.queue(who), []);
});

test('a row names the project, the consultant and the quality from the submitted reference; a private draft reference is never read', async () => {
  const { l, ev } = setup();
  const ref = await l.upsert(OWNER, { localId: 'p1', reference: REF(), draft: true });
  await queued(ev, OWNER, 's1');
  let row = ev.queue(REV)[0];
  assert.deepEqual([row.project, row.consultant, row.quality], ['', '', null], 'a draft reference leaks nothing to a queue row');
  assert.equal(row.project_ref, 'PRJ-1'); assert.equal(row.claims, 2);
  l.submit(OWNER, ref.id);
  row = ev.queue(REV)[0];
  assert.deepEqual([row.project, row.consultant], ['Claims triage rebuild', 'Alex Martin']);
  assert.ok(!JSON.stringify(row).includes('Zebracorp'), 'the confidential client never rides in the queue');
  assert.ok(!JSON.stringify(row).includes('alex@mantu.com'), 'no email address either');
  assert.match(row.queued_at, /^2026-11-01T/);
});

test('the reference is matched by its local id too, and only the owner\'s own references are considered', async () => {
  const { l, ev } = setup();
  const mine = await l.upsert(OWNER, { localId: 'local-uuid-1', reference: REF('By local id', 'OTHER-ID') }); l.submit(OWNER, mine.id);
  const theirs = await l.upsert(OTHER, { localId: 'p9', reference: REF('Someone else\'s PRJ-1') }); l.submit(OTHER, theirs.id);
  await queued(ev, OWNER, 's1', 'local-uuid-1'); await queued(ev, OWNER, 's2', 'PRJ-1');
  const rows = ev.queue(REV);
  assert.equal(rows.find(r => r.project_ref === 'local-uuid-1').project, 'By local id');
  assert.equal(rows.find(r => r.project_ref === 'PRJ-1').project, '', 'another person\'s reference with the same Project ID is not this record\'s');
});

test('oldest first; a reviewer\'s own record is not in their queue; a record leaves the queue when it is decided', async () => {
  const { ev } = setup();
  const a = await queued(ev, OWNER, 's1'), b = await queued(ev, OTHER, 's2', 'PRJ-2'), own = await queued(ev, { email: REV.email, role: 'user' }, 's3', 'PRJ-3');
  assert.deepEqual(ev.queue(REV).map(r => r.id), [a.id, b.id], 'the reviewer\'s own submission is not waiting for them');
  assert.deepEqual(ev.queue(ADMIN).map(r => r.id), [a.id, b.id, own.id], 'another reviewer or an admin does see it');
  await ev.review(REV, a.id, 'clarify', { expected_revision: a.revision, reason: 'Which quarter?' });
  assert.deepEqual(ev.queue(REV).map(r => r.id), [b.id]);
  await ev.review(REV, b.id, 'approve', { expected_revision: b.revision, content_hash: b.content_hash });
  assert.deepEqual(ev.queue(REV), []);
});

test('the route: GET only, browser only, the same role rule; the list route is unchanged', async () => {
  const { l, ev } = setup(); const q = await queued(ev, OWNER, 's1');
  const call = (method, path, who) => libraryRoutes(new Request('https://atlas.test' + path, { method, headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, 'x-atlas-email': who.email }, ...(method === 'POST' ? { body: '{}' } : {}) }), l, {})
    .then(async r => ({ status: r.status, body: await r.json() }));
  const ok = await call('GET', '/api/library/evidence/queue', REV);
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.items.map(r => r.id), [q.id]);
  assert.deepEqual((await call('GET', '/api/library/evidence/queue', OWNER)).body, { items: [] });
  assert.equal((await call('POST', '/api/library/evidence/queue', REV)).status, 404);
  assert.equal((await call('GET', '/api/evidence/queue', REV)).status, 404, 'the Interview DO path has no queue');
  assert.equal((await call('GET', '/api/library/evidence', REV)).body.items.length, 1);
});

test('the owner\'s own list names their library reference (library_id) so their screen can follow it; nobody else gets that field', async () => {
  const { l, ev } = setup();
  const mine = await l.upsert(OWNER, { localId: 'local-uuid-1', reference: REF('By local id', 'OTHER-ID') }), byPid = await l.upsert(OWNER, { localId: 'p2', reference: REF('By Project ID', 'PRJ-2') });
  await queued(ev, OWNER, 's1', 'local-uuid-1'); await queued(ev, OWNER, 's2', 'PRJ-2'); await queued(ev, OWNER, 's3', 'PRJ-NONE'); await queued(ev, OWNER, 's4', null);
  const byRef = Object.fromEntries(ev.list(OWNER).map(x => [x.project_ref, x.library_id]));
  assert.equal(byRef['local-uuid-1'], mine.id); assert.equal(byRef['PRJ-2'], byPid.id);
  assert.equal(byRef['PRJ-NONE'], undefined, 'no match, no field'); assert.equal(byRef[null], undefined, 'no project, no link: never a guess by time or title');
  for (const x of ev.list(REV)) assert.ok(!('library_id' in x), 'a reviewer\'s list carries no reference id');
});
