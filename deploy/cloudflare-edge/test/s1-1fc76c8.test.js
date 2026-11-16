// Review of 1fc76c8. These fail on that tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { appendAudit, sha256Hex, verifyChain, verifyDaily, GENESIS } from '../src/audit-chain.js';
import { eraseMine } from '../src/subject-rights.js';
import { privacyRoutes } from '../src/operate.js';
import { ensure as ensureOutreach } from '../src/outreach.js';
import { ensureJourney } from '../src/journey.js';
import * as profile from '../src/profile.js';
import { ENV, ORIGIN, session } from './security-harness.js';

const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
const EMAIL = 'ada@example.test';
const MAIL = 'ada.mail@example.test';
const OID = '66666666-7777-4888-8999-000000000000';
const STAMP = '2026-11-16T00:00:00.000Z';
const DELETE_ENV = { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' };
const fresh = sql => ({ exec: (...args) => sql.exec(...args) });
const legacyHash = (prev, row) => sha256Hex(JSON.stringify([prev, String(row.id), String(row.action), String(row.at)]));

function bareAudit() {
  const sql = memorySql();
  sql.exec('CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)');
  return sql;
}
function modernPair() {
  const sql = bareAudit();
  appendAudit(sql, { id: 'r1', actor: 'a1@example.test', action: 'saved', at: STAMP, detail: 'one' });
  appendAudit(sql, { id: 'r2', actor: 'a2@example.test', action: 'saved', at: STAMP, detail: 'two' });
  assert.equal(verifyDaily(sql).ok, true);
  return sql;
}
function plantLegacy(anchorHead) {
  const sql = memorySql();
  sql.exec('CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT, prev_hash TEXT, hash TEXT)');
  const rows = [
    { id: 'r1', actor: 'a1@example.test', action: 'saved', at: STAMP, detail: 'one' },
    { id: 'r2', actor: 'a2@example.test', action: 'saved', at: STAMP, detail: 'two' },
  ];
  let prev = GENESIS;
  for (const row of rows) {
    const hash = legacyHash(prev, row);
    sql.exec('INSERT INTO audit (id, actor, action, at, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)', row.id, row.actor, row.action, row.at, row.detail, prev, hash);
    prev = hash;
  }
  sql.exec('CREATE TABLE audit_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, head TEXT NOT NULL)');
  sql.exec('INSERT INTO audit_anchor (id, n, head) VALUES (1, 2, ?)', anchorHead ?? prev);
  return { sql, head: prev };
}

function forgeColumn(sql, alter) {
  sql.exec('UPDATE audit SET hash = NULL, prev_hash = NULL');
  sql.exec('UPDATE audit SET actor = ? WHERE seq = 2', 'mallory');
  sql.exec(alter);
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  assert.equal(daily.legacyUnverified, 2);
  const tail = sql.exec('SELECT * FROM audit WHERE seq = 2').toArray()[0];
  assert.equal(tail.actor, 'mallory');
  assert.equal(tail.commit ?? null, null);
  assert.equal(sql.exec('SELECT actor FROM audit WHERE "commit" IS NOT NULL').toArray().some(r => r.actor === 'mallory'), false);
}
test('clearing hashes and dropping commit does not sign the forged actor', () => {
  forgeColumn(modernPair(), 'ALTER TABLE audit DROP COLUMN "commit"');
});

test('clearing hashes and renaming commit does not sign the forged actor', () => {
  forgeColumn(modernPair(), 'ALTER TABLE audit RENAME COLUMN "commit" TO "old_commit"');
});

test('cleared hashes with the commit column present stay unsealed', () => {
  const sql = modernPair();
  sql.exec('UPDATE audit SET hash = NULL, "commit" = NULL, actor = ? WHERE seq = 2', 'mallory');
  const checked = verifyChain(fresh(sql));
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'UNSEALED');
  const tail = sql.exec('SELECT * FROM audit WHERE seq = 2').toArray()[0];
  assert.equal(tail.commit, null);
  assert.equal(tail.hash, null);
});

test('an intact unkeyed chain with a matching anchor is not signed', () => {
  const { sql } = plantLegacy();
  const checked = verifyChain(fresh(sql));
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'TAMPERED');
  const stored = sql.exec('SELECT * FROM audit ORDER BY seq').toArray();
  assert.equal(stored[0].actor, 'a1@example.test');
  assert.equal(stored[1].actor, 'a2@example.test');
  assert.equal(stored.every(r => r.commit == null), true);
  const daily = verifyDaily(fresh(sql));
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'TAMPERED');
});

test('a legacy chain whose anchor does not match is not signed', () => {
  const { sql } = plantLegacy('ab'.repeat(32));
  const checked = verifyChain(fresh(sql));
  assert.equal(checked.ok, false);
  const tail = sql.exec('SELECT * FROM audit WHERE seq = 2').toArray()[0];
  assert.equal(tail.actor, 'a2@example.test');
  assert.equal(tail.commit ?? null, null);
});

function limitEnv(extra = {}) {
  let limits = 0;
  const interview = { idFromName: () => 'i', get: () => ({ fetch: async request => {
    if (new URL(request.url).pathname === '/api/limit') limits += 1;
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  } }) };
  const library = { idFromName: () => 'g', get: () => ({ fetch: async () => new Response('{"erased":false}', { headers: { 'content-type': 'application/json' } }) }) };
  return { env: { ...ENV, IDENTITY_SOURCE: 'entra', ENTRA_TENANTS: A, INTERVIEW: interview, LIBRARY: library, ...extra }, limits: () => limits };
}

test('a bad spoken-ask content type is 415 before the limiter', async () => {
  const box = limitEnv();
  const me = await session(box.env, { email: EMAIL, custom: { tid: A, oid: OID } });
  const res = await handle(new Request(ORIGIN + '/api/transcribe', {
    method: 'POST', body: 'nope',
    headers: { 'cf-access-jwt-assertion': me.token, Origin: ORIGIN, 'X-Atlas-CSRF': me.csrf, 'X-Atlas-Consent': 'spoken-ask-v1; once', 'Content-Type': 'text/plain' },
  }), box.env, '', { flagsOf: () => ({ spokenAsk: true }) });
  assert.deepEqual({ status: res.status, limits: box.limits() }, { status: 415, limits: 0 });
});

test('invalid classify JSON is 400 before the limiter', async () => {
  const box = limitEnv();
  const me = await session(box.env, { email: EMAIL, custom: { tid: A, oid: OID } });
  const res = await me.go('/api/jev/classify', { method: 'POST', body: 'not-json', headers: { 'content-type': 'application/json' } }, box.env);
  assert.deepEqual({ status: res.status, limits: box.limits() }, { status: 400, limits: 0 });
});

test('erase with confirmed false is 400 before the limiter', async () => {
  const box = limitEnv();
  const me = await session(box.env, { email: EMAIL, custom: { tid: A, oid: OID } });
  const res = await me.go('/api/me/erase', { method: 'POST', body: '{"confirmed":false}', headers: { 'content-type': 'application/json' } }, box.env);
  assert.deepEqual({ status: res.status, limits: box.limits() }, { status: 400, limits: 0 });
});

test('invalid sheet JSON is 400 before the limiter', async () => {
  const box = limitEnv({ AI: { run: async () => { throw new Error('model'); }, toMarkdown: async () => ({ format: 'markdown', data: '' }) } });
  const me = await session(box.env, { email: EMAIL, custom: { tid: A, oid: OID } });
  const res = await me.go('/api/sheet/draft', { method: 'POST', body: 'not-json', headers: { 'content-type': 'application/json' } }, box.env);
  assert.deepEqual({ status: res.status, limits: box.limits() }, { status: 400, limits: 0 });
});

test('privacy delete refuses when the store has no transaction', async () => {
  const lib = new Library(memorySql(), { now: () => STAMP });
  ensureJourney(lib);
  lib.sql.exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', EMAIL, A, '{}', STAMP);
  delete lib.transactionSync;
  await assert.rejects(() => privacyRoutes({ method: 'POST', parts: ['privacy', 'delete'], user: { email: EMAIL, mail: EMAIL, role: 'user', tenant: A, tenantEnforced: true }, lib, env: DELETE_ENV, body: {} }), /atomic/);
  assert.equal(lib.sql.exec('SELECT subject FROM journey WHERE subject = ? AND tenant = ?', EMAIL, A).toArray().length, 1);
});

test('subject erasure scrubs a copy that holds only the mail address', () => {
  const lib = new Library(memorySql(), { now: () => STAMP });
  profile.ensure(lib);
  ensureOutreach(lib);
  const mixed = 'Ada.Mail@Example.Test';
  const longer = MAIL + '.au';
  for (const tenant of [A, B]) {
    lib.sql.exec('INSERT INTO refs (id, owner, title, status, revision, data, state, tenant, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'story-' + tenant.slice(0, 4), 'kim@example.test', 'Kim', 'draft', 1, '{}', '{}', tenant, STAMP, STAMP);
    lib.log('story-' + tenant.slice(0, 4), 'kim@example.test', 'interview invitation', 'manual for ' + mixed);
    lib.sql.exec('INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'kim@example.test', tenant, 'kim@example.test', JSON.stringify({ managerEmail: { value: mixed, at: STAMP } }), '{}', '{}', STAMP, STAMP, STAMP);
    lib.sql.exec('INSERT INTO directory_imports (batch, tenant, source, by, started_at, finished_at, rows, rejected, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'batch-' + tenant.slice(0, 4), tenant, 'csv', mixed, STAMP, STAMP, 1, 0, 'applied');
    lib.sql.exec('INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, payload, created_at, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'out-' + tenant.slice(0, 4), 'gap_request', 'subj-' + tenant.slice(0, 4), 'email_draft', 'kim@example.test', 'pending_approval', JSON.stringify({ note: 'please ask ' + mixed }), STAMP, tenant);
  }
  lib.sql.exec('INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'sam@example.test', A, 'sam@example.test', JSON.stringify({ managerEmail: { value: longer, at: STAMP } }), '{}', '{}', STAMP, STAMP, STAMP);
  eraseMine(lib, { email: EMAIL, mail: MAIL, role: 'user', tenant: A, tenantEnforced: true, subj: 'ab'.repeat(16) }, 'ab'.repeat(16));
  const hasMail = value => String(value || '').toLowerCase().includes(MAIL);
  const auditA = lib.sql.exec('SELECT actor, detail FROM audit WHERE id = ?', 'story-abcd').toArray()[0];
  assert.equal(hasMail(JSON.stringify(auditA)), false);
  assert.equal(lib.sql.exec('SELECT detail FROM audit WHERE id = ?', 'story-bbbb').toArray()[0].detail, 'manual for ' + mixed);
  const kimA = JSON.parse(lib.sql.exec('SELECT edits FROM profiles WHERE subject = ? AND tenant = ?', 'kim@example.test', A).toArray()[0].edits);
  const kimB = JSON.parse(lib.sql.exec('SELECT edits FROM profiles WHERE subject = ? AND tenant = ?', 'kim@example.test', B).toArray()[0].edits);
  const samA = JSON.parse(lib.sql.exec('SELECT edits FROM profiles WHERE subject = ? AND tenant = ?', 'sam@example.test', A).toArray()[0].edits);
  assert.equal(hasMail(kimA.managerEmail.value), false);
  assert.equal(kimB.managerEmail.value, mixed);
  assert.equal(samA.managerEmail.value, longer);
  assert.equal(lib.sql.exec('SELECT by FROM directory_imports WHERE tenant = ?', A).toArray()[0].by.toLowerCase() === MAIL, false);
  assert.equal(lib.sql.exec('SELECT by FROM directory_imports WHERE tenant = ?', B).toArray()[0].by, mixed);
  const outA = lib.sql.exec('SELECT payload FROM outreach WHERE tenant = ?', A).toArray()[0];
  const outB = lib.sql.exec('SELECT payload FROM outreach WHERE tenant = ?', B).toArray()[0];
  assert.equal(hasMail(outA.payload), false);
  assert.equal(outB.payload.includes(mixed), true);
});
