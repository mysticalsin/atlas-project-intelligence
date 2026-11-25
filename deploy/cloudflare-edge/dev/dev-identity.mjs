// A development identity is copied into request headers (x-atlas-user and x-atlas-email).
// A code point above 255 is not a header value. Headers.set throws, and the local
// edge then never answers. Latin-1 addresses stay allowed: they already fit a header.

export function devIdentityHeaderError(email) {
  const value = String(email ?? '');
  for (const ch of value) {
    if (ch.codePointAt(0) > 255) return 'This development identity cannot be used as a request header.';
  }
  return '';
}
