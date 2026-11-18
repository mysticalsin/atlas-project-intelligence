// Each growing IN list must stay at or under 100 bound parameters. These tests call the
// current statements with a list that exceeds that cap, then require the whole write to roll back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER_ALLOW, lintDir } from './write-lint.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { deleteOwnedProfile, directoryRows, ensure as ensureProfile } from '../src/profile.js';
import { eraseManagerTrust } from '../src/operate.js';
import { daily as outreachDaily, ensure as ensureOutreach, onTrigger, personAliases } from '../src/outreach.js';
import * as claims from '../src/claims.js';
import { splitSentences } from '../src/snippets.js';

const NOW = '2026-11-08T00:00:00.000Z';
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

// Bounded dynamic placeholder lists. The max is every bound parameter on that statement.
const ALLOW = PLACEHOLDER_ALLOW;

function library() {
  return new Library(memorySql(), { now: () => NOW });
}
function user(email, tenant = TENANT) {
  return { email, mail: email, role: 'user', tenant, tenantEnforced: true };
}
function reference(answers) {
  return {
    title: 'Bound project', stage: 'Pilot', sector: 'Insurance',
    consultant: { name: 'Ada', role: 'Consultant' },
    client: { name: 'Northwind', location: 'Lyon', contact: 'Ops' },
    details: { projectId: 'PRJ-BOUND', country: 'France', consultants: [{ name: 'Jo', email: 'jo@example.test', role: 'PO' }] },
    answers: answers || ['The client had a slow queue.', 'I rebuilt the routing step.', 'We kept a manual fallback.', 'The queue was shorter on the team dashboard.', 'Dashboard export v1.', 'Similar service desks.'],
  };
}
function insertProfile(l, subject, tenant, email) {
  l.sql.exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
    VALUES (?, ?, ?, '{}', '{}', '{}', ?, ?, ?)`, subject, tenant, email, NOW, NOW, NOW);
}
function padProfiles(l, subject, tenant, extra) {
  ensureProfile(l);
  for (let i = 0; i < extra; i++) insertProfile(l, ' '.repeat(i + 1) + subject, tenant, `alias-${i}@example.test`);
}
function chainProfiles(l, start, tenant, extra) {
  ensureProfile(l);
  let prev = start;
  for (let i = 0; i < extra; i++) {
    const next = `alias-${i}@example.test`;
    insertProfile(l, prev, tenant, next);
    prev = next;
  }
}
function trust(l, owner, email, tenant, source = 'directory') {
  l.sql.exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', owner, email, source, tenant, NOW);
}
function count(l, table) {
  return l.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;
}
async function story(l, email, answers) {
  const saved = await l.upsert(user(email), { localId: 'bound-' + email, reference: reference(answers) });
  return l.row(saved.id);
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

test('a manager-trust erasure of 50 aliases deletes every matching row and keeps the others', () => {
  const l = library();
  const aliases = Array.from({ length: 50 }, (_, i) => `alias-${i}@example.test`);
  for (const alias of aliases) trust(l, alias, 'mgr@example.test', TENANT);
  trust(l, 'other@example.test', 'mgr@example.test', TENANT);
  trust(l, aliases[0], 'mgr@example.test', OTHER);
  assert.equal(eraseManagerTrust(l, TENANT, aliases), 50);
  assert.deepEqual(l.rows('SELECT owner, tenant FROM manager_trust ORDER BY tenant, owner').map(row => [row.owner, row.tenant]), [
    [aliases[0], OTHER],
    ['other@example.test', TENANT],
  ]);
});

test('a later manager-trust delete chunk rolls the whole erasure back', () => {
  const l = library();
  const aliases = Array.from({ length: 50 }, (_, i) => `alias-${i}@example.test`);
  for (let i = 0; i < 101; i++) trust(l, aliases[i % aliases.length], `mgr-${i}@example.test`, TENANT);
  trust(l, 'other@example.test', 'kept@example.test', TENANT);
  const orig = l.sql.exec.bind(l.sql);
  l.sql.exec = (q, ...p) => {
    if (String(q).startsWith('DELETE FROM manager_trust') && p.length === 1) throw new Error('disk');
    return orig(q, ...p);
  };
  assert.throws(() => eraseManagerTrust(l, TENANT, aliases), /disk/);
  assert.equal(count(l, 'manager_trust'), 102);
});

test('profile erasure deletes more than 100 folded rows and the collapsed notes', () => {
  const l = library();
  ensureProfile(l);
  for (let i = 0; i < 101; i++) insertProfile(l, ' '.repeat(i) + 'ada@example.test', TENANT, 'ada@example.test');
  insertProfile(l, 'other@example.test', TENANT, 'other@example.test');
  for (let i = 0; i < 101; i++) l.sql.exec("INSERT INTO profile_collapsed (id, subject, tenant, reason) VALUES (?, 'ada@example.test', ?, 'duplicate')", i + 1, TENANT);
  l.sql.exec("INSERT INTO profile_collapsed (id, subject, tenant, reason) VALUES (1000, 'other@example.test', ?, 'duplicate')", TENANT);
  assert.equal(deleteOwnedProfile(l, user('ada@example.test')), 101);
  assert.deepEqual(l.rows('SELECT subject FROM profiles').map(row => row.subject), ['other@example.test']);
  assert.deepEqual(l.rows('SELECT subject FROM profile_collapsed').map(row => row.subject), ['other@example.test']);
});

test('a later profile delete chunk rolls back both the profiles and the collapsed notes', () => {
  const l = library();
  ensureProfile(l);
  for (let i = 0; i < 101; i++) insertProfile(l, ' '.repeat(i) + 'ada@example.test', TENANT, 'ada@example.test');
  for (let i = 0; i < 101; i++) l.sql.exec("INSERT INTO profile_collapsed (id, subject, tenant, reason) VALUES (?, 'ada@example.test', ?, 'duplicate')", i + 1, TENANT);
  const orig = l.sql.exec.bind(l.sql);
  l.sql.exec = (q, ...p) => {
    if (String(q).startsWith('DELETE FROM profiles') && p.length === 1) throw new Error('disk');
    return orig(q, ...p);
  };
  assert.throws(() => deleteOwnedProfile(l, user('ada@example.test')), /disk/);
  assert.equal(count(l, 'profiles'), 101);
  assert.equal(count(l, 'profile_collapsed'), 101);
});

test('a directory read of 100 keys returns every row in the tenant', () => {
  const l = library();
  ensureProfile(l);
  const keys = Array.from({ length: 100 }, (_, i) => `k${i}@example.test`);
  for (const key of keys) {
    l.sql.exec(`INSERT INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant)
      VALUES (?, 'dna', ?, '', '', '', '', 'pull', ?, ?)`, key, key, NOW, TENANT);
  }
  l.sql.exec(`INSERT INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant)
    VALUES (?, 'dna', 'Foreign', '', '', '', '', 'pull', ?, ?)`, keys[0], NOW, OTHER);
  l.sql.exec(`INSERT INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant)
    VALUES (?, 'staged:batch', 'Staged', '', '', '', '', 'staged', ?, ?)`, keys[0], NOW, TENANT);
  const names = directoryRows(l, keys, TENANT).map(row => row.name).sort();
  assert.equal(names.length, 100);
  assert.equal(names.includes('Foreign'), false);
  assert.equal(names.includes('Staged'), false);
});

test('manager approval still sees a directory grant when the owner has 100 keys', async () => {
  const l = library();
  const row = await story(l, 'ada@example.test');
  padProfiles(l, 'ada@example.test', TENANT, 99);
  assert.equal(l.ownerKeys(row).length, 100);
  l.bindTrust({ email: 'directory', role: 'system', tenant: TENANT, tenantEnforced: true }, { owner: 'ada@example.test', email: 'sam@example.test', source: 'directory', tenant: TENANT, tenantEnforced: true });
  assert.equal(l.canManagerApprove(row, user('sam@example.test')), true);
});

test('manager approval still sees one staffing row when the owner has 100 keys', async () => {
  const l = library();
  const row = await story(l, 'ada@example.test');
  padProfiles(l, 'ada@example.test', TENANT, 99);
  ensureOutreach(l);
  trust(l, 'ada@example.test', 'sam@example.test', TENANT, 'staffing');
  l.sql.exec(`INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at, tenant)
    VALUES ('PRJ-BOUND', 'ada@example.test', 'sam@example.test', 'Sam', 'Bound', '', 'staffing', ?, ?)`, NOW, TENANT);
  assert.equal(l.canManagerApprove(row, user('sam@example.test')), true);
});

test('a staffing update with 100 linked aliases removes the stale grant', () => {
  const l = library();
  chainProfiles(l, 'ada@example.test', TENANT, 99);
  assert.equal(personAliases(l, 'ada@example.test', TENANT).length, 100);
  ensureOutreach(l);
  trust(l, 'ada@example.test', 'old@example.test', TENANT, 'staffing');
  trust(l, 'stranger@example.test', 'old@example.test', TENANT, 'staffing');
  const caller = user('ada@example.test');
  onTrigger(l, caller, { projectId: 'PRJ-BOUND', email: 'ada@example.test', managerEmail: 'sam@example.test', title: 'Bound', endDate: '2026-11-08' }, caller);
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM manager_trust WHERE lower(owner) = 'ada@example.test' AND lower(email) = 'old@example.test'")[0].n, 0);
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM manager_trust WHERE lower(owner) = 'ada@example.test' AND lower(email) = 'sam@example.test'")[0].n, 1);
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM manager_trust WHERE lower(owner) = 'stranger@example.test'")[0].n, 1);
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM staffing WHERE lower(consultant_email) = 'ada@example.test'")[0].n, 1);
});

test('a due staffing row with 98 linked owners still invites the consultant', () => {
  const l = library();
  chainProfiles(l, 'ada@example.test', TENANT, 97);
  assert.equal(personAliases(l, 'ada@example.test', TENANT).length, 98);
  ensureOutreach(l);
  l.sql.exec(`INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at, tenant)
    VALUES ('PRJ-DUE', 'ada@example.test', 'sam@example.test', 'Sam', 'Due', '2026-11-08', 'staffing', ?, ?)`, NOW, TENANT);
  const result = outreachDaily(l, user('atlas-cron'));
  assert.equal(result.staffingInvited, 1);
  assert.equal(l.rows("SELECT email FROM invitations").map(row => row.email).includes('ada@example.test'), true);
});

test('asking a manager still reads staffing when the owner has 100 keys', async () => {
  const l = library();
  const row = await story(l, 'ada@example.test');
  padProfiles(l, 'ada@example.test', TENANT, 99);
  assert.equal(l.ownerKeys(row).length, 100);
  ensureOutreach(l);
  claims.ensure(l);
  l.sql.exec(`INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at, tenant)
    VALUES ('PRJ-BOUND', 'ada@example.test', 'sam@example.test', 'Sam', 'Bound', '', 'staffing', ?, ?)`, NOW, TENANT);
  const text = 'I rebuilt the routing step.';
  l.sql.exec(`INSERT INTO claims (id, ref_id, revision, topic, idx, text, sentence_hash, status, created_by, created_at)
    VALUES ('c1', ?, 1, 1, 0, ?, ?, 'unverified', 'ada@example.test', ?)`, row.id, text, await sha256('1\n' + text), NOW);
  const result = await claims.routes({ method: 'POST', parts: ['confirmations'], user: user('ada@example.test'), lib: l, body: { refId: row.id, claimIds: ['c1'], kind: 'manager' }, env: { ORIGIN: 'https://atlas.test' }, url: new URL('https://atlas.test/api/library/confirmations') });
  assert.equal(result.status, 201);
  assert.equal(result.body.request.toEmail, 'sam@example.test');
});

test('an inbox request with 100 claims still returns every claim', async () => {
  const l = library();
  const answers = ['The client had a slow queue.', '', '', '', '', ''];
  for (const topic of [1, 2, 3, 4]) {
    const list = Array.from({ length: 25 }, (_, i) => `Topic ${topic} point ${String(i).padStart(2, '0')} stands.`);
    answers[topic] = list.join(' ');
  }
  const row = await story(l, 'ada@example.test', answers);
  const built = [];
  for (const topic of [1, 2, 3, 4]) splitSentences(row.data.answers[topic]).forEach((text, idx) => built.push({ topic, idx, text }));
  assert.equal(built.length, 100);
  claims.ensure(l);
  const ids = [];
  for (const claim of built) {
    const id = `c-${claim.topic}-${claim.idx}`;
    ids.push(id);
    l.sql.exec(`INSERT INTO claims (id, ref_id, revision, topic, idx, text, sentence_hash, status, created_by, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, 'unverified', 'ada@example.test', ?)`, id, row.id, claim.topic, claim.idx, claim.text, await sha256(`${claim.topic}\n${claim.text}`), NOW);
  }
  l.sql.exec(`INSERT INTO confirmation_requests (id, ref_id, revision, kind, to_email, manager_source, claim_ids, status, created_by, created_by_mail, created_at, expires_at, tenant)
    VALUES ('req-bound', ?, 1, 'manager', 'sam@example.test', 'directory', ?, 'open', 'ada@example.test', 'ada@example.test', ?, '2026-12-01T00:00:00.000Z', ?)`, row.id, JSON.stringify(ids), NOW, TENANT);
  const result = await claims.routes({ method: 'GET', parts: ['confirmations', 'inbox'], user: user('sam@example.test'), lib: l, url: new URL('https://atlas.test/api/library/confirmations/inbox') });
  assert.equal(result.body.items.length, 1);
  assert.equal(result.body.items[0].claims.length, 100);
});

test('dynamic placeholder lists stay in the chunk helper or on the bounded allowlist', () => {
  const { helper, rest } = lintDir(SRC);
  assert.equal(helper.length, 1, 'the chunk helper builds placeholders in one place');
  assert.deepEqual(rest.map(item => `${item.file}:${item.max}`).sort(), ALLOW.map(item => `${item.file}:${item.max}`).sort());
  for (const item of rest) {
    const allowed = ALLOW.find(entry => entry.file === item.file && entry.max === item.max);
    assert.ok(allowed, item.file);
    assert.ok(item.max <= 100, allowed.why);
  }
});
