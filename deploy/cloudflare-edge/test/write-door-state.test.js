// The door flags are ordinary fields. A callback can set them and the write commits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { anchoredVerdict, verifyChain } from '../src/audit-chain.js';
import { memorySql } from './sqlite.js';

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
function tamper(lib) {
  sqlOf(lib).exec("UPDATE audit SET detail = detail || ' tampered' WHERE action != 'chain-start'");
}

test('a callback cannot update a tampered chain by resetting the receipt flag', async () => {
  const lib = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  const title = lib.rows('SELECT title FROM refs WHERE id = ?', saved.id)[0].title;
  tamper(lib);
  assert.throws(() => lib.recorded(() => {
    lib.exec('UPDATE refs SET title = ? WHERE id = ?', 'stolen', saved.id);
    lib._receiptOnly = true;
  }), err => err.status === 409 && err.code === 'CHAIN_DAMAGED');
  assert.equal(lib.rows('SELECT title FROM refs WHERE id = ?', saved.id)[0].title, title);
});

test('an insert through exec with no door open is refused', () => {
  const lib = open();
  lib.schema(() => lib.exec('CREATE TABLE teams_seen (activity_id TEXT PRIMARY KEY, at TEXT)'));
  lib._door = 1;
  assert.throws(
    () => lib.exec("INSERT INTO teams_seen (activity_id, at) VALUES ('sneak', '2026-11-17T05:00:00.000Z')"),
    err => err.status === 500 && err.code === 'SQL_DOOR',
  );
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM teams_seen')[0].n, 0);
});

test('a log line cannot be appended off the anchor by setting the transaction flag', () => {
  const lib = open();
  lib.schema(() => {
    lib._auditTx = 1;
    lib.log('library', 'ada@example.test', 'sneak', 'off anchor');
  });
  sqlOf(lib).exec("DELETE FROM audit WHERE action = 'sneak'");
  const after = anchoredVerdict(sqlOf(lib), verifyChain(sqlOf(lib), SALT, lib.dbId));
  assert.equal(after.ok, false);
});

test('setting the door fields cannot delete rows with no audit line', async () => {
  const lib = open();
  await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  lib._door = 1;
  lib._doorKind = 'recorded';
  assert.throws(() => lib.exec('DELETE FROM refs'), err => err.status === 500 && err.code === 'SQL_DOOR');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before);
});
