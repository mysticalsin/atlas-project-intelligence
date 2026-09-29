import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, cleanReference, deriveStatus } from '../src/library.js';
import { completeness, parseReview, forModel } from '../src/review.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' }, N1 = { email: 'sam@mantu.com', role: 'user' }, OTHER = { email: 'kim@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' };
const REF = () => ({ title: 'Claims triage alias', stage: 'Production', sector: 'Insurance', consultant: { name: 'Alex', role: 'Data engineer' },
  client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', start: '2024-03', end: '2024-11', teamSize: 6, teamRoles: ['Data engineer'], technologies: ['Python'], deliverables: ['Routing model'], serviceLines: ['Data & AI'],
    consultants: [{ name: 'Jo', email: 'jo@mantu.com', role: 'PO' }], links: [{ label: 'Ticket', url: 'https://x.example/1' }, { url: 'javascript:x' }] },
  answers: ['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.', 'I designed and built the routing model and ran the pilot with two teams.',
    'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.', 'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
    'Operations dashboard export v3, before and after quarters.', 'Any insurer or service desk with manual routing and a measurable queue would benefit.'],
  validation: { manager: { name: 'Sam', email: 'SAM@mantu.com' }, managerStaff: false }, sneaky: 'dropped' });
const GOOD = JSON.stringify({ score: 90, client_value_clear: true, issues: [{ field: 'evidence', kind: 'vague', detail: 'Name the dashboard owner.' }], recommendations: ['Add the population measured.'], summary: 'Strong.' });
function lib(reply = GOOD) {
  let t = 0; const seen = [];
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, t++)).toISOString(), complete: async m => { seen.push(m); return typeof reply === 'function' ? reply() : reply; } });
  return { l, seen };
}

test('cleanReference bounds input, drops unknown fields and unsafe links, lowercases emails', () => {
  const d = cleanReference(REF());
  assert.ok(!('sneaky' in d)); assert.equal(d.details.links.length, 1); assert.equal(d.validation.manager.email, 'sam@mantu.com');
  assert.throws(() => cleanReference({ title: '' }), /title/);
});

test('create, same content does not create a revision, a change does and reopens review + validation', async () => {
  const { l } = lib();
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  assert.equal(a.revision, 1); assert.equal(a.status, 'in_review');
  assert.equal((await l.upsert(OWNER, { localId: 'p1', reference: REF() })).unchanged, true);
  await l.review(OWNER, a.id); l.validate(N1, a.id, { decision: 'validate' });
  assert.equal(l.get(OWNER, a.id).status, 'published');
  const changed = REF(); changed.answers[3] += ' Payouts were faster.';
  const b = await l.upsert(OWNER, { localId: 'p1', reference: changed });
  assert.equal(b.revision, 2); assert.equal(b.status, 'in_review');
  const full = l.get(OWNER, a.id);
  assert.equal(full.state.validation.status, 'pending'); assert.deepEqual(full.revisions.map(r => r.revision), [2, 1]);
  assert.deepEqual(full.audit.map(x => x.action), ['revised', 'validated', 'reviewed', 'created']);
  assert.equal(l.revision(OWNER, a.id, 1).data.answers[3].includes('faster'), false);
});

test('permissions: others see only published, anonymised; the N+1 and listed consultants see everything', async () => {
  const { l } = lib();
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  assert.throws(() => l.get(OTHER, a.id), /not found/);
  assert.equal(l.get(N1, a.id).data.client.name, 'Zebracorp');
  assert.equal(l.get({ email: 'jo@mantu.com', role: 'user' }, a.id).access, 'full');
  await l.review(OWNER, a.id); l.validate(N1, a.id, { decision: 'validate' });
  const pub = l.get(OTHER, a.id);
  assert.equal(pub.access, 'public'); assert.ok(!('client' in pub.data)); assert.doesNotMatch(JSON.stringify(pub), /Zebracorp|Lyon|jo@mantu/);
  assert.match(pub.data.answers[0], /^the client had claims/); assert.equal(pub.revisions.length, 0); assert.equal(pub.audit.length, 0);
  assert.equal(l.list(OTHER).total, 1); assert.equal(l.list(OTHER).items[0].client, '');
  await assert.rejects(l.upsert(OTHER, { id: a.id, reference: REF() }), /cannot edit/);
  assert.throws(() => l.validate(OTHER, a.id, { decision: 'validate' }), /not found|Only the N\+1/);
  assert.throws(() => l.validate(OWNER, a.id, { decision: 'validate' }), /Only the N\+1/);
});

test('quality gate: no review agent answer, missing core fields or unsupported claims can never publish', async () => {
  const { l } = lib('not json');
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  const r = await l.review(OWNER, a.id);
  assert.equal(r.state.quality.status, 'needs_work'); assert.match(r.state.quality.blockers.join(' '), /did not answer/);
  l.validate(N1, a.id, { decision: 'validate' }); assert.equal(l.get(OWNER, a.id).status, 'needs_work');
  const u = lib(JSON.stringify({ score: 95, client_value_clear: true, issues: [{ field: 'outcome', kind: 'unsupported_claim', detail: 'The 70% saving has no source.' }] })).l;
  const b = await u.upsert(OWNER, { localId: 'p2', reference: REF() });
  assert.equal((await u.review(OWNER, b.id)).state.quality.status, 'needs_work');
  const thin = REF(); thin.answers[3] = ''; thin.client.name = '';
  const l3 = lib().l; const c3 = await l3.upsert(OWNER, { localId: 'p3', reference: thin }); const q = (await l3.review(OWNER, c3.id)).state.quality;
  assert.equal(q.status, 'needs_work'); assert.ok(q.missing.includes('Client benefits and outcomes') && q.missing.includes('Client name (confidential)'));
});

test('the review agent never sees confidential client details', async () => {
  const { l, seen } = lib();
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  await l.review(OWNER, a.id);
  assert.doesNotMatch(JSON.stringify(seen), /Zebracorp|Lyon|Head of Claims|jo@mantu|sam@mantu/);
  assert.match(seen[0][1].content, /the client had claims/);
});

test('N+1 can request changes with a note; manager staff needs no validation; withdraw and reinstate', async () => {
  const { l } = lib();
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() }); await l.review(OWNER, a.id);
  assert.throws(() => l.validate(N1, a.id, { decision: 'request_changes' }), /Say what/);
  assert.equal(l.validate(N1, a.id, { decision: 'request_changes', note: 'Add the team size.' }).status, 'changes_requested');
  const staff = REF(); staff.validation.managerStaff = true;
  const b = await l.upsert(OWNER, { localId: 'p2', reference: staff }); await l.review(OWNER, b.id);
  assert.equal(l.get(OWNER, b.id).status, 'published');
  assert.equal(l.withdraw(OWNER, b.id, { note: 'client asked' }).status, 'withdrawn');
  assert.equal(l.list(OTHER).total, 0);
  assert.throws(() => l.reinstate(OWNER, b.id), /reviewer/);
  assert.equal(l.reinstate(REV, b.id).status, 'published');
});

test('list filters and facets', async () => {
  const { l } = lib();
  await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  const other = REF(); other.title = 'SAP rollout alias'; other.details.country = 'Belgium'; other.details.technologies = ['SAP S/4HANA'];
  await l.upsert(OWNER, { localId: 'p2', reference: other });
  const all = l.list(OWNER);
  assert.equal(all.total, 2); assert.deepEqual(all.facets.country, { France: 1, Belgium: 1 });
  assert.equal(l.list(OWNER, { country: 'belgium' }).items[0].title, 'SAP rollout alias');
  assert.equal(l.list(OWNER, { tech: 'python' }).total, 1); assert.equal(l.list(OWNER, { q: 'routing model' }).total, 2);
  assert.equal(l.list(OWNER, { q: 'zebracorp' }).total, 2, 'record people and reviewers can search by client');
  assert.equal(l.list(OTHER, { q: 'zebracorp' }).total, 0, 'others can never find a reference by its confidential client');
});

test('review helpers: completeness is weighted and parseReview is bounded', () => {
  assert.equal(completeness(cleanReference(REF())).score, 100);
  assert.equal(parseReview('{"score": 400, "issues": [{"field":"x","kind":"y","detail":"d"}]}').score, 100);
  assert.equal(parseReview('{"score":"high"}'), null);
  assert.equal(deriveStatus({ quality: { status: 'ready' }, validation: { status: 'pending' } }), 'awaiting_validation');
  assert.ok(!('client' in forModel(cleanReference(REF()))));
});

import { libraryRoutes } from '../src/library-routes.js';
test('library routes: save triggers an automatic review, then the N+1 validates and it publishes', async () => {
  const { l } = lib(); const pending = [];
  const call = (method, path, who, body) => libraryRoutes(new Request('https://atlas.test' + path, { method, headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), l, { waitUntil: p => pending.push(p) });
  const saved = await (await call('POST', '/api/library', OWNER, { localId: 'p1', reference: REF() })).json();
  assert.equal(saved.status, 'in_review'); await Promise.all(pending);
  assert.equal((await (await call('GET', '/api/library/' + saved.id, OWNER)).json()).status, 'awaiting_validation');
  assert.equal((await call('POST', `/api/library/${saved.id}/validate`, OTHER, { decision: 'validate' })).status, 404);
  const v = await (await call('POST', `/api/library/${saved.id}/validate`, N1, { decision: 'validate' })).json();
  assert.equal(v.status, 'published'); assert.equal(v.state.validation.by, 'sam@mantu.com');
  assert.equal((await call('GET', '/api/library', { email: '', role: 'admin' })).status, 401);
  assert.equal((await call('GET', '/api/library/nope/whatever', OWNER)).status, 404);
});
test('system routes: trigger creates an invitation, scan-stale runs; ordinary users cannot reach them', async () => {
  const { l } = lib();
  const call = (path, who, body) => libraryRoutes(new Request('https://atlas.test' + path, { method: 'POST', headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }), l);
  const sys = { email: 'pm-system', role: 'system' };
  assert.equal((await call('/api/library/trigger', sys, { email: 'alex@mantu.com', reason: 'milestone', projectId: 'PRJ-3' })).status, 201);
  assert.equal((await (await call('/api/library/scan-stale', sys)).json()).invited, 0);
  assert.equal((await call('/api/library/trigger', OWNER, { email: 'x@y.co' })).status, 404);
  assert.equal((await (await libraryRoutes(new Request('https://atlas.test/api/library/invitations', { headers: { 'x-atlas-user': 'alex@mantu.com', 'x-atlas-role': 'user' } }), l)).json()).items[0].reason, 'milestone');
});

// T1-S0 (WOW_SPEC §2.3, §F1.10): the own-client scrub is word-bounded, still case-insensitive, names of 3+ characters.
import { clientScrub, reviewReference } from '../src/review.js';
test('forModel regression: a client named "Air" no longer turns "repair" into "repthe client"', async () => {
  const air = REF(); air.client = { name: 'Air', location: 'Lyon', contact: 'Ops' };
  air.answers[0] = 'Air had a backlog; we did the repair of the queue. AIR and air agreed, in Lyon and Lyonnais.';
  const m = forModel(cleanReference(air));
  assert.equal(m.answers[0], 'the client had a backlog; we did the repair of the queue. the client and the client agreed, in the client and Lyonnais.');
  assert.equal(clientScrub({ client: { name: 'Air', contact: 'HR' } })('HR teams repair air ducts'), 'HR teams repair the client ducts', 'names under 3 characters are left to scrub.js');
  assert.equal(clientScrub({ client: { name: 'Acme  Inc.' } })('Acme\nInc. and ACME INC. hired us'), 'the client and the client hired us');
  const { l, seen } = lib(); const a = await l.upsert(OWNER, { localId: 'air', reference: air }); await l.review(OWNER, a.id);
  assert.match(seen[0][1].content, /did the repair of the queue/); assert.doesNotMatch(seen[0][1].content, /repthe client|Air had/);
  const views = []; await reviewReference(cleanReference(air), async msgs => { views.push(msgs[1].content); return GOOD; }, { view: r => ({ only: r.title }) });
  assert.equal(views[0], JSON.stringify({ only: 'Claims triage alias' }), 'reviewReference accepts a view');
});

// ---- T1 step 1 (WOW_SPEC §2.3 "Existing leaks fixed by T1", §F1.9 #7, §F1.10): record text reaches a model only
// through recordView; typed queries and contexts are pseudonymised and come back to the caller in their own words.
import { recordView } from '../src/scrub.js';
import { fakeModel } from '../dev/fake-model.mjs';
const TWO = () => {
  const b = REF(); b.title = 'Grid telemetry alias'; b.sector = 'Energy'; b.client = { name: 'Brightwave', location: 'Nantes', contact: 'Jane Doe' };
  b.details = { ...b.details, projectId: 'PRJ-2', consultants: [] };
  b.answers[0] = 'Brightwave asked us to repeat what we did at Zebracorp with their Head of Claims; write to ops@brightwave.example or see https://brightwave.example/case.';
  const z = REF(); z.answers[5] = 'Any insurer like Brightwave with manual routing and a measurable queue would benefit from this approach.';
  return [z, b];
};
const LEAK = /zebracorp|brightwave|head of claims|jane doe|nantes|lyon|jane@acme|\+33|acme\.example/i;
async function twoClients() {
  const seen = [], fake = fakeModel();
  const l = new Library(memorySql(), { now: () => '2026-09-29T00:00:00.000Z', complete: async m => { seen.push(JSON.stringify(m)); return fake.complete(m); }, embed: async t => { seen.push(String(t)); return fake.embed(t); } });
  const [z, b] = TWO(), ids = [];
  for (const [k, ref] of [['z', z], ['b', b], ['c', { ...REF(), title: 'Payments alias', client: { name: 'Corvina Bank', location: '', contact: '' } }]]) ids.push((await l.upsert(OWNER, { localId: k, reference: ref })).id);
  for (const id of ids) { await l.review(OWNER, id); l.validate(N1, id, { decision: 'validate' }); }
  return { l, seen, ids };
}

test('recordView: own client "the client", other library clients "another client", their contacts "a contact", PII masked', async () => {
  const { l, ids } = await twoClients();
  const v = recordView(l, l.row(ids[1]).data);
  assert.equal(v.answers[0], 'the client asked us to repeat what we did at another client with their a contact; write to [email] or see [link].');
  assert.equal(recordView(l, l.row(ids[0]).data).answers[5], 'Any insurer like another client with manual routing and a measurable queue would benefit from this approach.');
  assert.ok(!('client' in v)); assert.equal(v.details.links[0].url, '[link]');
});

test('review, index, recommend, insights and slides send no second-client name, contact or PII to any model', async () => {
  const { l, seen, ids } = await twoClients();
  assert.equal(l.get(OWNER, ids[0]).status, 'published');
  const rec = await l.recommend(OTHER, { query: 'Meeting Zebracorp and Brightwave about energy data; write to jane@acme.example or +33 6 12 34 56 78' });
  await l.insights(REV);
  const s = await l.slides(OTHER, ids[1], { context: 'Pitch to the Zebracorp COO, jane@acme.example' });
  assert.equal(seen.length, 11, '3 reviews + 3 index embeds + recommend (target, embed, rerank) + insights + slides');
  for (const input of seen) assert.doesNotMatch(input, LEAK);
  assert.match(rec.target.searchText, /Meeting Zebracorp and Brightwave about energy data; write to jane@acme\.example or \+33 6 12 34 56 78/, 'the caller sees their own query words');
  assert.doesNotMatch(JSON.stringify(rec.target), /\[(Company|Person|Email|Phone|Link) \d+\]|another client/, 'no masking trace in the caller view');
  assert.ok(s.sections.flatMap(x => x.bullets).some(b => b.text.includes('Pitch to the Zebracorp COO, jane@acme.example')), 'slide text un-masked for the caller');
  const audit = l.get(OWNER, ids[1]).audit.find(a => a.action === 'slides generated');
  assert.equal(audit.detail, 'context 45 characters'); assert.doesNotMatch(JSON.stringify(l.get(REV, ids[1]).audit), /Zebracorp|jane@|Pitch/);
});
