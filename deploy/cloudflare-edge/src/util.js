// Bounded input helpers shared by the library and every feature module (the single copy; frozen after T1-S0).
// Every value a browser sends passes through one of these before it is stored or compared.

export const str = (v, n) => typeof v === 'string' ? Array.from(v.split(/\s+/).filter(Boolean).join(' ')).slice(0, n).join('') : '';
export const para = (v, n) => typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, n) : '';
export const list = (v, n, l) => [...new Set((Array.isArray(v) ? v : []).slice(0, 50).map(x => str(x, l)).filter(Boolean))].slice(0, n);
// Longer than 254 characters (RFC 5321) is never an address: refused before the regex, which backtracks quadratically on
// a long run of dots (a 250,000-character body field cost 36 s of Durable Object CPU; review #7, same class).
export const email = v => { const e = String(v || '').trim().toLowerCase(); return e.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) ? e.slice(0, 200) : ''; };
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

// Durable sliding window on the library SQLite. True when the call is allowed and counted, false when it is over
// `max` or the arguments are outside the bounds below. A new Library on the same database sees the same rows.
// The WeakMap is not a second copy of the cap. Every SQL parameter is bound; the key is never interpolated.
// Sentinel L2: windowMs stops at one day, the same horizon that deletes every bucket's older rows. A longer
// window would be shortened by that prune, so it is refused instead. Ask and bid-edit keys stay as the caller
// passed them, including when they have no tenant. The subject in the key is the verified email.
const RATE_DAY_MS = 86400000;
const RATE_CREATE = 'CREATE TABLE IF NOT EXISTS rate_hits (bucket TEXT NOT NULL, at_ms INTEGER NOT NULL)';

function rateNow(lib) {
  const parsed = Date.parse(typeof lib?.now === 'function' ? lib.now() : '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function rateArgs(key, max, windowMs) {
  const bucket = typeof key === 'string' ? key : '';
  if (!bucket || bucket.length > 200) return null;
  if (!Number.isInteger(max) || max < 1 || max > 10000) return null;
  if (!Number.isInteger(windowMs) || windowMs < 1000 || windowMs > RATE_DAY_MS) return null;
  return { bucket, max, windowMs };
}

function requireLibrary(lib, name) {
  if (typeof lib?.exec !== 'function' || typeof lib?.recorded !== 'function') throw new Error(name + ' needs a library with exec');
}

export function rateLimit(lib, key, max, windowMs) {
  requireLibrary(lib, 'rateLimit');
  const args = rateArgs(key, max, windowMs);
  if (!args) return false;
  const now = rateNow(lib);
  return lib.recorded(() => {
    lib.exec(RATE_CREATE);
    // A row at or beyond one window ahead is stored at `now`. A strict `>` left a row dated exactly
    // now + windowMs in the future, and that row still counted for a second window.
    lib.exec('UPDATE rate_hits SET at_ms = ? WHERE bucket = ? AND at_ms >= ?', now, args.bucket, now + args.windowMs);
    lib.exec('DELETE FROM rate_hits WHERE at_ms <= ?', now - RATE_DAY_MS);
    lib.exec('DELETE FROM rate_hits WHERE bucket = ? AND at_ms <= ?', args.bucket, now - args.windowMs);
    const n = Number(lib.rows('SELECT COUNT(*) AS n FROM rate_hits WHERE bucket = ? AND at_ms > ?', args.bucket, now - args.windowMs)[0].n);
    if (n >= args.max) return false;
    lib.exec('INSERT INTO rate_hits (bucket, at_ms) VALUES (?, ?)', args.bucket, now);
    return true;
  });
}

function bucketHasSubject(bucket, subject) {
  if (bucket === subject) return true;
  const mark = ':' + subject;
  return typeof bucket === 'string' && bucket.length > mark.length && bucket.endsWith(mark);
}

// Group 10 calls this from erase. Rows whose bucket is that verified email, or ends with colon plus that email, go.
// Another address is left in place. Every parameter is bound.
export function eraseRateHits(lib, email) {
  requireLibrary(lib, 'eraseRateHits');
  const subject = typeof email === 'string' ? email : '';
  if (!subject) return 0;
  return lib.recorded(() => {
    lib.exec(RATE_CREATE);
    const rows = lib.rows('SELECT rowid AS id, bucket FROM rate_hits');
    let removed = 0;
    for (const row of rows) {
      if (!bucketHasSubject(row.bucket, subject)) continue;
      lib.exec('DELETE FROM rate_hits WHERE rowid = ?', row.id);
      removed += 1;
    }
    return removed;
  });
}
