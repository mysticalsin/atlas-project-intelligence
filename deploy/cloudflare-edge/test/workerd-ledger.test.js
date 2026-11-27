// Real workerd binding. At 13d99fe this fails: ProductionSpendLedger does not extend DurableObject,
// so reserve returns 500 "does not support RPC". No PRODUCTION_MONTHLY_LIMIT_USD binding: the class
// uses the $5 default. Live Cloudflare is not called.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('workerd RPC reserves, settles, snapshots, records an overrun, and refuses a call over $5', async () => {
  const mf = new Miniflare({
    scriptPath: path.join(root, 'workerd-fixtures/ledger-binding.mjs'),
    modules: true,
    modulesRules: [
      { type: 'ESModule', include: ['**/*.js', '**/*.mjs'], fallthrough: true },
      { type: 'Text', include: ['**/*.html'], fallthrough: true },
    ],
    compatibilityDate: '2025-09-01',
    durableObjects: { SPEND_LEDGER: { className: 'ProductionSpendLedger', useSQLite: true } },
  });
  const call = async body => {
    const res = await mf.dispatchFetch('https://atlas.example/ledger', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return JSON.parse(text);
  };
  try {
    const reserved = await call({ op: 'reserve', req: { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 1000, outputTokens: 100 } });
    assert.equal(reserved.ok, true);
    assert.match(reserved.id, /^P/);
    const settled = await call({ op: 'settle', id: reserved.id, observed: { usage: { inputTokens: 10, outputTokens: 4 } } });
    assert.equal(settled.settled, true);
    const snap = await call({ op: 'snapshot' });
    assert.equal(snap.limitUsd, 5);
    assert.equal(snap.overruns.requests, 0);
    assert.ok(snap.reserved.usd < reserved.usd, 'settle charged the smaller actual');
    // 600,000 retain tokens at $10 / million is $6, over the $5 month, through the real binding.
    const refused = await call({ op: 'reserve', req: { kind: 'memory', provider: 'hindsight', operation: 'retain', inputTokens: 600000, outputTokens: 0 } });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'exhausted:usd');
    const afterRefusal = await call({ op: 'snapshot' });
    assert.equal(afterRefusal.reserved.usd, snap.reserved.usd);
    assert.equal(afterRefusal.overruns.requests, 0);
    // Settle charges the priced usage even when it is above the reservation. The extra is an overrun, not a clamp.
    const again = await call({ op: 'reserve', req: { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 1000, outputTokens: 100 } });
    assert.equal(again.ok, true);
    const overrun = await call({ op: 'settle', id: again.id, observed: { usage: { inputTokens: 4000000, outputTokens: 0 } } });
    assert.equal(overrun.settled, true);
    const blown = await call({ op: 'snapshot' });
    assert.equal(blown.overruns.requests, 1);
    assert.ok(blown.reserved.usd > again.usd, 'the real amount is stored, not clamped to the hold or to $5');
    assert.ok(blown.overruns.nanoUsd > 0);
    assert.equal(blown.exhausted, true);
    assert.equal(blown.phase, 'exhausted');
    const stopped = await call({ op: 'reserve', req: { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 1000, outputTokens: 100 } });
    assert.equal(stopped.ok, false);
    assert.equal(stopped.reason, 'exhausted:usd');
  } finally {
    await mf.dispose();
  }
});

test('workerd reads a v1 month and does not rewrite an unknown version', async () => {
  const mf = new Miniflare({
    scriptPath: path.join(root, 'workerd-fixtures/ledger-binding-version.mjs'),
    modules: true,
    modulesRules: [
      { type: 'ESModule', include: ['**/*.js', '**/*.mjs'], fallthrough: true },
      { type: 'Text', include: ['**/*.html'], fallthrough: true },
    ],
    compatibilityDate: '2025-09-01',
    durableObjects: { SPEND_LEDGER: { className: 'ProductionSpendLedger', useSQLite: true } },
  });
  const call = async body => {
    const res = await mf.dispatchFetch('https://atlas.example/ledger', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return JSON.parse(text);
  };
  const v1 = {
    v: 1, phase: 'open', month: '2026-11', denyReason: '', next: 1,
    open: { P1: { kind: 'memory', provider: 'hindsight', operation: 'recall', nano: 1000, at: Date.parse('2026-11-12T00:00:00Z') } },
    reserved: { nanoUsd: 5000, requests: 1 },
    observed: { nanoUsd: 4000, requests: 1, unpriced: 0 },
    byKind: { memory: 1 }, refusals: {},
    settled: { ok: 1, errors: 0 },
    overruns: { requests: 0, nanoUsd: 0 },
  };
  try {
    assert.equal((await call({ op: 'plant', doc: v1 })).ok, true);
    const snap = await call({ op: 'snapshot' });
    assert.equal(snap.reserved.nanoUsd, 5000);
    assert.equal(snap.inFlight, 1);
    assert.equal(snap.settled.unsettled, 0);
    assert.deepEqual((await call({ op: 'stored' })).doc, v1);
    const future = { v: 9, phase: 'open', month: '2026-11', open: { P9: { nano: 50 } }, note: 'leave this' };
    assert.equal((await call({ op: 'plant', doc: future })).ok, true);
    const refused = await call({ op: 'reserve', req: { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 10, outputTokens: 4 } });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unknown_month');
    assert.deepEqual((await call({ op: 'stored' })).doc, future);
  } finally {
    await mf.dispose();
  }
});

test('workerd settle put failure leaves the full hold', async () => {
  const mf = new Miniflare({
    scriptPath: path.join(root, 'workerd-fixtures/ledger-binding-fail.mjs'),
    modules: true,
    modulesRules: [
      { type: 'ESModule', include: ['**/*.js', '**/*.mjs'], fallthrough: true },
      { type: 'Text', include: ['**/*.html'], fallthrough: true },
    ],
    compatibilityDate: '2025-09-01',
    durableObjects: { SPEND_LEDGER: { className: 'ProductionSpendLedger', useSQLite: true } },
  });
  const call = async body => {
    const res = await mf.dispatchFetch('https://atlas.example/ledger', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return JSON.parse(text);
  };
  try {
    const reserved = await call({ op: 'reserve', req: { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 1000, outputTokens: 100 } });
    assert.equal(reserved.ok, true);
    const before = await call({ op: 'snapshot' });
    assert.equal(before.inFlight, 1);
    await call({ op: 'arm' });
    const settled = await call({ op: 'settle', id: reserved.id, observed: { usage: { inputTokens: 1, outputTokens: 1 } } });
    assert.deepEqual(settled.settled, { ok: false, reason: 'ledger_error' });
    const after = await call({ op: 'snapshot' });
    assert.equal(after.reserved.nanoUsd, before.reserved.nanoUsd);
    assert.equal(after.reserved.usd, before.reserved.usd);
    assert.equal(after.inFlight, 1);
  } finally {
    await mf.dispose();
  }
});
