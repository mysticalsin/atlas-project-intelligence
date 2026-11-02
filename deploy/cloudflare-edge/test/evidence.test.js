// Evidence store and review (T13): interview notes become claims with source references; review runs through the policy gate and the
// EVIDENCE state machine; approvals bind to one revision and hash. Fixtures are synthetic. Same harness as library.test.js (node:sqlite).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { evidence, claimsFromNotes, cleanNotes, attributionFrom, postDraftFromInterview, FIELD_CLAIM, CLAIM_TYPES } from '../src/evidence.js';
import { FIELDS } from '../src/policy.generated.js';
import { decide } from '../src/policy-gate.js';
import { ensure as ensureOutreach } from '../src/outreach.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' }, N1 = { email: 'sam@mantu.com', role: 'user' }, OTHER = { email: 'kim@mantu.com', role: 'user' };
const REV = { email: 'rev@mantu.com', role: 'reviewer' }, REV2 = { email: 'rev2@mantu.com', role: 'reviewer' };
const SECRET = 'Zebracorp routing pilot cut triage from 40 to 12 minutes';
const NOTES = (session = 'sess-001') => ({ session_id: session, project_ref: 'PRJ-1', details: [
  { id: 'D-001', field: 'problem', item_id: 'item-1', quote: 'Claims were bouncing between three teams and payouts were slow.', status: 'reported', asr_min_conf: 0.91, audio_offset_ms: 12000 },
  { id: 'D-002', field: 'contribution', item_id: 'item-2', quote: 'I designed and built the routing model.', status: 'reported', asr_min_conf: 0.52, audio_offset_ms: 48500 },
  { id: 'D-003', field: 'decision', item_id: 'item-3', quote: 'We chose the model over rules after a pilot.', status: 'reported', asr_min_conf: 0.88, audio_offset_ms: 90250 },
  { id: 'D-004', field: 'measurement', item_id: 'item-4', quote: SECRET + ' according to the dashboard.', status: 'uncertain', asr_min_conf: 0.7, audio_offset_ms: 130000 },
  { id: 'D-005', field: 'measurement', item_id: 'item-5', quote: 'I do not know the baseline period.', status: 'unknown' },
  { id: 'D-006', field: 'outcome', item_id: 'item-6', quote: 'Old wording that was later corrected.', active: false },
  { id: 'D-007', field: 'limitations', item_id: 'item-7', quote: 'Keep this one private please.', withheld: true },
] });

function setup() {
  let t = 0, n = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') });
  return { l, ev: evidence(l) };
}
const REF = () => ({ title: 'Claims triage alias', stage: 'Production', sector: 'Insurance', consultant: { name: 'Alex', role: 'Data engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', consultants: [] }, answers: ['a', 'b', 'c', 'd', 'e', 'f'], validation: { manager: { name: 'Sam', email: 'SAM@mantu.com' }, managerStaff: false } });
// The N+1 an approver can be: the staffing record (or the DNA directory). The one a consultant types on the reference is NOT an approver (L2).
const staff = l => { ensureOutreach(l); l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('PRJ-1', 'alex@mantu.com', 'sam@mantu.com', 'Sam', '', '', 'staffing-csv', 'x')"); };
const draft = async (ev, owner = OWNER, notes = NOTES(), extra = {}) => ev.createDraftFromNotes(owner.email, { ...notes, ...extra });
const queued = async (ev, owner = OWNER, notes = NOTES(), extra = {}) => { const d = await draft(ev, owner, notes, extra); return ev.submit(owner.email, d.id, d.revision); };
const approve = (ev, who, v) => ev.review(who, v.id, 'approve', { expected_revision: v.revision, content_hash: v.content_hash });
const rejects = async (p, status, reason) => assert.rejects(p, e => e.status === status && (reason === undefined || e.reason === reason || e.message.includes(reason)), `expected ${status} ${reason ?? ''}`);

test('every interview ledger field maps to a claim type, and the vocabulary has the pack types plus context and learning (D13)', () => {
  assert.deepEqual(Object.keys(FIELD_CLAIM).sort(), Object.keys(FIELDS).sort());
  for (const [type] of Object.values(FIELD_CLAIM)) assert.ok(CLAIM_TYPES.includes(type));
  for (const t of ['responsibility', 'deliverable', 'technology', 'outcome', 'metric', 'credential', 'context', 'learning']) assert.ok(CLAIM_TYPES.includes(t));
});

test('attribution defaults from the I / we cue and never guesses', () => {
  assert.equal(attributionFrom('I designed the routing model'), 'individual');
  assert.equal(attributionFrom("I’ve built it"), 'individual');
  assert.equal(attributionFrom('We chose the model over rules'), 'team');
  assert.equal(attributionFrom('I wrote it and we shipped it'), 'unknown');
  assert.equal(attributionFrom('Triage fell from 40 to 12 minutes'), 'unknown');
  assert.equal(attributionFrom('they gave me the US contract'), 'unknown');
});

test('notes become claims: exact words, source references carry session, item, ledger id, ASR confidence and offset', async () => {
  const { ev } = setup(), v = await draft(ev);
  assert.equal(v.state, 'evidence_draft'); assert.equal(v.status, 'evidence_draft'); assert.equal(v.revision, 1); assert.equal(v.mine, true); assert.match(v.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(v.claims.length, 4, 'unknown, replaced and withheld details are not claims');
  const byField = f => v.claims.find(c => c.source_refs[0].field === f);
  const c = byField('contribution');
  assert.equal(c.statement, 'I designed and built the routing model.'); // the consultant's words, not a paraphrase
  assert.deepEqual([c.claim_type, c.subject_type, c.subject_id, c.attribution, c.origin, c.revision, c.review_status], ['responsibility', 'person', OWNER.email, 'individual', 'consultant_reported', 1, 'draft']);
  assert.deepEqual(c.source_refs, [{ kind: 'interview', session_id: 'sess-001', item_id: 'item-2', ledger_id: 'sess-001:D-002', field: 'contribution', quote: c.statement,
    provenance: 'unverified_speech_recognition', ledger_status: 'reported', asr_min_conf: 0.52, audio_offset_ms: 48500, supersedes_ledger_id: null }]);
  assert.deepEqual([byField('decision').subject_type, byField('decision').attribution], ['team', 'team']); // "We chose": a team decision is not the individual's
  assert.deepEqual([byField('problem').claim_type, byField('problem').subject_type, byField('problem').subject_id], ['context', 'project', 'PRJ-1']);
  const m = byField('measurement');
  assert.deepEqual([m.claim_type, m.value, m.unit, m.baseline, m.after_state, m.period], ['metric', null, null, null, null, null]); // nothing is computed from the wording
  assert.equal(m.source_refs[0].ledger_status, 'uncertain'); // uncertainty is carried, not dropped
  assert.deepEqual(v.revisions.map(r => [r.revision, r.kind]), [[1, 'created_from_notes']]);
  assert.ok(v.actions.includes('submit') && v.actions.includes('amend') && !v.actions.includes('approve'));
});

test('ledger ids are globally unique per session and ASR meta may arrive per item', async () => {
  const { ev } = setup(), a = await draft(ev, OWNER, NOTES('sess-A')), b = await draft(ev, OWNER, { ...NOTES('sess-B'), details: [{ ...NOTES().details[1], asr_min_conf: undefined, audio_offset_ms: undefined }], asr: { 'item-2': { min_conf: 0.4, audio_offset_ms: 777 } } });
  const ids = [...a.claims, ...b.claims].flatMap(c => c.source_refs.map(r => r.ledger_id));
  assert.equal(new Set(ids).size, ids.length); assert.ok(ids.includes('sess-A:D-002') && ids.includes('sess-B:D-002'));
  assert.deepEqual([b.claims[0].source_refs[0].asr_min_conf, b.claims[0].source_refs[0].audio_offset_ms], [0.4, 777]);
});

test('notes are bounded and checked; bad notes create nothing', async () => {
  const { l, ev } = setup();
  const bad = [{}, { session_id: 'a b', details: NOTES().details }, { session_id: 's1', details: [] }, { session_id: 's1', details: [{ id: 'X-1', field: 'problem', item_id: 'i', quote: 'q' }] },
    { session_id: 's1', details: [{ id: 'D-001', field: 'nonsense', item_id: 'i', quote: 'q' }] }, { session_id: 's1', details: [{ id: 'D-001', field: 'problem', item_id: 'i', quote: '' }] },
    { session_id: 's1', details: [NOTES().details[0], NOTES().details[0]] }, { session_id: 's1', details: new Array(101).fill(0).map((_, i) => ({ id: 'D-' + String(i + 1).padStart(3, '0'), field: 'problem', item_id: 'i', quote: 'q' })) }];
  for (const n of bad) await rejects(ev.createDraftFromNotes(OWNER.email, n), 400);
  await rejects(ev.createDraftFromNotes(OWNER.email, { session_id: 's2', details: [NOTES().details[4], NOTES().details[5], NOTES().details[6]] }), 400); // nothing usable
  await rejects(ev.createDraftFromNotes('', NOTES()), 401);
  await rejects(draft(ev, OWNER, NOTES('s3'), { ref_id: 'nope' }), 404);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM evidence_records')[0].n, 0);
  const d = cleanNotes({ session_id: 's', details: [{ id: 'D-001', field: 'problem', item_id: 'i', quote: 'x'.repeat(5000), asr_min_conf: 7, audio_offset_ms: -1, sneaky: 1 }] }).details[0];
  assert.equal(d.quote.length, 1800); assert.equal(d.asr_min_conf, null); assert.equal(d.audio_offset_ms, null); assert.ok(!('sneaky' in d));
});

test('idempotent: the same notes again return the same record; different notes for that session are refused; another owner cannot take it', async () => {
  const { l, ev } = setup(), a = await draft(ev), b = await draft(ev);
  assert.equal(a.unchanged, false); assert.equal(b.unchanged, true); assert.equal(b.id, a.id);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM evidence_records')[0].n, 1);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM evidence_claims')[0].n, 4);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM workflow_transitions')[0].n, 1);
  const changed = NOTES(); changed.details[1].quote = 'I designed the routing model and ran the pilot.';
  await rejects(ev.createDraftFromNotes(OWNER.email, changed), 409);
  await rejects(draft(ev, OTHER), 409);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM evidence_records')[0].n, 1);
  // concurrent posts of the same notes still make one record
  const { l: l2, ev: ev2 } = setup(); const [x, y] = await Promise.all([draft(ev2, OWNER, NOTES('sess-C')), draft(ev2, OWNER, NOTES('sess-C'))]);
  assert.equal(x.id, y.id); assert.equal(l2.rows('SELECT COUNT(*) AS n FROM evidence_records')[0].n, 1);
});

test('a draft is the owner\'s alone (D19); submission is an explicit act; then the N+1 and reviewers see it, others still get 404', async () => {
  const { l, ev } = setup(); staff(l); const ref = await l.upsert(OWNER, { localId: 'p1', reference: REF() }), d = await draft(ev, OWNER, NOTES(), { ref_id: ref.id });
  for (const who of [N1, OTHER, REV, { email: 'root@mantu.com', role: 'admin' }]) { assert.throws(() => ev.get(who, d.id), e => e.status === 404); assert.equal(ev.list(who).length, 0); }
  assert.equal(ev.get(OWNER, d.id).state, 'evidence_draft'); assert.equal(ev.list(OWNER).length, 1); // saved, not submitted
  const q = ev.submit(OWNER.email, d.id, 1);
  assert.deepEqual([q.state, q.status, q.claims.every(c => c.review_status === 'submitted')], ['reviewer_queue', 'submitted_for_review', true]);
  for (const who of [N1, REV, { email: 'root@mantu.com', role: 'admin' }]) { assert.equal(ev.get(who, d.id).access, 'reviewer'); assert.equal(ev.list(who).length, 1); }
  assert.throws(() => ev.get(OTHER, d.id), e => e.status === 404); assert.throws(() => ev.get({ email: '', role: 'admin' }, d.id), e => e.status === 404);
  assert.throws(() => ev.get(REV, 'missing'), e => e.status === 404);
  assert.deepEqual(q.history.map(h => [h.event, h.from, h.to, h.actor]), [['submit', 'evidence_draft', 'submitted_for_review', 'user'], ['enqueue', 'submitted_for_review', 'reviewer_queue', 'system']]);
});

test('submit is the owner\'s, needs the revision they saw, and happens once', async () => {
  const { ev } = setup(), d = await draft(ev);
  await rejects(Promise.resolve().then(() => ev.submit(OWNER.email, d.id, undefined)), 400);
  await rejects(Promise.resolve().then(() => ev.submit(OWNER.email, d.id, 2)), 409, 'REVISION_MISMATCH');
  await rejects(Promise.resolve().then(() => ev.submit(OTHER.email, d.id, 1)), 404);
  ev.submit(OWNER.email, d.id, 1);
  await rejects(Promise.resolve().then(() => ev.submit(REV, d.id, 1)), 403, 'ROLE_NOT_PERMITTED');
  await rejects(Promise.resolve().then(() => ev.submit(OWNER.email, d.id, 1)), 409, 'TRANSITION_NOT_ALLOWED');
});

test('W7: no approval without a reviewer, no self-approval, and an approval names the revision and hash the reviewer saw', async () => {
  const { l, ev } = setup(); staff(l); const ref = await l.upsert(OWNER, { localId: 'p1', reference: REF() }), v = await queued(ev, OWNER, NOTES(), { ref_id: ref.id });
  const go = (who, p) => ev.review(who, v.id, 'approve', p), at = { expected_revision: 1, content_hash: v.content_hash };
  await rejects(go(OWNER, at), 403, 'ROLE_NOT_PERMITTED'); // the owner is not a reviewer
  await rejects(go({ ...OWNER, role: 'reviewer' }, at), 403, 'SELF_APPROVAL'); // a reviewer role does not let anyone approve their own evidence
  await rejects(go({ ...OWNER, role: 'admin' }, at), 403, 'SELF_APPROVAL');
  await rejects(go(OTHER, at), 404);
  await rejects(go(REV, { expected_revision: 1 }), 400); // the reviewer must say which content they reviewed
  await rejects(go(REV, { content_hash: v.content_hash }), 400);
  await rejects(go(REV, { expected_revision: 2, content_hash: v.content_hash }), 409, 'REVISION_MISMATCH');
  await rejects(go(REV, { expected_revision: 1, content_hash: 'f'.repeat(64) }), 409, 'CONTENT_HASH_MISMATCH');
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM approvals')[0].n, 0); assert.equal(ev.get(REV, v.id).state, 'reviewer_queue'); // every refusal changed nothing
  const done = await go(N1, at); // the resolved N+1 is an accountable reviewer
  assert.deepEqual([done.state, done.status, done.approved, done.claims.every(c => c.review_status === 'validated')], ['approved', 'evidence_approved', true, true]);
  assert.deepEqual([done.approval.revision, done.approval.content_hash, done.approval.approver_sub], [1, v.content_hash, N1.email]);
  await rejects(go(REV, at), 409, 'TRANSITION_NOT_ALLOWED'); // already decided
});

test('the approval is what the gate needs: bound to the exact revision, so use for a purpose is allowed only while the hash matches', async () => {
  const { l, ev } = setup(), v = await queued(ev), ok = await approve(ev, REV, v);
  const grant = ev.grantPermission(OWNER, v.id, { expected_revision: 1, purpose: 'internal_knowledge', channel: 'internal', legal_basis_ref: 'consent-1' });
  assert.deepEqual([grant.revision, grant.hash, grant.status], [1, v.content_hash, 'active']);
  const entity = { id: v.id, owner_sub: OWNER.email, revision: ok.revision, content_hash: ok.content_hash, status: ok.state, approved_revision: ok.approval.revision, approved_hash: ok.approval.content_hash };
  const use = e => decide({ sub: 'm', roles: ['member'] }, 'use_for_purpose', e, { now: '2026-11-02T00:00:00Z', expected_revision: e.revision, content_hash: e.content_hash, purpose: 'internal_knowledge', channel: 'internal', grants: ev.grantsFor(v.id) });
  assert.deepEqual(use(entity), { allow: true, reason: 'ALLOWED' });
  const am = await ev.review(OWNER, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: ok.claims[0].claim_id, statement: 'Claims bounced between two teams.' }] });
  assert.deepEqual(use({ ...entity, revision: am.revision, content_hash: am.content_hash, status: am.state, approved_revision: null, approved_hash: null }),
    { allow: false, reason: 'REQUIREMENT_UNMET:evidence_approved' });
  const rev = ev.revokePermission(OWNER, v.id, grant.id, { expected_revision: am.revision });
  assert.equal(rev.status, 'revoked'); assert.ok(rev.revoked_at);
  await rejects(Promise.resolve().then(() => ev.grantPermission(OWNER, v.id, { expected_revision: am.revision, purpose: 'sell_to_third_party' })), 403, 'UNKNOWN_PURPOSE');
  await rejects(Promise.resolve().then(() => ev.grantPermission(REV, v.id, { expected_revision: am.revision, purpose: 'cv' })), 404); // a draft again: the reviewer cannot even see it
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM permission_grants WHERE status = 'active'")[0].n, 0);
});

test('amend by the reviewer: a new revision with a new hash; approval then binds to the new hash, and the old one cannot be approved', async () => {
  const { ev } = setup(), v = await queued(ev), c = v.claims.find(x => x.source_refs[0].field === 'measurement');
  const am = await ev.review(REV, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: c.claim_id, value: '12', unit: 'minutes', baseline: '40', period: '2024-Q1 to 2024-Q4', origin: 'artifact_supported' }] });
  assert.deepEqual([am.revision, am.state, am.unchanged], [2, 'reviewer_queue', false]); assert.notEqual(am.content_hash, v.content_hash);
  const c2 = am.claims.find(x => x.claim_id === c.claim_id);
  assert.deepEqual([c2.value, c2.unit, c2.baseline, c2.origin, c2.revision], ['12', 'minutes', '40', 'artifact_supported', 2]);
  assert.deepEqual(c2.source_refs.at(-1), { kind: 'amendment', revision: 2, by: 'reviewer' }); assert.equal(c2.source_refs[0].ledger_id, 'sess-001:D-004'); // provenance is never rewritten
  assert.deepEqual(am.revisions.map(r => [r.revision, r.kind, r.author_role]), [[2, 'amended', 'reviewer'], [1, 'created_from_notes', 'user']]);
  await rejects(approve(ev, REV, v), 409, 'REVISION_MISMATCH'); // approving what they saw before the amendment
  const prior = ev.get(REV, v.id, { revision: 1 }); // the prior revision is kept and readable
  assert.equal(prior.claims.find(x => x.claim_id === c.claim_id).value, null); assert.equal(prior.claims[0].review_status, 'superseded'); assert.equal(prior.viewing_revision, 1);
  const ok = await approve(ev, REV2, am);
  assert.deepEqual([ok.approval.revision, ok.approval.content_hash, ok.approved], [2, am.content_hash, true]);
  assert.throws(() => ev.get(REV, v.id, { revision: 3 }), e => e.status === 404);
  // no-op amendments are not revisions
  const same = await ev.review(OWNER, v.id, 'amend', { expected_revision: 2, claims: [{ claim_id: c.claim_id, value: '12' }] });
  assert.deepEqual([same.unchanged, same.revision], [true, 2]);
});

test('a content change after approval invalidates it, starts review again, and lists the derivatives (D11)', async () => {
  const { l, ev } = setup(), v = await queued(ev), ok = await approve(ev, REV, v);
  l.sql.exec("INSERT INTO branch_status (entity, branch, status, updated_at) VALUES (?, 'dna', 'pending', 't')", v.id);
  l.sql.exec("INSERT INTO branch_status (entity, branch, status, updated_at) VALUES (?, 'michat', 'mock_acknowledged', 't')", v.id);
  ev.grantPermission(OWNER, v.id, { expected_revision: 1, purpose: 'cv' });
  assert.equal(ok.approved, true);
  await rejects(ev.review(OWNER, v.id, 'amend', { expected_revision: 1 }), 400); // nothing said to change
  await rejects(ev.review(OWNER, v.id, 'amend', { expected_revision: 9, claims: [{ claim_id: ok.claims[0].claim_id, statement: 'x' }] }), 409, 'REVISION_MISMATCH');
  await rejects(ev.review(OWNER, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: 'ghost', statement: 'x' }] }), 404);
  await rejects(ev.review(OWNER, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: ok.claims[0].claim_id, origin: 'manager_validated' }] }), 400); // an owner cannot validate their own claim
  const am = await ev.review(OWNER, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: ok.claims[0].claim_id, statement: 'Claims bounced between two teams.' }], add: [{ claim_type: 'technology', statement: 'We used Python.' }] });
  assert.deepEqual([am.revision, am.approved, am.approval, am.state, am.status], [2, false, null, 'evidence_draft', 'evidence_draft']);
  assert.deepEqual(am.derivatives, [{ kind: 'branch', branch: 'dna', status: 'pending' }, { kind: 'branch', branch: 'michat', status: 'mock_acknowledged' }, { kind: 'permission', purpose: 'cv', destination: null }]);
  assert.deepEqual(l.rows('SELECT revision, status FROM approvals').map(r => [r.revision, r.status]), [[1, 'superseded']]);
  assert.equal(am.claims.length, 5); assert.equal(am.claims.at(-1).claim_type, 'technology'); assert.equal(am.claims.at(-1).attribution, 'team'); assert.deepEqual(am.claims.at(-1).source_refs, [{ kind: 'typed', revision: 2, by: 'owner' }]);
  assert.throws(() => ev.get(REV, v.id), e => e.status === 404); // back to an owner-only draft until the owner submits again
  assert.deepEqual(l.rows('SELECT event, from_state, to_state FROM workflow_transitions WHERE entity = ? ORDER BY seq', v.id).map(r => r.event).slice(-2), ['approve', 'amend_after_approval']);
  const again = ev.submit(OWNER.email, v.id, 2); assert.equal(again.state, 'reviewer_queue');
  const re = await approve(ev, REV, again); assert.deepEqual([re.approved, re.approval.revision], [true, 2]);
  assert.equal(ev.get(OWNER, v.id).history.map(h => h.event).join(), 'submit,enqueue,approve'); // a new cycle's machine, the earlier cycle's trail stays in workflow_transitions
});

test('clarify returns it to the owner, who amends and submits again (a new revision each time the content changes)', async () => {
  const { l, ev } = setup(), v = await queued(ev);
  await rejects(ev.review(REV, v.id, 'clarify', { expected_revision: 1 }), 400); // say what to clarify
  const c = await ev.review(REV, v.id, 'clarify', { expected_revision: 1, note: 'Which dashboard, and over which dates?' });
  assert.deepEqual([c.state, c.status, c.clarifications.map(x => [x.by, x.note, x.revision])], ['needs_clarification', 'needs_clarification', [[REV.email, 'Which dashboard, and over which dates?', 1]]]);
  await rejects(ev.review(REV, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: c.claims[0].claim_id, statement: 'x' }] }), 409, 'AMEND_NOT_ALLOWED_IN_STATE');
  const a = await ev.review(OWNER, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: c.claims[3].claim_id, period: '2024-Q1 to Q4', value: '12' }] });
  assert.deepEqual([a.state, a.revision], ['evidence_draft', 2]);
  assert.equal(ev.submit(OWNER.email, v.id, 2).state, 'reviewer_queue');
  assert.deepEqual(l.rows('SELECT event FROM workflow_transitions WHERE entity = ? ORDER BY seq', v.id).map(r => r.event), ['create_from_notes', 'submit', 'enqueue', 'request_clarification', 'revise', 'submit', 'enqueue']);
});

test('W8: reject needs a reason and keeps the revision that was rejected; the owner can then dispute or be asked to clarify', async () => {
  const { ev } = setup(), v = await queued(ev), why = { expected_revision: 1, content_hash: v.content_hash };
  await rejects(ev.review(REV, v.id, 'reject', why), 400); await rejects(ev.review(REV, v.id, 'reject', { ...why, reason: '   ' }), 400);
  assert.equal(ev.get(REV, v.id).state, 'reviewer_queue');
  await rejects(ev.review(OWNER, v.id, 'reject', { ...why, reason: 'no' }), 403, 'ROLE_NOT_PERMITTED');
  const r = await ev.review(REV, v.id, 'reject', { ...why, reason: 'The 40-to-12 figure has no source.' });
  assert.deepEqual([r.state, r.status, r.revision, r.content_hash, r.claims.length, r.claims.every(c => c.review_status === 'rejected')], ['rejected', 'rejected', 1, v.content_hash, 4, true]);
  assert.deepEqual([r.rejection.reason, r.rejection.by, r.rejection.revision, r.rejection.content_hash], ['The 40-to-12 figure has no source.', REV.email, 1, v.content_hash]);
  assert.equal(r.approved, false); assert.equal(r.history.at(-1).reason, 'The 40-to-12 figure has no source.');
  assert.equal(ev.get(OWNER, v.id).claims[0].statement, v.claims[0].statement); // nothing was lost
  const cl = await ev.review(REV2, v.id, 'clarify', { expected_revision: 1, note: 'Please add the dashboard export.' }); // reject -> needs_clarification is allowed (D10)
  assert.equal(cl.state, 'needs_clarification');
});

test('dispute keeps both views: the reviewer\'s rejection and the owner\'s rationale, with who adjudicates; only the owner disputes, only after a rejection', async () => {
  const { ev } = setup(), v = await queued(ev);
  await rejects(ev.review(OWNER, v.id, 'dispute', { expected_revision: 1, reason: 'not yet rejected' }), 409, 'TRANSITION_NOT_ALLOWED');
  await ev.review(REV, v.id, 'reject', { expected_revision: 1, content_hash: v.content_hash, reason: 'No source for the figure.' });
  await rejects(ev.review(OWNER, v.id, 'dispute', { expected_revision: 1 }), 400); // a rationale is required
  await rejects(ev.review(REV2, v.id, 'dispute', { expected_revision: 1, reason: 'I disagree' }), 403); // a reviewer does not dispute their colleague's rejection here
  const d = await ev.review(OWNER, v.id, 'dispute', { expected_revision: 1, rationale: 'The dashboard export is the source.', adjudicator: 'rev2@mantu.com', claim_ids: [v.claims[3].claim_id] });
  assert.deepEqual([d.state, d.status, d.claims.every(c => c.review_status === 'disputed')], ['disputed', 'disputed', true]);
  assert.deepEqual([d.dispute.rationale, d.dispute.by, d.dispute.adjudicator, d.dispute.claim_ids], ['The dashboard export is the source.', OWNER.email, 'rev2@mantu.com', [v.claims[3].claim_id]]);
  assert.deepEqual([d.dispute.rejection.reason, d.dispute.rejection.by], ['No source for the figure.', REV.email]); // the other view is kept beside it
  assert.deepEqual([d.rejection.reason, d.claims.length], ['No source for the figure.', 4]);
  assert.equal((await ev.review(REV2, v.id, 'clarify', { expected_revision: 1, note: 'Send the export.' })).state, 'needs_clarification'); // the adjudicator can route it back
});

test('withdraw: a draft is withdrawn at once and hidden; after approval it goes to impact review with the derivatives listed, and a reviewer completes it', async () => {
  const { l, ev } = setup(), d0 = await draft(ev, OWNER, NOTES('sess-W0'));
  await rejects(ev.review(OWNER, d0.id, 'withdraw', { expected_revision: 1 }), 400); // a reason
  assert.equal((await ev.review(OWNER, d0.id, 'withdraw', { expected_revision: 1, reason: 'Wrong project' })).state, 'withdrawn');
  const v = await queued(ev, OWNER, NOTES('sess-W1')), ok = await approve(ev, REV, v);
  l.sql.exec("INSERT INTO branch_status (entity, branch, status, updated_at) VALUES (?, 'imp', 'pending', 't')", v.id);
  await rejects(ev.review(REV, v.id, 'withdraw', { expected_revision: 1, reason: 'x' }), 403); // withdrawal is the owner's act
  const w = await ev.review(OWNER, v.id, 'withdraw', { expected_revision: 1, reason: 'I do not want this used.' });
  assert.deepEqual([w.state, w.status, w.approved, w.approval], ['impact_review', 'impact_review', false, null]);
  assert.deepEqual([w.impact.derivatives, w.impact.from, w.impact.revision], [[{ kind: 'branch', branch: 'imp', status: 'pending' }], 'approved', 1]);
  assert.deepEqual(l.rows('SELECT status FROM approvals').map(r => r.status), ['revoked']);
  await rejects(ev.review(OWNER, v.id, 'complete_impact_review', { expected_revision: 1 }), 403); // the owner does not close their own impact review
  const done = await ev.review(REV2, v.id, 'complete_impact_review', { expected_revision: 1 });
  assert.deepEqual([done.state, done.impact.completed_by, done.claims.every(c => c.review_status === 'withdrawn')], ['withdrawn', REV2.email, true]);
  await rejects(ev.review(OWNER, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: ok.claims[0].claim_id, statement: 'x' }] }), 409, 'AMEND_NOT_ALLOWED_IN_STATE');
});

test('unknown review actions and forbidden people-inference actions are refused', async () => {
  const { ev } = setup(), v = await queued(ev);
  for (const a of ['rate_consultant', 'infer_sentiment', 'publish', '', undefined]) await rejects(ev.review(REV, v.id, a, { expected_revision: 1 }), 400);
});

test('audit rows carry no claim text, not even the reviewer\'s reason; the text stays in the record for those who may read it', async () => {
  const { l, ev } = setup(), v = await queued(ev), reason = 'The ' + SECRET + ' figure has no source';
  await ev.review(REV, v.id, 'reject', { expected_revision: 1, content_hash: v.content_hash, reason });
  await ev.review(OWNER, v.id, 'dispute', { expected_revision: 1, rationale: 'Please see: ' + SECRET });
  await ev.review(REV2, v.id, 'clarify', { expected_revision: 1, note: 'About ' + SECRET });
  const rows = l.rows('SELECT * FROM workflow_transitions'), approvals = l.rows('SELECT * FROM approvals');
  assert.ok(rows.length >= 6);
  const dump = JSON.stringify([rows, approvals]);
  for (const word of ['Zebracorp', 'routing', 'triage', 'dashboard', 'minutes', 'figure has no source', 'Claims were bouncing', 'designed and built']) assert.ok(!dump.includes(word), word);
  assert.deepEqual([...new Set(rows.map(r => r.reason))].sort(), [null, 'text_recorded']);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['actor', 'actor_role', 'at', 'entity', 'event', 'from_state', 'reason', 'revision', 'seq', 'to_state', 'workflow_version']);
  assert.ok(rows.every(r => r.workflow_version === 'atlas-conversation-2.1.0'));
  assert.ok(ev.get(OWNER, v.id).history.some(h => h.reason === reason)); // readable to the owner and reviewers
  assert.ok(!JSON.stringify(l.rows('SELECT * FROM audit')).includes('Zebracorp')); // the library's own audit is untouched by evidence
});

test('claims are immutable per (claim_id, revision); only review_status moves', async () => {
  const { l, ev } = setup(), v = await queued(ev), snap = () => l.rows('SELECT claim_id, revision, statement, value, source_refs, attribution FROM evidence_claims ORDER BY claim_id, revision');
  const before = snap();
  await approve(ev, REV, v);
  assert.deepEqual(snap(), before);
  await ev.review(OWNER, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: v.claims[0].claim_id, statement: 'changed' }] });
  const after = snap();
  assert.deepEqual(after.filter(r => r.revision === 1), before); // revision 1 is exactly as written
  assert.throws(() => l.sql.exec("INSERT INTO evidence_claims (claim_id, revision, entity) VALUES (?, 1, 'x')", v.claims[0].claim_id), /UNIQUE|constraint/i);
});

test('the state is replayed from its audit on every load: a tampered record is refused, not guessed at', async () => {
  const { l, ev } = setup(), v = await queued(ev);
  const s = JSON.parse(l.rows('SELECT state_json FROM evidence_records')[0].state_json); s.machine.state = 'approved';
  l.sql.exec('UPDATE evidence_records SET state_json = ?', JSON.stringify(s));
  assert.throws(() => ev.get(OWNER, v.id), e => e.status === 500);
  assert.deepEqual(ev.list(OWNER), []); // one unreadable record does not break the list
});

test('the N+1 is resolved the way the library resolves it: from the reference, and a stranger is still a 404', async () => {
  const { l, ev } = setup(); staff(l); const ref = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  const a = await queued(ev, OWNER, NOTES('s-a'), { ref_id: ref.id }), b = await queued(ev, OWNER, { ...NOTES('s-b'), project_ref: 'PRJ-9' }); // b names no reference and no staffed project: nobody to resolve
  assert.equal(ev.get(N1, a.id).access, 'reviewer'); assert.throws(() => ev.get(N1, b.id), e => e.status === 404);
  assert.deepEqual(ev.list(N1).map(x => x.id), [a.id]);
  const other = { email: 'zed@mantu.com', role: 'user' }, ref2 = await l.upsert(other, { localId: 'q', reference: REF() });
  await assert.rejects(draft(ev, OWNER, NOTES('s-c'), { ref_id: ref2.id }), e => e.status === 404); // not a reference the owner may use
});

test('routes: identity comes from the verified headers, never the body; the browser path cannot create drafts', async () => {
  const { l } = setup(), seen = [];
  const call = (method, path, who, body) => libraryRoutes(new Request('https://atlas.test' + path, { method, headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, 'x-atlas-email': who.email }, ...(body ? { body: JSON.stringify(body) } : {}) }), l, {})
    .then(async r => { const j = await r.json(); seen.push([r.status, j]); return { status: r.status, body: j }; });
  const evil = await call('POST', '/api/evidence', OWNER, { owner: 'victim@mantu.com', sub: 'victim@mantu.com', owner_sub: 'victim@mantu.com', notes: NOTES() });
  assert.equal(evil.status, 201); assert.equal(evil.body.mine, true);
  assert.equal(l.rows('SELECT owner_sub FROM evidence_records')[0].owner_sub, OWNER.email);
  assert.equal((await call('POST', '/api/evidence', OWNER, { notes: NOTES() })).status, 200); // same notes again
  assert.equal((await call('POST', '/api/library/evidence', OWNER, { notes: NOTES('forged') })).status, 404); // a browser cannot post notes
  assert.equal((await call('POST', '/api/evidence', { email: 'x@mantu.com', role: 'external' }, { notes: NOTES('e') })).status, 404);
  assert.equal((await call('POST', '/api/evidence', { email: 'sys', role: 'system' }, { notes: NOTES('s') })).status, 404);
  const id = evil.body.id;
  assert.equal((await call('GET', '/api/library/evidence/' + id, OTHER)).status, 404);
  assert.equal((await call('GET', '/api/evidence/' + id, REV)).status, 404); // a reviewer cannot see a draft
  const got = await call('GET', '/api/library/evidence/' + id, OWNER); assert.equal(got.body.claims.length, 4);
  assert.equal((await call('POST', '/api/library/evidence/' + id + '/submit', OWNER, { expected_revision: 1 })).body.state, 'reviewer_queue');
  assert.equal((await call('GET', '/api/library/evidence', REV)).body.items.length, 1);
  const stale = await call('POST', '/api/library/evidence/' + id + '/submit', OWNER, { expected_revision: 1 }); assert.equal(stale.status, 409); assert.match(stale.body.reason, /^TRANSITION_NOT_ALLOWED/);
  const self = await call('POST', '/api/library/evidence/' + id + '/review', { ...OWNER, role: 'reviewer' }, { action: 'approve', expected_revision: 1, content_hash: got.body.content_hash });
  assert.deepEqual([self.status, self.body.reason], [403, 'SELF_APPROVAL']);
  const ok = await call('POST', '/api/library/evidence/' + id + '/review', REV, { action: 'approve', expected_revision: 1, content_hash: got.body.content_hash });
  assert.deepEqual([ok.status, ok.body.state, ok.body.approved], [200, 'downstream_proposals', true]);
  assert.equal((await call('GET', `/api/library/evidence/${id}?revision=1`, OWNER)).body.viewing_revision, 1);
  assert.equal((await call('GET', `/api/library/evidence/${id}?revision=7`, OWNER)).status, 404);
  assert.equal((await call('PUT', '/api/library/evidence/' + id, OWNER, { x: 1 })).status, 404);
  assert.equal((await call('POST', '/api/library/evidence/' + id + '/nope', OWNER, {})).status, 404);
  assert.equal((await call('POST', '/api/library/evidence/' + id + '/review', REV, { action: 'bogus', expected_revision: 2 })).status, 400);
});

test('the library\'s own routes and tables are untouched: evidence tables are additive and the library still works', async () => {
  const { l } = setup(), names = l.rows("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name);
  for (const t of ['refs', 'revisions', 'audit', 'evidence_records', 'evidence_claims', 'evidence_revisions', 'workflow_transitions', 'approvals', 'permission_grants', 'branch_status']) assert.ok(names.includes(t), t);
  assert.equal((await l.upsert(OWNER, { localId: 'p1', reference: REF() })).revision, 1);
  const l2 = new Library(l.sql); assert.ok(l2); // a second constructor over the same database is harmless (IF NOT EXISTS)
});

test('postDraftFromInterview: the server-to-server post T11 calls, under the verified identity it is given', async () => {
  const { l } = setup(), requests = [];
  const env = { LIBRARY: { idFromName: n => n, get: n => ({ fetch: async req => { requests.push([n, req.url, req.method, req.headers.get('x-atlas-user')]); return libraryRoutes(req, l, {}); } }) } };
  const r1 = await postDraftFromInterview(env, { user: OWNER.email, role: 'user', mail: OWNER.email }, NOTES());
  assert.deepEqual([r1.status, r1.body.mine, r1.body.state], [201, true, 'evidence_draft']);
  assert.deepEqual(requests[0], ['global', 'https://atlas.internal/api/evidence', 'POST', OWNER.email]);
  const r2 = await postDraftFromInterview(env, { user: OWNER.email }, NOTES()); assert.deepEqual([r2.status, r2.body.id], [200, r1.body.id]);
  assert.equal((await postDraftFromInterview(env, { user: OWNER.email }, { session_id: 'x', details: [] })).status, 400);
  assert.equal((await postDraftFromInterview({}, { user: 'a' }, NOTES())).status, 0);
  assert.equal((await postDraftFromInterview(env, {}, NOTES())).status, 0);
  assert.equal((await postDraftFromInterview({ LIBRARY: { idFromName: () => 1, get: () => ({ fetch: async () => { throw new Error('down'); } }) } }, { user: 'a' }, NOTES())).status, 0);
});

test('claimsFromNotes is pure: the same notes give the same claims and ids', () => {
  const n = cleanNotes(NOTES()), a = claimsFromNotes('rec1', 'u', n, 't'), b = claimsFromNotes('rec1', 'u', cleanNotes(NOTES()), 't');
  assert.deepEqual(a, b); assert.deepEqual(a.map(c => c.claim_id), ['rec1-c1', 'rec1-c2', 'rec1-c3', 'rec1-c4']);
});

// ---- G1: governance fixes from the independent review ----
test('L2: an N+1 the consultant typed on the reference never becomes a reviewer; a staffing record does', async () => {
  const { l, ev } = setup(), ref = await l.upsert(OWNER, { localId: 'p1', reference: REF() }); // REF names sam as the self-declared N+1
  const q = await queued(ev, OWNER, NOTES('s-l2'), { ref_id: ref.id });
  assert.throws(() => ev.get(N1, q.id), e => e.status === 404); assert.deepEqual(ev.list(N1), []);
  await assert.rejects(approve(ev, N1, q), e => e.status === 404);
  staff(l); // the staffing record, not the owner, says who the N+1 is
  assert.equal(ev.get(N1, q.id).access, 'reviewer'); assert.equal((await approve(ev, N1, q)).state, 'approved');
});

test('M2 scenario C: a reviewer who rewrote the claims cannot approve their own rewrite; a different reviewer can', async () => {
  const { l, ev } = setup(), q = await queued(ev), c = q.claims.find(x => x.claim_type === 'metric');
  const a = await ev.review(REV, q.id, 'amend', { expected_revision: 1, claims: [{ claim_id: c.claim_id, statement: 'Triage fell from 40 to 2 minutes, saving 1M EUR.', origin: 'independently_measured' }] });
  assert.equal(a.revision, 2); assert.deepEqual([a.revisions[0].author, a.revisions[0].author_role], [REV.email, 'reviewer']);
  await rejects(approve(ev, REV, a), 403, 'AUTHOR_CANNOT_APPROVE');
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM approvals')[0].n, 0); assert.equal(ev.get(REV, q.id).state, 'reviewer_queue');
  const ok = await approve(ev, REV2, a);
  assert.deepEqual([ok.state, ok.approval.approver_sub, ok.approval.revision], ['approved', REV2.email, 2]);
  // the same rule after approval: an amendment of an approved record by REV is approved by someone else
  const b = await ev.review(REV, q.id, 'amend', { expected_revision: 2, claims: [{ claim_id: c.claim_id, statement: 'Triage fell from 40 to 3 minutes.' }] });
  assert.equal(b.revision, 3);
  const again = ev.submit(OWNER.email, q.id, 3);
  await rejects(approve(ev, REV, again), 403, 'AUTHOR_CANNOT_APPROVE'); assert.equal((await approve(ev, REV2, again)).state, 'approved');
});

test('M2: the gate denies approve for the author of the revision under review, and only approve', () => {
  const e = { id: 'ev-1', owner_sub: 'u-owner', revision: 2, content_hash: 'h', status: 'reviewer_queue', revision_author: 'rev@mantu.com' };
  const c = { now: '2026-11-01T00:00:00Z', expected_revision: 2, content_hash: 'h', to: 'approved', transitions: { reviewer_queue: ['approved', 'rejected'] } };
  assert.deepEqual(decide({ sub: 'rev@mantu.com', roles: ['reviewer'] }, 'approve', e, c), { allow: false, reason: 'AUTHOR_CANNOT_APPROVE' });
  assert.equal(decide({ sub: 'rev2@mantu.com', roles: ['reviewer'] }, 'approve', e, c).allow, true);
  assert.equal(decide({ sub: 'rev@mantu.com', roles: ['reviewer'] }, 'reject', e, { ...c, to: 'rejected' }).allow, true);
});

test('L9: the list is filtered in SQL, so records a person cannot see are never replayed', async () => {
  const { l, ev } = setup(), mine = await draft(ev, OWNER, NOTES('s-mine')), theirs = [];
  for (let i = 0; i < 4; i++) theirs.push(await draft(ev, OTHER, NOTES('s-o' + i)));
  const loads = []; const orig = ev.load.bind(ev); ev.load = id => { loads.push(id); return orig(id); };
  assert.deepEqual(ev.list(OWNER).map(x => x.id), [mine.id]);
  assert.deepEqual(loads, [mine.id], 'only the owner\'s own record was loaded');
  loads.length = 0; assert.equal(ev.list(REV).length, 0); assert.deepEqual(loads, [], 'a reviewer sees no drafts and loads none');
  ev.submit(OTHER.email, theirs[0].id, 1); loads.length = 0;
  assert.deepEqual(ev.list(REV).map(x => x.id), [theirs[0].id]); assert.deepEqual(loads, [theirs[0].id]);
  void l;
});
