// Real workerd binding. At 13d99fe this fails: ProductionSpendLedger does not extend DurableObject,
// so reserve returns 500 "does not support RPC". Live Cloudflare is not called.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('workerd RPC reserves, settles, snapshots and refuses through the binding', async () => {
  const mf = new Miniflare({
    scriptPath: path.join(root, 'test/ledger-binding.mjs'),
    modules: true,
    modulesRules: [
      { type: 'ESModule', include: ['**/*.js', '**/*.mjs'], fallthrough: true },
      { type: 'Text', include: ['**/*.html'], fallthrough: true },
    ],
    compatibilityDate: '2025-09-01',
    bindings: { PRODUCTION_MONTHLY_LIMIT_USD: '0.05' },
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
    assert.equal(typeof snap.reserved.usd, 'number');
    assert.equal(snap.overruns.requests, 0);
    const refused = await call({ op: 'reserve', req: { kind: 'memory', provider: 'hindsight', operation: 'retain', inputTokens: 65536, outputTokens: 1 } });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'exhausted:usd');
  } finally {
    await mf.dispose();
  }
});
