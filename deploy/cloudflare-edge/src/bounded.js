// Bounded request-body reads (red review M5): the declared Content-Length can be absent (chunked) or wrong, so every route
// that reads a body pulls at most `max` bytes from the stream and stops pulling the moment it is exceeded.
// null means "too large" (the stream is cancelled; nothing past the cap is ever buffered); an empty body is an empty array.
export async function boundedBytes(request, max) {
  if (!request.body) return new Uint8Array(0);
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) { await request.body.cancel().catch(() => {}); return null; }
  const reader = request.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // The stream may reuse this buffer on the next read. Copy before that.
    const copy = new Uint8Array(value);
    n += copy.length;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(copy);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export async function boundedText(request, max) {
  const bytes = await boundedBytes(request, max);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
// JSON body: { value } on success, { tooLarge: true } past the cap, { invalid: true } when it does not parse.
export async function boundedJson(request, max) {
  const text = await boundedText(request, max);
  if (text === null) return { tooLarge: true };
  try { return { value: JSON.parse(text) }; } catch { return { invalid: true }; }
}
