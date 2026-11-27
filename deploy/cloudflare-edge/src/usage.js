// What a model response says it used. Missing fields stay missing: the ledger then keeps the ceiling.
// gpt-oss bills reasoning as output tokens (one output price, no separate reasoning price:
// https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/ read 2026-11-11).
// When completion_tokens already includes reasoning, reasoning_tokens is not larger and is not added again.
// When reasoning_tokens is larger, the provider reported reasoning outside completion_tokens, so both are charged.

function num(v) { return Number.isInteger(v) && v >= 0 ? v : null; }

export function usageFrom(body) {
  const u = body && typeof body === 'object' ? body.usage || body.result?.usage : null;
  if (!u || typeof u !== 'object') return null;
  const input = num(u.prompt_tokens) ?? num(u.input_tokens);
  const completion = num(u.completion_tokens) ?? num(u.output_tokens);
  const details = u.completion_tokens_details;
  const reasoning = num(u.reasoning_tokens) ?? (details && typeof details === 'object' ? num(details.reasoning_tokens) : null);
  if (input == null && completion == null && reasoning == null) return null;
  const output = completion != null && reasoning != null && reasoning > completion
    ? completion + reasoning
    : Math.max(completion || 0, reasoning || 0);
  return { inputTokens: input || 0, outputTokens: output };
}
