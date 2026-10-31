// G2 (Tony, 2026-10-31, binding): an interview is PRIVATE until the consultant clicks Submit for review. Nothing from it reaches the N+1, reviewers, admins, colleagues,
// the list, search, Ask, recommend, bids, analytics, the duplicate index, memory or the rating before that click. Audit gap closed: Art 5(1)(b) purpose limitation
// ("every interview auto-syncs to the shared library, visible to the N+1 and auto-scored").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as ask from '../src/ask.js';
import * as claims from '../src/claims.js';
import * as outreach from '../src/outreach.js';
import { memorySql } from './sqlite.js';
import { fakeModel } from '../dev/fake-model.mjs';
import { FakeStorage } from './reconnect-harness.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' }, N1 = { email: 'sam@mantu.com', role: 'user' }, MEMBER = { email: 'jo@mantu.com', role: 'user' }, OTHER = { email: 'kim@mantu.com', role: 'user' };
const REV = { email: 'rev@mantu.com', role: 'reviewer' }, ADMIN = { email: 'root@mantu.com', role: 'admin' };
const REF = (title = 'Claims triage alias') => ({ title, stage: 'Production', sector: 'Insurance', consultant: { name: 'Alex', role: 'Data engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', teamSize: 6, technologies: ['Python'], deliverables: ['Routing model'], serviceLines: ['Data & AI'], consultants: [{ name: 'Jo', email: 'jo@mantu.com', role: 'PO' }], links: [] },
  answers: ['Claims bounced between three teams, slowing payouts for customers across the region.', 'I designed and built the claims routing model and ran the pilot.', 'We compared rules against a model and chose the model.',
    'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.', 'Operations dashboard export v3, before and after quarters.', 'Any insurer with manual claims routing would benefit.'],
  validation: { manager: { name: 'Sam', email: 'sam@mantu.com' }, managerStaff: false } });
const EMBED = async t => [/claims|triage|routing|payout/i.test(t) ? 1 : 0, 0.1, 0.05];
function world() {
  let t = 0; const calls = { complete: 0, embed: 0 }, fake = fakeModel();
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 9, 31, 8, 0, t++)).toISOString(), complete: async m => { calls.complete++; return fake.complete(m); }, embed: async x => { calls.embed++; return EMBED(x); } });
  outreach.ensure(l);
  l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('PRJ-1', 'alex@mantu.com', 'sam@mantu.com', 'Sam', '', '', 'staffing-csv', 'x')");
  return { l, calls };
}
const draft = (l, data = REF(), localId = 'p1') => l.upsert(OWNER, { localId, reference: data, draft: true });
const VIEWERS = { 'the resolved N+1': N1, 'a listed consultant': MEMBER, 'another user': OTHER, 'a reviewer': REV, 'an admin': ADMIN };

test('G2 private draft: owner-only. The N+1, a listed consultant, another user, a reviewer and an admin get 404 on every read, and it is in no list or search', async () => {
  const { l } = world(), saved = await draft(l);
  assert.equal(saved.status, 'draft'); assert.equal(saved.revision, 1);
  for (const [who, u] of Object.entries(VIEWERS)) {
    assert.throws(() => l.get(u, saved.id), /not found/, who);
    assert.throws(() => l.revision(u, saved.id, 1), /not found/, who);
    assert.equal(l.list(u).total, 0, who + ': not listed');
    assert.equal(l.list(u, { q: 'claims' }).total, 0, who + ': not searchable');
    assert.equal(l.list(u, { q: 'zebracorp' }).total, 0, who + ': not searchable by client either');
    assert.equal(l.list(u, { status: 'draft' }).total, 0, who);
    assert.throws(() => l.validate(u, saved.id, { decision: 'validate' }), /not found/, who + ': cannot validate it');
    assert.throws(() => l.withdraw(u, saved.id), /not found/, who + ': cannot withdraw it');
    assert.equal(l.access(l.row(saved.id), u), null, who);
  }
  const mine = l.get(OWNER, saved.id);
  assert.equal(mine.status, 'draft'); assert.equal(mine.permissions.submit, true); assert.equal(mine.permissions.validate, false);
  assert.equal(l.list(OWNER).total, 1); assert.equal(l.list(OWNER, { mine: '1' }).items[0].status, 'draft'); assert.equal(l.list(OWNER, { q: 'claims' }).total, 1);
  assert.equal(l.canEdit(l.row(saved.id), REV), false, 'a reviewer cannot even edit it'); assert.equal(l.canEdit(l.row(saved.id), MEMBER), false);
});

test('G2 private draft: not analytics, not export, not the duplicate index, not the stale-review scan, not merged, never rated', async () => {
  const { l, calls } = world(), saved = await draft(l);
  assert.equal(l.analytics(REV).totals.visible, 0, 'analytics for reviewers: nothing');
  assert.equal(l.analytics(OWNER).totals.visible, 0, 'a draft is not counted even in its owner\'s analytics (processing pool)');
  assert.deepEqual(l.exportAll(REV).references, [], 'the reviewer export never carries a draft');
  assert.ok(l.rows("SELECT 1 FROM audit WHERE action = 'export' AND actor = ?", REV.email).length === 1, 'and the export itself is audited (no content)');
  await l.index(saved.id); assert.equal(l.row(saved.id).embedding, null, 'not embedded'); assert.equal(calls.embed, 0, 'no embedding call');
  const twin = await l.upsert(OTHER, { localId: 'twin', reference: REF('Claims triage alias twin') }); await l.index(twin.id);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM duplicate_pairs')[0].n, 0, 'no duplicate pair with a draft, in either direction');
  assert.deepEqual(l.get(OTHER, twin.id).state.duplicates, []);
  l.sql.exec("UPDATE refs SET next_review = '2020-01-01T00:00:00.000Z'"); assert.equal(l.scanStale(), 1, 'only the submitted twin is invited for a six-month update, never the draft');
  await assert.rejects(l.merge(REV, { keep: twin.id, merge: saved.id }), /two different active references/);
  await assert.rejects(l.review(OWNER, saved.id), /Submit this reference for review first/);
  await assert.rejects(l.review(REV, saved.id), /not found/);
  assert.equal(calls.complete, 0, 'no model call for a draft: not rated');
  assert.equal(l.row(saved.id).quality_score, null);
  assert.throws(() => l.reinstate(REV, saved.id), /not found/);
});

test('G2 private draft: Ask, recommend and a bid-style processing pool never use a draft (not even their owner\'s own), a published reference still works', async () => {
  const { l } = world();
  const d = await draft(l, REF('Claims triage draft'));
  const pub = await l.upsert(OTHER, { localId: 'pub', reference: { ...REF('Claims routing published'), validation: { manager: { name: '', email: '' }, managerStaff: true } } });
  const row = l.row(pub.id); l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', by: 't', at: '', note: '' } }, 't', 'validated', ''); await l.index(pub.id);
  const asked = (await ask.routes({ method: 'POST', parts: ['ask'], body: { question: 'Which claims triage routing references do we have?' }, user: { mail: OWNER.email, ...OWNER }, lib: l, env: {} })).body;
  const ids = asked.results.map(r => r.id); assert.ok(ids.includes(pub.id), 'the published one is found'); assert.ok(!ids.includes(d.id), 'Ask never returns a draft, not even to its owner');
  const rec = await l.recommend(OWNER, { query: 'A claims triage and routing project for an insurer' });
  assert.ok(rec.results.every(r => r.id !== d.id), 'recommend never returns a draft');
  assert.ok(!l.visibleRows(OWNER, { processing: true }).some(([r]) => r.id === d.id) && l.visibleRows(OWNER).some(([r]) => r.id === d.id), 'the plain list keeps the owner\'s draft; the processing pool does not');
  assert.ok(l.visibleRows(REV, { processing: true }).every(([r]) => r.id !== d.id));
  // bids.js and ask.js both go through the processing pool (the bid match reads it directly)
  for (const f of ['bids.js', 'ask.js']) assert.match(readFileSync(new URL('../src/' + f, import.meta.url), 'utf8'), /visibleRows\(user, \{ processing: true \}\)/, f);
});

test('G2 submit: only the owner, idempotent, and only then do the N+1, reviewers and the rating see it; the click is audited', async () => {
  const { l, calls } = world(), saved = await draft(l);
  for (const u of [OTHER, MEMBER, REV, ADMIN, N1]) assert.throws(() => l.submit(u, saved.id), /not found/, u.email);
  assert.equal(l.row(saved.id).state.draft, true);
  const done = l.submit(OWNER, saved.id);
  assert.equal(done.status, 'in_review'); assert.equal(done.unchanged, false); assert.equal(l.row(saved.id).state.draft, false);
  assert.equal(l.get(N1, saved.id).access, 'full', 'the resolved N+1 can open it now'); assert.equal(l.get(REV, saved.id).access, 'full'); assert.equal(l.get(MEMBER, saved.id).access, 'full');
  assert.equal(l.list(REV).total, 1); assert.equal(l.analytics(REV).totals.visible, 1);
  assert.ok(l.rows("SELECT 1 FROM audit WHERE id = ? AND action = 'submitted for review' AND actor = ?", saved.id, OWNER.email).length === 1);
  assert.equal(l.submit(OWNER, saved.id).unchanged, true, 'a second click changes nothing');
  await l.review(OWNER, saved.id); assert.ok(calls.complete >= 1, 'now the review agent runs'); assert.equal(l.get(OWNER, saved.id).state.quality.engine !== undefined, true);
});

test('G2 phases: a draft stays a draft across edits; a submitted reference is never turned back into one; a plain save (no draft flag) is the old behaviour', async () => {
  const { l } = world(), d = await draft(l), edited = REF(); edited.answers[3] += ' Payouts were faster.';
  const again = await l.upsert(OWNER, { localId: 'p1', reference: edited, draft: true });
  assert.equal(again.revision, 2); assert.equal(again.status, 'draft'); assert.equal(l.get(OWNER, d.id).revisions.length, 2);
  assert.equal((await l.upsert(OWNER, { localId: 'p1', reference: edited })).status, 'draft', 'an update without the flag does not publish a draft either');
  l.submit(OWNER, d.id);
  const third = REF(); third.answers[3] += ' And fewer escalations.';
  const after = await l.upsert(OWNER, { localId: 'p1', reference: third, draft: true });
  assert.equal(after.status, 'in_review', 'once submitted, an edit reopens review as before and is not a draft'); assert.equal(l.row(d.id).state.draft, false);
  const plain = await l.upsert(OTHER, { localId: 'x', reference: REF('Plain save') });
  assert.equal(plain.status, 'in_review', 'API callers that do not ask for a draft (imports, the old page) are unchanged');
});

test('G2 confirmations: a draft\'s sentences are never put in a request to the N+1 or a client', async () => {
  const { l } = world(), d = await draft(l);
  await assert.rejects(async () => claims.routes({ method: 'POST', parts: ['confirmations'], body: { refId: d.id, kind: 'manager', claimIds: ['x'] }, user: { ...OWNER, mail: OWNER.email }, lib: l, env: {} }), e => e.status === 409 && /Submit this reference for review first/.test(e.message));
});

test('G2 routes: POST /:id/submit starts the automatic review in the background (once) and is rate limited; a draft save does not review', async () => {
  const { l, calls } = world(), storage = new FakeStorage(), bg = [];
  const call = (path, method, body, user = OWNER) => libraryRoutes(new Request('https://atlas.internal/api/library' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'x-atlas-user': user.email, 'x-atlas-role': user.role, 'x-atlas-email': user.email, 'x-atlas-subj': 'a'.repeat(32) } }), l, { waitUntil: p => { bg.push(p); }, storage, env: {} });
  const saved = await (await call('', 'POST', { localId: 'r1', reference: REF(), draft: true })).json();
  await Promise.all(bg.splice(0)); assert.equal(saved.status, 'draft'); assert.equal(calls.complete, 0, 'saving a draft starts no review');
  assert.equal((await call('/' + saved.id + '/submit', 'POST', {}, OTHER)).status, 404);
  const sub = await call('/' + saved.id + '/submit', 'POST', {}); assert.equal(sub.status, 200); assert.equal((await sub.json()).status, 'in_review');
  await Promise.all(bg.splice(0)); assert.ok(calls.complete >= 1, 'the review started after the click');
  const before = calls.complete; await call('/' + saved.id + '/submit', 'POST', {}); await Promise.all(bg.splice(0)); assert.equal(calls.complete, before, 'a second click does not review again');
  // rate limit: 60 submits per hour per person
  let last; for (let i = 0; i < 62; i++) last = await call('/' + saved.id + '/submit', 'POST', {});
  assert.equal(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) > 0);
});

test('G2 client: the sync asks for a draft, a Submit for review button exists, and the Library copy no longer says "automatically" or "published to everyone"', () => {
  const app = readFileSync(new URL('../../../src/app.js', import.meta.url), 'utf8'), shell = readFileSync(new URL('../../../src/shell.html', import.meta.url), 'utf8');
  assert.match(app, /body:\{localId:p\.id,id:p\.library\?\.id\|\|undefined,reference:body,draft:true\}/, 'autoSave and every sync save the private draft');
  assert.match(app, /data-submit-ref/); assert.match(app, /\/submit',\{method:'POST'/); assert.match(app, /atlas-submitted/, 'the read-back\'s Submit for review click carries over to the story');
  const intro = /id="library"[\s\S]{0,900}/.exec(shell)[0];
  assert.doesNotMatch(intro, /automatically|published to everyone/i); assert.match(intro, /private draft/i); assert.match(intro, /Submit for review/);
  assert.doesNotMatch(app + shell, /appears here automatically|land here automatically/i);
});
