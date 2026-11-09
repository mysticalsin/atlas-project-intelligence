// The live-test path (meteredAI over workersAI, the SpendLedger caps) is unchanged by the production meter: the same
// caps, the same exhaustion points for the $1.50 total and the 800,000 input-token cap, and exactly one upstream call
// per admitted reservation (no second metering layer while LEDGER_MODE is unset, as in every live-test config).
// Passes at d88effdd and after; fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LedgerState, CAPS, PRICES, meteredAI, ledgerClient, modelsOf } from '../src/spend-ledger.js';
import { workersAI } from '../src/app.js';

const ENV = { STT_MODEL: '@cf/deepgram/nova-3', TTS_MODEL: '@cf/deepgram/aura-2-en', TTS_VOICE: 'asteria', TALKER_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };

function world(caps = CAPS) {
  const upstream = [];
  const env = { ...ENV, AI: { run: async (model, inputs) => { upstream.push(model); return inputs.stream ? new Response('data: {"response":"ok"}\n\ndata: [DONE]\n').body : { results: { channels: [{ alternatives: [{ transcript: 'x' }] }] } }; } } };
  const state = new LedgerState({ models: modelsOf(env), caps, route: 'binding' }), { session } = state.startSession();
  return { upstream, state, ai: meteredAI(workersAI(env), ledgerClient(state, session)) };
}
async function talkUntilRefused(ai, content, max = 500) {
  for (let n = 0; n < max; n++) {
    try { for await (const d of ai.chatStream([{ role: 'user', content }])) void d; }
    catch (e) { if (e.name === 'BudgetRefused') return { admitted: n, reason: e.reason }; throw e; }
  }
  throw new Error('never refused');
}

test('live-test caps and prices are unchanged: $1.50 total, 800,000 input tokens', () => {
  assert.deepEqual({ ...CAPS }, { sessions: 10, turnsPerSession: 10, audioMs: 1800000, audioRequests: 100, inputTokens: 800000, outputTokens: 20000, ttsChars: 20000, usd: 1.5, inFlight: 8 });
  assert.deepEqual(JSON.parse(JSON.stringify(PRICES)), { '@cf/deepgram/nova-3': { usdPerAudioMin: 0.0052 }, '@cf/pipecat-ai/smart-turn-v2': { usdPerAudioMin: 0.00033795 },
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { usdPerMInput: 0.293, usdPerMOutput: 2.253 }, '@cf/deepgram/aura-2-en': { usdPer1kChars: 0.03 }, '@cf/deepgram/aura-2-es': { usdPer1kChars: 0.03 } });
  for (const f of ['live-test/wrangler.jsonc', 'live-test/wrangler.mock.jsonc', 'live-test/wrangler.rest.jsonc'])
    assert.doesNotMatch(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /LEDGER_MODE/, f + ' leaves the production meter off');
});

test('800,000 input tokens: the 8th 100,024-token talker call is refused and latches; 7 upstream calls, one per reservation', async () => {
  const { upstream, state, ai } = world();
  const r = await talkUntilRefused(ai, 'a'.repeat(100000)); // 16 + 100,000 + 8 = 100,024 tokens reserved per call
  assert.deepEqual(r, { admitted: 7, reason: 'exhausted:inputTokens' });
  assert.equal(upstream.length, 7);
  assert.equal(state.snapshot().reserved.inputTokens, 7 * 100024);
  assert.equal(state.snapshot().stopped, 'exhausted:inputTokens');
});

test('$1.50: with the unit caps out of the way, the dollar cap refuses at the same call as before, and latches', async () => {
  const { upstream, state, ai } = world({ ...CAPS, inputTokens: 1e12, outputTokens: 1e12 });
  const tokens = 16 + 100000 + 8, perCall = Math.ceil((tokens * 0.293 + 300 * 2.253) / 1e6 * 1e9) + Math.ceil((0.30 / 1e6 + 300000 * 0.02 / 1e6) * 1e9);
  const expected = Math.floor(1.5e9 / perCall);
  const r = await talkUntilRefused(ai, 'a'.repeat(100000));
  assert.deepEqual(r, { admitted: expected, reason: 'exhausted:usd' });
  assert.equal(expected, 41);
  assert.equal(upstream.length, expected);
  assert.ok(state.snapshot().reserved.usd <= 1.5);
  assert.equal(state.snapshot().stopped, 'exhausted:usd');
});
