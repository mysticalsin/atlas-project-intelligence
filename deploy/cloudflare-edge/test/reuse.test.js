import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { parseSlides, parseRerank, parseInsights, parseTarget, numbersIn } from '../src/reuse.js';
import { memorySql } from './sqlite.js';
import { fakeModel } from '../dev/fake-model.mjs';

const U = e => ({ email: e, role: 'user' }), OWNER = U('alex@mantu.com'), N1 = U('sam@mantu.com'), OTHER = U('kim@mantu.com'), REV = { email: 'rev@mantu.com', role: 'reviewer' };
const base = (title, industry, challenge, extra = {}) => ({ title, stage: 'Production', sector: industry, consultant: { name: 'Alex', role: 'Engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: '' },
  details: { projectId: extra.pid || '', country: extra.country || 'France', start: '2024-01', duration: '6 months', teamSize: 4, teamRoles: ['Engineer'], technologies: extra.tech || ['Python'], deliverables: ['Model'], serviceLines: ['Data & AI'], consultants: extra.people || [], links: [] },
  answers: [challenge, 'I led the design and delivery of the solution with the client team myself.', 'We compared options, chose a model-based approach and kept a manual fallback.', 'Processing time fell from 40 to 12 minutes according to the operations dashboard.', 'Operations dashboard export v3.', 'Any organisation with manual, slow operational routing would benefit from this approach.'],
  validation: { manager: { name: 'Sam', email: 'sam@mantu.com' }, managerStaff: false }, jev: extra.jev || { primary: { key: 'data_ai', label: 'Data & AI' }, also: [], impact: 70 } });
async function published(l, owner, ref, localId) { const s = await l.upsert(owner, { localId, reference: ref }); await l.review({ email: 'atlas', role: 'admin' }, s.id); l.validate(N1, s.id, { decision: 'validate' }); return s.id; }
function lib() { const m = fakeModel(); return new Library(memorySql(), { complete: m.complete, embed: m.embed }); }

test('recommendation: understands the context, ranks by meaning, explains, never leaks client names or drafts to others', async () => {
  const l = lib();
  const a = await published(l, OWNER, base('Grid data platform', 'Energy', 'Zebracorp, a power utility, had fragmented grid data and slow decisions across control rooms and field teams.'), 'a');
  const b = await published(l, OWNER, base('Retail loyalty app', 'Retail', 'The retailer needed a mobile loyalty app for its stores and online shop customers.', { tech: ['React Native'] }), 'b');
  await l.upsert(OWNER, { localId: 'draft', reference: base('Unvalidated energy draft', 'Energy', 'Draft only: energy data project not yet validated by anyone at all.') });
  const r = await l.recommend(OTHER, { query: 'I am meeting the data director of a major energy company. Which references can I present?' });
  assert.equal(r.target.industry, 'Energy'); assert.ok(r.target.likelyChallenges.length);
  assert.equal(r.results[0].id, a, 'the energy data reference ranks first'); assert.match(r.results[0].why, /Similar challenge/); assert.ok(r.results[0].transferable.length);
  assert.ok(!r.results.some(x => x.title === 'Unvalidated energy draft'), 'unpublished drafts are never recommended to others');
  assert.doesNotMatch(JSON.stringify(r), /Zebracorp|Lyon/); assert.match(r.method, /semantic \+ model ranking/);
  assert.ok(r.results.map(x => x.id).includes(b) || r.results.length === 1);
  await assert.rejects(l.recommend(OTHER, { query: 'hi' }), /Describe/);
});

test('duplicates are detected (same project id or near-identical story) and a reviewer merges them into one stronger reference', async () => {
  const l = lib();
  const one = await l.upsert(OWNER, { localId: '1', reference: base('Claims triage', 'Insurance', 'Claims bounced between three teams slowing payouts across the region for customers.', { pid: 'PRJ-7' }) });
  await l.review({ email: 'atlas', role: 'admin' }, one.id);
  const jo = U('jo@mantu.com');
  const two = await l.upsert(jo, { localId: '2', reference: { ...base('Claims routing', 'Insurance', 'Claims bounced between teams and payouts were slow.', { pid: 'prj-7', tech: ['Azure ML'] }), consultant: { name: 'Jo', role: 'Data scientist' }, answers: ['Claims bounced between teams and payouts were slow.', 'I built and trained the routing model and coached the operations team.', '', '', '', ''] } });
  await l.review({ email: 'atlas', role: 'admin' }, two.id);
  const dups = l.get(OWNER, one.id).state.duplicates;
  assert.equal(dups[0].id, two.id); assert.equal(dups[0].sameProjectId, true);
  await assert.rejects(l.merge(OWNER, { keep: one.id, merge: two.id }), /reviewer/);
  const merged = await l.merge(REV, { keep: one.id, merge: two.id });
  const full = l.get(REV, merged.id);
  assert.ok(full.data.details.consultants.some(c => c.email === 'jo@mantu.com'), 'the other consultant is associated');
  assert.match(full.data.answers[1], /^I led[\s\S]*Contribution by another consultant: I built and trained/); assert.deepEqual(full.data.details.technologies.sort(), ['Azure ML', 'Python']);
  assert.equal(l.get(jo, one.id).access, 'full', 'the merged consultant keeps access'); assert.throws(() => l.get(REV, two.id), /not found/);
  assert.ok(full.audit.some(x => x.action === 'consolidated'));
});

test('slides: facts vs interpretation, invented numbers removed, client only for people allowed to see it', async () => {
  const l = lib();
  const id = await published(l, OWNER, base('Claims triage', 'Insurance', 'Zebracorp claims bounced between three teams, slowing payouts across the region.'), 's');
  const s = await l.slides(OTHER, id, { context: 'Meeting an insurer COO about claims backlog', includeClient: true });
  assert.ok(s.sections.some(x => x.bullets.some(b => b.kind === 'interpretation'))); assert.ok(s.sections.flatMap(x => x.bullets).every(b => ['fact', 'interpretation'].includes(b.kind)));
  assert.deepEqual(s.dropped, ['Cut costs by 99% overnight']); assert.equal(s.client, '', 'no client name for people outside the record');
  assert.doesNotMatch(JSON.stringify(s), /Zebracorp/);
  assert.equal((await l.slides(OWNER, id, { includeClient: true })).client, 'Zebracorp');
  const draft = await l.upsert(OWNER, { localId: 'd', reference: base('Draft', 'Insurance', 'A draft reference that is not yet published anywhere for anyone to use.') });
  await assert.rejects(l.slides(OTHER, draft.id, {}), /not found/);
  assert.match((await l.slides(OWNER, draft.id, {})).warning, /not validated/);
});

test('analytics: counts, coverage gaps, strongest, needs enrichment; client counts only for reviewers', async () => {
  const l = lib();
  await published(l, OWNER, base('A', 'Energy', 'Energy company with fragmented grid data and slow decisions in control rooms.'), 'a');
  await published(l, OWNER, base('B', 'Banking', 'Bank with manual payment reconciliation and long month-end closing cycles.', { country: 'Belgium' }), 'b');
  await l.upsert(OWNER, { localId: 'c', reference: base('C', 'Retail', 'Short.') });
  const a = l.analytics(REV);
  assert.equal(a.totals.published, 2); assert.deepEqual(a.byCountry.map(x => x.name).sort(), ['Belgium', 'France']);
  assert.ok(a.coverageGaps.includes('SAP & ERP in France')); assert.ok(a.needsEnrichment.some(x => x.title === 'C'));
  assert.equal(a.byClient[0].name, 'Zebracorp'); assert.deepEqual(l.analytics(OTHER).byClient, []); assert.equal(l.analytics(OTHER).totals.visible, 2);
});

test('insights: reviewers only, labelled interpretation, cited ids must exist', async () => {
  const l = lib();
  for (const [k, ind] of [['a', 'Energy'], ['b', 'Energy'], ['c', 'Banking']]) await published(l, OWNER, base('Ref ' + k, ind, `${ind} organisation with slow manual operations and fragmented data across teams.`), k);
  await assert.rejects(l.insights(OTHER), /reviewers/);
  const i = await l.insights(REV);
  assert.equal(i.label, 'interpretation'); assert.equal(i.repeatedNeeds[0].need, 'Operational efficiency in Energy');
  assert.ok(i.offeringIdeas[0].referenceIds.every(id => i.titles[id]), 'unknown ids are dropped');
});

test('invitations: lifecycle triggers, six-month scan, schedule/dismiss, no duplicates', async () => {
  let now = '2026-09-27T00:00:00.000Z';
  const m = fakeModel(), l = new Library(memorySql(), { complete: m.complete, embed: m.embed, now: () => now });
  const inv = l.invite('pm-system', { email: 'Alex@Mantu.com', reason: 'project_end', projectId: 'PRJ-9', title: 'Grid analytics' });
  assert.equal(inv.status, 'open'); assert.equal(l.invite('pm-system', { email: 'alex@mantu.com', reason: 'project_end', projectId: 'PRJ-9' }).id, inv.id);
  assert.equal(l.invitations(OWNER).length, 1); assert.equal(l.invitations(OTHER).length, 0);
  assert.equal(l.updateInvitation(OWNER, inv.id, { action: 'schedule', slot: '2026-10-02T10:00' }).status, 'scheduled');
  assert.throws(() => l.updateInvitation(OTHER, inv.id, { action: 'dismiss' }), /not found/);
  assert.equal(l.analytics(OWNER).activityWithoutReference[0].projectId, 'PRJ-9');
  await l.upsert(OWNER, { localId: 'x', reference: base('Old one', 'Energy', 'Energy company with fragmented grid data and slow decisions in control rooms.') });
  assert.equal(l.scanStale(), 0);
  now = '2027-04-01T00:00:00.000Z';
  assert.equal(l.scanStale(), 1); assert.equal(l.scanStale(), 1, 'the open invitation is reused, not duplicated');
  assert.equal(l.invitations(OWNER).filter(i => i.reason === 'six_month_update').length, 1);
  assert.throws(() => l.invite('x', { email: 'bad' }), /email/);
});

test('Spotlight contract: reviewers export/import; import is idempotent and rejects bad rows', async () => {
  const l = lib();
  await l.upsert(OWNER, { localId: 'a', reference: base('A', 'Energy', 'Energy company with fragmented grid data and slow decisions in control rooms.') });
  assert.throws(() => l.exportAll(OWNER), /reviewers/);
  const ex = l.exportAll(REV); assert.equal(ex.schema, 'atlas.reference.v1'); assert.equal(ex.references.length, 1);
  const imp = await l.importAll(REV, { references: [{ externalId: 'sp-1', reference: base('Spotlight ref', 'Telecom', 'Operator needed faster 5G site rollout planning across regions.') }, { externalId: 'sp-2', reference: { title: '' } }] });
  assert.deepEqual([imp.created, imp.rejected.length], [1, 1]);
  assert.equal((await l.importAll(REV, { references: [{ externalId: 'sp-1', reference: base('Spotlight ref', 'Telecom', 'Operator needed faster 5G site rollout planning across regions.') }] })).unchanged, 1);
});

test('reuse parsers are bounded and strict', () => {
  assert.deepEqual(numbersIn('from 40 to 12,5 min'), ['40', '12.5']);
  assert.equal(parseSlides('no json', ''), null);
  assert.deepEqual(parseRerank('{"results":[{"id":"x","relevance":90,"why":"w"},{"id":"evil","relevance":99,"why":"w"},{"id":"x","relevance":80,"why":"dup"}]}', ['x']).map(r => r.id), ['x']);
  assert.equal(parseInsights('{"offering_ideas":[{"title":"t","reference_ids":["nope"]}]}', ['a']).offeringIdeas.length, 0);
  assert.equal(parseTarget('garbage', 'energy meeting').searchText, 'energy meeting');
});

// ---- T1 step 1 (WOW_SPEC §F1.3, §2.3, §F1.10): strict rerank parsing, and typed queries/contexts pseudonymised ----
import { parseRerankStrict, rankPool } from '../src/reuse.js';
test('parseRerankStrict: null when the model did not answer usably, [] when it honestly found nothing', () => {
  const ids = ['a', 'b'];
  for (const bad of ['garbage', '', null, '{"results": "x"}', '{"other": []}', '[1,2]', '{"results":[{"id":"evil","relevance":90,"why":"w"}]}',
    '{"results":[{"id":"a","relevance":90,"why":""},{"id":"b","relevance":70}]}']) assert.equal(parseRerankStrict(bad, ids), null, String(bad));
  assert.deepEqual(parseRerankStrict('{"results":[]}', ids), []);
  assert.deepEqual(parseRerankStrict('{"results":[{"id":"a","relevance":20,"why":"weak"},{"id":"b","relevance":29,"why":"weak"}]}', ids), [], 'all valid, all below 30');
  const got = parseRerankStrict('{"results":[{"id":"b","relevance":"88","why":"good","transferable":["x","x"]},{"id":"evil","relevance":99,"why":"w"},{"id":"a","relevance":10,"why":"low"}]}', ids);
  assert.deepEqual(got, [{ id: 'b', relevance: 88, why: 'good', transferable: ['x'], caveat: '' }], 'hallucinated ids dropped when a valid one exists');
  assert.deepEqual(parseRerank('garbage', ids), [], 'the lenient form is unchanged');
});

test('rankPool: per-method floor on raw similarity, semantic before lexical, boosts reorder but never rescue', () => {
  const row = (id, embedding, answers) => [{ id, embedding: embedding ? JSON.stringify(embedding) : null, data: { title: id, details: {}, answers } }, 'public'];
  const pool = [row('lowSem', [1, 0.2], []), row('sem', [1, 1], []), row('lex', null, ['claims routing triage model']), row('lexLow', null, ['nothing shared here at all'])];
  const floor = { semantic: 0.9, lexical: 0.1 };
  const plain = rankPool(pool, 'claims routing', [1, 1], { floor });
  assert.deepEqual(plain.map(k => [k.row.id, k.retrieval]), [['sem', 'semantic'], ['lex', 'lexical']]);
  const boosted = rankPool(pool, 'claims routing', [1, 1], { floor, boost: r => r.id === 'lowSem' || r.id === 'lexLow' ? 5 : r.id === 'lex' ? 3 : 0 });
  assert.deepEqual(boosted.map(k => k.row.id), ['sem', 'lex'], 'a boost never rescues a row below the floor, and a lexical row never passes a semantic one');
  assert.equal(rankPool(pool, 'claims routing', null, { floor }).every(k => k.retrieval === 'lexical'), true, 'no query vector: lexical only');
});

test('recommend: the caveat says whether the ranking model did not answer or nothing reached 30', async () => {
  for (const [rerank, want] of [['not json', /did not answer/], ['{"results":[]}', /no candidate reached the relevance threshold of 30/], ['{"results":[{"id":"nope","relevance":90,"why":"w"}]}', /did not answer/]]) {
    const m = fakeModel(), l = new Library(memorySql(), { complete: async msgs => msgs[0].content.startsWith('You match past project references') ? rerank : m.complete(msgs), embed: m.embed });
    await published(l, OWNER, base('Grid data platform', 'Energy', 'A power utility had fragmented grid data and slow decisions across control rooms.'), 'a');
    const r = await l.recommend(OTHER, { query: 'Meeting an energy data director about grid decisions' });
    assert.ok(r.results.length); assert.ok(r.results.every(x => x.relevance === null && want.test(x.caveat)), rerank); assert.doesNotMatch(r.method, /model ranking/);
  }
});

test('recommend and slides: a library client, an email and a phone in the query or context never reach a model; the caller reads their own words', async () => {
  const seen = [], m = fakeModel();
  const l = new Library(memorySql(), { complete: async msgs => { seen.push(JSON.stringify(msgs)); return m.complete(msgs); }, embed: async t => { seen.push(String(t)); return m.embed(t); } });
  const id = await published(l, OWNER, base('Grid data platform', 'Energy', 'Zebracorp, a power utility, had fragmented grid data and slow decisions across control rooms.'), 'a');
  seen.length = 0;
  const query = 'Meeting ZEBRACORP and zebracorp energy data team, jane@acme.example, +33 6 12 34 56 78, https://acme.example/brief';
  const r = await l.recommend(OTHER, { query });
  assert.match(r.target.searchText, /^Meeting ZEBRACORP and zebracorp energy data team, jane@acme\.example, \+33 6 12 34 56 78, https:\/\/acme\.example\/brief/, 'every spelling back as typed');
  assert.doesNotMatch(JSON.stringify(r), /\[(Company|Person|Email|Phone|Link) \d+\]|another client|\[company\]|\[contact\]/);
  const s = await l.slides(OTHER, id, { context: 'Zebracorp board, call +33 6 12 34 56 78 or jane@acme.example' });
  assert.ok(s.sections.flatMap(x => x.bullets).some(b => b.text.includes('Zebracorp board, call +33 6 12 34 56 78 or jane@acme.example')));
  assert.ok(seen.length >= 4);
  for (const input of seen) assert.doesNotMatch(input, /zebracorp|jane@|acme\.example|\+33|12 34 56/i);
  assert.equal(l.get(OWNER, id).audit.find(a => a.action === 'slides generated').detail, 'context 60 characters');
});
