// A tampered, truncated, or unkeyed chain must not leave a business write behind.
// The audit append is what refuses. The reference, the revision, and the Teams rows roll back with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Library } from '../src/library.js';
import { verifyDaily } from '../src/audit-chain.js';
import { eraseMine } from '../src/subject-rights.js';
import * as outreach from '../src/outreach.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T04:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OWNER = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true, subj: 'ab'.repeat(16) };
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
  return { sql, lib };
}
function n(lib, table, where = '', ...p) {
  if (!lib.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray()[0]) return 0;
  return lib.sql.exec(`SELECT COUNT(*) AS n FROM ${table}${where ? ' WHERE ' + where : ''}`, ...p).toArray()[0].n;
}
async function seeded() {
  const box = open();
  const row = await box.lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  return { ...box, id: row.id };
}
function tamper(lib) {
  lib.sql.exec("UPDATE audit SET detail = detail || ' tampered' WHERE action != 'chain-start'");
}
function truncate(lib) {
  const daily = verifyDaily(lib.sql, SALT, lib.dbId);
  assert.equal(daily.reason, 'CHAIN_VERIFIED');
  lib.sql.exec('DELETE FROM audit WHERE seq = (SELECT MAX(seq) FROM audit)');
}
function unkey(lib) { lib.auditKey = null; }
function snap(lib, id) {
  const row = lib.row(id);
  return { revision: row.revision, status: row.status, title: row.data.title, refs: n(lib, 'refs'), revisions: n(lib, 'revisions', 'id = ?', id), audit: n(lib, 'audit'), erasure: n(lib, 'erasure_log') };
}
async function install(lib, activityId) {
  return outreach.system({
    lib, user: { email: 'teams-bot', role: 'system', tenant: '', tenantEnforced: false },
    body: { kind: 'install', activityId, tenantId: TENANT, aadObjectId: OID, serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'a:conv', teamsUserId: '29:ada', email: '' },
  });
}
function teamsRows(lib) {
  return { seen: n(lib, 'teams_seen'), conversations: n(lib, 'teams_conversations') };
}

for (const [name, breakChain, status] of [['tampered', tamper, 409], ['truncated', truncate, 409], ['null key', unkey, 503]]) {
  test(`a ${name} chain refuses save, revise, withdraw, erase and a Teams install with no business change`, async () => {
    const { lib, id } = await seeded();
    const before = snap(lib, id);
    breakChain(lib);
    const afterBreak = snap(lib, id);
    await assert.rejects(() => lib.upsert(OWNER, { localId: 'p2', reference: REF() }), err => err.status === status);
    await assert.rejects(() => lib.upsert(OWNER, { id, localId: 'p1', reference: { ...REF(), title: 'Claims triage revised' } }), err => err.status === status);
    assert.throws(() => lib.withdraw(OWNER, id, { note: 'stop' }), err => err.status === status);
    assert.throws(() => eraseMine(lib, OWNER, OWNER.subj), err => err.status === status);
    await assert.rejects(() => install(lib, 'act-' + name), err => err.status === status);
    assert.deepEqual(snap(lib, id), { ...afterBreak, erasure: before.erasure });
    assert.equal(afterBreak.revision, before.revision);
    assert.deepEqual(teamsRows(lib), { seen: 0, conversations: 0 });
  });
}

test('a clean chain writes the reference and its audit line together', async () => {
  const { lib } = open();
  const row = await lib.upsert(OWNER, { localId: 'p1', reference: REF() });
  assert.equal(row.revision, 1);
  assert.equal(n(lib, 'audit', "id = ? AND action = 'created'", row.id), 1);
  const revised = await lib.upsert(OWNER, { id: row.id, localId: 'p1', reference: { ...REF(), title: 'Claims triage revised' } });
  assert.equal(revised.revision, 2);
  assert.equal(lib.row(row.id).data.title, 'Claims triage revised');
  assert.equal(n(lib, 'audit', "id = ? AND action = 'revised'", row.id), 1);
  lib.withdraw(OWNER, row.id, { note: 'pause' });
  assert.equal(lib.row(row.id).status, 'withdrawn');
  assert.equal(n(lib, 'audit', "id = ? AND action = 'withdrawn'", row.id), 1);
  const teams = await install(lib, 'act-clean');
  assert.equal(teams.body.ok, true);
  assert.deepEqual(teamsRows(lib), { seen: 1, conversations: 1 });
  assert.equal(n(lib, 'audit', "action = 'teams install'"), 1);
});

test('the served page meta has no header-only CSP directives and the header still does', async () => {
  const { htmlCspHeaders } = await import('../src/csp.js');
  const { PAGE_SCRIPT_HASHES } = await import('../src/csp.generated.js');
  const page = readFileSync(new URL('../../../ATLAS_Voice.html', import.meta.url), 'utf8');
  const meta = /<meta content="([^"]*)" http-equiv="Content-Security-Policy"/.exec(page)[1];
  for (const name of ['frame-ancestors', 'report-uri', 'report-to']) assert.equal(meta.includes(name), false, name);
  const header = htmlCspHeaders({}, { hashes: PAGE_SCRIPT_HASHES, connect: 'wss://atlas.example.workers.dev', scriptBlob: true, workerBlob: true, mediaBlob: true })['Content-Security-Policy'];
  for (const name of ['frame-ancestors', 'report-uri', 'report-to']) assert.equal(header.includes(name), true, name);
});

test('local-edge passes a named dev-only audit salt and production still uses auditKey(env)', () => {
  const edge = readFileSync(new URL('../dev/local-edge.mjs', import.meta.url), 'utf8');
  const named = /export const DEV_AUDIT_SALT = '([^']+)'/.exec(edge);
  assert.ok(named && named[1].length > 8 && !named[1].includes('synthetic'));
  assert.match(edge, /new Library\([\s\S]*auditKey:\s*DEV_AUDIT_SALT/);
  assert.doesNotMatch(edge, /auditKey\(env\)/);
  const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /auditKey:\s*auditKey\(env\)/);
  const library = readFileSync(new URL('../src/library.js', import.meta.url), 'utf8');
  assert.match(library, /if \(auditKey == null\) throw/);
});
