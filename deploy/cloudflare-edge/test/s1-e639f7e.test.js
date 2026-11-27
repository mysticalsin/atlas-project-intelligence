// Review of e639f7e. These fail on that tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { handle } from '../src/app.js';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { internalRoutes } from '../src/privacy-routes.js';
import { appendAudit, sha256Hex, verifyDaily, GENESIS } from '../src/audit-chain.js';
import { eraseMine } from '../src/subject-rights.js';
import { ensure as ensureOutreach } from '../src/outreach.js';
import { FakeStorage } from './reconnect-harness.js';
import { ENV, ORIGIN, session } from './security-harness.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
const OID = '66666666-7777-4888-8999-000000000000';
const EMAIL = 'ada@example.test';
const MAIL = 'ada.mail@example.test';
const MALLORY = 'mallory';
const STAMP = '2026-11-16T00:00:00.000Z';
const MAIN = 'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)';
const AUDIO_MAX = 1536000;
const SHEET_CAP = 12 * 1024 * 1024;
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });
const legacyHash = (prev, row) => sha256Hex(JSON.stringify([prev, String(row.id ?? ''), String(row.action ?? ''), String(row.at ?? '')]));

function signedActors(sql) {
  try { return sql.exec('SELECT actor, "commit" FROM audit').toArray().filter(r => r.commit).map(r => r.actor); }
  catch { return []; }
}
function unkeyed(rows, anchorN = rows.length) {
  const sql = memorySql();
  sql.exec('CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT, prev_hash TEXT, hash TEXT)');
  let prev = GENESIS;
  const heads = [];
  for (const row of rows) {
    const hash = legacyHash(prev, row);
    sql.exec('INSERT INTO audit (id, actor, action, at, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)', row.id, row.actor, row.action, row.at, row.detail, prev, hash);
    heads.push(hash);
    prev = hash;
  }
  sql.exec('CREATE TABLE audit_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, head TEXT NOT NULL)');
  sql.exec('INSERT INTO audit_anchor (id, n, head) VALUES (1, ?, ?)', anchorN, heads[anchorN - 1]);
  return sql;
}
const row = (n, actor = 'a' + n + '@example.test') => ({ id: 'r' + n, actor, action: 'saved', at: STAMP, detail: 'detail ' + n });

function refusesForgery(sql) {
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.reason, 'TAMPERED');
  assert.equal(daily.ok, false);
  assert.deepEqual(signedActors(sql), []);
  assert.notEqual(daily.reason, 'CHAIN_VERIFIED');
}
function recomputeUnkeyed(sql) {
  let prev = GENESIS;
  for (const r of sql.exec('SELECT seq, id, action, at FROM audit ORDER BY seq').toArray()) {
    const hash = legacyHash(prev, r);
    sql.exec('UPDATE audit SET prev_hash = ?, hash = ? WHERE seq = ?', prev, hash, r.seq);
    prev = hash;
  }
  sql.exec('UPDATE audit_anchor SET n = (SELECT COUNT(*) FROM audit), head = ? WHERE id = 1', prev);
  return prev;
}

test('a recomputed unkeyed chain plus an anchor does not verify the forged actor', () => {
  refusesForgery(unkeyed([row(1), row(2, MALLORY)]));
});

test('dropping commit, recomputing the unkeyed chain and planting the anchor does not verify the forged actor', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'r1', actor: 'a1@example.test', action: 'saved', at: STAMP, detail: 'one' });
  appendAudit(sql, { id: 'r2', actor: 'a2@example.test', action: 'saved', at: STAMP, detail: 'two' });
  verifyDaily(sql);
  sql.exec('UPDATE audit SET actor = ? WHERE seq = 2', MALLORY);
  recomputeUnkeyed(sql);
  sql.exec('DROP INDEX IF EXISTS audit_one_chain_start');
  sql.exec('ALTER TABLE audit DROP COLUMN "commit"');
  refusesForgery(sql);
});

test('renaming commit, recomputing the unkeyed chain and planting the anchor does not verify the forged actor', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'r1', actor: 'a1@example.test', action: 'saved', at: STAMP, detail: 'one' });
  appendAudit(sql, { id: 'r2', actor: 'a2@example.test', action: 'saved', at: STAMP, detail: 'two' });
  verifyDaily(sql);
  sql.exec('UPDATE audit SET actor = ? WHERE seq = 2', MALLORY);
  recomputeUnkeyed(sql);
  sql.exec('DROP INDEX IF EXISTS audit_one_chain_start');
  sql.exec('ALTER TABLE audit RENAME COLUMN "commit" TO "old_commit"');
  refusesForgery(sql);
});

test('an anchor planted before the first Library does not verify a forged actor', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'r1', 'a1@example.test', 'saved', STAMP, 'one');
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'r2', MALLORY, 'saved', STAMP, 'two');
  sql.exec('CREATE TABLE audit_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, head TEXT NOT NULL)');
  sql.exec('INSERT INTO audit_anchor (id, n, head) VALUES (1, 2, ?)', 'ab'.repeat(32));
  const lib = new Library(sql, { now: () => STAMP });
  const daily = verifyDaily(sqlOf(lib), lib.auditKey);
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'TAMPERED');
  assert.equal(signedActors(sqlOf(lib)).includes(MALLORY), false);
  assert.equal(sqlOf(lib).exec("SELECT COUNT(*) AS n FROM audit WHERE action = 'chain-start'").toArray()[0].n, 0);
  const anchor = sqlOf(lib).exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  assert.equal(Number(anchor.n), 2);
  assert.equal(anchor.head, 'ab'.repeat(32));
});

test('an anchor at n-1 with a forged tail is not chain-verified', () => {
  refusesForgery(unkeyed([row(1), row(2), row(3, MALLORY)], 2));
});

test('a continuation row past the anchor is not chain-verified', () => {
  const sql = unkeyed([row(1), row(2)]);
  const head = sql.exec('SELECT hash FROM audit WHERE seq = 2').toArray()[0].hash;
  const extra = row(3, MALLORY);
  const hash = legacyHash(head, extra);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)', extra.id, extra.actor, extra.action, extra.at, extra.detail, head, hash);
  refusesForgery(sql);
});

test('an actor-only edit of an unkeyed row is not chain-verified', () => {
  const sql = unkeyed([row(1), row(2)]);
  sql.exec('UPDATE audit SET actor = ? WHERE seq = 2', MALLORY);
  refusesForgery(sql);
});

test('a detail-only edit of an unkeyed row is not chain-verified', () => {
  const sql = unkeyed([row(1), row(2)]);
  sql.exec('UPDATE audit SET detail = ? WHERE seq = 2', 'forged detail');
  refusesForgery(sql);
});

test('keyed rows without the commit column are tampered and are not re-signed', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  appendAudit(sql, { id: 'r1', actor: 'a1@example.test', action: 'saved', at: STAMP, detail: 'one' });
  appendAudit(sql, { id: 'r2', actor: MALLORY, action: 'saved', at: STAMP, detail: 'two' });
  sql.exec('DROP INDEX IF EXISTS audit_one_chain_start');
  sql.exec('ALTER TABLE audit DROP COLUMN "commit"');
  refusesForgery(sql);
});

function tempFile(setup) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-chain-'));
  const file = join(dir, 'audit.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  setup(db);
  db.close();
  return { dir, file, drop: () => rmSync(dir, { recursive: true, force: true }) };
}
function callers(file) {
  const url = new URL('./chain-callers.mjs', import.meta.url);
  return Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: { file, key: '' } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker hung')); }, 20000);
    worker.on('message', message => { clearTimeout(timer); resolve(message); });
    worker.on('error', error => { clearTimeout(timer); reject(error); });
  })));
}
function fileStarts(file) {
  const db = new DatabaseSync(file);
  try { return db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'chain-start'").get().n; }
  finally { db.close(); }
}

test('eight concurrent callers do not verify a forged actor on a recomputed unkeyed chain', async () => {
  const built = tempFile(db => {
    db.exec('CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT, prev_hash TEXT, hash TEXT)');
    const rows = [row(1), row(2, MALLORY)];
    let prev = GENESIS;
    const insert = db.prepare('INSERT INTO audit (id, actor, action, at, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const item of rows) {
      const hash = legacyHash(prev, item);
      insert.run(item.id, item.actor, item.action, item.at, item.detail, prev, hash);
      prev = hash;
    }
    db.exec('CREATE TABLE audit_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, head TEXT NOT NULL)');
    db.prepare('INSERT INTO audit_anchor (id, n, head) VALUES (1, 2, ?)').run(prev);
  });
  try {
    const results = await callers(built.file);
    assert.equal(results.length, 8);
    for (const result of results) {
      assert.equal(result.error || '', '');
      assert.equal(result.signed.includes(MALLORY), false);
      assert.notEqual(result.reason, 'CHAIN_VERIFIED');
      assert.equal(result.reason, 'TAMPERED');
    }
  } finally { built.drop(); }
});

test('a main-shaped database migrates once, reports legacy rows as unverified, and raises no chain alert', async () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'the note');
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', 'kim@example.test', 'saved', STAMP, 'other');
  const lib = new Library(sql, { now: () => STAMP });
  const daily = verifyDaily(sqlOf(lib), lib.auditKey);
  assert.equal(daily.ok, true);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  assert.equal(daily.legacyUnverified, 2);
  assert.equal(daily.checked, 1);
  const starts = sqlOf(lib).exec('SELECT actor, action, detail, "commit", hash FROM audit WHERE action = ?', 'chain-start').toArray();
  assert.equal(starts.length, 1);
  assert.deepEqual(JSON.parse(starts[0].detail), { legacy: 2, maxSeq: 2 });
  assert.equal(typeof starts[0].commit, 'string');
  assert.equal(starts[0].commit.length > 0, true);
  const legacy = sqlOf(lib).exec("SELECT actor, hash, \"commit\" FROM audit WHERE action != 'chain-start'").toArray();
  assert.equal(legacy.length, 2);
  assert.equal(legacy.every(r => r.commit == null && r.hash == null), true);
  const events = [];
  const orig = console.log;
  console.log = line => { try { const parsed = JSON.parse(line); if (parsed.atlas_sec) events.push(parsed); } catch { /* not a security line */ } };
  try {
    const res = await libraryRoutes(new Request('https://atlas.internal/api/library/scan-stale', {
      method: 'POST', body: '{}', headers: { 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system', 'x-atlas-tenant-enforced': '0' },
    }), lib, { env: { ATLAS_TENANT_ISOLATION: 'local-synthetic' } });
    assert.equal(res.status, 200);
  } finally { console.log = orig; }
  assert.equal(events.some(e => e.event === 'audit_chain_break'), false);
  assert.equal(events.some(e => e.event === 'audit_chain_ok' && e.reason === 'CHAIN_VERIFIED' && e.legacy === 2), true);
});

test('eight concurrent callers migrate a main-shaped database to one chain-start and do not sign the forged actor', async () => {
  const built = tempFile(db => {
    db.exec(MAIN);
    const insert = db.prepare('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)');
    insert.run('r1', 'a1@example.test', 'saved', STAMP, 'one');
    insert.run('r2', MALLORY, 'saved', STAMP, 'two');
  });
  try {
    const before = new DatabaseSync(built.file);
    try { assert.equal(before.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit_anchor'").get().n, 0); }
    finally { before.close(); }
    const results = await callers(built.file);
    assert.equal(results.length, 8);
    for (const result of results) {
      assert.equal(result.error || '', '');
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.reason, 'CHAIN_VERIFIED');
      assert.equal(result.legacyUnverified, 2);
      assert.equal(result.signed.includes(MALLORY), false);
    }
    assert.equal(fileStarts(built.file), 1);
  } finally { built.drop(); }
});

test('erasure tombstones legacy rows and does not refuse', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'story', EMAIL, 'saved', STAMP, 'note ' + EMAIL);
  const lib = new Library(sql, { now: () => STAMP });
  sqlOf(lib).exec('INSERT INTO refs (id, owner, title, status, revision, data, state, tenant, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'story', EMAIL, 'Story', 'draft', 1, '{}', '{}', A, STAMP, STAMP);
  const out = eraseMine(lib, { email: EMAIL, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) }, 'ab'.repeat(16));
  assert.equal(out.auditRefused, undefined);
  const legacy = sqlOf(lib).exec("SELECT actor, detail FROM audit WHERE action != 'chain-start' AND id = 'story'").toArray()[0];
  assert.match(legacy.actor, /^erased:[0-9a-f]{12}$/);
  assert.equal(legacy.detail, '');
  assert.equal(verifyDaily(sqlOf(lib), lib.auditKey).ok, true);
});

test('a second chain-start is refused', () => {
  const sql = memorySql();
  sql.exec(MAIN);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail) VALUES (?, ?, ?, ?, ?)', 'r1', 'a1@example.test', 'saved', STAMP, 'one');
  const lib = new Library(sql, { now: () => STAMP });
  assert.equal(sqlOf(lib).exec("SELECT COUNT(*) AS n FROM audit WHERE action = 'chain-start'").toArray()[0].n, 1);
  assert.throws(() => lib.log('audit', MALLORY, 'chain-start', '{"legacy":9,"maxSeq":9}'), /chain-start/);
  assert.throws(() => sqlOf(lib).exec('INSERT INTO audit (id, actor, action, at, detail, prev_hash, hash, "commit", tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'audit', MALLORY, 'chain-start', STAMP, '{"legacy":9,"maxSeq":9}', GENESIS, 'ab'.repeat(32), 'cd'.repeat(32), ''));
  assert.equal(sqlOf(lib).exec("SELECT COUNT(*) AS n FROM audit WHERE action = 'chain-start'").toArray()[0].n, 1);
});

function limitEnv(extra = {}) {
  let limits = 0;
  const interview = { idFromName: () => 'i', get: () => ({ fetch: async request => {
    if (new URL(request.url).pathname === '/api/limit') limits += 1;
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  } }) };
  return { env: { ...ENV, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: A, INTERVIEW: interview, LIBRARY: { idFromName: () => 'g', get: () => ({ fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) }) }, ...extra }, limits: () => limits };
}
function streamOf(chunks, { explodeAt = Infinity } = {}) {
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > explodeAt) { controller.error(new Error('read past the cap')); return; }
      if (pulls > chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[pulls - 1]);
    },
  });
  return { stream, pulls: () => pulls };
}

test('classify runs project shape validation before the limiter', async () => {
  const box = limitEnv({ TYPESAFE_API_KEY: '' });
  const me = await session(box.env, { email: EMAIL, custom: { tid: A, oid: OID } });
  const res = await me.go('/api/jev/classify', { method: 'POST', body: '{"project":{}}', headers: { 'content-type': 'application/json' } }, box.env);
  assert.equal(res.status, 400);
  assert.equal(box.limits(), 0);
});

test('an empty sheet body without Content-Length and an unknown sheet route are 4xx before the limiter', async () => {
  const box = limitEnv();
  const me = await session(box.env, { email: EMAIL, custom: { tid: A, oid: OID } });
  const empty = streamOf([]);
  const ingest = await handle(new Request(ORIGIN + '/api/sheet/ingest', {
    method: 'POST', body: empty.stream, duplex: 'half',
    headers: { 'cf-access-jwt-assertion': me.token, Origin: ORIGIN, 'X-Atlas-CSRF': me.csrf, 'content-type': 'application/pdf' },
  }), box.env, '<html></html>');
  assert.equal(ingest.status, 400);
  assert.equal(box.limits(), 0);
  const unknown = await me.go('/api/sheet/nope', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, box.env);
  assert.equal(unknown.status, 404);
  assert.equal(box.limits(), 0);
});

test('transcribe and sheet reject an oversized body before spend and before reading it all', async () => {
  const box = limitEnv();
  const me = await session(box.env, { email: EMAIL, custom: { tid: A, oid: OID } });
  const headers = { 'cf-access-jwt-assertion': me.token, Origin: ORIGIN, 'X-Atlas-CSRF': me.csrf };
  const declared = streamOf([new Uint8Array(32), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)], { explodeAt: 2 });
  const tooLong = await handle(new Request(ORIGIN + '/api/transcribe', {
    method: 'POST', body: declared.stream, duplex: 'half',
    headers: { ...headers, 'X-Atlas-Consent': 'spoken-ask-v1; once', 'Content-Type': 'audio/L16;rate=24000', 'Content-Length': String(AUDIO_MAX + 1) },
  }), box.env, '<html></html>', { flagsOf: () => ({ spokenAsk: true }) });
  assert.equal(tooLong.status, 413);
  assert.equal(declared.pulls() <= 1, true, 'a declared length over the cap is not read');
  const chunk = new Uint8Array(1000000);
  const streamed = streamOf([chunk, chunk, chunk, chunk], { explodeAt: 3 });
  const over = await handle(new Request(ORIGIN + '/api/transcribe', {
    method: 'POST', body: streamed.stream, duplex: 'half',
    headers: { ...headers, 'X-Atlas-Consent': 'spoken-ask-v1; once', 'Content-Type': 'audio/L16;rate=24000' },
  }), box.env, '<html></html>', { flagsOf: () => ({ spokenAsk: true }) });
  assert.equal(over.status, 413);
  assert.equal(streamed.pulls() <= 3, true);
  const sheetDeclared = streamOf([new Uint8Array(32), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)], { explodeAt: 2 });
  const sheetCap = await handle(new Request(ORIGIN + '/api/sheet/ingest', {
    method: 'POST', body: sheetDeclared.stream, duplex: 'half',
    headers: { ...headers, 'content-type': 'application/pdf', 'Content-Length': String(SHEET_CAP + 1) },
  }), box.env, '<html></html>');
  assert.equal(sheetCap.status, 413);
  assert.equal(sheetDeclared.pulls() <= 1, true, 'a declared length over the cap is not read');
  const wide = new Uint8Array(8 * 1024 * 1024);
  const sheetStream = streamOf([wide, wide, wide, wide], { explodeAt: 3 });
  const sheetOver = await handle(new Request(ORIGIN + '/api/sheet/ingest', {
    method: 'POST', body: sheetStream.stream, duplex: 'half',
    headers: { ...headers, 'content-type': 'application/pdf' },
  }), box.env, '<html></html>');
  assert.equal(sheetOver.status, 413);
  assert.equal(sheetStream.pulls() <= 3, true);
  assert.equal(box.limits(), 0);
});

test('a direct erase without confirmed does not spend', async () => {
  const lib = new Library(memorySql(), { now: () => STAMP });
  const storage = new FakeStorage();
  let reads = 0;
  const watch = {
    get: async keys => { reads += 1; return storage.get(keys); },
    put: async obj => storage.put(obj),
    delete: keys => storage.delete(keys),
    list: options => storage.list(options),
  };
  await assert.rejects(() => internalRoutes({
    lib, user: { email: EMAIL, mail: EMAIL, role: 'user', subj: 'ab'.repeat(16) },
    method: 'POST', url: new URL('https://atlas.internal/api/privacy/erase'), body: {}, env: {}, storage: watch,
  }), /confirmation/);
  assert.equal(reads, 0);
});

test('outreach addressed to the Entra mail is deleted with the library identity', () => {
  const lib = new Library(memorySql(), { now: () => STAMP });
  ensureOutreach(lib);
  const email = (A + ':' + OID).toLowerCase();
  const mixed = 'Ada@Example.Test';
  sqlOf(lib).exec('INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, payload, created_at, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'out-mail', 'gap_request', 'subj-mail', 'email_draft', mixed, 'pending_approval', JSON.stringify({ note: mixed }), STAMP, A);
  sqlOf(lib).exec('INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, payload, created_at, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'out-id', 'gap_request', 'subj-id', 'email_draft', email, 'pending_approval', '{}', STAMP, A);
  sqlOf(lib).exec('INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, payload, created_at, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'out-other', 'gap_request', 'subj-other', 'email_draft', 'kim@example.test', 'pending_approval', JSON.stringify({ note: 'ask ' + mixed }), STAMP, A);
  sqlOf(lib).exec('INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, payload, created_at, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'out-b', 'gap_request', 'subj-b', 'email_draft', mixed, 'pending_approval', JSON.stringify({ note: mixed }), STAMP, B);
  sqlOf(lib).exec('INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, payload, created_at, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'out-long', 'gap_request', 'subj-long', 'email_draft', mixed + '.au', 'pending_approval', '{}', STAMP, A);
  eraseMine(lib, { email, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) }, 'ab'.repeat(16));
  assert.equal(sqlOf(lib).exec('SELECT id FROM outreach WHERE id = ?', 'out-mail').toArray().length, 0);
  assert.equal(sqlOf(lib).exec('SELECT id FROM outreach WHERE id = ?', 'out-id').toArray().length, 0);
  assert.equal(sqlOf(lib).exec('SELECT to_email FROM outreach WHERE id = ?', 'out-b').toArray()[0].to_email, mixed);
  assert.equal(sqlOf(lib).exec('SELECT to_email FROM outreach WHERE id = ?', 'out-long').toArray()[0].to_email, mixed + '.au');
  assert.equal(String(sqlOf(lib).exec('SELECT payload FROM outreach WHERE id = ?', 'out-other').toArray()[0].payload).toLowerCase().includes(EMAIL), false);
});
