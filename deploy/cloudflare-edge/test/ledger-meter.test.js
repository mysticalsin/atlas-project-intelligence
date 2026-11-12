// The wrapper factory itself (src/meter.js): mode parsing, off pass-through, timeouts, settling, the budget state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paid, ledgerMode, BudgetState, ProductionSpendLedger, PRODUCTION_MONTHLY_LIMIT_USD, DEFAULT_LEDGER_MODE, priceOf, sanitize } from '../src/meter.js';

const ROOT = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, ROOT), 'utf8');
const lines = () => { const out = []; return { out, log: l => out.push(l) }; };

test('LEDGER_MODE: unset enforces; explicit off is off; unknown values are not silently off', () => {
  assert.equal(DEFAULT_LEDGER_MODE, 'enforce');
  assert.equal(PRODUCTION_MONTHLY_LIMIT_USD, 5, 'the production month cap defaults to $5');
  for (const v of [undefined, null, '']) assert.equal(ledgerMode({ LEDGER_MODE: v }), 'enforce');
  assert.equal(ledgerMode({}), 'enforce'); assert.equal(ledgerMode(undefined), 'enforce');
  assert.equal(ledgerMode({ LEDGER_MODE: 'off' }), 'off');
  assert.equal(ledgerMode({ LEDGER_MODE: 'observe' }), 'observe');
  assert.equal(ledgerMode({ LEDGER_MODE: 'enforce' }), 'enforce');
  assert.equal(ledgerMode({ LEDGER_MODE: 'Observe' }), 'invalid');
  assert.match(read('wrangler.jsonc'), /"LEDGER_MODE": "enforce"/, 'production enforces the cap');
  assert.doesNotMatch(read('wrangler.jsonc'), /"LEDGER_MODE": "off"/, 'production is never off');
  assert.doesNotMatch(read('wrangler.jsonc'), /"PRODUCTION_MONTHLY_LIMIT_USD"/, 'no limit override, so the $5 default applies');
  for (const f of ['../../scripts/run_local_voice.sh', '../../scripts/pod_setup.sh']) assert.doesNotMatch(read(f), /LEDGER_MODE=off|ATLAS_LEDGER_DEV=1/, f + ' does not turn the ledger off');
  assert.match(read('dev/local-edge.mjs'), /LEDGER_MODE: 'off'/, 'the local edge sets off explicitly');
});

test('off: toMarkdown and provider fetches pass the exact arguments through, with no estimate evaluated', async () => {
  const seen = [], env = { LEDGER_MODE: 'off', AI: { toMarkdown: (...a) => { seen.push(a); return 'md'; }, run: (...a) => { seen.push(a); return 'r'; } } };
  Object.defineProperty(env, 'SPEND_LEDGER', { get() { throw new Error('looked up'); } });
  const never = () => { throw new Error('estimate evaluated in off mode'); };
  const m = paid(env), files = [{ name: 'a.pdf' }], opts = { conversionOptions: { pdf: { metadata: false } } };
  assert.equal(await m.toMarkdown(never, files, opts), 'md');
  assert.equal(m.run(never, 'model', { x: 1 }, undefined), 'r', 'off returns the upstream value itself, not a wrapper promise');
  assert.equal(seen[0].length, 2); assert.equal(seen[0][0], files); assert.equal(seen[0][1], opts);
  assert.equal(seen[1].length, 3, 'a trailing undefined argument is kept');
  const f = (...a) => a; assert.deepEqual(m.fetch(never, f, 'https://x.example/', { method: 'POST' }), ['https://x.example/', { method: 'POST' }]);
});

test('observe: the estimate failing does not block the call either', async () => {
  const { out, log } = lines(), env = { LEDGER_MODE: 'observe', AI: { run: async m => 'ran ' + m } };
  assert.equal(await paid(env, { log }).run(() => { throw new Error('bad estimate'); }, 'm'), 'ran m');
  assert.equal(out[0].kind, 'unknown');
});

test('enforce: a hanging ledger times out and refuses', async () => {
  const calls = [], env = { LEDGER_MODE: 'enforce', AI: { run: async () => { calls.push(1); return 'x'; } } };
  const ledger = { reserve: () => new Promise(() => {}) };
  await assert.rejects(paid(env, { ledger, timeoutMs: 20, log: () => {} }).run(() => ({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 }), 'm', {}), e => e.reason === 'ledger_timeout');
  assert.equal(calls.length, 0);
});

test('enforce: an invalid LEDGER_MODE refuses every paid call', async () => {
  const calls = [], env = { LEDGER_MODE: 'enfroce', AI: { run: async () => { calls.push(1); } } };
  await assert.rejects(paid(env, { ledger: { reserve: async () => ({ ok: true, id: 'x' }) }, log: () => {} }).run(() => ({ kind: 'stt' }), 'm'), e => e.reason === 'invalid_mode');
  assert.equal(calls.length, 0);
});

test('enforce awaits a failed settle and leaves the reservation at its ceiling', async () => {
  const b = new BudgetState({ limitUsd: 5, now: () => Date.parse('2026-11-12T00:00:00Z') });
  const { out, log } = lines();
  const ledger = { reserve: req => b.reserve(req), settle: async () => { throw new Error('settle down'); } };
  const door = paid({ LEDGER_MODE: 'enforce', AI: { run: async () => 'out' } }, { ledger, log });
  await assert.rejects(door.run(() => ({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 }), 'm'), e => e.reason === 'ledger_error');
  assert.equal(b.snapshot().inFlight, 1);
  assert.ok(b.snapshot().reserved.nanoUsd > 0);
  assert.ok(out.some(row => row.error === 'settle' && row.ledger === 'settle_failed'));
});

test('enforce settles after success and after an upstream failure, and the upstream error is unchanged', async () => {
  const settled = [], ledger = { reserve: async () => ({ ok: true, id: 'P1' }), settle: async (id, o) => settled.push([id, o]) };
  const ok = paid({ LEDGER_MODE: 'enforce', AI: { run: async () => 'out' } }, { ledger, log: () => {} });
  assert.equal(await ok.run(() => ({ kind: 'stt' }), 'm'), 'out');
  const boom = Object.assign(new Error('upstream'), { name: 'AiError' });
  const bad = paid({ LEDGER_MODE: 'enforce', AI: { run: async () => { throw boom; } } }, { ledger, log: () => {} });
  await assert.rejects(bad.run(() => ({ kind: 'stt' }), 'm'), e => e === boom);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(settled, [['P1', {}], ['P1', { error: 'AiError' }]]);
});

test('BudgetState: priced ceilings, never refunded, one UTC month; ProductionSpendLedger persists', async () => {
  let t = Date.parse('2026-11-09T23:59:00Z');
  const b = new BudgetState({ limitUsd: 0.02, now: () => t });
  assert.equal(priceOf({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1 }), Math.ceil(1000 / 60000 * 0.0052 * 1e9), 'audio rounds up to a whole second');
  assert.equal(priceOf({ kind: 'turn', model: '@cf/pipecat-ai/smart-turn-v2', audioMs: 8000 }), Math.ceil(8000 / 60000 * 0.00033795 * 1e9), 'turn at the 8 s cap');
  assert.equal(priceOf({ kind: 'turn', model: '@cf/pipecat-ai/smart-turn-v2', audioMs: 20000 }), null, 'turn above the cap is not given a smaller ceiling');
  assert.equal(priceOf({ kind: 'analyst', model: '@cf/openai/gpt-oss-120b', inputTokens: 10, outputTokens: 10 }), Math.ceil((10 * 0.35 + 10 * 0.75) / 1e6 * 1e9));
  assert.equal(priceOf({ kind: 'jev', provider: 'typesafe', requests: 1 }), Math.ceil(64000 * 0.042 / 1e6 * 1e9));
  assert.equal(priceOf({ kind: 'stt', model: 'not-a-model', audioMs: 1000 }), null, 'an unknown model is still refused');
  const r = b.reserve({ kind: 'tts', model: '@cf/deepgram/aura-2-en', chars: 100 });
  assert.ok(r.ok); assert.equal(b.settle(r.id, { error: 'x' }), true); assert.equal(b.settle(r.id), false);
  assert.equal(b.snapshot().reserved.requests, 1, 'a failed call keeps its reservation');
  t += 120000; // next UTC day, same month
  assert.equal(b.snapshot().month, '2026-11');
  assert.equal(b.snapshot().reserved.requests, 1, 'a new day does not reset the month');
  t = Date.parse('2026-12-01T00:00:00Z');
  assert.equal(b.snapshot().month, '2026-12');
  assert.equal(b.snapshot().reserved.requests, 0);
  assert.deepEqual(sanitize({ kind: 'stt', text: 'secret', audioMs: 12.2, model: 'm' }), { kind: 'stt', model: 'm', audioMs: 13 });
  const store = new Map(), state = { storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, structuredClone(v)); } } };
  const a = new ProductionSpendLedger(state, {}, { limitUsd: 1 });
  assert.ok((await a.reserve({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 })).ok);
  assert.equal((await new ProductionSpendLedger(state, {}, { limitUsd: 1 }).snapshot()).reserved.requests, 1, 'state survives a restart');
  assert.equal((await new ProductionSpendLedger(state, {}, { limitUsd: null }).reserve({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 })).reason, 'limit_unset', 'an explicit empty limit refuses');
});
