// Workers AI list prices for the production meter (meter.js).
// List prices, no free allocation assumed. Read 2026-11-11.
// The live-test ledger reports this page as its pricing source. The other citations in this file are for the
// production kinds priced below it.
export const PRICING_SOURCE = 'https://developers.cloudflare.com/workers-ai/platform/pricing/ (page last updated 2026-10-20, read 2026-11-11)';
// Workers AI pricing table, last updated 2026-10-20:
// https://developers.cloudflare.com/workers-ai/platform/pricing/
// smart-turn-v2: the page lists $0.00033795 per audio minute and 0.51 neurons per audio minute
// (= $0.00000561 at $0.011 per 1,000 neurons); the higher figure is used.
// bge-m3: the pricing table lists $0.012 per million input tokens. The model page lists $0.0118
// (https://developers.cloudflare.com/workers-ai/models/bge-m3/, read 2026-11-11). The higher figure is used.
// gpt-oss-120b: $0.350 / $0.750 per million tokens on the pricing table, and $0.35 / $0.75 on
// https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/ (read 2026-11-11).
export const PRICES = Object.freeze({
  '@cf/deepgram/nova-3': { usdPerAudioMin: 0.0052 },
  '@cf/pipecat-ai/smart-turn-v2': { usdPerAudioMin: 0.00033795 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { usdPerMInput: 0.293, usdPerMOutput: 2.253 },
  '@cf/deepgram/aura-2-en': { usdPer1kChars: 0.030 },
  '@cf/deepgram/aura-2-es': { usdPer1kChars: 0.030 },
  '@cf/openai/gpt-oss-120b': { usdPerMInput: 0.35, usdPerMOutput: 0.75 },
  '@cf/baai/bge-m3': { usdPerMInput: 0.012 },
});

// ElevenLabs Flash / Turbo, which covers eleven_flash_v2_5: $0.04 per 1,000 characters.
// https://elevenlabs.io/pricing/api read 2026-11-11. Taxes are excluded there and here.
export const ELEVENLABS_USD_PER_1K_CHARS = 0.04;

// The only copy of each kind's enforced limit. Call sites pass these numbers to the provider, and meter.js
// prices the same numbers. reasoningTokens is added into the max_tokens that is sent: gpt-oss bills reasoning
// as output, and that generation cap is the ceiling. pcmBytesPerMs is 24 kHz PCM16.
export const LIMITS = Object.freeze(JSON.parse(`{
  "pcmBytesPerMs": 48,
  "talker": {"maxTokens": 300, "reasoningTokens": 0},
  "analyst": {"maxTokens": 1500, "reasoningTokens": 1500},
  "analystReport": {"maxTokens": 3000, "reasoningTokens": 3000},
  "analystComplete": {"maxTokens": 2500, "reasoningTokens": 2500},
  "analystSheet": {"maxTokens": 5000, "reasoningTokens": 5000},
  "analystVisuals": {"maxTokens": 1500, "reasoningTokens": 1500},
  "gatewayAnalyst": {"maxTokens": 800, "reasoningTokens": 800},
  "notes": {"maxTokens": 3000, "reasoningTokens": 0},
  "editor": {"maxTokens": 4500, "reasoningTokens": 0},
  "gatewayReport": {"maxTokens": 1400, "reasoningTokens": 0},
  "embed": {"maxChars": 8000},
  "stt": {"maxAudioMs": 60000},
  "tts": {"maxChars": 4000, "maxAudioMs": 120000},
  "turn": {"maxAudioMs": 8000},
  "realtime": {"inputTokensPerSecond": 10, "outputTokensPerSecond": 20, "maxSeconds": 900, "maxResponseTokens": 900},
  "memoryRecall": {"maxTokens": 700},
  "gatewayRecall": {"maxTokens": 300},
  "memoryBody": {"maxBytes": 65536},
  "jev": {"contextTokens": 64000},
  "markdown": {"maxBytes": 10485760, "maxPages": 30, "maxImageBytes": 1600000, "imageInputTokens": 8192, "imageOutputTokens": 1024}
}`));

// toMarkdown documents are free at list price. An image is not: how-it-works (updated 2026-10-15, read 2026-11-11) sends the
// image to @cf/facebook/detr-resnet-50 and then to @cf/google/gemma-4-26b-a4b-it.
// https://developers.cloudflare.com/workers-ai/features/markdown-conversion/
// https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/
// Gemma 4 26B is on the pricing table at $0.100 per million input tokens and $0.300 per million output tokens.
// detr-resnet-50 has no list price: its model page says the model is not in the catalog (read 2026-11-11,
// https://developers.cloudflare.com/workers-ai/models/detr-resnet-50/). That call is reserved at the same Gemma
// ceiling and flagged. Cloudflare does not publish toMarkdown's token counts. The image token budget below is
// the worst case for one file at or under markdown.maxImageBytes. A document is reserved as that same worst
// case for every page up to markdown.maxPages, because a page can take the image path and detr has no list price.
export const MARKDOWN_IMAGE_INPUT_TOKENS = LIMITS.markdown.imageInputTokens;
export const MARKDOWN_IMAGE_OUTPUT_TOKENS = LIMITS.markdown.imageOutputTokens;
export const GEMMA_USD_PER_M_INPUT = 0.100;
export const GEMMA_USD_PER_M_OUTPUT = 0.300;
export function markdownFileUsd() {
  const gemma = (MARKDOWN_IMAGE_INPUT_TOKENS * GEMMA_USD_PER_M_INPUT + MARKDOWN_IMAGE_OUTPUT_TOKENS * GEMMA_USD_PER_M_OUTPUT) / 1e6;
  return gemma * 2;
}

// Hindsight Cloud, https://vectorize.io/pricing read 2026-11-11.
// Retain is $10 per million tokens. Recall is $0.75 per million tokens. Reflect is $0.05 per call; ATLAS does not call it.
// ensureBank, stats, document list and forget have no published unit. They reserve the bytes of the request at the
// retain rate (the dearest published token rate), then settle on the usage the response returns. They are not the
// flat 20,000-token retain ($0.20), which would exhaust the month after a handful of interviews.
export const HINDSIGHT_RETAIN_USD_PER_M = 10;
export const HINDSIGHT_RECALL_USD_PER_M = 0.75;

// TypeSafe Jev 1.13 and 1.14: $0.042 per million input tokens, output free. Default context is 64k per request.
// ATLAS does not send the long-context header. https://docs.typesafe.ai/models read 2026-11-11.
// Call sites send requests: 1 and not a token count, so each call reserves the published 64k context cap.
export const TYPESAFE_USD_PER_M_INPUT = 0.042;
export const TYPESAFE_CONTEXT_TOKENS = LIMITS.jev.contextTokens;
export const TYPESAFE_USD_PER_REQUEST = TYPESAFE_CONTEXT_TOKENS * TYPESAFE_USD_PER_M_INPUT / 1e6;

// OpenAI Realtime audio is the dearer modality. Text is cheaper ($4 / $24 per million on gpt-realtime-2.1).
// https://developers.openai.com/api/docs/models/gpt-realtime-2.1 read 2026-11-11. The ceiling uses audio.
export const REALTIME_USD_PER_M_INPUT = 32;
export const REALTIME_USD_PER_M_OUTPUT = 64;
