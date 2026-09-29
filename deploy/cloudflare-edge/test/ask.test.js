// ask.js (WOW_SPEC §F6.1-§F6.5): Ask ATLAS. Library on memorySql with keyword embeddings (exact similarity) and a
// capturing model; every model input is checked for the confidentiality sentinels.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ask from '../src/ask.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { fakeModel } from '../dev/fake-model.mjs';

const ALEX = { email: 'alex@mantu.com', role: 'user' }, LEE = { email: 'lee@mantu.com', role: 'user' }, KIM = { email: 'kim@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' };
const SENTINEL = /zebracorp|brightwave|acme prospect|jane@acme\.example|\+33 6 12 34 56 78|https:\/\/acme\.example/i;
const TRACE = /\ba client\b|another client|\[Company|\[company\]|\[prospect\]|\[Person|\[person\]|\[contact\]|\[Email|\[Phone|\[Link/;
const EMBED = async t => [/claims|triage|routing|payout/i.test(t) ? 1 : 0, /retail|loyalty|store/i.test(t) ? 1 : 0, /grid|energy|utility/i.test(t) ? 1 : 0, 0.05];
const ref = (title, client, answers, extra = {}) => ({ title, stage: 'Production', sector: extra.sector || 'Insurance', consultant: { name: extra.owner || 'Lee Chen', role: 'Data engineer' },
  client: { name: client, location: 'Lyon', contact: '' },
  details: { projectId: '', country: extra.country || 'France', consultants: extra.people || [], technologies: ['Python'], deliverables: [], serviceLines: ['Data & AI'], teamRoles: [], links: [] },
  answers: [...answers, '', '', '', '', '', ''].slice(0, 6), sources: [], report: null, validation: { manager: { name: '', email: '' }, managerStaff: true } });
async function publish(l, owner, data, { publish: pub = true } = {}) {
  const s = await l.upsert(owner, { localId: data.title, reference: data }), row = l.row(s.id);
  if (pub) l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', by: 't', at: '', note: '' } }, 't', 'validated', '');
  await l.index(s.id);
  return s.id;
}
// rerank(input, fake) answers RERANK; everything else goes to the fake model.
async function world(rerank = null) {
  const seen = { complete: [], embed: [] }, fake = fakeModel(); let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 29, 9, 0, t++)).toISOString(),
    complete: async m => { seen.complete.push(JSON.stringify(m)); return rerank && m[0].content.startsWith('You match past project references') ? rerank(JSON.parse(m[1].content), fake, m) : fake.complete(m); },
    embed: async x => { seen.embed.push(String(x)); return EMBED(x); } });
  const ids = {
    mine: await publish(l, ALEX, ref('Claims triage for my client', 'Zebracorp', ['Zebracorp had claims bouncing between teams; I rebuilt the claims routing.', 'I designed the claims routing model with the Zebracorp team.'],
      { owner: 'Alex Park', country: 'France', people: [{ name: 'Ana Ruiz', email: 'ana@mantu.com', role: 'Product owner' }] })),
    theirs: await publish(l, LEE, ref('Claims routing at scale', 'Zebracorp', ['Zebracorp needed faster claims payouts across regions.', 'I led the payout routing work for claims.'],
      { country: 'Belgium', people: [{ name: 'Ana Ruiz', email: 'ana@mantu.com', role: 'Product owner' }, { name: 'Bo Li', email: 'bo@mantu.com', role: 'Developer' }] })),
    other: await publish(l, LEE, ref('Payout triage alias', 'Brightwave', ['Brightwave had slow claims triage, as we did at Zebracorp before.', 'I built the claims triage queue.'], { country: 'Belgium', owner: 'Kai Moss' })),
    retail: await publish(l, LEE, ref('Loyalty app alias', 'Shopco', ['A retailer needed a loyalty app for its stores.'], { sector: 'Retail', country: 'Spain' })),
    draft: await publish(l, LEE, ref('Draft claims triage', 'Draftco', ['Draft claims triage routing, not validated yet.']), { publish: false }),
  };
  seen.complete.length = 0; seen.embed.length = 0;
  return { l, seen, ids };
}
const call = async (l, user, body, method = 'POST', path = 'ask') => {
  try { const r = await ask.routes({ method, parts: path.split('/'), body, user: { mail: user.email, ...user }, lib: l, env: {} }); return { status: r.status || 200, body: r.body }; }
  catch (e) { if (!e.status) throw e; return { status: e.status, body: { error: e.message } }; }
};
const echo = ({ context, candidates }) => JSON.stringify({ results: candidates.map((c, i) => ({ id: c.id, relevance: 90 - i * 10, why: 'You asked: ' + context.query, caveat: i ? 'Check the scope.' : '' })) });

test('F6.4 #1 leak and no oracle: a library client, an email, a phone and a URL never reach a model; the caller reads their own words', async () => {
  const { l, seen } = await world(echo);
  const question = 'What claims triage did we do at ZEBRACORP and Brightwave? Ask jane@acme.example, +33 6 12 34 56 78, https://acme.example';
  const r = (await call(l, KIM, { question })).body;
  assert.ok(seen.complete.length === 1 && seen.embed.length === 1);
  for (const input of [...seen.complete, ...seen.embed]) assert.doesNotMatch(input, SENTINEL);
  assert.equal(r.results[0].why, 'You asked: ' + question, 'un-masked with the question map: every spelling as typed');
  assert.doesNotMatch(JSON.stringify(r.results.map(x => [x.why, x.caveat, r.note])), TRACE);
  // why and caveat carry the caller's own words back; everything else is library data for a public reader.
  assert.doesNotMatch(JSON.stringify(r.results.map(x => ({ ...x, why: undefined, caveat: undefined, snippets: undefined }))), /Zebracorp|Brightwave|@/, 'a public reader: no client, no owner email');
  assert.deepEqual(l.rows("SELECT detail FROM audit WHERE action = 'ask'").map(a => a.detail), [`${r.results.length} results`]);
});

test('F6.4 #2 verdicts: garbage gives unranked, {"results":[]} gives none with no results, empty pool and nothing above the floor make no ranking call', async () => {
  const q = { question: 'Which claims triage references do we have?' };
  const garbage = await world(() => 'not json'), g = (await call(garbage.l, KIM, q)).body;
  assert.equal(g.verdict, 'unranked'); assert.ok(g.results.length && g.results.every(x => x.relevance === null && x.caveat === 'Not ranked: the ranking model did not answer. Similarity is not relevance.'));
  assert.match(g.method, /\(not ranked\)$/); assert.match(g.note, /the ranking model did not answer/);
  assert.equal((await call((await world(() => '{"results":[{"id":"ghost","relevance":90,"why":"x"}]}')).l, KIM, q)).body.verdict, 'unranked', 'hallucinated ids');
  const none = (await call((await world(() => '{"results":[]}')).l, KIM, q)).body;
  assert.deepEqual([none.verdict, none.results, none.people, none.totals.visible, none.note], ['none', [], [], 0, 'Nothing in the library answers this yet.']);
  const strong = (await call((await world(echo)).l, KIM, q)).body, partial = (await call((await world(({ candidates }) => JSON.stringify({ results: [{ id: candidates[0].id, relevance: 55, why: 'w' }] }))).l, KIM, q)).body;
  assert.deepEqual([strong.verdict, partial.verdict], ['strong', 'partial']); assert.equal(strong.label, 'Answers are interpretation over the library; open each reference for the facts. People are listed by the projects they worked on, never ranked.');
  const far = await world(echo), fr = (await call(far.l, KIM, { question: 'Which references cover mining haul trucks?' })).body;
  assert.deepEqual([fr.verdict, fr.results, far.seen.complete.length], ['none', [], 0], 'nothing above the floor: no ranking call');
  const empty = new Library(memorySql(), { complete: async () => { throw new Error('no model call'); }, embed: async () => { throw new Error('no model call'); } });
  const e = (await call(empty, KIM, q)).body;
  assert.deepEqual([e.verdict, e.method, e.results, e.note], ['empty_library', 'none', [], 'No references are available to you yet.']);
  for (const [body, status] of [[{ question: 'short' }, 400], [{ question: 'x'.repeat(601) }, 400], [{}, 400]]) assert.equal((await call(empty, KIM, body)).status, status);
  assert.equal((await call(empty, KIM, q, 'GET')).status, 404);
});

test('F6.4 #6 client filter: full access to that client narrows the pool; without it the name changes nothing', async () => {
  const { l, ids } = await world(echo);
  const mine = (await call(l, ALEX, { question: 'What claims triage have we done for Zebracorp?' })).body;
  assert.deepEqual(mine.results.map(x => x.id), [ids.mine], 'only the Zebracorp rows alex can open fully'); assert.equal(mine.note, 'Filtered to references for that client that you can open fully.');
  const kim = (await call(l, KIM, { question: 'What claims triage have we done for Zebracorp?' })).body, unknown = (await call(l, KIM, { question: 'What claims triage have we done for Quuxcorp?' })).body;
  assert.equal(kim.note, ''); assert.deepEqual(kim.results.map(x => x.id).sort(), unknown.results.map(x => x.id).sort(), 'the same pool as an unknown name');
  assert.ok(kim.results.length >= 3 && kim.results.every(x => x.status === 'published' && x.access === 'public') && !kim.results.some(x => x.id === ids.draft), 'published rows only for a public reader');
  const rev = (await call(l, REV, { question: 'What claims triage have we done for ZEBRACORP?' })).body;
  assert.deepEqual(rev.results.map(x => x.id).sort(), [ids.mine, ids.theirs].sort(), 'a reviewer opens every Zebracorp row');
  const owner = (await call(l, LEE, { question: 'Any draft claims triage?' })).body;
  assert.ok(owner.results.some(x => x.id === ids.draft && x.status === 'in_review'), 'full-access drafts are in the pool, with their status');
});

test('F6.4 #3 people, snippets, SafeSummary and countries: record membership only, emails and raw text only with full access', async () => {
  const { l, ids } = await world(echo);
  const r = (await call(l, ALEX, { question: 'Who worked on claims routing and payouts?', limit: 8 })).body, by = Object.fromEntries(r.results.map(x => [x.id, x]));
  assert.deepEqual(by[ids.mine].people, [{ name: 'Alex Park', role: 'Data engineer', email: 'alex@mantu.com' }, { name: 'Ana Ruiz', role: 'Product owner', email: 'ana@mantu.com' }]);
  assert.deepEqual(by[ids.theirs].people, [{ name: 'Lee Chen', role: 'Data engineer' }, { name: 'Ana Ruiz', role: 'Product owner' }, { name: 'Bo Li', role: 'Developer' }], 'no email without full access');
  assert.equal(by[ids.mine].owner, 'alex@mantu.com'); assert.equal(by[ids.mine].client, 'Zebracorp'); assert.deepEqual([by[ids.theirs].owner, by[ids.theirs].client], ['', '']);
  assert.match(JSON.stringify(by[ids.mine].snippets), /Zebracorp/, 'raw sentences for a row the caller opens fully');
  assert.doesNotMatch(JSON.stringify(by[ids.theirs].snippets), /Zebracorp/); assert.match(JSON.stringify(by[ids.other].snippets), /the client had slow claims triage, as we did at another client before\./);
  for (const x of r.results) { assert.ok(x.snippets.length <= 2 && x.snippets.every(s => s.text.length <= 300 && !('raw' in s))); }
  const ana = r.people.filter(p => p.name === 'Ana Ruiz');
  assert.equal(ana.length, 2, 'deduped by name and email: with and without the email are two entries');
  assert.ok(ana.some(p => p.email === 'ana@mantu.com' && p.refIds.includes(ids.mine)) && ana.some(p => !p.email && p.refIds.includes(ids.theirs)));
  assert.ok(r.people.length <= 10); assert.ok(r.people.every(p => !('score' in p) && !('rank' in p)));
  assert.deepEqual(r.countries.find(c => c.name === 'Belgium'), { name: 'Belgium', n: 2 }); assert.equal(r.totals.visible, r.results.length);
  const pub = (await call(l, KIM, { question: 'Who worked on claims routing and payouts?' })).body;
  assert.doesNotMatch(JSON.stringify(pub), /@/, 'no response to a public-access reader contains an @');
  assert.doesNotMatch(JSON.stringify(pub.results.map(x => x.snippets)), /Zebracorp|Brightwave/, 'masked snippets for public rows');
});

test('rate limit: 60 questions per user per hour, then 429', async () => {
  const { l } = await world(echo);
  for (let i = 0; i < 60; i++) assert.equal((await call(l, KIM, { question: 'Which claims triage references?' })).status, 200);
  assert.deepEqual(await call(l, KIM, { question: 'Which claims triage references?' }), { status: 429, body: { error: 'Too many questions this hour. Try again later.' } });
  assert.equal((await call(l, ALEX, { question: 'Which claims triage references?' })).status, 200, 'per user');
});
