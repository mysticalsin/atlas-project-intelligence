// A measurement of zero is not a usage report. The reserved ceiling stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetState, generationTokens, LIMITS, priceOf } from '../src/meter.js';

const NOW = () => Date.parse('2026-11-12T12:00:00Z');

test('a zero realtime, transcribe or hindsight measurement keeps the ceiling', () => {
  const cases = [
    [{ kind: 'realtime', provider: 'openai', inputTokens: 300, outputTokens: 1500 }, { inputTokens: 0, outputTokens: 0 }],
    [{ kind: 'transcribe', provider: 'openai', audioMs: 30000 }, { audioMs: 0 }],
    [{ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 40, outputTokens: 20 }, { inputTokens: 0, outputTokens: 0 }],
  ];
  for (const [req, usage] of cases) {
    const b = new BudgetState({ now: NOW });
    const reserved = b.reserve(req);
    assert.equal(reserved.ok, true, req.kind);
    const ceiling = b.toJSON().open[reserved.id].nano;
    assert.ok(ceiling > 0, req.kind);
    assert.equal(priceOf({ ...req, ...usage, settleUsage: true }), null, req.kind);
    assert.equal(b.settle(reserved.id, { usage }), true, req.kind);
    const snap = b.snapshot();
    assert.equal(snap.reserved.nanoUsd, ceiling, req.kind);
    assert.equal(snap.inFlight, 0, req.kind);
    assert.equal(snap.overruns.requests, 0, req.kind);
  }
});

test('a talker stream with no usage stops at the reserved output and keeps the ceiling', async () => {
  const { workersAI } = await import('../src/app.js');
  const cap = generationTokens(LIMITS.talker);
  const b = new BudgetState({ limitUsd: 5, now: NOW });
  const ledger = { async reserve(req) { return b.reserve(req); }, async settle(id, observed) { return b.settle(id, observed); } };
  const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const overflow = 'x'.repeat(cap + 40);
  const sse = `data: {"choices":[{"delta":{"content":${JSON.stringify(overflow)}}}]}\n\ndata: [DONE]\n\n`;
  const env = {
    LEDGER_MODE: 'enforce', TALKER_MODEL: model,
    SPEND_LEDGER: { idFromName: () => 'production', get: () => ledger },
    AI: { async run() { return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }); } },
  };
  let said = '';
  for await (const delta of workersAI(env).chatStream([{ role: 'user', content: 'hi' }])) said += delta;
  assert.equal(said.length, cap);
  assert.equal(said, 'x'.repeat(cap));
  const snap = b.snapshot();
  assert.equal(snap.inFlight, 0);
  assert.equal(snap.overruns.requests, 0);
  assert.equal(snap.reserved.nanoUsd, snap.observed.nanoUsd);
  assert.ok(snap.reserved.nanoUsd > 0);
});
