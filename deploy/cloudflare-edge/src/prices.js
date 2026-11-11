// Workers AI list prices shared by the live-test ledger (spend-ledger.js) and the production meter (meter.js).
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

// toMarkdown documents are free. An image is not: how-it-works (updated 2026-10-15, read 2026-11-11) sends the
// image to @cf/facebook/detr-resnet-50 and then to @cf/google/gemma-4-26b-a4b-it.
// https://developers.cloudflare.com/workers-ai/features/markdown-conversion/
// https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/
// Gemma 4 26B is on the pricing table at $0.100 per million input tokens and $0.300 per million output tokens.
// detr-resnet-50 has no list price: its model page says the model is not in the catalog (read 2026-11-11,
// https://developers.cloudflare.com/workers-ai/models/detr-resnet-50/). That call is reserved at the same Gemma
// ceiling and flagged. Cloudflare does not publish toMarkdown's token counts. The ceiling assumes 8,192 input
// tokens (a 1280×720 image plus the detection prompt) and 1,024 output tokens (longer than the 1,200 characters
// the sheet keeps). Every toMarkdown call, including a document, reserves this image worst case.
export const MARKDOWN_IMAGE_INPUT_TOKENS = 8192;
export const MARKDOWN_IMAGE_OUTPUT_TOKENS = 1024;
export const GEMMA_USD_PER_M_INPUT = 0.100;
export const GEMMA_USD_PER_M_OUTPUT = 0.300;
export function markdownFileUsd() {
  const gemma = (MARKDOWN_IMAGE_INPUT_TOKENS * GEMMA_USD_PER_M_INPUT + MARKDOWN_IMAGE_OUTPUT_TOKENS * GEMMA_USD_PER_M_OUTPUT) / 1e6;
  return gemma * 2;
}

// Hindsight Cloud, https://vectorize.io/pricing read 2026-11-11.
// Retain is $10 per million tokens. Recall is $0.75 per million tokens. Reflect is $0.05 per call; ATLAS does not call it.
// The dearest operation ATLAS sends is retain: the project document is cut at 12,000 characters and the conversation
// note at 6,000, plus a 2,000-token allowance for JSON, tags and context. ensureBank, stats, document list and forget
// have no published unit, so every Hindsight request reserves this retain ceiling.
export const HINDSIGHT_RETAIN_TOKENS = 20000;
export const HINDSIGHT_USD_PER_M_TOKENS = 10;
export const HINDSIGHT_USD_PER_REQUEST = HINDSIGHT_RETAIN_TOKENS * HINDSIGHT_USD_PER_M_TOKENS / 1e6;

// TypeSafe Jev 1.13 and 1.14: $0.042 per million input tokens, output free. Default context is 64k per request.
// ATLAS does not send the long-context header. https://docs.typesafe.ai/models read 2026-11-11.
// Call sites send requests: 1 and not a token count, so each call reserves the published 64k context cap.
export const TYPESAFE_USD_PER_M_INPUT = 0.042;
export const TYPESAFE_CONTEXT_TOKENS = 64000;
export const TYPESAFE_USD_PER_REQUEST = TYPESAFE_CONTEXT_TOKENS * TYPESAFE_USD_PER_M_INPUT / 1e6;
