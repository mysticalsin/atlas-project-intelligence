import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetState, ProductionSpendLedger, analystCall, priceOf, markdownPlan, LIMITS } from '../src/meter.js';
import { usageFrom } from '../src/usage.js';
import { transition } from '../src/month-budget.js';
import { monthSpend } from '../src/operate.js';
import { ledgerAccessOk } from '../src/spend-route.js';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const GPT = '@cf/openai/gpt-oss-120b';
const NANO = 1e9;

function memory() {
  const puts = [];
  let saved = null;
  let failGet = false;
  let failPut = false;
  const storage = {
    async get() { if (failGet) throw new Error('get'); return saved; },
    async put(_key, value) { puts.push(JSON.parse(JSON.stringify(value))); if (failPut) throw new Error('put'); saved = value; },
  };
  return { storage, puts, set failGet(v) { failGet = v; }, set failPut(v) { failPut = v; }, saved: () => saved };
}

test('excluded reasoning is charged on top of completion', () => {
  const billed = usageFrom({ usage: { prompt_tokens: 3, completion_tokens: 4, reasoning_tokens: 5 } });
  assert.equal(billed.outputTokens, 9);
  const included = usageFrom({ usage: { prompt_tokens: 3, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 } } });
  assert.equal(included.outputTokens, 8);
});

test('gpt-oss reserves the sum because max_tokens including reasoning is not stated', () => {
  const cap = LIMITS.analyst.maxTokens + LIMITS.analyst.reasoningTokens;
  assert.equal(cap, 3000);
  const at = priceOf({ kind: 'analyst', model: GPT, inputTokens: 8, outputTokens: cap });
  const over = priceOf({ kind: 'analyst', model: GPT, inputTokens: 8, outputTokens: cap + 1 });
  assert.ok(over > at);
});

test('hindsight list, delete, stats and bank reserve one flat ceiling and record an overrun', () => {
  const flat = Math.ceil(LIMITS.hindsightOps.flatUsd * NANO);
  for (const operation of ['list', 'forget', 'delete', 'stats', 'bank']) {
    assert.equal(priceOf({ kind: 'memory', provider: 'hindsight', operation, inputTokens: 4, outputTokens: 0 }), flat, operation);
  }
  const b = new BudgetState({ now: () => NOW });
  const reserved = b.reserve({ kind: 'memory', provider: 'hindsight', operation: 'list', inputTokens: 4, outputTokens: 0 });
  assert.equal(b.snapshot().reserved.nanoUsd, flat);
  const bigger = priceOf({ kind: 'memory', provider: 'hindsight', operation: 'list', inputTokens: LIMITS.memoryBody.maxBytes + 1000, outputTokens: 0, settleUsage: true });
  assert.ok(bigger > flat);
  assert.equal(b.settle(reserved.id, { usage: { inputTokens: LIMITS.memoryBody.maxBytes + 1000, outputTokens: 0 } }), true);
  assert.equal(b.snapshot().overruns.requests, 1);
});

test('images are refused and only known documents are priced', () => {
  const image = markdownPlan(new Uint8Array([1, 2, 3]), 'a.png', 'image/png');
  assert.equal(image.ok, false);
  assert.equal(image.code, 'unpriced_model');
  assert.equal(LIMITS.markdown.maxImages, 0);
  const odd = markdownPlan(new Uint8Array([1, 2, 3, 4]), 'payload.exe', 'application/octet-stream');
  assert.equal(odd.ok, false);
  assert.equal(odd.code, 'unsupported_document');
  const doc = markdownPlan(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'brief.pdf', 'application/pdf');
  assert.equal(doc.ok, true);
});

test('settle prices the stored model, not the client fields', () => {
  const b = new BudgetState({ now: () => NOW });
  const reserved = b.reserve({ kind: 'analyst', model: GPT, provider: 'workers', inputTokens: 1000, outputTokens: 1000 });
  const row = b.toJSON().open[reserved.id];
  assert.equal(row.model, GPT);
  assert.equal(row.provider, 'workers');
  assert.equal(row.kind, 'analyst');
  const priced = priceOf({ kind: 'analyst', model: GPT, inputTokens: 10, outputTokens: 4, settleUsage: true });
  assert.equal(b.settle(reserved.id, { usage: { inputTokens: 10, outputTokens: 4 }, actualNano: 1, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }), true);
  assert.equal(b.snapshot().observed.nanoUsd, priced + 6_000_300, 'the binding proxy stays on the settled price');
  assert.notEqual(priced, 1);
});

test('snapshot does not write', async () => {
  const box = memory();
  const ledger = new ProductionSpendLedger({ storage: box.storage }, {}, { limitUsd: 5 });
  await ledger.reserve({ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 10, outputTokens: 10 });
  const writes = box.puts.length;
  const snap = await ledger.snapshot();
  assert.equal(box.puts.length, writes);
  assert.equal(typeof snap.reserved.usd, 'number');
});

test('one storage get failure does not stick', async () => {
  const box = memory();
  box.failGet = true;
  const ledger = new ProductionSpendLedger({ storage: box.storage }, {}, { limitUsd: 5 });
  const first = await ledger.reserve({ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 10, outputTokens: 10 });
  assert.equal(first.reason, 'ledger_error');
  box.failGet = false;
  const second = await ledger.reserve({ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 10, outputTokens: 10 });
  assert.equal(second.ok, true);
});

test('a settle put failure rolls the reservation back', async () => {
  const box = memory();
  const ledger = new ProductionSpendLedger({ storage: box.storage }, {}, { limitUsd: 5 });
  const reserved = await ledger.reserve({ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 20, outputTokens: 10 });
  assert.equal(reserved.ok, true);
  const before = box.saved().reserved.nanoUsd;
  box.failPut = true;
  const settled = await ledger.settle(reserved.id, { usage: { inputTokens: 1, outputTokens: 1 } });
  assert.deepEqual(settled, { ok: false, reason: 'ledger_error' });
  assert.equal(box.saved().reserved.nanoUsd, before);
  assert.ok(box.saved().open[reserved.id]);
});

test('a concurrent burst through apply keeps one total', async () => {
  const box = memory();
  const ledger = new ProductionSpendLedger({ storage: box.storage }, {}, { limitUsd: 5 });
  const req = { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 8, outputTokens: 4 };
  const results = await Promise.all(Array.from({ length: 12 }, () => ledger.reserve(req)));
  const ok = results.filter(r => r.ok);
  assert.equal(ok.length, 12);
  const snap = await ledger.snapshot();
  assert.equal(snap.reserved.requests, 12);
  assert.equal(Object.keys(box.saved().open).length, 12);
});

test('settle after a sweep finds nothing to charge again', () => {
  let now = NOW;
  const b = new BudgetState({ now: () => now });
  const reserved = b.reserve({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 });
  now += 120001;
  const next = b.reserve({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 });
  assert.equal(next.ok, true);
  assert.equal(b.settle(reserved.id, { actualNano: 1 }), false);
  assert.equal(transition(b.toJSON(), { type: 'settle', id: reserved.id }) === b.toJSON() || !b.toJSON().open[reserved.id], true);
});

test('each analyst attempt gets its own reservation', async () => {
  const reserves = [];
  const ledger = { async reserve(req) { reserves.push(req); return reserves.length === 1 ? { ok: false, reason: 'exhausted:usd' } : { ok: true, id: 'P' + reserves.length }; }, async settle() { return true; } };
  const ns = { idFromName: () => 'production', get: () => ledger };
  let runs = 0;
  const env = { LEDGER_MODE: 'enforce', ANALYST_MODEL: GPT, SPEND_LEDGER: ns, AI: { async run() { runs += 1; if (runs === 1) throw new Error('unknown field'); return { usage: { prompt_tokens: 2, completion_tokens: 2 } }; } } };
  await assert.rejects(() => analystCall(env, () => ({ kind: 'analyst', model: GPT, inputTokens: 8, outputTokens: 8 }), { messages: [] }), e => e.reason === 'exhausted:usd');
  assert.equal(runs, 0);
  assert.equal(reserves.length, 1);
  reserves.length = 0;
  ledger.reserve = async req => { reserves.push(req); return { ok: true, id: 'P' + reserves.length }; };
  const out = await analystCall(env, () => ({ kind: 'analyst', model: GPT, inputTokens: 8, outputTokens: 8 }), { messages: [] });
  assert.equal(out.usage.completion_tokens, 2);
  assert.equal(reserves.length, 2);
});

test('an unpriced editor model is refused with a visible reason', () => {
  const b = new BudgetState({ now: () => NOW });
  const refused = b.reserve({ kind: 'editor', provider: 'openai', model: 'operator-editor', inputTokens: 20, outputTokens: 20 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'unpriced');
});

test('the ledger route uses the existing Access check and does not mint a token', async () => {
  const request = headers => ({ headers: { get: name => headers[name] || '' } });
  assert.equal(await ledgerAccessOk(request({}), {}, async () => null), true);
  const env = { ACCESS_AUD: 'aud', CF_ACCESS_CLIENT_ID: 'id', CF_ACCESS_CLIENT_SECRET: 'sec' };
  assert.equal(await ledgerAccessOk(request({ Authorization: 'Bearer ledger' }), env, async () => null), false);
  assert.equal(await ledgerAccessOk(request({ 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'sec' }), env, async () => null), true);
  assert.equal(await ledgerAccessOk(request({}), { ACCESS_AUD: 'aud' }, async () => ({ sub: 'user' })), true);
});

test('the admin readout keeps an invalid mode and shows overruns', async () => {
  const snap = { reserved: { usd: 1.25 }, month: '2026-11', overruns: { requests: 2, nanoUsd: 40 } };
  const ns = { idFromName: () => 'production', get: () => ({ snapshot: async () => snap }) };
  const invalid = await monthSpend({ LEDGER_MODE: 'enfroce', SPEND_LEDGER: ns });
  assert.equal(invalid.mode, 'invalid');
  assert.equal(invalid.overruns.requests, 2);
  const missing = await monthSpend({ LEDGER_MODE: 'nope' });
  assert.equal(missing.mode, 'invalid');
  assert.equal(missing.available, false);
});
