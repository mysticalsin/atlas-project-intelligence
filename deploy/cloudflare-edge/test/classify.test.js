import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, DIMENSIONS, projectState, requestBody, parse, impact, classify } from '../src/classify.js';
import { handle } from '../src/app.js';

const PROJECT = { title: 'Service triage (synthetic)', role: 'Data engineer', sector: 'Insurance', stage: 'Pilot',
  answers: ['Tickets bounced between three teams.', 'I built the routing rules.', 'We added an ML classifier.', 'Triage time fell from 42 to 26 minutes.', 'Service desk report, March 2026.', 'Useful for any support organisation.'] };
function answers({ primary = 'data_ai', also = {}, scores = {} } = {}) {
  const a = { primary_category: { type: 'choice', choice: primary, confidence: .82, probabilities: {} } };
  for (const k of Object.keys(CATEGORIES)) a['also_' + k] = { type: 'noul', noul: also[k] ?? .1 };
  for (const k of Object.keys(DIMENSIONS)) a['score_' + k] = { type: 'score', score: scores[k] ?? 2, confidence: .8 };
  return { model: 'jev-1.13.0', answers: a };
}

test('state excludes confidential client fields by construction', () => {
  assert.throws(() => projectState({ ...PROJECT, client: { name: 'Contoso' } }), /confidential/);
  assert.throws(() => projectState({ ...PROJECT, answers: [] }));
  const s = projectState(PROJECT);
  assert.equal(s.account.outcome, 'Triage time fell from 42 to 26 minutes.');
});

test('one request carries the category choice, per-category flags and five impact scores', () => {
  const body = requestBody('jev-latest', projectState(PROJECT));
  assert.equal(body.questions.primary_category.type, 'choice');
  assert.ok('other' in body.questions.primary_category.criteria);
  assert.equal(Object.keys(body.questions).filter(k => k.startsWith('also_')).length, Object.keys(CATEGORIES).length);
  for (const k of Object.keys(DIMENSIONS)) { assert.equal(body.questions['score_' + k].type, 'score'); assert.equal(body.questions['score_' + k].criteria.length, 5); }
  assert.match(body.state.notice, /never reward bigger claims/);
});

test('parsing: primary + secondary categories and a 0–100 impact score', () => {
  const r = parse(answers({ primary: 'data_ai', also: { cloud_infra: .8, data_ai: .95 }, scores: { business_impact: 4, evidence: 4, reusability: 4, differentiation: 4, showcase: 4 } }));
  assert.equal(r.primary.label, 'Data & AI'); assert.deepEqual(r.also.map(x => x.key), ['cloud_infra']); assert.equal(r.impact, 100);
  assert.equal(parse(answers()).impact, 50);
  assert.equal(impact(parse(answers({ scores: { business_impact: 4 } })).scores, { business_impact: 1, evidence: 0, reusability: 0, differentiation: 0, showcase: 0 }), 100);
  assert.throws(() => parse({ answers: { ...answers().answers, primary_category: { type: 'choice', choice: 'made_up', confidence: .9 } } }));
  assert.throws(() => parse({ answers: { ...answers().answers, score_evidence: { type: 'score', score: 9, confidence: .9 } } }));
});

test('no key means an honest 503, never a fabricated score', async () => {
  await assert.rejects(classify({}, PROJECT), e => e.status === 503);
});

test('retries on 429 and returns parsed results', async () => {
  let calls = 0;
  const r = await classify({ LEDGER_MODE: 'off', TYPESAFE_API_KEY: 'k' }, PROJECT, async (url, init) => {
    calls++; assert.equal(JSON.parse(init.body).model, 'jev-latest');
    return calls === 1 ? new Response('', { status: 429 }) : new Response(JSON.stringify(answers({ primary: 'web_app' })));
  });
  assert.equal(calls, 2); assert.equal(r.primary.key, 'web_app');
});

test('route is CSRF- and origin-protected', async () => {
  const ORIGIN = 'https://atlas.example.workers.dev';
  const env = { ORIGIN, CSRF_SECRET: 's', ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 't' };
  // Without Access the route is unreachable (401 before anything else).
  const r = await handle(new Request(ORIGIN + '/api/jev/classify', { method: 'POST', body: '{}' }), env, '');
  assert.equal(r.status, 401);
});
