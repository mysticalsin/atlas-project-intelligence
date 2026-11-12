// A turn-model call that outlives the 350 ms wait must not become the verdict, and the hold settles at its reservation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workersAI } from '../src/app.js';
import { BudgetState, callCeilingNano } from '../src/meter.js';

test('a slow turn model is ignored after 350ms and the reservation is settled once', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ledger = new BudgetState({ limitUsd: 5, now: () => Date.parse('2026-11-12T00:00:00Z') });
  let ran = 0;
  const env = {
    LEDGER_MODE: 'enforce',
    TURN_MODEL: '@cf/pipecat-ai/smart-turn-v2',
    SPEND_LEDGER: { idFromName: () => 'production', get: () => ledger },
    AI: { async run() { ran += 1; await gate; return { is_complete: true, probability: 0.99, usage: { prompt_tokens: 500000, completion_tokens: 500000 } }; } },
  };
  const pending = workersAI(env).turnComplete(new Uint8Array(4800));
  const raced = await Promise.race([
    pending.then(value => ({ done: true, value })),
    new Promise(resolve => setTimeout(() => resolve({ done: false }), 450)),
  ]);
  assert.equal(raced.done, true);
  assert.equal(raced.value, null);
  const ceiling = callCeilingNano({ kind: 'turn', model: env.TURN_MODEL, audioMs: 1000 });
  const mid = ledger.snapshot();
  assert.equal(mid.inFlight, 0);
  assert.equal(mid.reserved.nanoUsd, ceiling);
  assert.equal(mid.observed.nanoUsd, ceiling);
  assert.equal(mid.overruns.requests, 0);
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  const after = ledger.snapshot();
  assert.equal(after.inFlight, 0);
  assert.equal(after.reserved.nanoUsd, ceiling);
  assert.equal(after.observed.requests, 1);
  assert.equal(after.overruns.requests, 0);
  assert.equal(ran, 1);
});
