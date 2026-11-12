// Persistent per-person rate limits (blue review G3). Fixed-window counters kept in Durable Object STORAGE, so they survive
// eviction and restarts (the in-memory util.rateLimit does not) and spread across the people's own Interview Durable Objects
// instead of loading the one global LibraryStore. A counter is { n, exp }: `exp` lets a sweep delete finished windows.
//   consume(storage, checks)   all checks must pass; counters advance only when every one has room (a refusal costs reads only)
//   limitRoute(request, ...)   the internal POST /api/limit of the Interview DO, called by the Worker for sheet/classify/transcribe
//   enforce(storage, ...)      for the library routes (Wave B): a ready 429 Response, or null when allowed
// Window arithmetic uses real time; tests pass `now`.
export const HOUR = 36e5, DAY = 864e5;
// Defaults per person; each can be overridden by an environment variable of the same name prefixed RL_ (a product decision for the owner).
export const LIMITS = Object.freeze({
  INTERVIEW_HOUR: 6, INTERVIEW_DAY: 20, // fresh interview starts (a reconnect/resume of a saved interview is not a start)
  SHEET_HOUR: 20, CLASSIFY_HOUR: 30, TRANSCRIBE_HOUR: 60, TRANSLATE_HOUR: 120,
});
// Wave B: the library routes use these names with enforce(). Values are per person per window.
export const LIBRARY_LIMITS = Object.freeze({
  upsert: { max: 120, windowMs: HOUR }, review: { max: 30, windowMs: HOUR }, insights: { max: 30, windowMs: HOUR }, recommend: { max: 30, windowMs: HOUR },
  slides: { max: 30, windowMs: HOUR }, export: { max: 5, windowMs: HOUR }, import: { max: 5, windowMs: HOUR },
  inbound: { max: 60, windowMs: 6e4 }, // triggers, directory push, Teams: per minute, one shared counter
  // G2: data subject rights and consent changes (per person)
  'me-export': { max: 5, windowMs: HOUR }, 'me-erase': { max: 3, windowMs: HOUR }, flags: { max: 30, windowMs: HOUR }, consent: { max: 60, windowMs: HOUR },
  submit: { max: 60, windowMs: HOUR },
  // X1 (red L1): the model-calling and lookup routes of the feature modules (library-routes.js persistentLimit)
  onepager: { max: 30, windowMs: HOUR }, ask: { max: 60, windowMs: HOUR }, 'bid-create': { max: 30, windowMs: DAY }, 'bid-edit': { max: 60, windowMs: HOUR }, 'bid-match': { max: 60, windowMs: HOUR },
  people: { max: 30, windowMs: HOUR },
});
export const limitOf = (env, name) => { const v = Math.floor(Number(env?.['RL_' + name])); return v > 0 ? v : LIMITS[name]; };

const BUCKET = /^[a-z0-9-]{1,32}$/;
const keyOf = (c, subj, now) => `rl:${c.bucket}:${subj ? subj + ':' : ''}${Math.floor(now / c.windowMs)}`;

// checks: [{ bucket, max, windowMs }]. Returns { ok: true, remaining } or { ok: false, retryAfter (seconds, at least 1), bucket }.
export async function consume(storage, checks, { now = Date.now(), subj = '' } = {}) {
  const valid = (Array.isArray(checks) ? checks : []).slice(0, 4).filter(c => c && BUCKET.test(c.bucket) && Number.isFinite(c.max) && c.max >= 1 && Number.isFinite(c.windowMs) && c.windowMs >= 1000);
  if (!valid.length) return { ok: true, remaining: Infinity };
  const slots = valid.map(c => ({ ...c, key: keyOf(c, subj, now), until: (Math.floor(now / c.windowMs) + 1) * c.windowMs }));
  const got = await storage.get(slots.map(s => s.key));
  let refused = null;
  for (const s of slots) {
    s.n = Number(got.get(s.key)?.n) || 0;
    if (s.n >= s.max && (!refused || s.until > refused.until)) refused = s;
  }
  if (refused) return { ok: false, retryAfter: Math.max(1, Math.ceil((refused.until - now) / 1000)), bucket: refused.bucket };
  await storage.put(Object.fromEntries(slots.map(s => [s.key, { n: s.n + 1, exp: s.until }])));
  if (slots.some(s => s.n === 0)) await sweep(storage, now); // a new window opened: drop finished ones
  return { ok: true, remaining: Math.min(...slots.map(s => s.max - s.n - 1)) };
}

// Deletes finished windows (at most 100 per call, so it never grows into a long operation).
export async function sweep(storage, now = Date.now()) {
  if (typeof storage.list !== 'function') return 0;
  const all = await storage.list({ prefix: 'rl:', limit: 200 });
  const dead = [...all].filter(([, v]) => !(Number(v?.exp) > now)).map(([k]) => k).slice(0, 100);
  if (dead.length) await storage.delete(dead);
  return dead.length;
}

export const retryAfterHeaders = retryAfter => ({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(retryAfter) });
export const tooMany = (retryAfter, message = 'Too many requests. Please wait a little and try again.') =>
  new Response(JSON.stringify({ error: message, retryAfter }), { status: 429, headers: retryAfterHeaders(retryAfter) });

// Library helper (Wave B): `const refused = await enforce(storage, 'review', user.subj)`; return it when not null.
export async function enforce(storage, name, subj, { now = Date.now() } = {}) {
  const spec = LIBRARY_LIMITS[name];
  if (!spec || !storage) return null;
  const r = await consume(storage, [{ bucket: name, ...spec }], { now, subj });
  return r.ok ? null : tooMany(r.retryAfter);
}

// POST /api/limit in the Interview Durable Object. Reachable only through the Worker (no browser route forwards this path).
export async function limitRoute(request, storage, { now = Date.now() } = {}) {
  let body; try { body = await request.json(); } catch { body = null; }
  if (request.method !== 'POST' || !body || !Array.isArray(body.checks)) return new Response(JSON.stringify({ error: 'Bad request.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const r = await consume(storage, body.checks, { now });
  return r.ok ? new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify({ ok: false, retryAfter: r.retryAfter, bucket: r.bucket }), { status: 429, headers: retryAfterHeaders(r.retryAfter) });
}
