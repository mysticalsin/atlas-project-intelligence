// Red until a recorded append checkpoints the anchor, and until a consent
// receipt may be stored on a damaged chain without moving that anchor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { anchoredVerdict, verifyChain } from '../src/audit-chain.js';
import { memorySql } from './sqlite.js';
import { recordReceipts } from '../src/privacy.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'cd'.repeat(16);
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
  const lib = new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
  return { lib };
}
function tamper(lib) {
  lib.sql.exec("UPDATE audit SET detail = detail || ' tampered' WHERE action != 'chain-start'");
}
function anchor(lib) {
  const row = lib.sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0];
  assert.ok(row, 'a recorded write leaves an anchor');
  return { n: Number(row.n), head: row.head };
}

test('a recorded write checkpoints the chain, so a tail delete no longer verifies', async () => {
  const { lib } = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  const verdict = anchoredVerdict(lib.sql, verifyChain(lib.sql, SALT, lib.dbId));
  const row = anchor(lib);
  assert.equal(verdict.ok, true);
  assert.equal(row.n, verdict.checked);
  assert.equal(row.head, verdict.head);
  lib.sql.exec('DELETE FROM audit WHERE seq = (SELECT MAX(seq) FROM audit)');
  const after = anchoredVerdict(lib.sql, verifyChain(lib.sql, SALT, lib.dbId));
  assert.equal(after.ok, false);
  assert.throws(() => lib.nextGen(saved.id), err => err.status === 409);
  assert.equal(Number(lib.columnState(saved.id)?.ratingGen) || 0, 0);
});

test('a consent receipt on a clean chain is audited and does not advance the anchor', async () => {
  const { lib } = open();
  await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  const before = anchor(lib);
  const saved = recordReceipts(lib, SUBJECT, [{ purpose: 'transcription', granted: true }]);
  assert.equal(saved.recorded.length, 1);
  assert.equal(lib.rows("SELECT action FROM audit WHERE action = 'consent receipt'").length, 1);
  assert.deepEqual(anchor(lib), before);
});

test('a damaged chain still accepts housekeeping and a consent receipt, and refuses a business write', async () => {
  const { lib } = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  const before = anchor(lib);
  tamper(lib);
  lib.schema(() => lib.exec('CREATE TABLE door_probe (id INTEGER)'));
  lib.housekeeping('probe', () => lib.exec('INSERT INTO door_probe (id) VALUES (7)'));
  assert.equal(lib.rows('SELECT id FROM door_probe')[0].id, 7);
  const receipt = recordReceipts(lib, SUBJECT, [{ purpose: 'memory', granted: true }]);
  assert.equal(receipt.recorded.length, 1);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts')[0].n, 1);
  assert.equal(lib.rows("SELECT action FROM audit WHERE action = 'consent receipt'").length, 0);
  assert.deepEqual(anchor(lib), before);
  assert.throws(() => lib.nextGen(saved.id), err => err.status === 409);
});
