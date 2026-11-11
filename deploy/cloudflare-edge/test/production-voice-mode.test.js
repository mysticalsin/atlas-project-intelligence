// Production voice mode stays baseline (Tony, 2026-11-11, via Jarvis 17:03 BRT). Plan A is off unless the
// production entry is explicitly changed to pass a global admission ledger and the early flags are set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { speculationConfig, MemoryLedger } from '../src/speculation.js';

const root = new URL('../', import.meta.url);
const wrangler = readFileSync(new URL('wrangler.jsonc', root), 'utf8');
const worker = readFileSync(new URL('src/worker.js', root), 'utf8');

test('production config resolves to baseline voice mode and enforces the $5 month cap', () => {
  assert.doesNotMatch(wrangler, /EARLY_STT/);
  assert.doesNotMatch(wrangler, /EARLY_DRAFT/);
  assert.doesNotMatch(wrangler, /"PRODUCTION_MONTHLY_LIMIT_USD"/);
  assert.match(wrangler, /"LEDGER_MODE": "enforce"/);
  assert.match(wrangler, /"name": "SPEND_LEDGER", "class_name": "ProductionSpendLedger"/);
  assert.match(wrangler, /"tag": "v3", "new_sqlite_classes": \["ProductionSpendLedger"\]/);
  assert.match(worker, /export \{ ProductionSpendLedger \} from '\.\/meter\.js'/);
  assert.match(worker, /speculationConfig\(this\.env,\s*null\)/);
  assert.deepEqual(speculationConfig({}, null), { enabled: false, reason: 'off' });
  const flagged = speculationConfig({ EARLY_STT: '1', EARLY_DRAFT: '1' }, null);
  assert.equal(flagged.enabled, false);
  assert.equal(flagged.reason, 'no_ledger');
  const global = new MemoryLedger({ requests: 1, concurrent: 1 }, { scope: 'global' });
  assert.equal(speculationConfig({ EARLY_STT: '1', EARLY_DRAFT: '1' }, global).enabled, true);
});
