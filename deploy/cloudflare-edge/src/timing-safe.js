// Constant-time equality for strings. A shorter left side used to ignore the rest of
// the right side and could match a longer value. Unequal lengths never match. Callers
// may still reject a length mismatch before calling. The loop is the one app.js used
// for CSRF and bearer secrets.
export function timingSafe(a, b) {
  const n = a.length > b.length ? a.length : b.length;
  let d = a.length === b.length ? 0 : 1;
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a.charCodeAt(i) : 0;
    const y = i < b.length ? b.charCodeAt(i) : 0;
    d |= x ^ y;
  }
  return d === 0;
}
