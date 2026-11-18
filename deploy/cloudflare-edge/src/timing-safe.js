// Equal-length compare. A shorter left side would ignore the rest of the right side, so callers
// check the lengths first. The loop is the one app.js used for CSRF and bearer secrets.
export function timingSafe(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
