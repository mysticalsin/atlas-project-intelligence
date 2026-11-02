// Bounded input helpers shared by the library and every feature module (the single copy; frozen after T1-S0).
// Every value a browser sends passes through one of these before it is stored or compared.

// Bidi controls (U+202A-202E, U+2066-2069, U+200E/200F, U+061C) and zero-width characters (U+200B-200D, U+2060, U+FEFF) are never kept: one can reorder what
// follows it on screen (a name that reads as an address) or make two different strings look alike (red-team retest L2). Same set in atlas_voice/identity.py.
export const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\u2060\uFEFF]/g;
// Free text keeps U+200C/U+200D (ZWNJ/ZWJ): Persian, Hindi and other scripts spell words with them, and emoji sequences need ZWJ.
// Only the characters that reorder text or hide inside it are removed; names (`name` below) drop the whole INVISIBLE set.
const REORDER = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B\u2060\uFEFF]/g;
export const str = (v, n) => typeof v === 'string' ? Array.from(v.replace(REORDER, '').split(/\s+/).filter(Boolean).join(' ')).slice(0, n).join('') : '';
export const name = (v, n) => str(typeof v === 'string' ? v.replace(INVISIBLE, '') : v, n);
export const para = (v, n) => typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, n) : '';
export const list = (v, n, l) => [...new Set((Array.isArray(v) ? v : []).slice(0, 50).map(x => str(x, l)).filter(Boolean))].slice(0, n);
// Longer than 254 characters (RFC 5321) is never an address: refused before the regex, which backtracks quadratically on
// a long run of dots (a 250,000-character body field cost 36 s of Durable Object CPU; review #7, same class).
// Quotes, brackets, parentheses, `=`, `,`, `;`, `:` and backslashes are never accepted (red-team L9: they are escaped today but would be live
// characters in a mailto:, an ICS line, a Teams card or a log line). An address with one is treated as no address.
export const email = v => { const e = String(v || '').trim().toLowerCase(); return e.length <= 254 && /^[^\s@<>"'`=(),;:\\[\]{}|]+@[^\s@<>"'`=(),;:\\[\]{}|]+\.[^\s@<>"'`=(),;:\\[\]{}|]+$/.test(e) ? e.slice(0, 200) : ''; };
export const https = v => { try { const u = new URL(String(v)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
export const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
export const fail = (status, message) => Object.assign(new Error(message), { status });

// An id as Library.newId makes it (32 hex) or a dashed UUID: returned lower-cased, else ''.
export const uuidish = v => { const s = String(v ?? '').trim().toLowerCase(); return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(s) ? s : ''; };

// Exact, case-insensitive membership of an email in a comma-separated list (never a domain or prefix match).
export const inList = (address, csv) => {
  const e = String(address || '').trim().toLowerCase();
  return !!e && String(csv || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(e);
};

// Soft per-DO-instance sliding-window limit: true when the call is allowed (and counted), false beyond `max`
// calls within `windowMs`. In memory only, so it resets when the Durable Object restarts.
const buckets = new WeakMap();
export function rateLimit(lib, key, max, windowMs) {
  if (!buckets.has(lib)) buckets.set(lib, new Map());
  const map = buckets.get(lib), parsed = Date.parse(typeof lib?.now === 'function' ? lib.now() : '');
  const now = Number.isFinite(parsed) ? parsed : Date.now(), k = String(key);
  const hits = (map.get(k) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) { map.set(k, hits); return false; }
  hits.push(now); map.set(k, hits);
  return true;
}
