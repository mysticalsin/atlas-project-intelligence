// Bounded input helpers shared by the library and every feature module (the single copy; frozen after T1-S0).
// Every value a browser sends passes through one of these before it is stored or compared.

export const str = (v, n) => typeof v === 'string' ? Array.from(v.split(/\s+/).filter(Boolean).join(' ')).slice(0, n).join('') : '';
export const para = (v, n) => typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, n) : '';
export const list = (v, n, l) => [...new Set((Array.isArray(v) ? v : []).slice(0, 50).map(x => str(x, l)).filter(Boolean))].slice(0, n);
// Longer than 200 characters is refused whole, before the regex. The regex backtracks quadratically on a long run of
// dots (a 250,000-character body field cost 36 s of Durable Object CPU; review #7, same class). Truncating to 200 stored
// two different addresses that share that prefix as one value. RFC 5321's 254-character limit sits inside this bound.
export const email = v => { const e = String(v || '').trim().toLowerCase(); return e.length <= 200 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) ? e : ''; };
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
