// Real workerd. The preview host asks for one AI call. The ledger is the Durable Object.
// Live Cloudflare is not called. The AI binding in the fixture only counts runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'https://gate8-atlas.tony-walteur.workers.dev';
const MESSAGE = "This month's AI budget is used up.";

function harness(bindings, durableObjects) {
  return new Miniflare({
    scriptPath: path.join(root, 'workerd-fixtures/preview-ai.mjs'),
    modules: true,
    modulesRules: [
      { type: 'ESModule', include: ['**/*.js', '**/*.mjs'], fallthrough: true },
      { type: 'Text', include: ['**/*.html'], fallthrough: true },
    ],
    compatibilityDate: '2025-09-01',
    bindings,
    ...(durableObjects ? { durableObjects } : {}),
  });
}

const previewBindings = {
  ATLAS_PREVIEW: '1',
  ATLAS_PREVIEW_HOST_SUFFIX: '-atlas.tony-walteur.workers.dev',
  LEDGER_MODE: 'enforce',
};

test('(b) a preview AI call stops at the $5 month with the visible sentence and no provider run', async () => {
  const mf = harness(previewBindings, { SPEND_LEDGER: { className: 'ProductionSpendLedger', useSQLite: true } });
  try {
    const spent = await mf.dispatchFetch(HOST + '/exhaust', { method: 'POST' });
    const snap = await spent.json();
    assert.equal(spent.status, 200, JSON.stringify(snap));
    assert.equal(snap.exhausted, true);
    const res = await mf.dispatchFetch(HOST + '/ai', { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 429, JSON.stringify(body));
    assert.equal(body.error, MESSAGE);
    assert.equal(body.code, 'budget_exhausted');
    assert.equal(body.fetches, 0);
  } finally {
    await mf.dispose();
  }
});
