// Accounting units for a price ceiling. These are estimates, not a provider tokenizer.
// audio: milliseconds of 24 kHz PCM16 (48 bytes per ms).
export const audioMs = pcm => Math.ceil((pcm?.length || 0) / 48);
const encoder = new TextEncoder();
export function estimateInputTokens(messages) {
  let n = 16;
  for (const m of messages || []) n += encoder.encode(String(m?.content ?? '')).length + 8;
  return n;
}
