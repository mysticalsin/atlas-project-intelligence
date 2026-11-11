import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetRoutes } from '../src/sheet.js';
import { Analyst } from '../src/ledger.js';
import { storyRater } from '../src/rating.js';
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
  const rater = storyRater({ TYPESAFE_API_KEY: 'test-key' }, async () => { calls += 1; throw refused(); }, { sleep: async () => {} });
  await assert.rejects(rater.rate('{"state":{}}', '{"title":"Claims triage"}', { asked: { ok: { type: 'noul', instructions: 'Is there a result?' } } }), e => e.name === 'BudgetRefused' && e.reason === 'exhausted:usd');
  assert.equal(calls, 1);
});
