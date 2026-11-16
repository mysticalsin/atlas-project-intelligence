// Security response headers for EVERY response the Worker returns (page, JSON, redirects, early refusals, the Teams tab).
// app.js `handle` runs each response through `secure`, so a path that forgets `headers()` still ships them. The strict
// script CSP is a separate, later change (the page is not yet CSP-clean); this module never touches script-src.
// 101 WebSocket upgrades are returned untouched: a browser applies none of these to a socket handshake.
export const HSTS = 'max-age=63072000; includeSubDomains';
export const PERMISSIONS_POLICY = 'microphone=(self), camera=(), geolocation=(), payment=(), usb=(), display-capture=()';
// A response that carries no CSP at all (a pass-through that forgot) gets the locked-down data-only policy; documents keep their own.
export const DATA_CSP = "default-src 'none'; frame-ancestors 'none'";
// HTML that arrived with no policy of its own. script-src 'none': it must not run a script the route forgot to hash.
export const HTML_DENY_CSP = "default-src 'none'; script-src 'none'; script-src-attr 'none'; style-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const baseSecurityHeaders = () => ({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': HSTS,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': PERMISSIONS_POLICY,
});

// The same response with every missing security header added (existing values are never overwritten). The result is a new
// Response because responses returned by a Durable Object stub have immutable headers.
export function secure(res) {
  if (!res || res.status === 101 || res.webSocket) return res;
  const add = Object.entries(baseSecurityHeaders()).filter(([k]) => !res.headers.has(k));
  if (!res.headers.has('Content-Security-Policy')) add.push(['Content-Security-Policy', /html/i.test(res.headers.get('Content-Type') || '') ? HTML_DENY_CSP : DATA_CSP]);
  if (!add.length) return res;
  const h = new Headers(res.headers);
  for (const [k, v] of add) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
