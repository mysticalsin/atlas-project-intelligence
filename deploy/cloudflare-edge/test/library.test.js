import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, cleanReference, deriveStatus } from '../src/library.js';
import { completeness, parseReview, forModel } from '../src/review.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' }, N1 = { email: 'sam@mantu.com', role: 'user' }, OTHER = { email: 'kim@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' }, PRE = { email: 'pre@mantu.com', role: 'presales' }, SYS = { email: 'directory', role: 'system' };
function approve(l, id, owner = OWNER.email) {
  l.bindTrust(SYS, { owner, email: N1.email, source: 'directory', sandbox: true });
  l.validate(N1, id, { decision: 'validate', lane: 'manager' });
  return l.validate(PRE, id, { decision: 'validate', lane: 'presales' });
}
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
  await l.review(OWNER, a.id); approve(l, a.id);
  assert.equal(l.get(OWNER, a.id).status, 'published');
  const changed = REF(); changed.answers[3] += ' Payouts were faster.';
  const b = await l.upsert(OWNER, { localId: 'p1', reference: changed });
  assert.equal(b.revision, 2); assert.equal(b.status, 'in_review');
  const full = l.get(OWNER, a.id);
  assert.equal(full.state.validation.status, 'pending'); assert.deepEqual(full.revisions.map(r => r.revision), [2, 1]);
  assert.deepEqual(full.audit.map(x => x.action), ['revised', 'presales approved', 'manager approved', 'reviewed', 'created']);
  assert.equal(l.revision(OWNER, a.id, 1).data.answers[3].includes('faster'), false);
});

test('permissions: others see only published, anonymised; the N+1 and listed consultants see everything', async () => {
  const { l } = lib();
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  assert.throws(() => l.get(OTHER, a.id), /not found/);
  assert.throws(() => l.get(N1, a.id), /not found/, 'a typed manager email does not grant access');
  l.bindTrust(SYS, { owner: OWNER.email, email: N1.email, source: 'directory', sandbox: true });
  assert.equal(l.get(N1, a.id).data.client.name, 'Zebracorp');
  assert.throws(() => l.get({ email: 'jo@mantu.com', role: 'user' }, a.id), /not found/, 'a teammate email on the story does not grant access');
  await l.review(OWNER, a.id); l.validate(N1, a.id, { decision: 'validate', lane: 'manager' }); l.validate(PRE, a.id, { decision: 'validate', lane: 'presales' });
  const pub = l.get(OTHER, a.id);
  assert.equal(pub.access, 'public'); assert.ok(!('client' in pub.data)); assert.doesNotMatch(JSON.stringify(pub), /Zebracorp|Lyon|jo@mantu/);
  assert.match(pub.data.answers[0], /^the client had claims/); assert.equal(pub.revisions.length, 0); assert.equal(pub.audit.length, 0);
  assert.equal(l.list(OTHER).total, 1); assert.equal(l.list(OTHER).items[0].client, '');
  await assert.rejects(l.upsert(OTHER, { id: a.id, reference: REF() }), /cannot edit/);
  assert.throws(() => l.validate(OTHER, a.id, { decision: 'validate', lane: 'manager' }), /not found|trusted manager/);
  assert.throws(() => l.validate(OWNER, a.id, { decision: 'validate', lane: 'manager' }), /trusted manager/);
});

test('quality gate: no review agent answer, missing core fields or unsupported claims can never publish', async () => {
  const { l } = lib('not json');
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  const r = await l.review(OWNER, a.id);
  assert.equal(r.state.quality.status, 'needs_work'); assert.match(r.state.quality.blockers.join(' '), /did not answer/);
  l.bindTrust(SYS, { owner: OWNER.email, email: N1.email, source: 'directory', sandbox: true });
  l.validate(N1, a.id, { decision: 'validate', lane: 'manager' }); l.validate(PRE, a.id, { decision: 'validate', lane: 'presales' }); assert.equal(l.get(OWNER, a.id).status, 'needs_work');
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

test('trusted manager can request changes; the manager-staff checkbox does not publish; withdraw and reinstate', async () => {
  const { l } = lib();
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() }); await l.review(OWNER, a.id);
  l.bindTrust(SYS, { owner: OWNER.email, email: N1.email, source: 'directory', sandbox: true });
  assert.throws(() => l.validate(N1, a.id, { decision: 'request_changes', lane: 'manager' }), /Say what/);
  assert.equal(l.validate(N1, a.id, { decision: 'request_changes', lane: 'manager', note: 'Add the team size.' }).status, 'changes_requested');
  const staff = REF(); staff.validation.managerStaff = true;
  const b = await l.upsert(OWNER, { localId: 'p2', reference: staff }); await l.review(OWNER, b.id);
  assert.notEqual(l.get(OWNER, b.id).status, 'published');
  assert.equal(l.get(OWNER, b.id).state.validation.managerStaffIgnored, true);
  approve(l, b.id);
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
  l.bindTrust(SYS, { owner: OWNER.email, email: N1.email, source: 'directory', sandbox: true });
  assert.equal((await call('POST', `/api/library/${saved.id}/validate`, OTHER, { decision: 'validate', lane: 'manager' })).status, 404);
  assert.equal((await (await call('POST', `/api/library/${saved.id}/validate`, N1, { decision: 'validate', lane: 'manager' })).json()).status, 'awaiting_validation');
  const v = await (await call('POST', `/api/library/${saved.id}/validate`, PRE, { decision: 'validate', lane: 'presales' })).json();
  assert.equal(v.status, 'published'); assert.equal(v.state.validation.managerDecision, 'approved'); assert.equal(v.state.validation.presalesDecision, 'approved');
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
  for (const id of ids) { await l.review(OWNER, id); approve(l, id); }
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

// ---- Track Z (WOW_ZERO_CONFIG §5.9, §9): no consultant in any model view; the people-facing views are unchanged. ----
import { hashOf, anonymise } from '../src/library.js';
import { snippetsOf } from '../src/snippets.js';
test('Z forModel drops the consultant (name and role); stored hashes are unchanged; the public view and search still show people', async () => {
  const ZREF = () => ({ ...REF(), consultant: { name: 'Zelda Quintero', role: 'Principal Zebra' } }), data = cleanReference(ZREF()), m = forModel(data);
  assert.equal('consultant' in m, false); assert.doesNotMatch(JSON.stringify(m), /Zelda|Quintero|Principal Zebra|jo@mantu|"Jo"/);
  assert.deepEqual(data.consultant, { name: 'Zelda Quintero', role: 'Principal Zebra' }, 'the record itself keeps its consultant');
  const { l } = lib(), a = await l.upsert(OWNER, { localId: 'h', reference: ZREF() });
  assert.equal(l.row(a.id).content_hash, await hashOf(data), 'forModel is never hashed: the content hash is the stored data only');
  assert.equal((await l.upsert(OWNER, { localId: 'h', reference: ZREF() })).unchanged, true, 'saving the same record again reopens nothing');
  assert.deepEqual(anonymise(data).consultant, { name: 'Zelda Quintero', role: 'Principal Zebra' }, 'the published view for people keeps the consultant');
  const air = cleanReference({ ...REF(), consultant: { name: 'Zebracorp liaison', role: 'Lead at Zebracorp' } });
  assert.deepEqual(anonymise(air).consultant, { name: 'the client liaison', role: 'Lead at the client' }, 'own-client scrubbed exactly as before');
  assert.equal(l.list(OWNER, { q: 'quintero' }).total, 1, 'the library search still finds a reference by its consultant');
  assert.equal(l.list(OWNER, { q: 'principal zebra' }).total, 1);
});

test('Z merge text names nobody; recordView and snippets strip a legacy "Contribution by <name or email>:" prefix', async () => {
  const { l } = lib(), one = await l.upsert(OWNER, { localId: '1', reference: REF() });
  const two = await l.upsert({ email: 'zelda@mantu.com', role: 'user' }, { localId: '2', reference: { ...REF(), title: 'Other', consultant: { name: 'Zelda Quintero', role: 'Principal' },
    answers: ['Context.', 'Zelda built the ingestion pipeline and trained the ops team on it.', '', '', '', ''] } });
  const merged = await l.merge(REV, { keep: one.id, merge: two.id }), a1 = l.row(merged.id).data.answers[1];
  assert.match(a1, /\n\nContribution by another consultant: Zelda built the ingestion/); assert.doesNotMatch(a1, /Contribution by (Zelda|zelda@)/);
  const legacy = { ...cleanReference(REF()), answers: ['Context here.', 'I built the model.\n\nContribution by jo@mantu.com: I ran the pilot.\nContribution by Zelda Quintero: I trained the team.', '', '', '', ''] };
  const view = recordView(l, legacy).answers[1];
  assert.equal(view, 'I built the model.\n\nContribution by another consultant: I ran the pilot.\nContribution by another consultant: I trained the team.');
  assert.equal(recordView(l, { ...legacy, answers: ['Contribution by Kai: first line.', '', '', '', '', ''] }).answers[0], 'Contribution by another consultant: first line.');
  const snips = snippetsOf(l, legacy).map(s => s.text).join('\n');
  assert.doesNotMatch(snips, /jo@mantu|Zelda|\[email\]:/); assert.match(snips, /Contribution by another consultant: I ran the pilot\./);
  assert.equal(recordView(l, { ...legacy, answers: ['A contribution by the team: fine.', '', '', '', '', ''] }).answers[0], 'A contribution by the team: fine.', 'only a line-leading prefix');
});

// ---- JEV story rating (docs/JEV_RATING.md §13.2): the library side. Fake TypeSafe fetcher only; no network. ----
import { storyRater } from '../src/rating.js';
import * as profileMod from '../src/profile.js';
import { fakeTypesafe } from '../dev/fake-typesafe.mjs';
const TS_KEY = 'test-key-SECRET';
// status(i): the HTTP status of the i-th TypeSafe call (200 answers every question sure at the top level).
function jevLib({ complete = async () => GOOD, status = () => 200, fetcher = null, key = TS_KEY } = {}) {
  const calls = [];
  fetcher = fetcher || (async (url, init) => {
    const body = JSON.parse(init.body), s = status(calls.length); calls.push(body);
    if (s !== 200) return new Response('{}', { status: s });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, q.type === 'score'
      ? { type: 'score', score: 3, legend: Object.fromEntries(q.criteria.map((c, k) => [String(k), c])), probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 }, confidence: 1 }
      : q.type === 'noul' ? { type: 'noul', noul: 0.95 }
        : { type: 'choice', choice: 'en', probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'en' ? 0.99 : 0.001])), confidence: 0.99 }]));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 10 } }));
  });
  let t = 0;
  const rater = storyRater({ TYPESAFE_API_KEY: key }, fetcher, { budgets: { background: { backoffMs: 1 } } });
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 29, 0, 0, t++)).toISOString(), complete, rater, metric: () => {} });
  return { l, calls };
}
const JEV_TENANT = '11111111-1111-4111-8111-111111111111';
const onTenant = user => ({ ...user, tenant: JEV_TENANT });
const consent = (l, u) => profileMod.routes({ method: 'POST', parts: ['profile', 'consent'], body: { kind: 'jevRating', version: 1, granted: true }, user: { idp: {}, mail: u.email, ...u }, lib: l, env: {} });
const route = (l, pending) => (method, path, who, body) => libraryRoutes(new Request('https://atlas.test' + path, { method, headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, 'Content-Type': 'application/json', ...(who.tenant ? { 'x-atlas-tenant': who.tenant } : {}) },
  body: body ? JSON.stringify(body) : undefined }), l, { waitUntil: p => pending.push(p) });

test('JEV: a save by a consenting owner is rated in the background budget; GET shows the engine and jevAllowed', async () => {
  const { l, calls } = jevLib({ status: i => (i < 2 ? 529 : 200) }), pending = [], call = route(l, pending);
  const owner = onTenant(OWNER);
  await consent(l, owner);
  const saved = await (await call('POST', '/api/library', owner, { localId: 'p1', reference: REF() })).json();
  assert.equal(saved.status, 'in_review');
  await Promise.all(pending);
  const got = await (await call('GET', '/api/library/' + saved.id, owner)).json();
  assert.deepEqual([got.state.quality.engine, got.status, calls.length, got.rating.running, got.jevAllowed], ['jev', 'awaiting_validation', 3, false, true],
    'two 529s and a 200: three sequential attempts (the interactive budget stops at two)');
  // The interview's automatic save of the same content does not rate again; "Rate again" reuses the answer.
  assert.equal((await call('POST', '/api/library', owner, { localId: 'p1', reference: REF() })).status, 200);
  const again = await (await call('POST', `/api/library/${saved.id}/review`, owner, {})).json();
  assert.deepEqual([again.state.quality.cached, calls.length, again.rating.running], [true, 3, false], 'nothing is left running once the rating is stored');
  const agent = await l.upsert(N1, { localId: 'n1', reference: { ...REF(), title: 'Agent alias' } });
  assert.equal((await (await call('POST', `/api/library/${agent.id}/review`, N1, {})).json()).rating.running, false, 'the index alone is not a running rating');
});

test('JEV: the owner\'s consent decides, whoever triggers the rating; a reviewer\'s own consent does not count', async () => {
  const { l, calls } = jevLib();
  const owner = onTenant(OWNER), rev = onTenant(REV);
  await consent(l, rev);
  const a = await l.upsert(owner, { localId: 'p1', reference: REF() });
  let q = (await l.review(rev, a.id)).state.quality;
  assert.deepEqual([q.engine, q.fallbackReason, calls.length], ['review-agent', 'no_consent', 0]);
  assert.equal(l.get(rev, a.id).jevAllowed, false);
  await consent(l, owner);
  q = (await l.review(rev, a.id)).state.quality;
  assert.deepEqual([q.engine, calls.length], ['jev', 1]);
  assert.equal(l.get(rev, a.id).jevAllowed, true);
});

test('JEV: merge rates the kept reference in the background budget', async () => {
  const { l, calls } = jevLib({ status: i => (i < 2 ? 529 : 200) }), pending = [], call = route(l, pending);
  const owner = onTenant(OWNER), rev = onTenant(REV);
  await consent(l, owner);
  const one = await l.upsert(owner, { localId: '1', reference: REF() }), two = await l.upsert(owner, { localId: '2', reference: { ...REF(), title: 'Other alias' } });
  const merged = await (await call('POST', '/api/library/merge', rev, { keep: one.id, merge: two.id })).json();
  await Promise.all(pending);
  assert.deepEqual([l.get(owner, merged.id).state.quality.engine, calls.length], ['jev', 3]);
});

test('JEV: "Rate again" returns after the primary rating; the second opinion lands later through waitUntil', async () => {
  const fake = fakeTypesafe({ key: TS_KEY }); fake.setMode('unsure'); // a ready candidate whose pessimistic score is below 75
  let release; const { l } = jevLib({ fetcher: fake, complete: () => new Promise(r => { release = r; }) }), pending = [], call = route(l, pending);
  const owner = onTenant(OWNER);
  await consent(l, owner);
  const a = await l.upsert(owner, { localId: 'p1', reference: REF() });
  const res = await Promise.race([call('POST', `/api/library/${a.id}/review`, owner, {}), new Promise(r => setTimeout(() => r('waited for the second opinion'), 1000))]);
  assert.notEqual(res, 'waited for the second opinion');
  const first = await res.json();
  assert.deepEqual([first.state.quality.engine, first.state.quality.status, first.rating.running], ['jev', 'needs_work', true]);
  release(GOOD); await Promise.all(pending);
  const q = l.get(owner, a.id).state.quality;
  assert.deepEqual([q.engine, q.escalatedFrom, l.get(owner, a.id).rating.running], ['review-agent', 'jev', false]);
});

test('JEV: list() items keep exactly today\'s fields', async () => {
  const { l } = jevLib();
  const owner = onTenant(OWNER);
  await consent(l, owner);
  const a = await l.upsert(owner, { localId: 'p1', reference: REF() }); await l.review(owner, a.id);
  assert.deepEqual(Object.keys(l.list(owner).items[0]), ['id', 'title', 'status', 'revision', 'access', 'mine', 'practice', 'industry', 'country', 'serviceLines', 'technologies',
    'headline', 'impact', 'qualityScore', 'qualityStatus', 'updatedAt', 'nextReview', 'owner', 'client']);
});

test('JEV: without a rater, today\'s semantics and audit text hold; the stored rating names the review agent', async () => {
  const { l } = lib();
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  const q = (await l.review(OWNER, a.id)).state.quality;
  assert.deepEqual([q.engine, q.fallbackReason, q.jev, q.score], ['review-agent', 'no_key', null, 95]);
  assert.equal(l.get(OWNER, a.id).audit[0].detail, 'score 95, ready');
  assert.equal(l.get(OWNER, a.id).jevAllowed, false);
});

// ---- Integration review (no key = today): a deployment without TYPESAFE_API_KEY behaves exactly as before JEV. ----
// worker.js always passes a rater; without the key it is unavailable, so these use storyRater({}) (no fetch is made).
const noKeyLib = ({ complete = async () => GOOD, raterOpts = {} } = {}) => new Library(memorySql(), { complete, rater: storyRater({}, async () => { throw new Error('no network in tests'); }, raterOpts), metric: () => {} });

test('JEV off (no key): "Run quality review" while the save\'s review runs waits for that review, as today (the no-key dialog does not poll)', async () => {
  let release; const l = noKeyLib({ complete: () => new Promise(r => { release = r; }), raterOpts: { budgets: { interactive: { deadlineMs: 50 } } } });
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  const bg = l.review({ email: 'atlas', role: 'admin' }, a.id, { budget: 'background' });
  await new Promise(r => setTimeout(r, 5));
  const click = l.review(OWNER, a.id, { budget: 'interactive', waitUntil: () => {} });
  await new Promise(r => setTimeout(r, 120)); // well past the JEV-only interactive join cap
  release(GOOD);
  const r = await click; await bg;
  assert.deepEqual([r.state.quality?.engine, r.state.quality?.score, r.rating.running], ['review-agent', 95, false], 'the click returns the rating, not an empty dialog');
});

test('JEV off (no key): a story with no text is rated by the review agent, as today', async () => {
  const seen = []; const l = noKeyLib({ complete: async m => { seen.push(m); return GOOD; } });
  const a = await l.upsert(OWNER, { localId: 'p1', reference: { ...REF(), answers: ['', '', '', '', '', ''] } });
  const q = (await l.review(OWNER, a.id)).state.quality;
  assert.equal(seen.length, 1, 'the review agent is asked, as before JEV');
  assert.deepEqual([q.engine, q.fallbackReason, q.aiScore], ['review-agent', 'no_key', 90]);
});

test('JEV off (no key): a review agent that does not answer leaves today\'s audit text', async () => {
  const l = noKeyLib({ complete: async () => { throw new Error('down'); } });
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  const q = (await l.review(OWNER, a.id)).state.quality;
  assert.deepEqual([q.aiScore, q.fallbackReason], [null, 'no_key']);
  assert.equal(l.get(OWNER, a.id).audit[0].detail, `score ${q.score}, ${q.status}`, 'no "· rules only" suffix without JEV');
});
