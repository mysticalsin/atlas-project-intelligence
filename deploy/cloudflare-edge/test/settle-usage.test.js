// Settle charges the usage the response returns. A smaller actual refunds the rest of the reservation.
// A larger actual is counted and flagged in the same step. Missing usage keeps the ceiling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BudgetState, ProductionSpendLedger, paid, ledgerMode, priceOf, callCeilingNano, LIMITS } from '../src/meter.js';

const NOW = () => Date.parse('2026-11-11T12:00:00Z');
const NANO = 1e9;

function book() {
  return new BudgetState({ now: NOW });
}

test('unset LEDGER_MODE enforces, and production config is never off', () => {
  assert.equal(ledgerMode({}), 'enforce');
  assert.equal(ledgerMode({ LEDGER_MODE: '' }), 'enforce');
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(wrangler, /"LEDGER_MODE": "enforce"/);
  assert.doesNotMatch(wrangler, /"LEDGER_MODE": "off"/);
});

test('actual below the ceiling refunds the rest of the reservation', () => {
  const b = book();
  const req = { kind: 'analyst', model: '@cf/openai/gpt-oss-120b', inputTokens: 1000, outputTokens: 1000 };
  const r = b.reserve(req);
  assert.equal(r.ok, true);
  const ceiling = b.snapshot().reserved.nanoUsd;
  const actual = Math.floor(ceiling / 2);
  assert.equal(b.settle(r.id, { actualNano: actual }), true);
  const snap = b.snapshot();
  assert.equal(snap.reserved.nanoUsd, actual);
  assert.equal(snap.inFlight, 0);
  assert.equal(snap.overruns.requests, 0);
});

test('actual above the ceiling is counted and flagged in the same step', () => {
  const b = book();
  const req = { kind: 'analyst', model: '@cf/openai/gpt-oss-120b', inputTokens: 100, outputTokens: 100 };
  const r = b.reserve(req);
  const ceiling = b.snapshot().reserved.nanoUsd;
  const actual = ceiling + 50_000;
  assert.equal(b.settle(r.id, { actualNano: actual }), true);
  const snap = b.snapshot();
  assert.equal(snap.reserved.nanoUsd, actual);
  assert.equal(snap.overruns.requests, 1);
  assert.equal(snap.overruns.nanoUsd, 50_000);
});

test('a mixed-kind burst settles each call on its own usage', () => {
  const b = book();
  const kinds = [
    { kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 },
    { kind: 'talker', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', inputTokens: 200, outputTokens: 50 },
    { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 40, outputTokens: 20 },
  ];
  const held = kinds.map(req => ({ req, id: b.reserve(req).id, ceiling: callCeilingNano(req) }));
  const actuals = held.map(h => Math.max(1, Math.floor(h.ceiling / 4)));
  held.forEach((h, i) => b.settle(h.id, { actualNano: actuals[i] }));
  const snap = b.snapshot();
  assert.equal(snap.reserved.nanoUsd, actuals.reduce((s, n) => s + n, 0));
  assert.equal(snap.inFlight, 0);
  assert.equal(snap.byKind.stt, 1);
  assert.equal(snap.byKind.talker, 1);
  assert.equal(snap.byKind.memory, 1);
});

test('a storage write failure does not admit the call and does not keep a partial reservation', async () => {
  let puts = 0;
  const state = { storage: { get: async () => null, put: async () => { puts += 1; throw new Error('disk'); } } };
  const ledger = new ProductionSpendLedger(state, {}, { limitUsd: 5 });
  const refused = await ledger.reserve({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'ledger_error');
  assert.equal(puts, 1);
});

test('a missing ledger refuses before the upstream call', async () => {
  let calls = 0;
  const door = paid({ LEDGER_MODE: 'enforce', AI: { run: async () => { calls += 1; return { usage: { prompt_tokens: 1, completion_tokens: 1 } }; } } }, { log: () => {} });
  await assert.rejects(() => door.run(() => ({ kind: 'analyst', model: '@cf/openai/gpt-oss-120b', inputTokens: 10, outputTokens: 10 }), 'model', {}), e => e.reason === 'no_ledger');
  assert.equal(calls, 0);
});

test('Hindsight is priced from tokens, not the flat retain ceiling', () => {
  const flat = 20000 * 10 / 1e6 * NANO;
  const recall = priceOf({ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 40, outputTokens: 20 });
  assert.ok(recall < flat / 10, 'a short recall is not the $0.20 retain ceiling');
  assert.equal(recall, Math.ceil(60 * 0.75 / 1e6 * NANO));
});

test('explicit off writes one log line and still makes the call', async () => {
  const lines = [];
  let calls = 0;
  const door = paid({ LEDGER_MODE: 'off', AI: { run: async () => { calls += 1; return 'ok'; } } }, { log: line => lines.push(line) });
  assert.equal(await door.run(() => ({ kind: 'stt' }), 'm', {}), 'ok');
  assert.equal(calls, 1);
  assert.equal(lines.filter(l => l.mode === 'off').length, 1);
});

test('a reservation older than the TTL settles at the ceiling so open rows do not pile up', () => {
  let t = NOW();
  const b = new BudgetState({ now: () => t });
  const first = b.reserve({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 });
  const ceiling = b.snapshot().reserved.nanoUsd;
  t += 120_001;
  const second = b.reserve({ kind: 'tts', model: '@cf/deepgram/aura-2-en', chars: 20 });
  assert.equal(second.ok, true);
  const snap = b.snapshot();
  assert.equal(snap.inFlight, 1, 'the fresh reservation stays open');
  assert.ok(snap.reserved.nanoUsd >= ceiling, 'the swept row kept its ceiling');
  assert.equal(b.toJSON().open[first.id], undefined);
});

test('reasoning inside completion is not added again, and excluded reasoning is', async () => {
  const { usageFrom } = await import('../src/usage.js');
  const included = usageFrom({ usage: { prompt_tokens: 10, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 } } });
  assert.equal(included.outputTokens, 8);
  const separate = usageFrom({ usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 9 } } });
  assert.equal(separate.outputTokens, 13);
  const ceiling = priceOf({ kind: 'analyst', model: '@cf/openai/gpt-oss-120b', inputTokens: 10, outputTokens: 8 });
  const raised = priceOf({ kind: 'analyst', model: '@cf/openai/gpt-oss-120b', inputTokens: 10, outputTokens: 9 });
  assert.ok(raised > ceiling);
});

test('a document toMarkdown ceiling is the page cap, and an image stays one file of two Gemma calls', () => {
  const pages = LIMITS.markdown.maxPages;
  const document = priceOf({ kind: 'markdown', files: pages, media: 'document' });
  const image = priceOf({ kind: 'markdown', files: 1 });
  assert.ok(document > image, 'a document reserves the image worst case for every page in the cap');
  assert.equal(priceOf({ kind: 'markdown', files: pages + 1, media: 'document' }), null, 'more pages than the cap is not priced as the cap');
  assert.equal(callCeilingNano({ kind: 'markdown', files: 1 }), image + 6_000_300);
});

test('a streamed talker settles reported usage plus the proxy', async () => {
  const { workersAI } = await import('../src/app.js');
  const b = new BudgetState({ limitUsd: 5, now: NOW });
  const ledger = { async reserve(req) { return b.reserve(req); }, async settle(id, observed) { return b.settle(id, observed); } };
  const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
  const env = {
    LEDGER_MODE: 'enforce', TALKER_MODEL: model,
    SPEND_LEDGER: { idFromName: () => 'production', get: () => ledger },
    AI: { async run() { return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }); } },
  };
  const said = [];
  for await (const delta of workersAI(env).chatStream([{ role: 'user', content: 'hi' }])) said.push(delta);
  assert.deepEqual(said, ['Hi']);
  const priced = priceOf({ kind: 'talker', model, inputTokens: 12, outputTokens: 3, settleUsage: true });
  assert.equal(b.snapshot().observed.nanoUsd, priced + 6_000_300);
  assert.equal(b.snapshot().inFlight, 0);
});

test('a binding settle keeps the proxy on the usage price', () => {
  const b = book();
  const model = '@cf/openai/gpt-oss-120b';
  const req = { kind: 'analyst', model, inputTokens: 1000, outputTokens: 1000 };
  const reserved = b.reserve(req);
  assert.equal(reserved.ok, true);
  const usage = { inputTokens: 10, outputTokens: 4 };
  const priced = priceOf({ kind: 'analyst', model, ...usage, settleUsage: true });
  assert.equal(b.settle(reserved.id, { usage }), true);
  assert.equal(b.snapshot().observed.nanoUsd, priced + 6_000_300);
});

test('the proxy fee is the published binding formula', () => {
  assert.equal(6_000_300, Math.round((0.30 / 1e6 + 300000 * 0.02 / 1e6) * NANO));
});

test('Hindsight list, stats and bank reserve the flat ceiling, not the request bytes', () => {
  const flat = Math.ceil(LIMITS.hindsightOps.flatUsd * NANO);
  const one = priceOf({ kind: 'memory', provider: 'hindsight', operation: 'stats', inputTokens: 0, outputTokens: 0 });
  const bank = priceOf({ kind: 'memory', provider: 'hindsight', operation: 'bank', inputTokens: 80, outputTokens: 0 });
  assert.equal(one, flat);
  assert.equal(bank, flat);
});

test('realtime audio uses the dearer published modality', () => {
  const nano = priceOf({ kind: 'realtime', provider: 'openai', inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(nano, Math.ceil((32 + 64) * NANO));
});
