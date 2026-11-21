// Sweep 01 group 14 limits. Written before the fix. No skip and no expected failure.
// Plan freeze: PR #38 v4 at 9ce5ea97, group-14-rate-limit-consent.md sha256 66f3511b43736aef68614dc5d6e6f21c4d15f96072529af7c1ca30c53e083a1f.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';
import { consume } from '../src/ratelimit.js';
import { applyState, loadState } from '../src/privacy.js';
import * as util from '../src/util.js';

const DAY = 864e5;
const PURPOSES = ['transcription', 'draft', 'checkpoint', 'memory', 'notice'];

function counter() {
  const data = new Map();
  return {
    async get(keys) {
      await new Promise(resolve => setImmediate(resolve));
      const out = new Map();
      for (const key of keys) if (data.has(key)) out.set(key, structuredClone(data.get(key)));
      return out;
    },
    async put(entries) {
      await new Promise(resolve => setImmediate(resolve));
      for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value));
    },
    keys() { return [...data.keys()]; },
  };
}

function libraryAt(sql, clock) {
  return new Library(sql, { now: () => new Date(clock.now).toISOString() });
}

function rowsOf(sql) {
  const names = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_hits'").toArray();
  if (!names.length) return [];
  return sql.exec('SELECT bucket, at_ms FROM rate_hits ORDER BY bucket, at_ms').toArray();
}

test('ATLAS-07 a new Library on the same SQLite keeps the bid-create cap', () => {
  const sql = memorySql();
  const clock = { now: Date.parse('2026-11-21T00:00:00.000Z') };
  const lib = libraryAt(sql, clock);
  const key = 'bid-create:tenant:ada@example.test';
  for (let i = 0; i < 30; i++) assert.equal(util.rateLimit(lib, key, 30, DAY), true, 'hit ' + i);
  assert.equal(util.rateLimit(lib, key, 30, DAY), false);
  const again = libraryAt(sql, clock);
  assert.equal(util.rateLimit(again, key, 30, DAY), false, 'evicting the Library object does not reset the cap');
  clock.now += DAY - 1;
  assert.equal(util.rateLimit(again, key, 30, DAY), false, 'a hit one millisecond inside the window still counts');
  clock.now += 1;
  assert.equal(util.rateLimit(again, key, 30, DAY), true, 'a hit exactly one window old does not count');
  const fresh = libraryAt(memorySql(), clock);
  for (let i = 0; i < 30; i++) assert.equal(util.rateLimit(fresh, key, 30, DAY), true);
  const young = libraryAt(memorySql(), clock);
  assert.equal(util.rateLimit(young, 'ask:ada@example.test', 1, 60000), true);
  clock.now += 59999;
  assert.equal(util.rateLimit(young, 'ask:ada@example.test', 1, 60000), false, 'a hit one millisecond inside the window still counts');
});

test('a library without exec does not fall back to a private map', () => {
  assert.throws(() => util.rateLimit({ now: () => '2026-11-21T00:00:00.000Z' }, 'ask:ada@example.test', 1, 1000), /exec/);
});

test('M1 a long clock step holds for one window and does not open a fresh window', async () => {
  const storage = counter();
  const windowMs = 60000;
  const T = 1_700_000_030_000;
  const check = [{ bucket: 'inbound', max: 1, windowMs }];
  assert.equal((await consume(storage, check, { now: T, subj: 'person' })).ok, true);
  assert.equal((await consume(storage, check, { now: T, subj: 'person' })).ok, false);
  const stepped = T - 10 * windowMs;
  assert.equal((await consume(storage, check, { now: stepped, subj: 'person' })).ok, false);
  const freshKey = `rl:inbound:person:${Math.floor(stepped / windowMs)}`;
  assert.equal(storage.keys().includes(freshKey), false, 'the hold does not insert into an empty window key');
  assert.equal((await consume(storage, check, { now: stepped + windowMs, subj: 'person' })).ok, true);

  const sql = memorySql();
  const clock = { now: Date.parse('2026-11-21T00:00:00.000Z') };
  const lib = libraryAt(sql, clock);
  const key = 'bid-create:tenant:ada@example.test';
  assert.equal(util.rateLimit(lib, key, 1, windowMs), true);
  sql.exec('UPDATE rate_hits SET at_ms = ? WHERE bucket = ?', clock.now + 365 * DAY, key);
  assert.equal(util.rateLimit(lib, key, 1, windowMs), false, 'a row dated a year ahead still denies');
  const dated = rowsOf(sql).filter(row => row.bucket === key);
  assert.ok(dated.length >= 1);
  assert.ok(dated.every(row => row.at_ms <= clock.now + windowMs), 'the future row is not left dated in the future');
  clock.now += windowMs;
  assert.equal(util.rateLimit(lib, key, 1, windowMs), true, 'the clamped row denies for one window and then allows');
});

test('L1 rate_hits older than one day are pruned and erasure removes the subject', () => {
  const sql = memorySql();
  const clock = { now: Date.parse('2026-11-21T00:00:00.000Z') };
  const lib = libraryAt(sql, clock);
  const ada = 'bid-create:tenant:ada@example.test';
  const bob = 'ask:bob@example.test';
  assert.equal(util.rateLimit(lib, ada, 5, 36e5), true);
  clock.now += DAY + 1;
  assert.equal(util.rateLimit(lib, ada, 5, 36e5), true, 'the day-old hit no longer counts');
  assert.equal(rowsOf(sql).some(row => row.at_ms <= clock.now - DAY), false, 'rows older than one day are gone');
  assert.equal(util.rateLimit(lib, bob, 5, 36e5), true);
  assert.equal(typeof util.eraseRateHits, 'function');
  util.eraseRateHits(lib, 'ada@example.test');
  const after = rowsOf(sql);
  assert.equal(after.some(row => String(row.bucket).includes('ada@example.test')), false);
  assert.equal(after.some(row => row.bucket === bob), true, "another email's rows stay");
  const again = libraryAt(sql, clock);
  assert.equal(util.rateLimit(again, ada, 1, 36e5), true);

  const other = memorySql();
  const otherClock = { now: clock.now };
  const otherLib = libraryAt(other, otherClock);
  assert.equal(util.rateLimit(otherLib, ada, 5, 36e5), true);
  other.exec('INSERT INTO rate_hits (bucket, at_ms) VALUES (?, ?)', 'people:other-tenant:cara@example.test', otherClock.now - DAY - 5);
  assert.equal(util.rateLimit(otherLib, bob, 5, 36e5), true);
  assert.equal(rowsOf(other).some(row => row.bucket === 'people:other-tenant:cara@example.test'), false, 'pruning covers every bucket, not only the key just consumed');
});

test('L2 out-of-range limit parameters are refused', () => {
  const sql = memorySql();
  const clock = { now: Date.parse('2026-11-21T00:00:00.000Z') };
  const lib = libraryAt(sql, clock);
  const key = 'ask:ada@example.test';
  for (const max of [0, -1, 1e9, NaN]) assert.equal(util.rateLimit(lib, key, max, 1000), false, 'max ' + max);
  for (const windowMs of [0, -1]) assert.equal(util.rateLimit(lib, key, 1, windowMs), false, 'window ' + windowMs);
  assert.equal(util.rateLimit(lib, 'x'.repeat(201), 1, 1000), false);
  assert.equal(util.rateLimit(lib, '', 1, 1000), false);
  assert.equal(rowsOf(sql).length, 0, 'a refused call writes no row');
  assert.equal(util.rateLimit(lib, key, 1, 1000), true);
  assert.equal(rowsOf(sql).length, 1);
});

test('L2 a window longer than one day is refused because pruning is one day', () => {
  const sql = memorySql();
  const clock = { now: Date.parse('2026-11-21T00:00:00.000Z') };
  const lib = libraryAt(sql, clock);
  const key = 'ask:ada@example.test';
  assert.equal(util.rateLimit(lib, key, 1, 7 * DAY), false, 'seven days is past the one-day prune horizon');
  assert.equal(util.rateLimit(lib, key, 1, DAY + 1), false);
  assert.equal(rowsOf(sql).length, 0);
  assert.equal(util.rateLimit(lib, key, 1, DAY), true, 'one day is still inside the horizon');
  assert.equal(rowsOf(sql).length, 1);
});

test('L3 the limit subject is the verified email', () => {
  const sql = memorySql();
  const clock = { now: Date.parse('2026-11-21T00:00:00.000Z') };
  const lib = libraryAt(sql, clock);
  const body = { subject: 'ada@example.test' };
  assert.equal(util.rateLimit(lib, 'ask:ada@example.test', 1, 36e5), true);
  assert.equal(util.rateLimit(lib, 'ask:bob@example.test', 1, 36e5), true, 'two verified emails do not share a bucket');
  assert.equal(util.rateLimit(lib, 'ask:ada@example.test', 1, 36e5), false);
  assert.equal(util.rateLimit.length, 4, 'rateLimit does not take a body');
  assert.equal(body.subject, 'ada@example.test');
  const buckets = rowsOf(sql).map(row => row.bucket);
  assert.deepEqual(buckets.sort(), ['ask:ada@example.test', 'ask:bob@example.test']);
});

test('L3 a quote and a semicolon are bound, not spliced, and read back literally', () => {
  const sql = memorySql();
  const clock = { now: Date.parse('2026-11-21T00:00:00.000Z') };
  const lib = libraryAt(sql, clock);
  const key = "ask:o'hara; DROP TABLE rate_hits;--@example.test";
  const calls = [];
  const inner = lib.exec.bind(lib);
  lib.exec = (statement, ...args) => {
    calls.push({ statement, args });
    return inner(statement, ...args);
  };
  assert.equal(util.rateLimit(lib, key, 1, 60000), true);
  assert.equal(util.rateLimit(lib, key, 1, 60000), false, 'the same key spends its own cap');
  for (const call of calls) {
    assert.equal(call.statement.includes(key), false, 'the key is not spliced into SQL');
    assert.equal(call.statement.includes("o'hara"), false);
    assert.equal(call.statement.includes('DROP TABLE'), false);
    if (call.args.includes(key)) assert.match(call.statement, /\?/);
  }
  assert.ok(calls.some(call => call.args.includes(key)), 'the key is passed as a bound argument');
  const back = lib.rows('SELECT bucket, at_ms FROM rate_hits WHERE bucket = ?', key);
  assert.equal(back.length, 1);
  assert.equal(back[0].bucket, key, 'the stored bucket is the key, quote and semicolon included');
  assert.equal(back[0].at_ms, clock.now);
  assert.equal(util.eraseRateHits(lib, "o'hara; DROP TABLE rate_hits;--@example.test"), 1);
  assert.equal(lib.rows('SELECT bucket FROM rate_hits WHERE bucket = ?', key).length, 0);
  assert.equal(util.rateLimit(lib, 'ask:ada@example.test', 1, 60000), true, 'the quoted key does not become another statement');
  assert.equal(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_hits'").toArray().length, 1);
});

test('a thrown put releases the rate-limit lock', async () => {
  let failPut = true;
  const data = new Map();
  const storage = {
    async get(keys) {
      const out = new Map();
      for (const key of keys) if (data.has(key)) out.set(key, structuredClone(data.get(key)));
      return out;
    },
    async put(entries) {
      if (failPut) throw new Error('put failed');
      for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value));
    },
  };
  const check = [{ bucket: 'inbound', max: 1, windowMs: 60000 }];
  await assert.rejects(() => consume(storage, check, { now: 100000, subj: 'person' }), /put failed/);
  failPut = false;
  assert.equal((await consume(storage, check, { now: 100000, subj: 'person' })).ok, true);
});

test('L4 a beforeCommit that hangs releases the lock', { timeout: 500 }, async () => {
  let value;
  const storage = {
    async get() { return value ? structuredClone(value) : undefined; },
    async put(_key, next) { value = structuredClone(next); },
  };
  await assert.rejects(() => applyState(storage, { transcription: true }, {
    commitTimeoutMs: 30,
    beforeCommit: () => new Promise(() => {}),
  }));
  assert.equal(value, undefined, 'a timed-out grant stores nothing');
  await applyState(storage, { draft: true }, { commitTimeoutMs: 30, beforeCommit: async () => {} });
  const state = await loadState(storage);
  assert.equal(state.purposes.draft?.granted, true);
  assert.notEqual(state.purposes.transcription?.granted, true);
});

test('F3 property overlapping consumes stay inside max', async () => {
  for (const max of [1, 2, 5]) {
    for (const width of [1, 8, 40]) {
      const storage = counter();
      let transactions = 0;
      storage.transaction = async (fn) => { transactions += 1; return fn(); };
      const check = [{ bucket: 'inbound', max, windowMs: 60000 }];
      const now = 1_700_000_030_000;
      const results = await Promise.all(Array.from({ length: width }, () => consume(storage, check, { now, subj: 'person' })));
      const allowed = results.filter(result => result.ok).length;
      assert.ok(allowed <= max, `max ${max} width ${width} allowed ${allowed}`);
      assert.ok(transactions >= 1, 'storage.transaction runs inside the mutex');
      if (allowed === max) assert.equal((await consume(storage, check, { now, subj: 'person' })).ok, false);
    }
  }
});

test('F4 property overlapping grants keep every purpose and a throw does not store', async () => {
  const pairs = [];
  for (const left of PURPOSES) for (const right of PURPOSES) if (left !== right) pairs.push([left, right]);
  for (const [left, right] of pairs) {
    let value;
    const storage = {
      async get() {
        await new Promise(resolve => setImmediate(resolve));
        return value ? structuredClone(value) : undefined;
      },
      async put(_key, next) {
        await new Promise(resolve => setImmediate(resolve));
        value = structuredClone(next);
      },
    };
    const pause = async () => { await new Promise(resolve => setImmediate(resolve)); };
    await Promise.all([
      applyState(storage, { [left]: true }, { beforeCommit: pause }),
      applyState(storage, { [right]: true }, { beforeCommit: pause }),
    ]);
    const state = await loadState(storage);
    assert.equal(state.purposes[left]?.granted, true, left);
    assert.equal(state.purposes[right]?.granted, true, right);
  }
  let value;
  const storage = {
    async get() { return value ? structuredClone(value) : undefined; },
    async put(_key, next) { value = structuredClone(next); },
  };
  await Promise.allSettled([
    applyState(storage, { transcription: true }, { beforeCommit: async () => { throw new Error('receipt failed'); } }),
    applyState(storage, { draft: true }, { beforeCommit: async () => {} }),
  ]);
  const state = await loadState(storage);
  assert.equal(state.purposes.draft?.granted, true);
  assert.notEqual(state.purposes.transcription?.granted, true);
});

test('F8 property the spent window stays closed until seen plus one window', async () => {
  const windowMs = 10000;
  const max = 2;
  const start = 5_000_000;
  const storage = counter();
  const check = [{ bucket: 'inbound', max, windowMs }];
  const consumeAt = now => consume(storage, check, { now, subj: 'person' });
  assert.equal((await consumeAt(start)).ok, true);
  assert.equal((await consumeAt(start + 100)).ok, true);
  assert.equal((await consumeAt(start + 200)).ok, false);
  const windowStart = Math.floor((start + 200) / windowMs) * windowMs;
  assert.equal((await consumeAt(windowStart)).ok, false, 'the spent window start is refused');
  assert.equal((await consumeAt(start + 200 - windowMs)).ok, false, 'one window earlier does not open a fresh window');
  assert.equal((await consumeAt(start + 200 + windowMs)).ok, true, 'seen plus one window opens');

  let high = -Infinity;
  const counted = new Map();
  let seed = 0x14d14;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const box = counter();
  for (let i = 0; i < 24; i++) {
    const now = start + Math.floor(next() * 2 * windowMs);
    const result = await consume(box, check, { now, subj: 'person' });
    if (result.ok && now >= high) counted.set(Math.floor(now / windowMs), (counted.get(Math.floor(now / windowMs)) || 0) + 1);
    if (now > high) high = now;
  }
  for (const n of counted.values()) assert.ok(n <= max, String(n));
});

test('an empty checks array is still allowed', async () => {
  const storage = { async get() { throw new Error('no read'); }, async put() { throw new Error('no write'); } };
  assert.deepEqual(await consume(storage, [], { now: 1 }), { ok: true, remaining: Infinity });
});
