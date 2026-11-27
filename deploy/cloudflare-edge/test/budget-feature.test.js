import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetRoutes } from '../src/sheet.js';
import { Analyst } from '../src/ledger.js';
import { storyRater } from '../src/rating.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as profile from '../src/profile.js';
import { memorySql } from './sqlite.js';
import { BUDGET_CODE, BUDGET_MESSAGE } from '../src/budget-stop.js';

const refused = () => Object.assign(new Error('cap'), { name: 'BudgetRefused', reason: 'exhausted:usd' });

test('a sheet draft the month cannot pay for is 429 with the one sentence, and the model is not retried', async () => {
  let calls = 0;
  const ai = { complete: async () => { calls += 1; throw refused(); } };
  const res = await sheetRoutes(new Request('https://atlas.test/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentText: 'A delivered project.' }) }), 'draft', ai);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: BUDGET_MESSAGE, code: BUDGET_CODE });
  assert.equal(calls, 1);
});

test('a document the month cannot convert is the same 429, not an empty extraction', async () => {
  const ai = { toMarkdown: async () => { throw refused(); } };
  const res = await sheetRoutes(new Request('https://atlas.test/x', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'x-file-name': 'brief.pdf' }, body: new Uint8Array([1, 2, 3]) }), 'ingest', ai);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: BUDGET_MESSAGE, code: BUDGET_CODE });
});

test('the evidence analyst names the month stop instead of an empty analysis', async () => {
  const analyst = new Analyst(async () => { throw refused(); });
  const result = await analyst.hear('user-1', 'Triage fell from 40 minutes to 12 on the operations dashboard.');
  assert.equal(result.analyst_status, 'budget_exhausted');
  assert.equal(result.candidate_details.length, 0);
});

test('a story rating refused for the month is not retried as a network error', async () => {
  let calls = 0;
  const rater = storyRater({ LEDGER_MODE: 'off', TYPESAFE_API_KEY: 'test-key' }, async () => { calls += 1; throw refused(); }, { sleep: async () => {} });
  await assert.rejects(rater.rate('{"state":{}}', '{"title":"Claims triage"}', { asked: { ok: { type: 'noul', instructions: 'Is there a result?' } } }), e => e.name === 'BudgetRefused' && e.reason === 'exhausted:usd');
  assert.equal(calls, 1);
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = { email: 'alex@mantu.com', role: 'user', tenant: TENANT };
const STORY = () => ({ title: 'Claims triage alias', stage: 'Production', sector: 'Insurance', consultant: { name: 'Alex', role: 'Data engineer' },
  client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', start: '2024-03', end: '2024-11', teamSize: 6, teamRoles: ['Data engineer'], technologies: ['Python'], deliverables: ['Routing model'], serviceLines: ['Data & AI'],
    consultants: [{ name: 'Jo', email: 'jo@mantu.com', role: 'PO' }], links: [{ label: 'Ticket', url: 'https://x.example/1' }] },
  answers: ['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.', 'I designed and built the routing model and ran the pilot with two teams.',
    'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.', 'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
    'Operations dashboard export v3, before and after quarters.', 'Any insurer or service desk with manual routing and a measurable queue would benefit.'],
  validation: { manager: { name: 'Sam', email: 'sam@mantu.com' }, managerStaff: false } });

async function grant(l) {
  return profile.routes({ method: 'POST', parts: ['profile', 'consent'], body: { kind: 'jevRating', version: 1, granted: true }, user: { idp: {}, mail: OWNER.email, ...OWNER }, lib: l, env: {},
    url: new URL('https://atlas.test/api/library/profile/consent') });
}

test('background indexing leaves the embedding null and writes no vector when the budget refuses', async () => {
  let embeds = 0;
  const l = new Library(memorySql(), {
    now: () => '2026-11-11T00:00:00.000Z',
    complete: async () => JSON.stringify({ score: 90, client_value_clear: true, issues: [], recommendations: ['Name the population.'], summary: 'Strong.' }),
    embed: async () => { embeds += 1; throw refused(); },
  });
  const id = (await l.upsert(OWNER, { localId: 'p1', reference: STORY() })).id;
  await l.review(OWNER, id);
  const row = l.rows('SELECT embedding FROM refs WHERE id = ?', id)[0];
  assert.equal(embeds, 1);
  assert.equal(row.embedding, null);
});

test('an exhausted month does not fall through to another rating model, store a rules score, or retry the rating', async () => {
  for (const budget of ['interactive', 'background']) {
    let fetches = 0, completes = 0;
    const rater = storyRater({ LEDGER_MODE: 'off', TYPESAFE_API_KEY: 'test-key' }, async () => { fetches += 1; throw refused(); }, { sleep: async () => {} });
    const l = new Library(memorySql(), {
      now: () => '2026-11-11T00:00:00.000Z',
      complete: async () => { completes += 1; return '{"score":90}'; },
      rater,
    });
    await grant(l);
    const id = (await l.upsert(OWNER, { localId: 'p1', reference: STORY() })).id;
    await assert.rejects(() => l.review(budget === 'background' ? { email: 'atlas', role: 'admin', tenant: TENANT } : OWNER, id, { budget }), e => e.name === 'BudgetExhausted' && e.code === BUDGET_CODE && e.message === BUDGET_MESSAGE);
    assert.equal(fetches, 1, budget);
    assert.equal(completes, 0, budget);
    assert.equal(l.row(id).state.quality, null, budget);
    assert.equal(l.rows('SELECT quality_score FROM refs WHERE id = ?', id)[0].quality_score, null, budget);
  }
});

test('ask and recommend stay 200 with the lexical cards and the one sentence', async () => {
  const l = new Library(memorySql(), {
    now: () => '2026-11-11T00:00:00.000Z',
    complete: async () => { throw refused(); },
    embed: async () => { throw refused(); },
  });
  const id = (await l.upsert(OWNER, { localId: 'p1', reference: STORY() })).id;
  const row = l.row(id);
  l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved', by: 't', at: '', note: '' } }, 't', 'validated', '');
  const headers = { 'content-type': 'application/json', 'x-atlas-user': 'kim@mantu.com', 'x-atlas-role': 'user', 'x-atlas-email': 'kim@mantu.com', 'x-atlas-tenant': TENANT };
  const post = (path, body) => libraryRoutes(new Request('https://atlas.test/api/library/' + path, { method: 'POST', headers, body: JSON.stringify(body) }), l);
  const ask = await post('ask', { question: 'Which claims triage references do we have?' });
  const recommend = await post('recommend', { query: 'I am meeting an insurer about claims triage routing.' });
  assert.equal(ask.status, 200);
  assert.equal(recommend.status, 200);
  const askBody = await ask.json(), recBody = await recommend.json();
  assert.deepEqual(askBody.budget, { code: BUDGET_CODE, message: BUDGET_MESSAGE });
  assert.deepEqual(recBody.budget, { code: BUDGET_CODE, message: BUDGET_MESSAGE });
  assert.equal(askBody.verdict, 'unranked');
  assert.ok(askBody.results.some(r => r.title === 'Claims triage alias'));
  assert.ok(recBody.results.some(r => r.title === 'Claims triage alias'));
});
