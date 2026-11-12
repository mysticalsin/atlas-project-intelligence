// Production voice stays on the Worker path that is actually in this tree. Early processing was not carried.
// Production enforces the $5 month and never sets the meter off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const wrangler = readFileSync(new URL('wrangler.jsonc', root), 'utf8');
const worker = readFileSync(new URL('src/worker.js', root), 'utf8');

test('production config enforces the $5 month and is never off', () => {
  assert.doesNotMatch(wrangler, /EARLY_STT/);
  assert.doesNotMatch(wrangler, /EARLY_DRAFT/);
  assert.doesNotMatch(wrangler, /"PRODUCTION_MONTHLY_LIMIT_USD"/);
  assert.doesNotMatch(wrangler, /"LEDGER_MODE": "off"/);
  assert.match(wrangler, /"LEDGER_MODE": "enforce"/);
  assert.match(wrangler, /"name": "SPEND_LEDGER", "class_name": "ProductionSpendLedger"/);
  assert.match(wrangler, /"tag": "v3", "new_sqlite_classes": \["ProductionSpendLedger"\]/);
  assert.match(worker, /export \{ ProductionSpendLedger \} from '\.\/meter\.js'/);
  assert.doesNotMatch(worker, /speculationConfig/);
});
