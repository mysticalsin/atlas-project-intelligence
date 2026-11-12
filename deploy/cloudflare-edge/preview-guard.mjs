// Refuse a preview upload when this build cannot meter live AI.
// The live Worker has no SPEND_LEDGER and no v3 migration. Those have to be in this file.
import { readFileSync } from 'node:fs';
import { previewLedgerReady } from './src/preview.js';

const file = process.argv[2] || new URL('./wrangler.jsonc', import.meta.url);
const text = readFileSync(file, 'utf8');
const cfg = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
const result = previewLedgerReady(cfg);
if (!result.ok) {
  console.error('Preview upload refused. This build needs SPEND_LEDGER bound to ProductionSpendLedger, the v3 migration that creates it, and LEDGER_MODE enforce or unset. Missing: ' + result.reason);
  process.exit(1);
}
