// Cursor delta of 9d47ae2b, on top of the local null-key fix. These fail on 03046edc.
// verifyChain and verifyDaily must refuse before ensureChain. The cron and the two bearer
// ingresses must refuse before LIBRARY.get. A copied chain must not verify under another
// database id, and a relink that only rebuilds the public hash must be COMMIT_MISMATCH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { handle, scheduled } from '../src/app.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { appendAudit, auditKey, rowHash, verifyChain, verifyDaily, GENESIS } from '../src/audit-chain.js';

const EMAIL = 'ada@example.test';
const STAMP = '2026-11-16T00:00:00.000Z';
const SALT = 'synthetic-log-salt';
const ORIGIN = 'https://atlas.example.workers.dev';
const TID = '11111111-1111-4111-8111-111111111111';
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const MAIN_COLS = ['seq', 'id', 'actor', 'action', 'at', 'detail'];
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });

function columns(sql) {
  return sql.exec("SELECT name FROM pragma_table_info('audit')").toArray().map(row => row.name);
}
function mainShaped(sql, count) {
  assert.deepEqual(columns(sql), MAIN_COLS);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n, count);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit_anchor'").toArray()[0].n, 0);
}
function anchorOf(sql) {
  return sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
}

test('verifyChain and verifyDaily return LOG_SALT before touching storage', () => {
  const raw = memorySql();
  raw.exec(MAIN);
  let calls = 0;
  const sql = {
    exec(...args) { calls++; return raw.exec(...args); },
    transactionSync(fn) { calls++; return raw.transactionSync(fn); },
  };
  assert.equal(verifyChain(sql, null).reason, 'LOG_SALT');
  assert.equal(verifyDaily(sql, null).reason, 'LOG_SALT');
  assert.equal(calls, 0);
  mainShaped(raw, 0);
});

test('the cron and both bearer ingresses refuse before opening the library when production has no LOG_SALT', async () => {
  const sql = memorySql();
  sql.exec(MAIN);
  let gets = 0;
  const env = {
    ORIGIN, CSRF_SECRET: 'test-secret', DATA_MODE: 'production', ATLAS_SYSTEM_TENANT: TID,
    TRIGGER_SECRET: 's3cret-value', DIRECTORY_PUSH_SECRET: 'push-secret-value',
    LIBRARY: {
      idFromName: name => name,
      get() {
        gets++;
        const lib = new Library(sql, { now: () => STAMP, auditKey: auditKey(env) });
        return { fetch: request => libraryRoutes(request, lib, { env }) };
      },
    },
  };
  assert.equal(auditKey(env), null);
  const waited = [];
  await scheduled({}, env, { waitUntil: promise => waited.push(promise) });
  await Promise.all(waited);
  assert.equal(waited.length, 0);
  assert.equal(gets, 0);
  const trig = await handle(new Request(ORIGIN + '/api/triggers', {
    method: 'POST', body: '{}', headers: { Authorization: 'Bearer s3cret-value' },
  }), env, '');
  assert.equal(trig.status, 503);
  assert.equal((await trig.json()).code, 'LOG_SALT');
  const push = await handle(new Request(ORIGIN + '/api/directory/push', {
    method: 'POST', body: '{"rows":[]}', headers: { Authorization: 'Bearer push-secret-value' },
  }), env, '');
  assert.equal(push.status, 503);
  assert.equal((await push.json()).code, 'LOG_SALT');
  assert.equal(gets, 0);
  mainShaped(sql, 0);
  env.LOG_SALT = SALT;
  const lib = new Library(sql, { now: () => STAMP, auditKey: auditKey(env) });
  assert.equal(verifyDaily(sqlOf(lib), SALT).reason, 'CHAIN_VERIFIED');
  appendAudit(sqlOf(lib), { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'after' }, SALT);
  assert.equal(verifyDaily(fresh(sqlOf(lib)), SALT).reason, 'CHAIN_VERIFIED');
});

test('deleting a middle row and rebuilding only the public hash is COMMIT_MISMATCH', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  const lib = new Library(sql, { now: () => STAMP, auditKey: SALT });
  lib.log('story', EMAIL, 'saved', 'one');
  lib.log('story', EMAIL, 'saved', 'two');
  lib.log('story', EMAIL, 'saved', 'three');
  assert.equal(verifyDaily(sql, SALT).reason, 'CHAIN_VERIFIED');
  const saved = sql.exec('SELECT seq, id, action, at, "commit", hash FROM audit WHERE action = ? ORDER BY seq', 'saved').toArray();
  assert.equal(saved.length, 3);
  const anchor = anchorOf(sql);
  sql.exec('DELETE FROM audit WHERE seq = ?', saved[1].seq);
  const hash = rowHash(saved[0].hash, saved[2]);
  sql.exec('UPDATE audit SET prev_hash = ?, hash = ? WHERE seq = ?', saved[0].hash, hash, saved[2].seq);
  const daily = verifyDaily(fresh(sql), SALT);
  assert.equal(daily.reason, 'COMMIT_MISMATCH');
  const still = anchorOf(sql);
  assert.equal(Number(still.n), Number(anchor.n));
  assert.equal(still.head, anchor.head);
  const before = sql.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n;
  assert.throws(() => appendAudit(fresh(sql), { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'more' }, SALT), err => err.status === 409);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n, before);
  assert.equal(sql.exec('SELECT prev_hash FROM audit WHERE action = ? ORDER BY seq', 'chain-start').toArray()[0].prev_hash, GENESIS);
});

test('a chain copied from another database with the same salt is refused and writes no anchor', () => {
  const source = memorySql();
  source.exec(MAIN);
  const origin = new Library(source, { now: () => STAMP, auditKey: SALT, dbId: 'do-source' });
  origin.log('story', EMAIL, 'saved', 'kept');
  assert.equal(verifyDaily(source, SALT, 'do-source').reason, 'CHAIN_VERIFIED');
  const copied = source.exec('SELECT seq, id, actor, action, at, detail, prev_hash, hash, "commit", tombstone FROM audit ORDER BY seq').toArray();
  const target = memorySql();
  target.exec(MAIN);
  new Library(target, { now: () => STAMP, auditKey: SALT, dbId: 'do-target' });
  target.exec('DELETE FROM audit');
  target.exec('DELETE FROM audit_anchor');
  for (const row of copied) {
    target.exec('INSERT INTO audit (seq, id, actor, action, at, detail, prev_hash, hash, "commit", tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.seq, row.id, row.actor, row.action, row.at, row.detail, row.prev_hash, row.hash, row.commit, row.tombstone);
  }
  const daily = verifyDaily(fresh(target), SALT, 'do-target');
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'COMMIT_MISMATCH');
  assert.equal(target.exec('SELECT COUNT(*) AS n FROM audit_anchor').toArray()[0].n, 0);
  const before = target.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n;
  assert.throws(() => appendAudit(fresh(target), { id: 'story', actor: EMAIL, action: 'saved', at: STAMP, detail: 'more' }, SALT, 'do-target'), err => err.status === 409);
  assert.equal(target.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n, before);
});
