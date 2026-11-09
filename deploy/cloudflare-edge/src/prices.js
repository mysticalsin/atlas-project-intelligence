// Workers AI list prices shared by the live-test ledger (spend-ledger.js) and the production meter (meter.js).
export const PRICING_SOURCE = 'https://developers.cloudflare.com/workers-ai/platform/pricing/ (page last updated 2026-10-20, read 2026-11-09)';
// List prices, no free allocation assumed. smart-turn-v2: the page lists $0.00033795 per audio minute and 0.51 neurons
// per audio minute (= $0.00000561 at $0.011 per 1,000 neurons); the higher figure is used.
export const PRICES = Object.freeze({
  '@cf/deepgram/nova-3': { usdPerAudioMin: 0.0052 },
  '@cf/pipecat-ai/smart-turn-v2': { usdPerAudioMin: 0.00033795 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { usdPerMInput: 0.293, usdPerMOutput: 2.253 },
  '@cf/deepgram/aura-2-en': { usdPer1kChars: 0.030 },
  '@cf/deepgram/aura-2-es': { usdPer1kChars: 0.030 },
});
