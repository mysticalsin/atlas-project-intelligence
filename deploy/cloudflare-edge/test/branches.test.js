// Branches after approval (T15, D1-D5, D11, D12, D17; pack acceptance 9-12): seven independent branch records, per-branch permission
// checks, jobs and mock adapters, status cards, Spotlight gates, impact review. Synthetic data only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { evidence } from '../src/evidence.js';
import { decide } from '../src/policy-gate.js';
import { flags } from '../src/features.js';
import * as B from '../src/branches.js';
import { jobs } from '../src/jobs.js';
import { Spotlight, GATES } from '../src/spotlight.js';
import { registry, adapterMode, evidenceWorkflowOn, buildPayload, CONTRACTS, createMockAdapter } from '../src/adapters.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' }, N1 = { email: 'sam@mantu.com', role: 'user' }, OTHER = { email: 'kim@mantu.com', role: 'user' };
const REV = { email: 'rev@mantu.com', role: 'reviewer' }, REV2 = { email: 'rev2@mantu.com', role: 'reviewer' };
const actor = (sub, ...roles) => ({ sub, roles });
const PO = actor('po@mantu.com', 'project_owner'), CL = actor('cl@mantu.com', 'customer_liaison'), CR = actor('cr@mantu.com', 'confidentiality_reviewer'), LG = actor('lg@mantu.com', 'legal_reviewer'),
  BR = actor('br@mantu.com', 'brand_approver'), SA = actor('sa@mantu.com', 'spotlight_approver'), RV = actor(REV.email, 'reviewer');
const GATE_ACTOR = { claim_level_evidence: RV, project_owner_approval: PO, customer_permission_if_required: CL, confidentiality_review: CR, privacy_legal_review_if_required: LG,
  brand_approval: BR, exact_revision_publication_authorization: SA };
const CHANNEL = 'spotlight-web';
const NOTES = (session = 'sess-001') => ({ session_id: session, project_ref: 'PRJ-1', details: [
  { id: 'D-001', field: 'problem', item_id: 'item-1', quote: 'Zebracorp claims were bouncing between three teams and payouts were slow.', status: 'reported', asr_min_conf: 0.91, audio_offset_ms: 12000 },
  { id: 'D-002', field: 'contribution', item_id: 'item-2', quote: 'I designed and built the routing model.', status: 'reported', asr_min_conf: 0.52, audio_offset_ms: 48500 },
  { id: 'D-003', field: 'intervention', item_id: 'item-3', quote: 'We shipped a triage queue with a routing model in front of it.', status: 'reported' },
  { id: 'D-004', field: 'measurement', item_id: 'item-4', quote: 'Triage fell from 40 to 12 minutes according to the dashboard.', status: 'uncertain', asr_min_conf: 0.7 },
  { id: 'D-005', field: 'outcome', item_id: 'item-5', quote: 'Adjusters now trust the queue order.', status: 'reported' },
  { id: 'D-006', field: 'limitations', item_id: 'item-6', quote: 'It does not handle commercial lines yet.', status: 'reported' },
] });
const REF = () => ({ title: 'Claims triage alias', stage: 'Production', sector: 'Insurance', consultant: { name: 'Alex', role: 'Data engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', start: '2025-03-01', consultants: [] }, answers: ['a', 'b', 'c', 'd', 'e', 'f'], validation: { manager: { name: 'Sam', email: 'SAM@mantu.com' }, managerStaff: false } });

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
function setup({ mode = 'mock', maxAttempts = 3, configured = true } = {}) {
  let t = 0, n = 0;
  const clock = { t: T0 }, l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') });
  if (configured) B.configure(l, { ...(mode ? { mode } : {}), now: () => clock.t, random: () => 0, maxAttempts, adapters: {} });
  return { l, ev: evidence(l), clock, ad: registry(l) };
}
const PURPOSES = ['skills_profile', 'cv', 'matching', 'public_spotlight'];
// draft -> grants (owner, bound to revision 1) -> submit -> approve. Returns the approved view.
async function approved(ctx, { session = 'sess-001', grants = ['skills_profile', 'cv', 'matching'], ref = false } = {}) {
  const { l, ev } = ctx, extra = ref ? { ref_id: (await l.upsert(OWNER, { localId: 'r-' + session, reference: REF() })).id } : {};
  const d = await ev.createDraftFromNotes(OWNER.email, { ...NOTES(session), ...extra });
  for (const purpose of grants) ev.grantPermission(OWNER, d.id, { expected_revision: d.revision, purpose });
  const q = ev.submit(OWNER.email, d.id, d.revision);
  const ok = await ev.review(REV, q.id, 'approve', { expected_revision: q.revision, content_hash: q.content_hash });
  return ok;
}
const status = (l, id) => Object.fromEntries(l.rows('SELECT branch, status FROM branch_status WHERE entity = ?', id).map(r => [r.branch, r.status]));
const reasons = (l, id) => Object.fromEntries(l.rows('SELECT branch, reason FROM branch_status WHERE entity = ?', id).map(r => [r.branch, r.reason]));
const card = (view, b) => view.cards.find(c => c.branch === b);
const BRANCH_IDS = ['evidence', 'maap', 'project_review', 'dna', 'mechat', 'imp', 'spotlight'];

test('approval creates seven independent branch records; each destination has its own permission check', async () => {
  const ctx = setup(), { l } = ctx, ok = await approved(ctx, { grants: ['skills_profile', 'cv'] }); // no matching grant
  assert.equal(ok.state, 'approved');
  const s = status(l, ok.id);
  assert.deepEqual(Object.keys(s).sort(), [...BRANCH_IDS].sort());
  assert.deepEqual(s, { evidence: 'evidence_approved', maap: 'maap_pending', project_review: 'project_review_pending', dna: 'mock_acknowledged', mechat: 'mock_acknowledged', imp: 'permission_pending', spotlight: 'spotlight_draft' });
  assert.deepEqual([reasons(l, ok.id).imp, reasons(l, ok.id).maap, reasons(l, ok.id).project_review], ['PURPOSE_NOT_GRANTED:matching', 'MAAP_NOT_CONFIGURED', 'PROJECT_REVIEW_NOT_CONFIGURED']);
  assert.deepEqual(ok.derivatives.filter(d => d.kind === 'branch').map(d => d.branch).sort(), [...BRANCH_IDS].sort(), 'the review view lists the derivatives');
  const none = setup(), bare = await approved(none, { session: 's-bare', grants: [] });
  assert.deepEqual([status(none.l, bare.id).dna, reasons(none.l, bare.id).dna, reasons(none.l, bare.id).mechat], ['permission_pending', 'PURPOSE_NOT_GRANTED:skills_profile', 'PURPOSE_NOT_GRANTED:cv']);
  assert.equal(none.ad.DNA_SKILLS_WRITEBACK.calls.length + none.ad.MECHAT_CV.calls.length, 0, 'no permission, nothing sent');
});

test('DNA succeeds while MeChat fails: per-card states, nothing rolled back, never one overall "complete" (W11)', async () => {
  const ctx = setup(), { l, ev, ad } = ctx;
  ad.MECHAT_CV.failNext(1, { retryable: false, error: 'MOCK_MECHAT_DOWN' });
  const ok = await approved(ctx), view = B.statusView(ev, OWNER, ok.id);
  assert.deepEqual(view.cards.map(c => c.branch), BRANCH_IDS);
  assert.deepEqual(view.cards.map(c => c.display_status), ['approved', 'pending', 'pending', 'mock_acknowledged', 'failed', 'mock_acknowledged', 'draft']);
  assert.deepEqual([card(view, 'mechat').reason, card(view, 'dna').reason, card(view, 'imp').reason], ['MOCK_MECHAT_DOWN', 'MOCK_NOT_SYNCED', 'MOCK_NOT_SYNCED']);
  assert.deepEqual(view.overall, { status: 'attention', complete: false });
  assert.equal(ad.DNA_SKILLS_WRITEBACK.calls.length, 1, 'DNA was delivered once and not touched by the MeChat failure');
  assert.equal(l.rows("SELECT status FROM approvals WHERE status = 'approved'").length, 1, 'the approval stands');
  assert.equal(ev.get(OWNER, ok.id).state, 'approved');
  for (const c of view.cards) assert.deepEqual(Object.keys(c), ['branch', 'label', 'status', 'display_status', 'mock', 'updated_at', 'reason']);
  assert.deepEqual(view.cards.map(c => c.mock), [false, false, false, true, true, true, true], 'destination cards are mock: nothing real is connected');
});

test('an adapter that throws on one branch is that branch\'s state only (W11)', async () => {
  const ctx = setup(), { ev, ad } = ctx; ad.IMP_CAPABILITY.send = async () => { throw new Error('socket hang up'); };
  const ok = await approved(ctx), view = B.statusView(ev, OWNER, ok.id);
  assert.deepEqual([card(view, 'imp').display_status, card(view, 'imp').reason, card(view, 'dna').display_status, card(view, 'mechat').display_status], ['in_progress', 'ADAPTER_EXCEPTION', 'mock_acknowledged', 'mock_acknowledged']);
  const broken = setup(); broken.ad.MECHAT_CV.send = undefined; // a programming error inside one adapter is caught per branch
  const b = await approved(broken); assert.equal(status(broken.l, b.id).dna, 'mock_acknowledged'); assert.equal(status(broken.l, b.id).mechat, 'retrying');
});

test('retry and backoff are deterministic: not run early, retried on schedule, dead-lettered after max attempts, then recovered by a reviewer', async () => {
  const ctx = setup(), { l, ev, ad, clock } = ctx; ad.MECHAT_CV.failAlways('MOCK_DOWN');
  const ok = await approved(ctx);
  assert.equal(status(l, ok.id).mechat, 'retrying'); assert.equal(card(B.statusView(ev, OWNER, ok.id), 'mechat').display_status, 'in_progress');
  const J = jobs(l), job = J.list(ok.id).find(j => j.destination === 'MeChat');
  assert.deepEqual([job.attempt, job.next_attempt_at], [1, new Date(T0 + 500).toISOString()]);
  assert.equal((await B.pump(ev)).ran, 0, 'not due yet'); assert.equal(ad.MECHAT_CV.calls.length, 1);
  clock.t = T0 + 500; assert.equal((await B.pump(ev)).ran, 1); assert.equal(status(l, ok.id).mechat, 'retrying'); assert.equal(J.get(job.job_id).next_attempt_at, new Date(T0 + 1500).toISOString());
  clock.t = T0 + 1500; await B.pump(ev);
  assert.deepEqual([status(l, ok.id).mechat, reasons(l, ok.id).mechat, J.get(job.job_id).attempt], ['failed', 'MOCK_DOWN', 3]); assert.equal(ad.MECHAT_CV.calls.length, 3);
  assert.equal(status(l, ok.id).dna, 'mock_acknowledged'); assert.equal((await B.pump(ev)).ran, 0, 'a dead-lettered job is left for a person');
  await assert.rejects(B.sync(ev, OWNER, ok.id, { recover_job: job.job_id }), e => e.status === 403); // the owner does not run recovery
  await assert.rejects(B.sync(ev, OTHER, ok.id, {}), e => e.status === 404);
  await assert.rejects(B.sync(ev, REV, ok.id, { recover_job: 'nope' }), e => e.status === 404);
  ad.MECHAT_CV.reset(); // the destination is back
  const view = await B.sync(ev, REV, ok.id, { recover_job: job.job_id });
  assert.deepEqual([card(view, 'mechat').display_status, J.get(job.job_id).status, J.get(job.job_id).attempt], ['mock_acknowledged', 'succeeded', 1]);
  await assert.rejects(B.sync(ev, REV, ok.id, { recover_job: job.job_id }), e => e.status === 409 && e.reason === 'JOB_NOT_FAILED');
});

test('a duplicate fan-out or job is a no-op: one job and one delivery per destination and revision', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx);
  await B.fanOut(ev, ok.id); await B.fanOut(ev, ok.id); await B.pump(ev);
  assert.deepEqual(jobs(l).list(ok.id).map(j => j.destination), ['DNA', 'MeChat', 'IMP']);
  assert.deepEqual([ad.DNA_SKILLS_WRITEBACK.calls.length, ad.MECHAT_CV.calls.length, ad.IMP_CAPABILITY.calls.length], [1, 1, 1]);
  const j = jobs(l).list(ok.id)[0], again = await jobs(l).enqueue({ entity: ok.id, revision: ok.revision, hash: ok.content_hash, destination: 'DNA', payload: { x: 1 } });
  assert.deepEqual([again.duplicate, again.job.job_id], [true, j.job_id]);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM jobs')[0].n, 3);
});

test('a destination that already holds a newer revision is not overwritten: needs_reconciliation', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, d = await ev.createDraftFromNotes(OWNER.email, NOTES('s-newer'));
  ad.DNA_SKILLS_WRITEBACK.setDestinationRevision(d.id, 9);
  for (const purpose of PURPOSES.slice(0, 3)) ev.grantPermission(OWNER, d.id, { expected_revision: 1, purpose });
  const q = ev.submit(OWNER.email, d.id, 1); await ev.review(REV, q.id, 'approve', { expected_revision: 1, content_hash: q.content_hash });
  const view = B.statusView(ev, OWNER, d.id);
  assert.deepEqual([card(view, 'dna').display_status, card(view, 'dna').reason, card(view, 'mechat').display_status], ['needs_reconciliation', 'DESTINATION_NEWER_REVISION', 'mock_acknowledged']);
  assert.equal(ad.DNA_SKILLS_WRITEBACK.records.get(d.id).revision, 9, 'the newer destination record was left alone');
  assert.deepEqual(view.overall, { status: 'attention', complete: false });
  assert.equal((await B.pump(ev)).ran, 0, 'reconciliation is not retried');
});

test('a mock acknowledgement is never sync_complete or published: the gate refuses it and no card can show it', async () => {
  const ctx = setup(), { l, ev } = ctx, ok = await approved(ctx), rec = ev.load(ok.id);
  const mockAck = { mock: true, revision: rec.revision, hash: rec.content_hash }, entity = ev.entity(rec), at = { now: ev.now(), expected_revision: rec.revision, content_hash: rec.content_hash };
  const sys = actor('atlas-system', 'system');
  for (const action of ['record_sync_complete', 'record_published']) {
    assert.deepEqual(decide(sys, action, entity, { ...at, destination_ack: mockAck }), { allow: false, reason: 'DESTINATION_ACK_NOT_LIVE' });
    assert.equal(decide(sys, action, entity, { ...at, destination_ack: { ...mockAck, mock: undefined } }).allow, false, 'a missing flag is not live');
    assert.equal(decide(sys, action, entity, at).reason, 'NO_DESTINATION_ACK');
  }
  const seen = new Set(l.rows('SELECT status FROM branch_status').map(r => r.status));
  assert.ok(!seen.has('sync_complete') && !seen.has('published'));
  const view = B.statusView(ev, OWNER, ok.id);
  assert.ok(view.cards.every(c => !['sync_complete', 'published'].includes(c.display_status)));
  assert.equal(view.overall.complete, false); assert.ok(view.cards.filter(c => c.mock).every(c => c.mock === true));
  assert.ok(B.BRANCH_STATUSES.includes('sync_complete') && !Object.values(CONTRACTS).some(c => c.live), 'the vocabulary has the statuses; no adapter can reach them');
  // The only way there is a non-mock acknowledgement bound to this exact revision. A test double (not a real destination) shows the path is gated:
  const live = setup(), liveAd = createMockAdapter('DNA_SKILLS_WRITEBACK'), send = liveAd.send;
  liveAd.send = async (job, payload) => { const r = await send(job, payload); return { ...r, ack: { ...r.ack, mock: false, destination_record_id: 'real-1' } }; };
  live.ad.DNA_SKILLS_WRITEBACK = liveAd;
  const good = await approved(live, { session: 's-live', grants: ['skills_profile'] });
  assert.deepEqual([status(live.l, good.id).dna, B.statusView(live.ev, OWNER, good.id).cards[3].mock], ['sync_complete', false]);
  const liar = setup(); liar.ad.DNA_SKILLS_WRITEBACK = { send: async () => ({ ok: true, ack: { mock: false, destination_record_id: 'x', destination_revision: 1 } }) }; // unbound: no revision/hash
  const bad = await approved(liar, { session: 's-liar', grants: ['skills_profile'] });
  assert.deepEqual([status(liar.l, bad.id).dna, reasons(liar.l, bad.id).dna], ['needs_reconciliation', 'DESTINATION_ACK_NOT_BOUND_TO_REVISION']);
  assert.equal(B.overallOf(B.statusView(live.ev, OWNER, good.id).cards).complete, false, 'MAAP and Project Review can never close here');
});

test('adapters are contract-driven mocks with failure injection; every ack says mock:true', async () => {
  const ctx = setup(), { ev, ad } = ctx, ok = await approved(ctx);
  assert.deepEqual(Object.keys(ad).sort(), ['DNA_SKILLS_WRITEBACK', 'IMP_CAPABILITY', 'MAAP', 'MECHAT_CV', 'PROJECT_REVIEW', 'SPOTLIGHT_CMS']);
  assert.equal(ad.MECHAT_CV.label, 'MeChat (CV) — not connected, mock');
  for (const [name, c] of Object.entries(CONTRACTS)) assert.equal(ad[name].mock, true, name);
  const acks = jobs(ctx.l).list(ok.id).map(j => j.destination_ack);
  assert.equal(acks.length, 3); for (const a of acks) { assert.equal(a.mock, true); assert.match(a.note, /Nothing was sent to a real system/); assert.equal(a.destination_revision, 1); }
  const fresh = createMockAdapter('IMP_CAPABILITY'), job = { job_id: 'j', idempotency_key: 'k:IMP', destination: 'IMP', source_entity_id: 'e', source_revision: 2, payload_hash: 'p' };
  fresh.failNext(2, { error: 'X' }); fresh.setDestinationRevision('other', 4);
  assert.deepEqual([(await fresh.send(job, {})).error, (await fresh.send(job, {})).error, (await fresh.send(job, {})).ok], ['X', 'X', true]);
  assert.equal((await fresh.send(job, {})).duplicate, true, 'the destination dedupes by idempotency key');
  assert.equal((await fresh.send({ ...job, idempotency_key: 'k2', source_entity_id: 'other' }, {})).conflict, true);
  fresh.failNext(1, { throws: true, error: 'boom' }); await assert.rejects(fresh.send({ ...job, idempotency_key: 'k3' }, {})); fresh.reset(); assert.equal(fresh.calls.length, 0);
  assert.throws(() => createMockAdapter('NOPE'));
});

test('payloads come from the approved revision only: no transcript, source_refs, ledger or session ids, and nothing restricted to MeChat', async () => {
  const ctx = setup(), { ad } = ctx, ok = await approved(ctx);
  const sent = n => ad[n].calls[0].payload, dump = JSON.stringify([sent('DNA_SKILLS_WRITEBACK'), sent('MECHAT_CV'), sent('IMP_CAPABILITY')]);
  for (const leak of ['source_refs', 'sess-001', 'item-1', 'D-001', 'ledger', 'quote', 'asr_min_conf', 'audio_offset', 'provenance', 'created_by']) assert.ok(!dump.includes(leak), leak);
  const cv = sent('MECHAT_CV');
  assert.deepEqual([...new Set(cv.claims.map(c => c.claim_type))].sort(), ['deliverable', 'metric', 'outcome', 'responsibility']); // context (problem) and learning (limitations) stay out
  assert.ok(!JSON.stringify(cv).includes('commercial lines') && !JSON.stringify(cv).includes('bouncing between'));
  assert.deepEqual([cv.consultant_id, cv.profile_revision, cv.language, cv.permissions.length], [OWNER.email, 1, null, 1]);
  const dna = sent('DNA_SKILLS_WRITEBACK');
  assert.deepEqual([dna.reviewer, dna.effective_date, dna.assertions.every(a => a.skill_taxonomy_id === null && a.level === null && a.status === 'proposed')], [REV.email, dna.effective_date, true]);
  assert.ok(dna.assertions.length >= 2); assert.deepEqual(dna.assertions[0].evidence_refs[0], { claim_id: dna.assertions[0].claim_id, revision: 1 });
  assert.equal(sent('IMP_CAPABILITY').availability, null, 'availability is IMP\'s, never computed');
  for (const p of [sent('DNA_SKILLS_WRITEBACK'), sent('MECHAT_CV'), sent('IMP_CAPABILITY')]) assert.deepEqual([p.entity_id, p.source_revision, p.content_hash], [ok.id, 1, ok.content_hash]);
  assert.throws(() => buildPayload('SPOTLIGHT_CMS', {}));
});

test('revoking a permission flags what was derived under it for impact review, unless another grant still allows it (D11)', async () => {
  const ctx = setup(), { l, ev } = ctx, ok = await approved(ctx);
  const grants = ev.grantsFor(ok.id), dna = grants.find(g => g.purpose === 'skills_profile');
  ev.revokePermission(OWNER, ok.id, dna.id, { expected_revision: 1 });
  assert.deepEqual([status(l, ok.id).dna, reasons(l, ok.id).dna, status(l, ok.id).mechat, status(l, ok.id).imp], ['impact_review', 'PERMISSION_REVOKED:skills_profile', 'mock_acknowledged', 'mock_acknowledged']);
  const view = B.statusView(ev, OWNER, ok.id); assert.deepEqual([card(view, 'dna').display_status, view.overall.status], ['impact_review', 'attention']);
  await B.fanOut(ev, ok.id); assert.equal(status(l, ok.id).dna, 'impact_review', 'a flagged branch stays flagged for this revision until a person clears it');
  const twin = setup(), two = await twin.ev.createDraftFromNotes(OWNER.email, NOTES('s-two'));
  const g1 = twin.ev.grantPermission(OWNER, two.id, { expected_revision: 1, purpose: 'cv' }); twin.ev.grantPermission(OWNER, two.id, { expected_revision: 1, purpose: 'cv' });
  const q = twin.ev.submit(OWNER.email, two.id, 1); await twin.ev.review(REV, q.id, 'approve', { expected_revision: 1, content_hash: q.content_hash });
  twin.ev.revokePermission(OWNER, two.id, g1.id, { expected_revision: 1 }); assert.equal(status(twin.l, two.id).mechat, 'mock_acknowledged', 'one grant remains');
  const late = setup(), pend = await approved(late, { session: 's-late', grants: [] });
  assert.equal(status(late.l, pend.id).mechat, 'permission_pending'); // nothing was derived, so a revoke has nothing to flag
});

test('a grant after approval lets the waiting branch proceed; a grant bound to an older revision never does', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx, { grants: [] });
  assert.equal(status(l, ok.id).dna, 'permission_pending');
  ev.grantPermission(OWNER, ok.id, { expected_revision: 1, purpose: 'skills_profile' }); await B.afterGrant(ev, ok.id);
  assert.deepEqual([status(l, ok.id).dna, status(l, ok.id).mechat, ad.DNA_SKILLS_WRITEBACK.calls.length], ['mock_acknowledged', 'permission_pending', 1]);
  const am = await ev.review(OWNER, ok.id, 'amend', { expected_revision: 1, add: [{ statement: 'We added a dashboard for adjusters.', claim_type: 'technology' }] });
  const q = ev.submit(OWNER.email, ok.id, am.revision), again = await ev.review(REV, ok.id, 'approve', { expected_revision: q.revision, content_hash: q.content_hash });
  assert.equal(again.revision, 2);
  assert.deepEqual([status(l, ok.id).dna, reasons(l, ok.id).dna], ['permission_pending', 'PURPOSE_GRANT_NOT_BOUND_TO_REVISION:skills_profile']);
});

test('Spotlight: blocked while ANY gate is open, in the pack\'s order; the mock CMS then holds it and can never publish', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx, { ref: true, grants: [...PURPOSES] }), id = ok.id, at = { expected_revision: 1, content_hash: ok.content_hash };
  assert.equal(status(l, id).spotlight, 'spotlight_draft');
  assert.deepEqual(await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL }), { allow: false, reason: 'STORY_NOT_AWAITING_APPROVAL:spotlight_draft' });
  assert.throws(() => B.requestSpotlightApproval(ev, { sub: OWNER.email, roles: [] }, id, at), e => e.reason === 'ROLE_NOT_PERMITTED');
  assert.throws(() => B.requestSpotlightApproval(ev, RV, id, { expected_revision: 9, content_hash: ok.content_hash }), e => e.reason === 'REVISION_MISMATCH');
  assert.equal(B.requestSpotlightApproval(ev, RV, id, at), 'spotlight_approval_pending');
  assert.equal(status(l, id).spotlight, 'spotlight_approval_pending');
  assert.throws(() => B.requestSpotlightApproval(ev, RV, id, at), e => e.reason === 'STORY_NOT_DRAFT');
  for (let i = 0; i < GATES.length; i++) {
    const denied = await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL });
    assert.deepEqual(denied, { allow: false, reason: `SPOTLIGHT_GATE_OPEN:${GATES[i]}` }, `gate ${i} open`);
    assert.equal(ad.SPOTLIGHT_CMS.calls.length, 0, 'the CMS is not asked while a gate is open'); assert.equal(reasons(l, id).spotlight, `SPOTLIGHT_GATE_OPEN:${GATES[i]}`);
    const gate = GATES[i];
    if (gate === 'privacy_legal_review_if_required') B.approveSpotlightGate(ev, LG, id, gate, { ...at, decision: 'not_required', reason: 'No personal data beyond the consultant\'s own role.' });
    else B.approveSpotlightGate(ev, GATE_ACTOR[gate], id, gate, { ...at, ...(gate === 'exact_revision_publication_authorization' ? { channel: CHANNEL } : {}) });
  }
  const sp = new Spotlight(ev); assert.deepEqual(Object.values(sp.story(id).story.approval_state).every(Boolean), true);
  const out = await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL });
  assert.deepEqual([out.allow, out.sent, out.status], [true, true, 'publication_held']);
  assert.equal(ad.SPOTLIGHT_CMS.calls.length, 1);
  const sent = ad.SPOTLIGHT_CMS.calls[0], dump = JSON.stringify(sent.payload);
  assert.deepEqual([sent.payload.audience, sent.payload.channel, sent.payload.revision_hash, sent.destination], ['public', CHANNEL, ok.content_hash, 'Spotlight']);
  for (const leak of ['internal_notes', 'source_refs', 'approval_state', 'sess-001', 'item-', 'D-00', 'ledger', 'Zebracorp', 'asr_']) assert.ok(!dump.includes(leak), leak); // the client is anonymised; no internal ids
  assert.match(dump, /Cliente anonimizado/); assert.match(dump, /routing model in front of it/);
  const ack = jobs(l).list(id).find(j => j.destination === 'Spotlight').destination_ack;
  assert.deepEqual([ack.mock, ack.published, ack.canonical_url, ack.publication_state], [true, false, null, 'mock_held']);
  const view = B.statusView(ev, OWNER, id);
  assert.deepEqual([card(view, 'spotlight').display_status, card(view, 'spotlight').reason, card(view, 'spotlight').mock], ['held', 'MOCK_CMS_NOT_PUBLISHED', true]);
  assert.ok(!l.rows('SELECT status FROM branch_status').some(r => r.status === 'published') && sp.story(id).status === 'publication_held');
  assert.deepEqual(await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL }), { allow: false, reason: 'STORY_NOT_AWAITING_APPROVAL:publication_held' });
});

test('Spotlight gates: roles, self-approval, revision binding, the channel, the public permission and the library status', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx, { ref: true, grants: [] }), id = ok.id, at = { expected_revision: 1, content_hash: ok.content_hash };
  B.requestSpotlightApproval(ev, RV, id, at);
  assert.throws(() => B.approveSpotlightGate(ev, BR, id, 'confidentiality_review', at), e => e.reason === 'ROLE_NOT_PERMITTED'); // brand cannot close confidentiality
  assert.throws(() => B.approveSpotlightGate(ev, actor(OWNER.email, 'brand_approver'), id, 'brand_approval', at), e => e.reason === 'SELF_APPROVAL');
  assert.throws(() => B.approveSpotlightGate(ev, actor('admin@mantu.com', 'admin'), id, 'brand_approval', at), e => e.reason === 'ROLE_NOT_PERMITTED', 'no gate has an admin override');
  assert.throws(() => B.approveSpotlightGate(ev, BR, id, 'brand_approval', { ...at, expected_revision: 2 }), e => e.reason === 'REVISION_MISMATCH');
  assert.throws(() => B.approveSpotlightGate(ev, SA, id, 'exact_revision_publication_authorization', at), e => e.reason === 'CHANNEL_REQUIRED');
  assert.throws(() => B.approveSpotlightGate(ev, BR, id, 'nonsense', at), e => /^UNKNOWN_GATE/.test(e.reason));
  assert.throws(() => B.approveSpotlightGate(ev, BR, id, 'brand_approval', { ...at, decision: 'not_required', reason: 'x' }), e => e.status === 400); // only _if_required gates
  for (const g of GATES) B.approveSpotlightGate(ev, GATE_ACTOR[g], id, g, { ...at, channel: CHANNEL, ...(g === 'privacy_legal_review_if_required' ? { decision: 'not_required', reason: 'No legal check needed.' } : {}) });
  assert.deepEqual(await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL }), { allow: false, reason: 'PURPOSE_NOT_GRANTED:public_spotlight' }, 'every gate closed, but the owner has not granted public use');
  ev.grantPermission(OWNER, id, { expected_revision: 1, purpose: 'public_spotlight' });
  assert.equal((await B.publishSpotlight(ev, SA, id, { ...at, channel: 'other-channel' })).reason, 'SPOTLIGHT_GATE_OPEN:exact_revision_publication_authorization', 'the authorization names its channel');
  assert.equal((await B.publishSpotlight(ev, actor('x@mantu.com', 'publisher'), id, { ...at, channel: CHANNEL })).allow, true);
  assert.equal(ad.SPOTLIGHT_CMS.calls.length, 1);
  assert.deepEqual(decide(RV, 'map_library_status_to_spotlight', ev.entity(ev.load(id)), {}), { allow: false, reason: 'LIBRARY_PUBLISHED_NOT_SPOTLIGHT' }); // D17
  assert.equal(decide(SA, 'spotlight_publish', ev.entity(ev.load(id)), { ...at, derived_from_library_status: true }).reason, 'LIBRARY_PUBLISHED_NOT_SPOTLIGHT');
  const bare = new Spotlight(ev), rec = ev.load(id);
  assert.equal(rec.status, 'approved'); assert.ok(l.rows("SELECT 1 FROM spotlight_gates WHERE gate = 'brand_approval' AND approver_sub = ?", BR.sub).length === 1);
  assert.deepEqual(bare.gatesFor(id).brand_approval, { status: 'approved', revision: 1, hash: ok.content_hash, approver_sub: BR.sub, channel: null, reason: null, decided_by: null, at: bare.gatesFor(id).brand_approval.at });
});

test('a new evidence revision resets the story\'s approval flags and supersedes every gate, so nothing approved earlier can publish (T14 follow-up)', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx, { ref: true, grants: [...PURPOSES] }), id = ok.id, at = { expected_revision: 1, content_hash: ok.content_hash };
  B.requestSpotlightApproval(ev, RV, id, at);
  for (const g of GATES) B.approveSpotlightGate(ev, GATE_ACTOR[g], id, g, { ...at, channel: CHANNEL, ...(g === 'privacy_legal_review_if_required' ? { decision: 'not_required', reason: 'No legal check needed.' } : {}) });
  const sp = new Spotlight(ev); assert.ok(Object.values(sp.story(id).story.approval_state).every(Boolean));
  const am = await ev.review(OWNER, id, 'amend', { expected_revision: 1, add: [{ statement: 'We also reduced rework.', claim_type: 'outcome' }] });
  assert.equal(am.revision, 2);
  assert.deepEqual(Object.values(sp.story(id).story.approval_state), [false, false, false, false, false, false]);
  assert.deepEqual(l.rows('SELECT DISTINCT status FROM spotlight_gates').map(r => r.status), ['superseded']);
  assert.deepEqual([status(l, id).spotlight, reasons(l, id).spotlight, status(l, id).dna, status(l, id).evidence], ['impact_review', 'EVIDENCE_REVISION_CHANGED', 'impact_review', 'superseded']);
  assert.deepEqual([card(B.statusView(ev, OWNER, id), 'evidence').display_status, card(B.statusView(ev, OWNER, id), 'spotlight').display_status], ['draft', 'impact_review'], 'the evidence card follows the live record');
  const q = ev.submit(OWNER.email, id, 2), again = await ev.review(REV, id, 'approve', { expected_revision: 2, content_hash: q.content_hash });
  assert.equal(status(l, id).spotlight, 'spotlight_draft'); assert.equal(sp.story(id).revision, 2); assert.equal(sp.story(id).story.approval_state.evidence_validated, true);
  B.requestSpotlightApproval(ev, RV, id, { expected_revision: 2, content_hash: again.content_hash });
  assert.equal((await B.publishSpotlight(ev, SA, id, { expected_revision: 2, content_hash: again.content_hash, channel: CHANNEL })).reason, 'SPOTLIGHT_GATE_OPEN:claim_level_evidence', 'the earlier approvals were bound to revision 1');
  assert.equal(ad.SPOTLIGHT_CMS.calls.length, 0);
});

test('a job stuck for an older revision never delivers: a new revision halts them as SOURCE_SUPERSEDED', async () => {
  const ctx = setup(), { l, ev, ad } = ctx; ad.DNA_SKILLS_WRITEBACK.failAlways('MOCK_DOWN');
  const ok = await approved(ctx); assert.equal(status(l, ok.id).dna, 'retrying');
  await ev.review(OWNER, ok.id, 'amend', { expected_revision: 1, add: [{ statement: 'We added a dashboard.', claim_type: 'technology' }] });
  const j = jobs(l).list(ok.id).find(x => x.destination === 'DNA'); assert.deepEqual([j.status, j.last_error], ['needs_reconciliation', 'SOURCE_SUPERSEDED']);
  ctx.clock.t += 3_600_000; assert.equal((await B.pump(ev)).ran, 0); assert.equal(ad.DNA_SKILLS_WRITEBACK.calls.length, 1);
});

test('withdrawn after approval: every branch goes to impact review and nothing more is sent; completing the review closes them (D11)', async () => {
  const ctx = setup(), { l, ev, ad } = ctx; ad.MECHAT_CV.failAlways('MOCK_DOWN');
  const ok = await approved(ctx);
  const w = await ev.review(OWNER, ok.id, 'withdraw', { expected_revision: 1, reason: 'Wrong project' }); assert.equal(w.state, 'impact_review');
  assert.deepEqual(Object.values(status(l, ok.id)), Array(7).fill('impact_review'));
  assert.deepEqual(w.impact.derivatives.filter(d => d.kind === 'branch').map(d => d.status).sort(),
    ['evidence_approved', 'maap_pending', 'mock_acknowledged', 'mock_acknowledged', 'project_review_pending', 'retrying', 'spotlight_draft'], 'the derivatives were listed before they were flagged');
  assert.equal(jobs(l).list(ok.id).find(j => j.destination === 'MeChat').status, 'needs_reconciliation'); ctx.clock.t += 3_600_000; assert.equal((await B.pump(ev)).ran, 0);
  const view = B.statusView(ev, OWNER, ok.id); assert.deepEqual([view.overall.status, card(view, 'evidence').display_status], ['attention', 'impact_review']);
  await ev.review(REV2, ok.id, 'complete_impact_review', { expected_revision: 1 });
  assert.deepEqual(Object.values(status(l, ok.id)), Array(7).fill('withdrawn'));
});

test('MAAP and Project Review are shells: no rubric, so rate and close are denied by the gate', async () => {
  const ctx = setup(), { ad } = ctx, ok = await approved(ctx);
  assert.deepEqual(ad.MAAP.rate(), { allow: false, reason: 'MAAP_NOT_CONFIGURED' }); assert.deepEqual(ad.MAAP.close(), { allow: false, reason: 'MAAP_NOT_CONFIGURED' });
  assert.deepEqual(ad.PROJECT_REVIEW.rate(), { allow: false, reason: 'PROJECT_REVIEW_NOT_CONFIGURED' }); assert.deepEqual(ad.PROJECT_REVIEW.close(), { allow: false, reason: 'PROJECT_REVIEW_NOT_CONFIGURED' });
  assert.deepEqual([ad.MAAP.rubric, ad.MAAP.configured, ad.PROJECT_REVIEW.rubric], ['MUST_BE_CONFIGURED_BY_PROCESS_OWNER', false, 'MUST_BE_CONFIGURED_BY_PROCESS_OWNER']);
  assert.deepEqual(await ad.MAAP.send(), { ok: false, retryable: false, error: 'MAAP_NOT_CONFIGURED' });
  const entity = ctx.ev.entity(ctx.ev.load(ok.id));
  for (const [a, reason] of [['maap_rate', 'MAAP_NOT_CONFIGURED'], ['maap_outcome', 'MAAP_NOT_CONFIGURED'], ['project_review_close', 'PROJECT_REVIEW_NOT_CONFIGURED'], ['rate_consultant', 'FORBIDDEN_ACTION']]) {
    assert.deepEqual(decide(RV, a, entity, {}), { allow: false, reason }, a); // a reviewer cannot rate either, whatever the role
  }
});

test('flags and modes: ATLAS_ADAPTERS is off, mock or blocked (live); ATLAS_EVIDENCE_WORKFLOW=off turns the whole thing off', async () => {
  assert.deepEqual([adapterMode({}).mode, adapterMode({ ATLAS_ADAPTERS: 'mock' }).mode, adapterMode({ ATLAS_ADAPTERS: ' MOCK ' }).mode, adapterMode({ ATLAS_ADAPTERS: 'maybe' }).mode, adapterMode({ ATLAS_ADAPTERS: 'off' }).mode], ['off', 'mock', 'mock', 'off', 'off']);
  assert.deepEqual([adapterMode({ ATLAS_ADAPTERS: 'live' }).mode, adapterMode({ ATLAS_ADAPTERS: 'live' }).code], ['blocked', 'BLOCKED_EXTERNAL']);
  assert.deepEqual([flags({}).evidence_workflow, flags({ ATLAS_EVIDENCE_WORKFLOW: 'off' }).evidence_workflow, flags({ ATLAS_EVIDENCE_WORKFLOW: '1' }).evidence_workflow, evidenceWorkflowOn(undefined)], [true, false, true, true]);
  const off = setup({ mode: 'off' }), a = await approved(off); // adapters off: permitted, but nothing is queued or sent
  assert.deepEqual([status(off.l, a.id).dna, reasons(off.l, a.id).dna, off.l.rows('SELECT COUNT(*) AS n FROM jobs')[0].n], ['projection_pending', 'ADAPTERS_OFF', 0]);
  const view = B.statusView(off.ev, OWNER, a.id); assert.deepEqual([view.adapters, card(view, 'dna').display_status, card(view, 'dna').mock], ['off', 'pending', true]);
  const live = setup({ mode: 'live' }), b = await approved(live);
  assert.deepEqual([status(live.l, b.id).mechat, reasons(live.l, b.id).mechat, live.ad.MECHAT_CV.calls.length, card(B.statusView(live.ev, OWNER, b.id), 'mechat').display_status], ['blocked_external', 'BLOCKED_EXTERNAL', 0, 'blocked_external']);
  const rolled = setup({ configured: false }), c = await approved(rolled, { session: 's-unconfigured' });
  assert.equal(rolled.l.rows('SELECT COUNT(*) AS n FROM branch_status')[0].n, 0, 'evidence on its own behaves as in T13: no fan-out until configured');
  assert.equal(c.state, 'approved');
});

test('routes: status cards, the sync recovery route and permission routes; identity from the headers; flag off answers 404', async () => {
  const { l, ev } = setup({ mode: undefined }); let clock = T0;
  B.configure(l, { now: () => clock });
  const env = { ATLAS_ADAPTERS: 'mock' };
  const call = (method, path, who, body, e = env) => libraryRoutes(new Request('https://atlas.test' + path, { method, headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, 'x-atlas-email': who.email }, ...(body ? { body: JSON.stringify(body) } : {}) }), l, { env: e })
    .then(async r => ({ status: r.status, body: await r.json() }));
  const made = await call('POST', '/api/evidence', OWNER, { notes: NOTES('s-http') }), id = made.body.id, base = '/api/library/evidence/' + id;
  const s0 = await call('GET', base + '/status', OWNER);
  assert.equal(s0.status, 200); assert.deepEqual(s0.body.cards.map(c => c.branch), BRANCH_IDS);
  assert.deepEqual(s0.body.cards.map(c => c.display_status), ['draft', 'not_started', 'not_started', 'not_started', 'not_started', 'not_started', 'not_started']);
  assert.equal(s0.body.cards[3].reason, 'AWAITING_EVIDENCE_APPROVAL'); assert.equal(s0.body.overall.complete, false);
  assert.equal((await call('GET', base + '/status', OTHER)).status, 404); assert.equal((await call('GET', base + '/status', REV)).status, 404, 'a reviewer cannot see a draft');
  assert.equal((await call('GET', '/api/library/evidence/nope/status', OWNER)).status, 404);
  assert.equal((await call('POST', base + '/status', OWNER, {})).status, 404);
  const g = await call('POST', base + '/permissions', OWNER, { expected_revision: 1, purpose: 'cv' }); assert.deepEqual([g.status, g.body.purpose, g.body.status], [201, 'cv', 'active']);
  assert.equal((await call('POST', base + '/permissions', OTHER, { expected_revision: 1, purpose: 'cv' })).status, 404);
  assert.equal((await call('POST', base + '/permissions', OWNER, { expected_revision: 1, purpose: 'nonsense' })).status, 403);
  const sub = await call('POST', base + '/submit', OWNER, { expected_revision: 1 });
  const ap = await call('POST', base + '/review', REV, { action: 'approve', expected_revision: 1, content_hash: sub.body.content_hash }); assert.equal(ap.status, 200);
  const s1 = await call('GET', base + '/status', REV);
  assert.deepEqual(s1.body.cards.map(c => c.display_status), ['approved', 'pending', 'pending', 'waiting_permission', 'mock_acknowledged', 'waiting_permission', 'draft']);
  assert.deepEqual([s1.body.cards[3].reason, s1.body.cards[1].reason, s1.body.overall, s1.body.adapters], ['PURPOSE_NOT_GRANTED:skills_profile', 'MAAP_NOT_CONFIGURED', { status: 'in_progress', complete: false }, 'mock']);
  assert.deepEqual(s1.body.jobs.map(j => [j.destination, j.status, j.mock]), [['MeChat', 'succeeded', true]]);
  assert.ok(!JSON.stringify(s1.body).includes('Zebracorp') && !JSON.stringify(s1.body).includes('statement'), 'the status view carries no claim text');
  const g2 = await call('POST', base + '/permissions', OWNER, { expected_revision: 1, purpose: 'skills_profile' }); assert.equal(g2.status, 201);
  assert.equal((await call('GET', base + '/status', OWNER)).body.cards[3].display_status, 'mock_acknowledged', 'a grant lets the waiting branch proceed');
  const rv = await call('POST', `${base}/permissions/${g2.body.id}/revoke`, OWNER, { expected_revision: 1 }); assert.deepEqual([rv.status, rv.body.status], [200, 'revoked']);
  assert.equal((await call('GET', base + '/status', OWNER)).body.cards[3].display_status, 'impact_review');
  assert.equal((await call('POST', `${base}/permissions/${g2.body.id}/revoke`, OTHER, { expected_revision: 1 })).status, 404);
  const sync = await call('POST', base + '/sync', REV, {}); assert.equal(sync.status, 200); assert.equal(sync.body.cards.length, 7);
  assert.equal((await call('POST', base + '/sync', OWNER, {})).status, 403);
  const closed = await call('GET', base + '/status', OWNER, undefined, { ATLAS_EVIDENCE_WORKFLOW: 'off' }); assert.equal(closed.status, 404);
  assert.equal((await call('POST', base + '/sync', REV, {}, { ATLAS_EVIDENCE_WORKFLOW: 'off' })).status, 404);
  assert.equal(ev.get(OWNER, id).state, 'approved');
});

test('the daily trigger runs due jobs (scan-stale) and answers as before', async () => {
  const ctx = setup({ mode: undefined }), { l, ev, ad, clock } = ctx, env = { ATLAS_ADAPTERS: 'mock' };
  const call = (method, path, who, body) => libraryRoutes(new Request('https://atlas.test' + path, { method, headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, 'x-atlas-email': who.email }, ...(body ? { body: JSON.stringify(body) } : {}) }), l, { env })
    .then(async r => ({ status: r.status, body: await r.json() }));
  ad.IMP_CAPABILITY.failNext(1, { error: 'MOCK_DOWN' });
  const d = await ev.createDraftFromNotes(OWNER.email, NOTES('s-cron')); for (const p of ['skills_profile', 'cv', 'matching']) ev.grantPermission(OWNER, d.id, { expected_revision: 1, purpose: p });
  const q = ev.submit(OWNER.email, d.id, 1); const ap = await call('POST', `/api/library/evidence/${d.id}/review`, REV, { action: 'approve', expected_revision: 1, content_hash: q.content_hash });
  assert.equal(ap.status, 200); assert.equal(status(l, d.id).imp, 'retrying');
  clock.t = T0 + 500;
  const swept = await call('POST', '/api/library/scan-stale', { email: 'atlas-cron', role: 'system' }, {});
  assert.equal(swept.status, 200); assert.deepEqual(Object.keys(swept.body), ['invited']);
  assert.equal(status(l, d.id).imp, 'mock_acknowledged');
});
