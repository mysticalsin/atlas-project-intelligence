// B1 (3): persistent per-person rate limits in Durable Object storage, wired at /api/sheet/*, /api/jev/classify and /api/transcribe;
// 429 with Retry-After; the same helper is exported for the library routes (Wave B).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { consume, sweep, enforce, limitRoute, tooMany, limitOf, LIMITS, LIBRARY_LIMITS, HOUR, DAY } from '../src/ratelimit.js';
import { FakeStorage } from './reconnect-harness.js';
import { ENV, ORIGIN, session, ns } from './security-harness.js';

const T0 = Date.UTC(2026, 9, 31, 10, 20, 0); // 10:20 UTC

test('consume: fixed window per bucket, counts survive a new limiter over the same storage, Retry-After is the time to the end of the window', async () => {
  const st = new FakeStorage(), spec = [{ bucket: 'sheet', max: 3, windowMs: HOUR }];
  for (let i = 0; i < 3; i++) assert.equal((await consume(st, spec, { now: T0 + i * 1000 })).ok, true);
  const refused = await consume(st, spec, { now: T0 + 5000 });
  assert.equal(refused.ok, false); assert.equal(refused.bucket, 'sheet'); assert.equal(refused.retryAfter, 40 * 60 - 5); // window ends 11:00:00
  assert.ok((await consume(st, spec, { now: T0 + HOUR })).ok, 'next window starts fresh');
  // persistence: a fresh evaluation over the same storage (as after Durable Object eviction) sees the counter
  const again = await consume(st, [{ bucket: 'sheet', max: 1, windowMs: HOUR }], { now: T0 + HOUR + 10 });
  assert.equal(again.ok, false);
  assert.ok(st.keys().some(k => k.startsWith('rl:sheet:')));
});

test('consume: hour and day windows are checked together and nothing advances on a refusal; remaining is reported', async () => {
  const st = new FakeStorage(), spec = [{ bucket: 'interview-h', max: 2, windowMs: HOUR }, { bucket: 'interview-d', max: 3, windowMs: DAY }];
  assert.equal((await consume(st, spec, { now: T0 })).remaining, 1);
  assert.equal((await consume(st, spec, { now: T0 + 1 })).ok, true);
  const hourFull = await consume(st, spec, { now: T0 + 2 });
  assert.deepEqual([hourFull.ok, hourFull.bucket], [false, 'interview-h']);
  assert.ok(await consume(st, spec, { now: T0 + HOUR }), 'new hour');
  const dayFull = await consume(st, spec, { now: T0 + HOUR + 1 });
  assert.deepEqual([dayFull.ok, dayFull.bucket], [false, 'interview-d']); assert.equal(dayFull.retryAfter, Math.ceil((Date.UTC(2026, 10, 1) - (T0 + HOUR + 1)) / 1000));
  // the refused calls did not advance the day counter beyond its max
  const day = [...await st.list({ prefix: 'rl:interview-d:' })].map(([, v]) => v.n); assert.deepEqual(day, [3]);
  // the longest wait wins when both are full
  const both = await consume(new FakeStorage(), [{ bucket: 'a', max: 1, windowMs: HOUR }, { bucket: 'b', max: 1, windowMs: DAY }], { now: T0 });
  assert.ok(both.ok);
});

test('consume ignores malformed checks (bad bucket names, windows, maxima) and a sweep removes finished windows only', async () => {
  const st = new FakeStorage();
  assert.equal((await consume(st, [{ bucket: 'Bad Name!', max: 1, windowMs: HOUR }, { bucket: 'x', max: 0, windowMs: HOUR }, { bucket: 'y', max: 1, windowMs: 5 }, null, 'z'])).ok, true);
  assert.equal(st.keys().length, 0);
  await consume(st, [{ bucket: 'old', max: 5, windowMs: HOUR }], { now: T0 });
  await consume(st, [{ bucket: 'cur', max: 5, windowMs: DAY }], { now: T0 + 3 * HOUR }); // a new window opened: the finished hour is swept
  assert.deepEqual(st.keys().map(k => k.split(':')[1]), ['cur']);
  await consume(st, [{ bucket: 'live', max: 5, windowMs: HOUR }], { now: T0 + 3 * HOUR });
  assert.equal(await sweep(st, T0 + 3 * HOUR), 0, 'live windows stay');
  assert.equal(await sweep({}, T0), 0, 'a storage without list is tolerated');
});

test('limitRoute: the Interview Durable Object endpoint answers 200 or 429 + Retry-After and rejects anything else', async () => {
  const st = new FakeStorage(), call = (checks, method = 'POST') => limitRoute(new Request('https://atlas.internal/api/limit', { method, body: method === 'POST' ? JSON.stringify({ checks }) : undefined }), st, { now: T0 });
  assert.equal((await call([{ bucket: 'sheet', max: 1, windowMs: HOUR }])).status, 200);
  const r = await call([{ bucket: 'sheet', max: 1, windowMs: HOUR }]);
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), String(40 * 60)); assert.deepEqual(await r.json(), { ok: false, retryAfter: 2400, bucket: 'sheet' });
  assert.equal((await call(null)).status, 400); assert.equal((await call([], 'GET')).status, 400);
});

test('library helper for Wave B: enforce() returns null while allowed and a ready 429 Response after, per person', async () => {
  const st = new FakeStorage();
  for (let i = 0; i < LIBRARY_LIMITS.export.max; i++) assert.equal(await enforce(st, 'export', 'subj-a', { now: T0 }), null);
  const r = await enforce(st, 'export', 'subj-a', { now: T0 });
  assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0); assert.match((await r.json()).error, /Too many/);
  assert.equal(await enforce(st, 'export', 'subj-b', { now: T0 }), null, 'another person has their own counter');
  assert.equal(await enforce(st, 'no-such-limit', 'subj-a'), null); assert.equal(await enforce(null, 'export', 'a'), null);
  assert.equal(tooMany(7).headers.get('retry-after'), '7');
  assert.deepEqual(Object.keys(LIBRARY_LIMITS).sort(), ['consent', 'export', 'flags', 'import', 'inbound', 'insights', 'me-erase', 'me-export', 'recommend', 'review', 'slides', 'submit', 'upsert']); // G2 added consent, flags, me-erase, me-export, submit
});

test('limits are configurable per deployment by RL_* variables and default to the blue-team proposal', () => {
  assert.deepEqual([LIMITS.INTERVIEW_HOUR, LIMITS.INTERVIEW_DAY, LIMITS.SHEET_HOUR, LIMITS.CLASSIFY_HOUR, LIMITS.TRANSCRIBE_HOUR], [6, 20, 20, 30, 60]);
  assert.equal(limitOf({ RL_SHEET_HOUR: '5' }, 'SHEET_HOUR'), 5); assert.equal(limitOf({ RL_SHEET_HOUR: 'abc' }, 'SHEET_HOUR'), 20); assert.equal(limitOf({}, 'CLASSIFY_HOUR'), 30);
});

// ---- wired into the Worker: the INTERVIEW stub is a real limitRoute over FakeStorage, so counters persist across requests ----
function worldWith(limits = {}, extra = {}) {
  const stores = new Map(), stFor = n => stores.get(n) || stores.set(n, new FakeStorage()).get(n), st = stFor('user-abc'); // one storage per person, like one Durable Object per person
  const itv = ns(async (r, name) => (new URL(r.url).pathname === '/api/limit' ? limitRoute(r, stFor(name)) : new Response('{"resumable":null}')));
  return { st, env: { ...ENV, INTERVIEW: itv, LIBRARY: ns(), TYPESAFE_API_KEY: 'k', AI: { toMarkdown: async () => ({ format: 'markdown', data: 'x' }), run: async () => ({ response: '{"project":{}}' }) }, ...limits, ...extra } };
}
const calls = (itv, n) => itv.calls.filter(c => new URL(c.request.url).pathname === n).length;

test('/api/sheet/*: the 21st request in an hour is a 429 with Retry-After, counted in the person\'s own Interview Durable Object', async () => {
  const { st, env } = worldWith({ RL_SHEET_HOUR: '3' }), me = await session(env);
  for (let i = 0; i < 3; i++) assert.equal((await me.go('/api/sheet/draft', { method: 'POST', body: '{}' })).status === 429, false, 'request ' + (i + 1));
  const r = await me.go('/api/sheet/draft', { method: 'POST', body: '{}' });
  assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) >= 1 && Number(r.headers.get('retry-after')) <= 3600);
  const j = await r.json(); assert.match(j.error, /Too many/); assert.equal(j.retryAfter, Number(r.headers.get('retry-after')));
  assert.ok(st.keys().some(k => k.startsWith('rl:sheet:')));
  assert.equal(env.INTERVIEW.calls.at(-1).name, 'user-abc', 'the counter lives in this person\'s own Durable Object');
  assert.ok(me.logs.some(e => e.event === 'rate_limited' && e.reason === 'RATE:SHEET' && e.bucket === 'sheet' && e.status === 429));
  const other = await session(env, { sub: 'second-person' });
  assert.notEqual((await other.go('/api/sheet/draft', { method: 'POST', body: '{}' })).status, 429, 'per person: the second person has their own counter');
});

test('sheet ingest and visuals share the same counter; classify and transcribe have their own', async () => {
  const { env } = worldWith({ RL_SHEET_HOUR: '2', RL_CLASSIFY_HOUR: '1', RL_TRANSCRIBE_HOUR: '1' }), me = await session(env);
  await me.go('/api/sheet/ingest', { method: 'POST', body: new Uint8Array([1, 2, 3]) }); await me.go('/api/sheet/visuals', { method: 'POST', body: '{}' });
  assert.equal((await me.go('/api/sheet/draft', { method: 'POST', body: '{}' })).status, 429);
  assert.equal((await me.go('/api/jev/classify', { method: 'POST', body: '{"project":{}}' })).status === 429, false);
  const c = await me.go('/api/jev/classify', { method: 'POST', body: '{"project":{}}' });
  assert.equal(c.status, 429); assert.ok(c.headers.get('retry-after'));
  const tr = () => handle(new Request(ORIGIN + '/api/transcribe', { method: 'POST', headers: { 'cf-access-jwt-assertion': me.token, Origin: ORIGIN, 'X-Atlas-CSRF': me.csrf, 'X-Atlas-Consent': 'spoken-ask-v1; once', 'Content-Type': 'audio/L16;rate=24000' }, body: new Uint8Array(100) }), env, '', { flagsOf: () => ({ spokenAsk: true }) });
  assert.equal((await tr()).status, 400); // allowed through the limiter, refused by the length rule
  const t2 = await tr(); assert.equal(t2.status, 429); assert.ok(t2.headers.get('retry-after'));
});

test('a request refused by CSRF or by size does not spend the budget, and the limiter fails open if its Durable Object is unreachable', async () => {
  const { st, env } = worldWith({ RL_SHEET_HOUR: '1' }), me = await session(env);
  assert.equal((await me.go('/api/sheet/draft', { method: 'POST', body: '{}', csrf: 'bad' })).status, 403);
  assert.equal((await me.go('/api/sheet/draft', { method: 'POST', body: '{}', headers: { 'Content-Length': String(13 * 1024 * 1024) } })).status, 413);
  assert.equal(st.keys().filter(k => k.startsWith('rl:')).length, 0);
  const broken = { ...env, INTERVIEW: { idFromName: n => n, get: () => ({ fetch: async () => { throw new Error('DO down'); } }) } }, me2 = await session({ ...env, INTERVIEW: ns() });
  for (let i = 0; i < 3; i++) assert.notEqual((await me2.go('/api/sheet/draft', { method: 'POST', body: '{}' }, broken)).status, 429);
});

test('existing in-memory limits (ask, bids, profile) are unchanged and a deployment without INTERVIEW still works', async () => {
  const env = { ...ENV, LIBRARY: ns(), TYPESAFE_API_KEY: '', AI: { toMarkdown: async () => ({ format: 'markdown', data: 'x' }), run: async () => ({ response: '{}' }) } }, me = await session(env);
  for (let i = 0; i < 40; i++) assert.notEqual((await me.go('/api/sheet/draft', { method: 'POST', body: '{}' })).status, 429);
});
