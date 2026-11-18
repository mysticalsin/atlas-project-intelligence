// Red until nextGen, lastJev, gap expiry, saveJourney, and recordReceipts
// share the recorded transaction with an audit line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { ensure as ensureGaps, expire as expireGaps } from '../src/gaps.js';
import { saveJourney } from '../src/journey.js';
import { recordReceipts } from '../src/privacy.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'ab'.repeat(16);
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
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP, auditKey: SALT });
  return { lib };
}
function tamper(lib) {
  lib.sql.exec("UPDATE audit SET detail = detail || ' tampered' WHERE action != 'chain-start'");
}
function audited(lib, action) {
  return lib.rows('SELECT action FROM audit WHERE action = ?', action).length;
}

test('nextGen on a tampered chain does not move the generation', async () => {
  const { lib } = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  const before = Number(lib.columnState(saved.id)?.ratingGen) || 0;
  tamper(lib);
  assert.throws(() => lib.nextGen(saved.id), err => err.status === 409);
  assert.equal(Number(lib.columnState(saved.id)?.ratingGen) || 0, before);
});

test('nextGen writes an audit line', async () => {
  const { lib } = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  lib.nextGen(saved.id);
  assert.equal(audited(lib, 'rating generation'), 1);
});

test('a superseded rating keeps lastJev only with an audit line, and a tampered chain keeps neither', async () => {
  const { lib } = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  lib.nextGen(saved.id);
  const row = lib.row(saved.id);
  tamper(lib);
  assert.throws(() => lib.storeRating(row, 0, {}, OWNER.email, { bodyHash: 'abc' }), err => err.status === 409);
  assert.equal(lib.columnState(saved.id)?.lastJev, undefined);
});

test('lastJev on a clean chain is audited', async () => {
  const { lib } = open();
  const saved = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  lib.nextGen(saved.id);
  const row = lib.row(saved.id);
  assert.equal(lib.storeRating(row, 0, {}, OWNER.email, { bodyHash: 'abc' }), false);
  assert.equal(lib.columnState(saved.id).lastJev.bodyHash, 'abc');
  assert.equal(audited(lib, 'rating kept'), 1);
});

test('gap expiry on a tampered chain leaves the request open', async () => {
  const { lib } = open();
  await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  ensureGaps(lib);
  lib.sql.exec("INSERT INTO gap_requests (id, bid_id, status, created_at, tenant) VALUES ('g1', 'b1', 'open', '2020-01-01T00:00:00.000Z', '')");
  tamper(lib);
  assert.throws(() => expireGaps(lib, STAMP, {}), err => err.status === 409);
  assert.equal(lib.rows("SELECT status FROM gap_requests WHERE id = 'g1'")[0].status, 'open');
});

test('gap expiry writes an audit line', async () => {
  const { lib } = open();
  await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  ensureGaps(lib);
  lib.sql.exec("INSERT INTO gap_requests (id, bid_id, status, created_at, tenant) VALUES ('g1', 'b1', 'open', '2020-01-01T00:00:00.000Z', '')");
  assert.equal(expireGaps(lib, STAMP, {}), 1);
  assert.equal(lib.rows("SELECT status FROM gap_requests WHERE id = 'g1'")[0].status, 'expired');
  assert.equal(audited(lib, 'requests expired'), 1);
});

test('saveJourney on a tampered chain leaves no journey row', async () => {
  const { lib } = open();
  await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  tamper(lib);
  await assert.rejects(() => saveJourney(lib, OWNER, { fields: { title: { value: 'Queue', source: 'you', confirmed: true } } }), err => err.status === 409);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM journey').length ? lib.rows('SELECT COUNT(*) AS n FROM journey')[0].n : 0, 0);
});

test('saveJourney writes an audit line', async () => {
  const { lib } = open();
  await saveJourney(lib, OWNER, { fields: { title: { value: 'Queue', source: 'you', confirmed: true } } });
  assert.equal(audited(lib, 'journey saved'), 1);
});

test('a consent receipt on a tampered chain is not stored', () => {
  const { lib } = open();
  return lib.upsert(OWNER, { localId: 'p1', reference: REF() }).then(async () => {
    tamper(lib);
    assert.throws(() => recordReceipts(lib, SUBJECT, [{ purpose: 'transcription', granted: true }]), err => err.status === 409);
    assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts')[0].n, 0);
  });
});

test('a consent receipt writes an audit line', () => {
  const { lib } = open();
  const saved = recordReceipts(lib, SUBJECT, [{ purpose: 'transcription', granted: true }]);
  assert.equal(saved.recorded.length, 1);
  assert.equal(audited(lib, 'consent receipt'), 1);
});
