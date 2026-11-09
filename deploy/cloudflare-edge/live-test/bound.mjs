// The all-in spend bound for the live test from the ledger's own prices and caps (docs/LIVE_TEST_BOUND.md).
//   node live-test/bound.mjs
import { PRICES, CAPS, PRICING_SOURCE, PROXY_PER_CALL_USD } from '../src/spend-ledger.js';

const stt = PRICES['@cf/deepgram/nova-3'], turn = PRICES['@cf/pipecat-ai/smart-turn-v2'], talker = PRICES['@cf/meta/llama-3.3-70b-instruct-fp8-fast'], tts = PRICES['@cf/deepgram/aura-2-en'];
const top = Math.max(stt.usdPerAudioMin, turn.usdPerAudioMin);
// Provider terms bounded by the unit caps alone (independent of the dollar cap).
const rows = {
  audio_by_duration: CAPS.audioMs / 60000 * top,
  audio_if_each_request_billed_a_full_minute: CAPS.audioRequests * top,
  talker_input: CAPS.inputTokens / 1e6 * talker.usdPerMInput,
  talker_output: CAPS.outputTokens / 1e6 * talker.usdPerMOutput,
  tts: CAPS.ttsChars / 1000 * tts.usdPer1kChars,
};
const provider = Math.max(rows.audio_by_duration, rows.audio_if_each_request_billed_a_full_minute) + rows.talker_input + rows.talker_output + rows.tts;
console.log(JSON.stringify({ pricing: PRICING_SOURCE, caps: CAPS, provider_rows: rows, provider_bound_from_unit_caps_usd: +provider.toFixed(6),
  proxy_worst_case_per_call_usd: PROXY_PER_CALL_USD,
  all_in_bound_usd: CAPS.usd,
  why: 'every reservation is priced at its provider ceiling plus the proxy worst case, and the ledger admits a call only while the sum of reserved ceilings stays at or under the dollar cap; reservations are never refunded',
  within: provider <= CAPS.usd }, null, 1));
