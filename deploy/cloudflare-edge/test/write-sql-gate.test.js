// Schema accepts any CREATE, DROP, or ALTER. Housekeeping matches a prefix.
// The driver used to stop at the first semicolon, so a second statement was invisible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { ensure as ensureOutreach } from '../src/outreach.js';
import { ensure as ensurePrivacy } from '../src/privacy.js';
import { MIGRATIONS } from '../src/library.js';
import { splitStatements, sqlShape } from '../src/sql-text.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
const REF = () => ({
  title: 'Claims triage alias', stage: 'Production', sector: 'Insurance',
  consultant: { name: 'Ada', role: 'Data engineer' },
  client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', start: '2024-03', end: '2024-11', teamSize: 6, teamRoles: ['Data engineer'], technologies: ['Python'], deliverables: ['Routing model'], serviceLines: ['Data & AI'], consultants: [], links: [] },
  answers: ['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.', 'I designed and built the routing model and ran the pilot with two teams.',
    'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.', 'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
    'Operations dashboard export v3, before and after quarters.', 'Any insurer or service desk with manual routing and a measurable queue would benefit.'],
  validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: false },
});

function open() {
  return new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
}
function tableExists(lib, name) {
  return lib.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length === 1;
}

test('registered migrations do not target audit', () => {
  for (const [name, sql] of Object.entries(MIGRATIONS)) {
    assert.equal(splitStatements(sql).length, 1, name);
    const shape = sqlShape(sql);
    assert.doesNotMatch(shape, /\baudit\b/, name);
    assert.doesNotMatch(shape, /\bas select\b/, name);
  }
});

test('a trigger body is one statement, and a semicolon in a string is not a split', () => {
  const trigger = "CREATE TRIGGER IF NOT EXISTS consent_receipts_no_update BEFORE UPDATE ON consent_receipts BEGIN SELECT RAISE(ABORT, 'consent receipts are append-only'); END";
  assert.equal(splitStatements(trigger).length, 1);
  assert.equal(splitStatements("INSERT INTO t (note) VALUES ('a;b')").length, 1);
  assert.equal(splitStatements('SELECT 1; DELETE FROM refs').length, 2);
});

test('the memory driver runs a second statement', () => {
  const sql = memorySql();
  sql.exec('CREATE TABLE probe (id INTEGER)');
  sql.exec('INSERT INTO probe (id) VALUES (1)');
  sql.exec('SELECT 1; DELETE FROM probe');
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM probe').toArray()[0].n, 0);
});

test('a second statement is caught', async () => {
  const lib = open();
  await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  assert.throws(() => lib.exec('SELECT 1; DELETE FROM refs'), err => err.code === 'SQL_MULTI');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
});

test('SELECT 1; DELETE does not run the delete', async () => {
  const lib = open();
  await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  assert.throws(() => lib.exec('SELECT 1; DELETE FROM refs'), err => err.code === 'SQL_MULTI');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
});

test('schema refuses DROP TABLE audit', () => {
  const lib = open();
  assert.throws(() => lib.schema(() => lib.exec('DROP TABLE audit')), err => err.code === 'SCHEMA_DML');
  assert.equal(tableExists(lib, 'audit'), true);
});

test('schema refuses DROP TABLE audit_anchor', () => {
  const lib = open();
  assert.equal(tableExists(lib, 'audit_anchor'), true);
  assert.throws(() => lib.schema(() => lib.exec('DROP TABLE audit_anchor')), err => err.code === 'SCHEMA_DML');
  assert.equal(tableExists(lib, 'audit_anchor'), true);
});

test('schema refuses ALTER TABLE audit DROP COLUMN hash', () => {
  const lib = open();
  assert.throws(() => lib.schema(() => lib.exec('ALTER TABLE audit DROP COLUMN hash')), err => err.code === 'SCHEMA_DML');
  assert.ok(lib.rows("SELECT name FROM pragma_table_info('audit')").some(row => row.name === 'hash'));
});

test('schema refuses CREATE TABLE audit_copy AS SELECT', () => {
  const lib = open();
  assert.throws(() => lib.schema(() => lib.exec('CREATE TABLE audit_copy AS SELECT * FROM audit')), err => err.code === 'SCHEMA_DML');
  assert.equal(tableExists(lib, 'audit_copy'), false);
});

test('schema refuses a trigger that side-writes', async () => {
  const lib = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  lib.schema(() => lib.exec('CREATE TABLE IF NOT EXISTS teams_seen (activity_id TEXT PRIMARY KEY, at TEXT)'));
  assert.throws(() => lib.schema(() => lib.exec("CREATE TRIGGER leak AFTER UPDATE ON refs BEGIN INSERT INTO teams_seen (activity_id, at) VALUES ('leak', 'x'); END")), err => err.code === 'SCHEMA_DML');
  lib.recorded(() => lib.exec('UPDATE refs SET title = ? WHERE id = ?', 'renamed', saved.id));
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM teams_seen WHERE activity_id = 'leak'")[0].n, 0);
});

test('housekeeping refuses a prefix with an extra OR', () => {
  const lib = open();
  ensureOutreach(lib);
  lib.recorded(() => lib.exec("INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, reason, payload, created_at) VALUES ('o1', 'interview_invite', 's', 'email', 'ada@example.test', 'drafted', '', '', '2020-01-01')"));
  assert.throws(
    () => lib.housekeeping('retention', () => lib.exec('DELETE FROM outreach WHERE id=1 OR id=id')),
    err => err.code === 'HOUSEKEEPING_SQL',
  );
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM outreach')[0].n, 1);
});

test('a create followed by DROP TABLE audit is caught', () => {
  const lib = open();
  assert.throws(() => lib.schema(() => lib.exec('CREATE TABLE t(id INTEGER); DROP TABLE audit')), err => err.code === 'SQL_MULTI');
  assert.equal(tableExists(lib, 'audit'), true);
  assert.equal(tableExists(lib, 't'), false);
});

test('an insert followed by an update is caught', async () => {
  const lib = open();
  ensurePrivacy(lib);
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  const title = lib.rows('SELECT title FROM refs WHERE id = ?', saved.id)[0].title;
  const statement = "INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES ('r1', 'cdcdcdcdcdcdcdcd', 'memory', 1, 'n', 'h', '2026-11-17T05:00:00.000Z', 'api'); UPDATE refs SET title = 'stolen' WHERE id = '" + saved.id + "'";
  assert.throws(() => lib.recorded(() => lib.exec(statement)), err => err.code === 'SQL_MULTI');
  assert.equal(lib.rows('SELECT title FROM refs WHERE id = ?', saved.id)[0].title, title);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts')[0].n, 0);
});
