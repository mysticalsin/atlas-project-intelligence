// G2: the retention schedule is executed. Audit gap closed: Art 5(1)(e) storage limitation ("library, revisions, audit, evidence, staffing, outreach, jobs kept indefinitely; expired rows
// never deleted"). The periods are in atlas_voice/config/retention.json (all "PROPOSAL — DPO to confirm"); the daily scan-stale cron runs the sweep; tests use a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as outreach from '../src/outreach.js';
import * as evidence from '../src/evidence.js';
import * as bids from '../src/bids.js';
import * as claims from '../src/claims.js';
import * as gaps from '../src/gaps.js';
import * as privacy from '../src/privacy.js';
import { sweep, notSwept } from '../src/retention.js';
import { RETENTION } from '../src/policy.generated.js';
import { verifyChain } from '../src/audit-chain.js';
import { memorySql } from './sqlite.js';
import { FakeStorage } from './reconnect-harness.js';

const DAY = 864e5, T0 = Date.UTC(2026, 0, 1);
const ALEX = { email: 'alex@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' };
const REF = title => ({ title, stage: 'Production', sector: 'Insurance', consultant: { name: 'Alex', role: 'Data engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: '' },
  details: { projectId: 'PRJ-1', country: 'France', technologies: ['Python'], deliverables: [], serviceLines: ['Data & AI'], consultants: [], links: [] },
  answers: ['Claims bounced between teams.', 'I built the claims routing model.', '', 'Triage fell from 40 to 12 minutes.', '', ''], validation: { manager: { name: '', email: '' }, managerStaff: true } });
function world() {
  const clock = { t: T0 }, l = new Library(memorySql(), { now: () => new Date(clock.t).toISOString(), newId: (() => { let n = 0; return () => 'id' + String(++n).padStart(6, '0'); })() });
  outreach.ensure(l); bids.ensure(l); evidence.ensure(l); claims.ensure(l); gaps.ensure(l); privacy.ensure(l);
  return { l, clock, at: days => { clock.t = T0 + days * DAY; } };
}
const iso = d => new Date(T0 + d * DAY).toISOString();
const NOTES = s => ({ session_id: s, project_ref: 'PRJ-1', details: [{ id: 'D-001', field: 'contribution', item_id: 'u1', quote: 'I built the claims routing model.', status: 'reported', active: true }] });

test('G2 retention config: every period is a proposal for the DPO, the 24 h checkpoint is Tony\'s decision, and what the sweep does not enforce is listed', () => {
  assert.equal(RETENTION.status, 'PROPOSAL — DPO to confirm');
  for (const c of RETENTION.categories) assert.ok(c.status === 'PROPOSAL — DPO to confirm' || c.id === 'checkpoint', c.id);
  assert.deepEqual(RETENTION.categories.find(c => c.id === 'checkpoint'), { ...RETENTION.categories.find(c => c.id === 'checkpoint'), hours: 24, sweep: false });
  assert.deepEqual(notSwept().sort(), ['checkpoint', 'memory', 'security_logs']);
  for (const id of ['drafts', 'withdrawn_refs', 'rejected_evidence', 'audit', 'outreach', 'staffing_imports', 'consent_receipts', 'security_logs']) assert.ok(RETENTION.categories.some(c => c.id === id), id);
});

test('G2 retention: private drafts never submitted are erased after 90 days (reference and evidence draft); fresh drafts and submitted references stay', async () => {
  const { l, at } = world(), ev = evidence.evidence(l);
  const old = await l.upsert(ALEX, { localId: 'old', reference: REF('Old draft'), draft: true }), sub = await l.upsert(ALEX, { localId: 'sub', reference: REF('Submitted old') });
  const evOld = await ev.createDraftFromNotes(ALEX.email, NOTES('s-old'));
  at(100); const fresh = await l.upsert(ALEX, { localId: 'fresh', reference: REF('Fresh draft'), draft: true }); const evFresh = await ev.createDraftFromNotes(ALEX.email, NOTES('s-fresh'));
  at(100.5);
  const r = sweep(l);
  assert.deepEqual([r.draftReferences, r.draftEvidence], [1, 1]);
  assert.equal(l.row(old.id).data.erased, true); assert.equal(l.row(old.id).title, '[erased]'); assert.equal(l.rows('SELECT COUNT(*) AS n FROM revisions WHERE id = ?', old.id)[0].n, 0);
  assert.equal(l.row(fresh.id).data.title, 'Fresh draft'); assert.equal(l.row(sub.id).data.title, 'Submitted old', 'a submitted reference is not a draft');
  assert.equal(l.rows('SELECT statement FROM evidence_claims WHERE entity = ?', evOld.id)[0].statement, '[erased]'); assert.notEqual(l.rows('SELECT statement FROM evidence_claims WHERE entity = ?', evFresh.id)[0].statement, '[erased]');
  assert.deepEqual(sweep(l), {}, 'a second sweep on the same day does nothing');
});

test('G2 retention: withdrawn references are erased 90 days after the withdrawal, unless a bid uses them or the DPO still holds them; rejected evidence after 180 days', async () => {
  const { l, at } = world(), ev = evidence.evidence(l);
  const mk = async (k) => { const s = await l.upsert(ALEX, { localId: k, reference: REF('Ref ' + k) }); return s.id; };
  const a = await mk('a'), b = await mk('b'), c = await mk('c'), d = await mk('d');
  for (const id of [a, c, d]) l.withdraw(ALEX, id, {});
  l.sql.exec("INSERT INTO bid_references (bid_id, ref_id, revision, proof_type, used_at, used_by) VALUES ('b1', ?, 1, 'x', 'x', 'kim')", c);
  const rowD = l.row(d); l.setState(rowD, { ...rowD.state, erasure_pending_review: { reason: 'published_reference', at: iso(0) } }, 'x', 'x', '');
  const rejected = await ev.createDraftFromNotes(ALEX.email, NOTES('s-rej')), recent = await ev.createDraftFromNotes(ALEX.email, NOTES('s-rej2'));
  l.sql.exec("UPDATE evidence_records SET status = 'rejected' WHERE id IN (?, ?)", rejected.id, recent.id);
  at(95); l.withdraw(ALEX, b, {}); // withdrawn only 0 days ago
  l.sql.exec("UPDATE evidence_records SET updated_at = ? WHERE id = ?", iso(80), recent.id);
  let r = sweep(l); assert.equal(r.withdrawnReferences, 1, 'only the old, unused, unheld one'); assert.equal(l.row(a).data.erased, true); for (const id of [b, c, d]) assert.equal(l.row(id).data.erased, undefined, id);
  assert.equal(r.rejectedEvidence, undefined, 'rejected 95 days ago is not yet 180');
  at(185); r = sweep(l);
  assert.equal(r.rejectedEvidence, 1, 'the one last changed 185 days ago; the one changed at day 80 is 105 days old'); assert.equal(l.rows('SELECT statement FROM evidence_claims WHERE entity = ?', rejected.id)[0].statement, '[erased]'); assert.notEqual(l.rows('SELECT statement FROM evidence_claims WHERE entity = ?', recent.id)[0].statement, '[erased]');
});

test('G2 retention: finished outreach and invitations (90 d), expired confirmation and proof requests, staffing rows (180 d after the project end), receipts (6 years after the last one)', async () => {
  const { l, at } = world();
  l.sql.exec("INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, created_at) VALUES ('o-old', 'interview_invite', 's1', 'email', 'a@x', 'sent', ?), ('o-new', 'interview_invite', 's2', 'email', 'b@x', 'drafted', ?)", iso(0), iso(150));
  const inv = (email, status, created) => l.sql.exec('INSERT INTO invitations (id, email, project_id, title, reason, slot, reference_id, status, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'inv-' + email + status, email, 'P', 't', 'manual', '', '', status, created, 'x');
  inv('a@x', 'done', iso(0)); inv('b@x', 'dismissed', iso(0)); inv('c@x', 'open', iso(0)); inv('d@x', 'done', iso(150));
  l.sql.exec("INSERT INTO confirmation_requests (id, ref_id, revision, kind, to_email, claim_ids, status, created_by, created_at, expires_at) VALUES ('c-old', 'r', 1, 'manager', 'm@x', '[]', 'expired', 'u', ?, ?), ('c-new', 'r', 1, 'manager', 'm@x', '[]', 'open', 'u', ?, ?)", iso(0), iso(14), iso(136), iso(150));
  l.sql.exec("INSERT INTO gap_requests (id, bid_id, asks, email, status, created_by, created_at) VALUES ('g-old', 'b', '[]', 'a@x', 'expired', 'u', ?), ('g-open', 'b', '[]', 'a@x', 'open', 'u', ?), ('g-new', 'b', '[]', 'a@x', 'answered', 'u', ?)", iso(0), iso(0), iso(100));
  l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, end_date, source, updated_at) VALUES ('P1', 'a@x', 'm@x', ?, 'csv', ?), ('P2', 'a@x', 'm@x', ?, 'csv', ?), ('P3', 'a@x', 'm@x', '', 'csv', ?), ('P4', 'b@x', 'm@x', '', 'csv', ?)", iso(-10).slice(0, 10), iso(-10), iso(150).slice(0, 10), iso(0), iso(0), iso(190));
  privacy.recordReceipts(l, 'aa'.repeat(16), [{ purpose: 'draft', granted: true }], { now: iso(0) }); privacy.recordReceipts(l, 'bb'.repeat(16), [{ purpose: 'draft', granted: true }], { now: iso(0) }); privacy.recordReceipts(l, 'bb'.repeat(16), [{ purpose: 'draft', granted: false }], { now: iso(2000) });
  at(200); const r = sweep(l);
  assert.equal(r.outreach, 1); assert.equal(l.rows('SELECT id FROM outreach').map(x => x.id).join(), 'o-new');
  assert.equal(r.invitations, 2, 'finished and old only'); assert.deepEqual(l.rows('SELECT id FROM invitations ORDER BY id').map(x => x.id), ['inv-c@xopen', 'inv-d@xdone']);
  assert.equal(r.confirmationRequests, 1); assert.deepEqual(l.rows('SELECT id FROM confirmation_requests').map(x => x.id), ['c-new']);
  assert.equal(r.proofRequests, 1, 'g-old (expired, 200 days old); the open one and the recent answered one stay'); assert.deepEqual(l.rows('SELECT id FROM gap_requests ORDER BY id').map(x => x.id), ['g-new', 'g-open']);
  assert.equal(r.staffingRows, 2, 'P1 ended before the cut-off; P3 has no end date and was imported 200 days ago'); assert.deepEqual(l.rows('SELECT project_id FROM staffing ORDER BY project_id').map(x => x.project_id), ['P2', 'P4']);
  at(2300); const late = sweep(l);
  assert.equal(late.consentReceipts, 1, 'a person whose latest receipt is older than 6 years loses their receipts; the person with a recent one keeps both'); assert.equal(privacy.receiptsOf(l, 'bb'.repeat(16)).length, 2);
  assert.equal(privacy.receiptsOf(l, 'aa'.repeat(16)).length, 0);
});

test('G2 retention: audit rows older than two years are pseudonymised (actor token, detail cleared), system actors and recent rows are kept as they are, the chain is re-sealed and still verifies', async () => {
  const { l, at } = world();
  l.log('r1', 'alex@mantu.com', 'created', 'revision 1'); l.log('r1', 'atlas', 'reviewed', 'score 80, ready'); l.log('r2', 'kim@mantu.com', 'invitation', 'interview for lee@mantu.com');
  at(800); l.log('r1', 'alex@mantu.com', 'revised', 'revision 2'); l.log('r3', 'rev@mantu.com', 'validated', 'fine');
  const before = verifyChain(l.sql), rows = l.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  at(801); const r = sweep(l);
  assert.equal(r.auditRows, 3, 'the two personal rows and the system row whose free text is older than 730 days');
  const all = l.rows('SELECT actor, action, detail, at FROM audit ORDER BY seq');
  assert.equal(all.length, rows, 'rows are never removed');
  assert.ok(all[0].actor.startsWith('erased:') && all[0].detail === '' && all[0].action === 'created', 'the person becomes a token, the action stays');
  assert.equal(all[1].actor, 'atlas'); assert.equal(all[1].detail, '', 'old free text is cleared even for a system actor');
  assert.ok(all[2].actor.startsWith('erased:') && all[2].detail === '');
  assert.deepEqual(all.slice(3).map(x => [x.actor, x.detail]), [['alex@mantu.com', 'revision 2'], ['rev@mantu.com', 'fine']], 'rows younger than two years are untouched');
  assert.notEqual(all[0].actor, all[2].actor, 'a different person, a different token');
  const after = verifyChain(l.sql); assert.equal(after.ok, true); assert.equal(after.checked, rows); assert.notEqual(after.head, before.head); assert.equal(r.auditHead, after.head);
  assert.equal(sweep(l).auditRows, undefined, 'idempotent');
});

test('G2 retention: the sweep is driven by the JSON (a one-day period sweeps what a 90-day one keeps) and returns counts only: no id, no email, no word of content', async () => {
  const { l, at } = world(); await l.upsert(ALEX, { localId: 'd', reference: REF('Very secret title'), draft: true }); l.invite('atlas', { email: 'alex@mantu.com', reason: 'manual', projectId: 'P', title: 'T' });
  l.sql.exec("INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, created_at) VALUES ('o1', 'interview_invite', 's1', 'email', 'alex@mantu.com', 'sent', ?)", iso(0));
  at(5); assert.deepEqual(sweep(l), {});
  const tight = { ...RETENTION, categories: RETENTION.categories.map(c => ({ ...c, ...(c.id === 'drafts' || c.id === 'outreach' ? { days: 1 } : {}) })) };
  const r = sweep(l, { retention: tight }); assert.equal(r.draftReferences, 1); assert.equal(r.outreach, 1);
  assert.ok(Object.values(r).every(v => typeof v === 'number' || typeof v === 'string'), JSON.stringify(r)); assert.doesNotMatch(JSON.stringify(r), /alex|secret|mantu/);
});

test('G2 retention is part of the daily cron: scan-stale (system role) runs it, reports counts only, logs a chain re-seal when audit rows were pseudonymised, and no browser role can call it', async () => {
  const { l, at } = world(), storage = new FakeStorage();
  await l.upsert(ALEX, { localId: 'd', reference: REF('Old draft'), draft: true }); l.log('r', 'alex@mantu.com', 'created', 'x');
  at(800);
  const lines = []; const orig = console.log; console.log = x => lines.push(String(x));
  let res; try { res = await libraryRoutes(new Request('https://atlas.internal/api/library/scan-stale', { method: 'POST', body: '{}', headers: { 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system' } }), l, { storage, env: {} }); } finally { console.log = orig; }
  const body = await res.json(); assert.equal(res.status, 200); assert.equal(body.retention.draftReferences, 1); assert.ok(body.retention.auditRows >= 1); assert.equal(body.retention.auditHead, undefined, 'the head goes to the log, never the response');
  const sec = lines.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(x => x?.atlas_sec); assert.ok(sec.some(e => e.event === 'audit_chain_ok' && e.reason === 'CHAIN_RESEALED' && /^[0-9a-f]{16}$/.test(e.head)), JSON.stringify(sec));
  for (const role of ['user', 'reviewer', 'admin', 'external']) {
    const r = await libraryRoutes(new Request('https://atlas.internal/api/library/scan-stale', { method: 'POST', body: '{}', headers: { 'x-atlas-user': 'a@x', 'x-atlas-role': role } }), l, { storage, env: {} });
    assert.notEqual(r.status, 200, role);
  }
  const quiet = await (await libraryRoutes(new Request('https://atlas.internal/api/library/scan-stale', { method: 'POST', body: '{}', headers: { 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system' } }), l, { storage, env: {} })).json();
  assert.equal(quiet.retention, undefined, 'a quiet day says nothing');
});
