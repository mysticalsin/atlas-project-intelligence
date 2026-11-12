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
    scriptPath: path.join(root, 'test/ledger-binding.mjs'),
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
    assert.ok(blown.reserved.usd > again.usd);
    assert.ok(blown.overruns.nanoUsd > 0);
  } finally {
    await mf.dispose();
  }
});
