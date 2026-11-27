// LEDGER_MODE=off is explicit. Unset means enforce, so it is not this golden.
// The golden is this branch's off path: same arguments and outputs, no ledger lookup. Fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { scenario } from './ledger-scenario.js';

const GOLDEN = new URL('./ledger-off.golden.json', import.meta.url);
test('explicit off does not touch the ledger and matches the recorded calls', async () => {
  const off = await scenario('off');
  if (process.env.WRITE_GOLDEN === '1') writeFileSync(GOLDEN, JSON.stringify(off, null, 1) + '\n');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(off, golden, 'LEDGER_MODE=off');
  assert.ok(golden.calls.length >= 20, 'the scenario reaches every call site it covers');
});
