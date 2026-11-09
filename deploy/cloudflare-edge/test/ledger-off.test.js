// LEDGER_MODE off (the shipped default) is byte-identical to d88effdd: every paid call site receives the same
// arguments (same count, same order, same bytes) and returns the same output. The golden file was recorded by this
// same script against d88effdd (WRITE_GOLDEN=1); fakes only, no provider, no network, no spend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { scenario } from './ledger-scenario.js';

const GOLDEN = new URL('./ledger-off.golden.json', import.meta.url);
test('off (unset and explicit) is identical to d88effdd: same arguments reach every paid upstream, same outputs, no ledger lookup', async () => {
  const unset = await scenario(undefined);
  if (process.env.WRITE_GOLDEN === '1') writeFileSync(GOLDEN, JSON.stringify(unset, null, 1) + '\n');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(unset, golden, 'LEDGER_MODE unset');
  assert.deepEqual(await scenario('off'), golden, 'LEDGER_MODE=off');
  assert.ok(golden.calls.length >= 20, 'the scenario reaches every call site it covers');
});
