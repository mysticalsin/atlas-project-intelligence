// Agent Brain v2.1 T16: the workflow evaluation. Pack scenarios 10-16 (07_Evaluation_and_QA/ATLAS_Evaluation_Framework.md section 3), the twelve workflow
// acceptance tests W1-W12 (ATLAS_v2.1_Workflow_and_Template_Acceptance_Tests.md), the MAAP shell tests (04_Workflows/MAAP_Review_Specification.md section 8)
// and the release gates that can be checked offline (framework section 4). Every test name starts with its id so that eval/COVERAGE.md can point at it.
// Real code throughout: the evidence store, the review machine, the policy gate, the branch fan-out, the job queue (node:sqlite), the Worker's handle() and the
// Session. Only the destinations are mocks (adapters.js: mock:true on every acknowledgement), because no live DNA, MeChat, IMP, MAAP or Spotlight exists.
// Where a requirement cannot be met today the test pins what is actually there and COVERAGE.md says PARTIAL, rather than faking it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { evidence, claimsFromNotes, postDraftFromInterview } from '../src/evidence.js';
import { decide } from '../src/policy-gate.js';
import * as B from '../src/branches.js';
import { jobs } from '../src/jobs.js';
import { Spotlight, GATES } from '../src/spotlight.js';
import { registry, CONTRACTS } from '../src/adapters.js';
import { shortlist } from '../src/customer-jev.js';
import { handle } from '../src/app.js';
import { projectContext } from '../src/session.js';
import { ReplyGuard } from '../src/speech.js';
import { BANNED_PRAISE_SRC, WORKFLOW_CONFIG } from '../src/policy.generated.js';
import { TRANSITIONS } from '../src/conversation-state.js';
import { memorySql } from './sqlite.js';
import { ensure as ensureOutreach } from '../src/outreach.js';
import { rig, opened, talked, send, until, cleanup, named, PROJECT, startMsg } from './reconnect-harness.js';

test.afterEach(cleanup);

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
  { id: 'D-007', field: 'decision', item_id: 'item-7', quote: 'We chose the model over rules after a pilot.', status: 'reported' },
] });
const REF = () => ({ title: 'Claims triage alias', stage: 'Production', sector: 'Insurance', consultant: { name: 'Alex', role: 'Data engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', start: '2025-03-01', consultants: [] }, answers: ['a', 'b', 'c', 'd', 'e', 'f'], validation: { manager: { name: 'Sam', email: 'SAM@mantu.com' }, managerStaff: false } });

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const SEEN = new Set(); // every evidence-machine transition any test below made: G5 compares it with the machine's own table
function setup({ mode = 'mock', maxAttempts = 3 } = {}) {
  let t = 0, n = 0;
  const clock = { t: T0 }, l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') });
  B.configure(l, { mode, now: () => clock.t, random: () => 0, maxAttempts, adapters: {} });
  return { l, ev: evidence(l), clock, ad: registry(l) };
}
const trail = ctx => { for (const r of ctx.l.rows('SELECT event, from_state, to_state FROM workflow_transitions')) SEEN.add([r.event, r.from_state, r.to_state].join('>')); };
const PURPOSES = ['skills_profile', 'cv', 'matching', 'public_spotlight'];
const draft = (ctx, session = 'sess-001', extra = {}) => ctx.ev.createDraftFromNotes(OWNER.email, { ...NOTES(session), ...extra });
const queued = async (ctx, session = 'sess-001', extra = {}) => { const d = await draft(ctx, session, extra); return ctx.ev.submit(OWNER.email, d.id, d.revision); };
// draft -> owner grants (bound to revision 1) -> submit -> approve by a reviewer: the approved view, with the fan-out already done.
async function approved(ctx, { session = 'sess-001', grants = ['skills_profile', 'cv', 'matching'], ref = false } = {}) {
  const { l, ev } = ctx, extra = ref ? { ref_id: (await l.upsert(OWNER, { localId: 'r-' + session, reference: REF() })).id } : {};
  const d = await draft(ctx, session, extra);
  for (const purpose of grants) ev.grantPermission(OWNER, d.id, { expected_revision: d.revision, purpose });
  const q = ev.submit(OWNER.email, d.id, d.revision);
  return ev.review(REV, q.id, 'approve', { expected_revision: q.revision, content_hash: q.content_hash });
}
const status = (l, id) => Object.fromEntries(l.rows('SELECT branch, status FROM branch_status WHERE entity = ?', id).map(r => [r.branch, r.status]));
const reasons = (l, id) => Object.fromEntries(l.rows('SELECT branch, reason FROM branch_status WHERE entity = ?', id).map(r => [r.branch, r.reason]));
const card = (view, b) => view.cards.find(c => c.branch === b);
const BRANCH_IDS = ['evidence', 'maap', 'project_review', 'dna', 'mechat', 'imp', 'spotlight'];
const rejects = (p, status, reason) => assert.rejects(Promise.resolve().then(typeof p === 'function' ? p : () => p), e => e.status === status && (reason === undefined || e.reason === reason || String(e.message).includes(reason)), `expected ${status} ${reason ?? ''}`);
const closeGates = (ev, id, at, channel = CHANNEL) => { for (const g of GATES) B.approveSpotlightGate(ev, GATE_ACTOR[g], id, g, { ...at, channel, ...(g === 'privacy_legal_review_if_required' ? { decision: 'not_required', reason: 'No legal check needed.' } : {}) }); };

// =============================================================================================================================================================
// Pack scenarios 10-16
// =============================================================================================================================================================

test('S10 manager and consultant disagree: both views are retained, side by side, and nothing is overwritten', async () => {
  const ctx = setup(), { ev } = ctx, v = await queued(ctx), metric = v.claims.find(c => c.source_refs[0].field === 'measurement');
  const reason = 'The 40-to-12 figure has no source.', rationale = 'The operations dashboard export is the source.';
  const rej = await ev.review(REV, v.id, 'reject', { expected_revision: 1, content_hash: v.content_hash, reason });
  const dis = await ev.review(OWNER, v.id, 'dispute', { expected_revision: 1, rationale, adjudicator: REV2.email, claim_ids: [metric.claim_id] });
  assert.equal(dis.state, 'disputed');
  assert.deepEqual([dis.rejection.reason, dis.rejection.by], [reason, REV.email], 'the manager\'s view is kept');
  assert.deepEqual([dis.dispute.rationale, dis.dispute.by, dis.dispute.adjudicator], [rationale, OWNER.email, REV2.email], 'the consultant\'s view is kept beside it');
  assert.deepEqual([dis.dispute.rejection.reason, dis.dispute.rejection.by], [reason, REV.email], 'the dispute record carries the rejection it answers');
  assert.equal(dis.claims.find(c => c.claim_id === metric.claim_id).statement, metric.statement, 'the disputed claim\'s words are untouched');
  assert.equal(dis.revision, 1); assert.equal(dis.content_hash, rej.content_hash, 'a dispute is not an edit');
  // The adjudicator routes it back; the consultant amends: revision 2, and revision 1 (the one both parties argued about) stays readable.
  const back = await ev.review(REV2, v.id, 'clarify', { expected_revision: 1, note: 'Send the dashboard export.' });
  assert.equal(back.state, 'needs_clarification');
  const am = await ev.review(OWNER, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: metric.claim_id, period: '2024-Q1 to Q4', value: '12', unit: 'minutes', baseline: '40' }] });
  assert.equal(am.revision, 2);
  const first = ev.get(OWNER, v.id, { revision: 1 });
  assert.equal(first.claims.find(c => c.claim_id === metric.claim_id).value, null, 'revision 1 still reads as it did when it was rejected');
  assert.deepEqual(ev.get(OWNER, v.id).revisions.map(r => r.revision), [2, 1]);
  assert.ok(ctx.l.rows('SELECT event FROM workflow_transitions WHERE entity = ? ORDER BY seq', v.id).map(r => r.event).join() .startsWith('create_from_notes,submit,enqueue,reject,dispute,request_clarification,revise'), 'the audit trail holds every step in order');
  trail(ctx);
});

test('S11 MAAP is requested but its rubric is not configured: no rating is invented, nothing is sent, and the card says so', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx);
  assert.deepEqual([status(l, ok.id).maap, reasons(l, ok.id).maap], ['maap_pending', 'MAAP_NOT_CONFIGURED']);
  assert.deepEqual([ad.MAAP.rubric, ad.MAAP.configured], ['MUST_BE_CONFIGURED_BY_PROCESS_OWNER', false]);
  assert.deepEqual(ad.MAAP.rate(), { allow: false, reason: 'MAAP_NOT_CONFIGURED' }); assert.deepEqual(ad.MAAP.close(), { allow: false, reason: 'MAAP_NOT_CONFIGURED' });
  assert.deepEqual(await ad.MAAP.send(), { ok: false, retryable: false, error: 'MAAP_NOT_CONFIGURED' });
  const entity = ev.entity(ev.load(ok.id));
  for (const person of [RV, actor('admin@mantu.com', 'admin'), actor('atlas', 'system')]) for (const a of ['maap_rate', 'maap_close', 'maap_outcome']) assert.equal(decide(person, a, entity, {}).allow, false, `${person.roles} ${a}`);
  assert.equal(decide(RV, 'rate_consultant', entity, {}).reason, 'FORBIDDEN_ACTION', 'a rating of the person is never an action at all');
  const view = B.statusView(ev, OWNER, ok.id), maap = card(view, 'maap');
  assert.equal(maap.reason, 'MAAP_NOT_CONFIGURED'); assert.ok(!/rating|score|rubric_score|outcome/i.test(JSON.stringify(Object.keys(maap))), 'the card has no rating field at all');
  assert.ok(!jobs(l).list(ok.id).some(j => /maap/i.test(j.destination)), 'no job was created for MAAP');
  assert.equal(view.overall.complete, false);
  trail(ctx);
});

test('S12 a story is relevant to a prospect but has no public permission: internal retrieval works, publishing is blocked at the gate and at the CMS', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx, { ref: true, grants: ['skills_profile', 'cv', 'matching'] }), id = ok.id, at = { expected_revision: 1, content_hash: ok.content_hash };
  ev.grantPermission(OWNER, id, { expected_revision: 1, purpose: 'internal_knowledge', channel: 'internal' });
  // Relevance: JEV's shortlist is a retrieval signal over what may be used internally. It names a story; it grants nothing.
  const story = { id, eligible: true, title: 'Claims triage', revision: ok.revision, content_hash: ok.content_hash, tags: ['insurer'], stage: 'Production', kind: 'reference',
    sections: { challenge: 'claims bouncing between teams and payouts slow', outcome: 'Triage fell from 40 to 12 minutes', customer_fit: 'Any insurer with a claims queue' } };
  const hits = shortlist([story], { problem: 'Claims bounce between teams at an insurer', buyer: 'Head of claims operations', constraints: 'regulated', desired_outcome: 'faster triage' }, 5);
  assert.deepEqual(hits.map(s => s.id), [id], 'the story is found for the prospect');
  assert.ok(!/publish|permission|approved|grant/i.test(Object.keys(hits[0]).join()), 'a relevance hit carries no permission of any kind');
  const entity = ev.entity(ev.load(id));
  assert.deepEqual(decide(actor('m', 'member'), 'use_for_purpose', entity, { now: ev.now(), expected_revision: 1, content_hash: ok.content_hash, purpose: 'internal_knowledge', channel: 'internal', grants: ev.grantsFor(id) }), { allow: true, reason: 'ALLOWED' }, 'internal reuse is allowed');
  // Publication: every Spotlight gate closed by its own role, and still no public_spotlight grant from the owner.
  B.requestSpotlightApproval(ev, RV, id, at); closeGates(ev, id, at);
  assert.deepEqual(await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL }), { allow: false, reason: 'PURPOSE_NOT_GRANTED:public_spotlight' });
  assert.equal(ad.SPOTLIGHT_CMS.calls.length, 0, 'the CMS was never asked');
  assert.ok(!l.rows('SELECT status FROM branch_status').some(r => r.status === 'published'), 'nothing is marked published');
  trail(ctx);
});

test('S13 DNA succeeds and MeChat fails: the state is per destination, DNA is untouched, nothing is rolled back and no card says "complete"', async () => {
  const ctx = setup(), { l, ev, ad } = ctx;
  ad.MECHAT_CV.failNext(1, { retryable: false, error: 'MOCK_MECHAT_DOWN' });
  const ok = await approved(ctx), view = B.statusView(ev, OWNER, ok.id);
  assert.deepEqual([card(view, 'dna').display_status, card(view, 'mechat').display_status, card(view, 'mechat').reason], ['mock_acknowledged', 'failed', 'MOCK_MECHAT_DOWN']);
  assert.equal(ad.DNA_SKILLS_WRITEBACK.calls.length, 1, 'DNA was delivered once, whatever MeChat did');
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM approvals WHERE status = 'approved'")[0].n, 1, 'the approval stands'); assert.equal(ev.get(OWNER, ok.id).state, 'approved');
  assert.deepEqual(view.overall, { status: 'attention', complete: false });
  assert.ok(!view.cards.some(c => /^(complete|sync_complete|published)$/.test(c.display_status)), 'no card claims a completion');
  assert.equal(card(view, 'dna').mock, true, 'and the DNA success is labelled a mock acknowledgement, not a sync');
  trail(ctx);
});

test('S14 a duplicate webhook, draft post or job is idempotent: one invitation, one record, one job, one delivery', async () => {
  // The interview's server-to-server draft post, sent twice (a retried webhook): one record, the second says "unchanged".
  const ctx = setup(), { l, ev, ad } = ctx, a = await draft(ctx), b = await draft(ctx);
  assert.deepEqual([a.unchanged, b.unchanged, b.id === a.id], [false, true, true]);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM evidence_records')[0].n, 1); assert.equal(l.rows('SELECT COUNT(*) AS n FROM evidence_claims')[0].n, a.claims.length);
  // The same post arriving concurrently, and through the real route twice.
  const [x, y] = await Promise.all([draft(ctx, 'sess-C'), draft(ctx, 'sess-C')]); assert.equal(x.id, y.id);
  const env = { LIBRARY: { idFromName: n => n, get: () => ({ fetch: async req => libraryRoutes(req, l, { env: {} }) }) } };
  const p1 = await postDraftFromInterview(env, { user: OWNER.email, role: 'user', mail: OWNER.email }, NOTES('sess-R')), p2 = await postDraftFromInterview(env, { user: OWNER.email, role: 'user', mail: OWNER.email }, NOTES('sess-R'));
  assert.deepEqual([p1.status, p2.status, p1.body.id === p2.body.id], [201, 200, true]);
  // The one inbound webhook there is (the PM system's trigger, system identity): the same payload twice gives one invitation and no second outreach row.
  const hook = () => libraryRoutes(new Request('https://atlas.internal/api/library/trigger', { method: 'POST', headers: { 'x-atlas-user': 'pm-system', 'x-atlas-role': 'system' },
    body: JSON.stringify({ email: OWNER.email, reason: 'project_end', projectId: 'PRJ-9', title: 'Claims triage', slot: '2026-10-01T09:30', managerEmail: 'sam@mantu.com' }) }), l, { env: {} }).then(r => r.json());
  const w1 = await hook(), w2 = await hook();
  assert.equal(w1.id, w2.id, 'a repeated webhook is the same invitation'); assert.equal(l.rows('SELECT COUNT(*) AS n FROM invitations')[0].n, 1);
  // The fan-out and the job, repeated: one job and one delivery per destination and revision.
  const ok = await approved(ctx, { session: 'sess-J' });
  await B.fanOut(ev, ok.id); await B.fanOut(ev, ok.id); await B.pump(ev);
  assert.deepEqual(jobs(l).list(ok.id).map(j => j.destination), ['DNA', 'MeChat', 'IMP']);
  assert.deepEqual([ad.DNA_SKILLS_WRITEBACK.calls.length, ad.MECHAT_CV.calls.length, ad.IMP_CAPABILITY.calls.length], [1, 1, 1]);
  const j = jobs(l).list(ok.id)[0], again = await jobs(l).enqueue({ entity: ok.id, revision: ok.revision, hash: ok.content_hash, destination: 'DNA', payload: { x: 1 } });
  assert.deepEqual([again.duplicate, again.job.job_id], [true, j.job_id]);
  assert.throws(() => l.sql.exec('INSERT INTO jobs (job_id, idempotency_key) VALUES (?, ?)', 'dup', j.idempotency_key), /UNIQUE|constraint|NOT NULL/i, 'the key is UNIQUE in the table itself');
  trail(ctx);
});

test('S15 a destination that already holds a newer revision is never overwritten: the write is refused and flagged for reconciliation', async () => {
  const ctx = setup(), { ev, ad } = ctx, d = await draft(ctx, 'sess-newer');
  ad.DNA_SKILLS_WRITEBACK.setDestinationRevision(d.id, 9);
  for (const purpose of PURPOSES.slice(0, 3)) ev.grantPermission(OWNER, d.id, { expected_revision: 1, purpose });
  const q = ev.submit(OWNER.email, d.id, 1); await ev.review(REV, q.id, 'approve', { expected_revision: 1, content_hash: q.content_hash });
  const view = B.statusView(ev, OWNER, d.id);
  assert.deepEqual([card(view, 'dna').display_status, card(view, 'dna').reason, card(view, 'mechat').display_status], ['needs_reconciliation', 'DESTINATION_NEWER_REVISION', 'mock_acknowledged'], 'only that destination is held; MeChat went through');
  assert.equal(ad.DNA_SKILLS_WRITEBACK.records.get(d.id).revision, 9, 'the newer destination record was left alone');
  assert.equal((await B.pump(ev)).ran, 0, 'a human reconciles; nothing retries on its own');
  // And on the source side: a job still waiting for an older revision never delivers once a newer one exists.
  const c2 = setup(); c2.ad.DNA_SKILLS_WRITEBACK.failAlways('MOCK_DOWN');
  const ok = await approved(c2, { session: 'sess-old' });
  await c2.ev.review(OWNER, ok.id, 'amend', { expected_revision: 1, add: [{ statement: 'We added a dashboard.', claim_type: 'technology' }] });
  assert.deepEqual([jobs(c2.l).list(ok.id).find(j => j.destination === 'DNA').last_error], ['SOURCE_SUPERSEDED']);
  c2.clock.t += 3_600_000; assert.equal((await B.pump(c2.ev)).ran, 0); assert.equal(c2.ad.DNA_SKILLS_WRITEBACK.calls.length, 1);
  trail(ctx); trail(c2);
});

test('S16 a permission is revoked after approval and after the Spotlight hold: what was derived under it is identified and flagged for review, and nothing more is sent', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx, { ref: true, grants: PURPOSES }), id = ok.id, at = { expected_revision: 1, content_hash: ok.content_hash };
  B.requestSpotlightApproval(ev, RV, id, at); closeGates(ev, id, at);
  assert.equal((await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL })).allow, true); assert.equal(ad.SPOTLIGHT_CMS.calls.length, 1);
  assert.equal(status(l, id).spotlight, 'publication_held', 'the furthest a mock can go: held by the test CMS, never published');
  const grants = ev.grantsFor(id), sent = ad.DNA_SKILLS_WRITEBACK.calls.length + ad.MECHAT_CV.calls.length + ad.IMP_CAPABILITY.calls.length;
  ev.revokePermission(OWNER, id, grants.find(g => g.purpose === 'public_spotlight').id, { expected_revision: 1 });
  ev.revokePermission(OWNER, id, grants.find(g => g.purpose === 'skills_profile').id, { expected_revision: 1 });
  assert.deepEqual([status(l, id).spotlight, reasons(l, id).spotlight, status(l, id).dna, reasons(l, id).dna], ['impact_review', 'PERMISSION_REVOKED:public_spotlight', 'impact_review', 'PERMISSION_REVOKED:skills_profile']);
  assert.deepEqual([status(l, id).mechat, status(l, id).imp], ['mock_acknowledged', 'mock_acknowledged'], 'a permission that was not revoked leaves its destination alone');
  const view = B.statusView(ev, OWNER, id); assert.deepEqual([card(view, 'dna').display_status, card(view, 'spotlight').display_status, view.overall.complete], ['impact_review', 'impact_review', false]);
  await B.fanOut(ev, id); assert.equal(status(l, id).dna, 'impact_review', 'a flagged branch stays flagged until a person clears it');
  assert.equal(ad.DNA_SKILLS_WRITEBACK.calls.length + ad.MECHAT_CV.calls.length + ad.IMP_CAPABILITY.calls.length, sent, 'nothing more was sent');
  // Withdrawal after approval lists the derivatives too, and a reviewer completes the impact review.
  const w = await ev.review(OWNER, id, 'withdraw', { expected_revision: 1, reason: 'I do not want this used.' });
  assert.equal(w.state, 'impact_review'); assert.ok(w.impact.derivatives.some(d => d.kind === 'branch' && d.branch === 'spotlight') && w.impact.derivatives.some(d => d.kind === 'permission'), 'derivatives are listed, branches and permissions');
  assert.equal((await ev.review(REV2, id, 'complete_impact_review', { expected_revision: 1 })).state, 'withdrawn');
  trail(ctx);
});

// =============================================================================================================================================================
// Workflow acceptance W1-W12
// =============================================================================================================================================================

// W1/W2 use the real Worker handle() with a local Access-style signing key, as app.test.js does.
const TEAM = 'team.cloudflareaccess.com', AUD = 'aud-123', ORIGIN = 'https://atlas.example.workers.dev';
const b64u = b => Buffer.from(b).toString('base64url');
async function worker() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
  const jwt = async (email = 'alex@mantu.com') => { const now = Math.floor(Date.now() / 1000), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'user-' + email, email, exp: now + 600, iat: now };
    const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' })) + '.' + b64u(JSON.stringify(body)); return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input))); };
  const forwarded = [], real = globalThis.fetch;
  globalThis.fetch = async url => { assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys: [jwk] })); };
  const env = { ORIGIN, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, CSRF_SECRET: 'test-secret', TALKER_MODEL: 't', TTS_VOICE: 'harmonia',
    INTERVIEW: { idFromName: n => n, get: () => ({ fetch: r => { forwarded.push(r); return new Response('ok'); } }) } };
  const call = async (path, { token, headers = {} } = {}) => handle(new Request(ORIGIN + path, { headers: { ...(token === null ? {} : { 'cf-access-jwt-assertion': token ?? await jwt() }), ...headers } }), env, '');
  return { call, jwt, forwarded, restore: () => { globalThis.fetch = real; } };
}

test('W1 the consultant is identified before anything is prefilled: no verified identity, no interview, no bootstrap; the forwarded identity is the verified one', async () => {
  const w = await worker();
  try {
    assert.equal((await w.call('/api/bootstrap', { token: null })).status, 401); assert.equal((await w.call('/api/voice', { token: null, headers: { Upgrade: 'websocket', Origin: ORIGIN } })).status, 401);
    assert.equal(w.forwarded.length, 0, 'the interview Durable Object was never reached without an identity');
    const r = await w.call('/api/voice', { headers: { Upgrade: 'websocket', Origin: ORIGIN, 'x-atlas-user': 'boss@mantu.com', 'x-atlas-role': 'admin', 'x-atlas-admin': '1' } });
    assert.equal(r.status, 200);
    assert.deepEqual([w.forwarded[0].headers.get('x-atlas-user'), w.forwarded[0].headers.get('x-atlas-role')], ['alex@mantu.com', 'user'], 'identity and role come from the verified token, never from the browser');
    assert.equal(w.forwarded[0].headers.get('x-atlas-admin'), '0');
    // Honest limit (COVERAGE.md PARTIAL): the project context itself (role, sector, stage) is supplied by the page and checked only for shape and size here; there is no
    // server-side lookup of "the consultant's own projects" behind the identity. The interview's prefill therefore proves ordering, not content authorisation.
  } finally { w.restore(); }
});

test('W2 the prefill holds only the authorised fields: a fixed set of keys, never the consultant\'s name, never anything the page tries to add', async () => {
  assert.deepEqual(Object.keys(projectContext({ id: 'p', title: 'T', consultant: 'Alex', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: ['a'], oppId: 'o1' })).sort(),
    ['id', 'oppId', 'prior_notes', 'role', 'sector', 'stage', 'title'], 'the name is dropped on the way in');
  for (const extra of [{ subjectKey: 'k' }, { email: 'a@b.c' }, { bank: 'x' }, { manager: 'Sam' }, { salary: 1 }]) assert.throws(() => projectContext({ title: 'T', ...extra }), /Unexpected project fields/, JSON.stringify(extra));
  const h = rig({}); await opened(h);
  assert.deepEqual(h.s.prefill, { role: PROJECT.role, sector: PROJECT.sector, stage: PROJECT.stage }); assert.ok(!JSON.stringify([h.s.prefill, h.calls.talker]).includes(PROJECT.consultant));
  // A reference is the owner's (and the N+1's) alone: another person gets 404, not a masked copy.
  const ctx = setup(), rec = await ctx.l.upsert(OWNER, { localId: 'p1', reference: REF() });
  assert.throws(() => ctx.l.get(OTHER, rec.id), e => e.status === 404);
  // Honest limit: no server-side check that the page's role/sector/stage belong to the signed-in person (COVERAGE.md PARTIAL).
});

test('W3 the interview works by voice and by text: a typed answer takes the same path as a spoken one (same ledger, same next move, same audit)', async () => {
  const h = rig({ said: ['We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.'], talk: n => n === 0 ? ['What was the project?'] : ['Thanks. ', 'What was the baseline?'] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const spoken = h.s.humane.asked.length;
  await send(h, { type: 'text', text: 'The median handling time dropped from fourteen minutes to nine minutes over six weeks.' });
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.equal(h.s.humane.asked.length, spoken + 1, 'the typed turn got a selected move like a spoken one');
  assert.ok(h.s.history.some(m => m.role === 'user' && m.content.startsWith('The median handling time')), 'it is in the conversation history');
  assert.ok(h.events.some(e => e.type === 'user_text' && e.provenance === 'consultant_typed'), 'and labelled as typed, not as speech recognition');
  assert.equal(named(h.metrics, 'typed_turn').length, 1); assert.ok(!h.events.some(e => e.type === 'error'));
});

test('W3b a text-only interview: it starts with no microphone and no audio, and a typed answer takes the same path (same ledger, same next move, same audit, nothing synthesised)', async () => {
  const h = rig({ talk: n => n === 0 ? ['What was the project?'] : ['Thanks. ', 'What was the baseline?'] });
  await h.s.onText(startMsg({ mode: 'text' })); await until(() => !h.s.busy() && h.events.some(e => e.type === 'agent_text'));
  assert.equal(h.events.find(e => e.type === 'ready').input, 'text'); assert.equal(h.bytes.length, 0); assert.equal(h.calls.tts.length, 0);
  await send(h, { type: 'text', text: 'We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.' });
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.s.humane.asked.length, 1, 'the typed turn got a selected move'); assert.ok(h.s.ledger.transcripts.has('user-typed-1'), 'it is in the ledger');
  assert.ok(h.events.some(e => e.type === 'user_text' && e.provenance === 'consultant_typed'), 'labelled as typed');
  assert.ok(h.events.filter(e => e.type === 'agent_text').map(e => e.text).join('').includes('What was the baseline?'), 'ATLAS answered in text');
  assert.equal(h.calls.tts.length, 0); assert.equal(h.calls.stt, 0); assert.ok(!h.events.some(e => e.type === 'error'));
});

test('W4 one primary question per turn: whatever the model writes, one question is voiced', () => {
  const g = new ReplyGuard({ bannedPraise: BANNED_PRAISE_SRC }), out = [];
  for (const piece of ['Amazing! ', 'Thanks for that. ', 'What was the baseline? ', 'And who measured it? ', 'Also, when was that?']) if (!g.done) out.push(...g.push(piece));
  const said = out.join('');
  assert.equal((said.match(/\?/g) || []).length, 1); assert.ok(!/amazing/i.test(said)); assert.ok(g.done, 'the stream is stopped after the question');
});

test('W5 project-level facts and individual contribution claims are separate records, and a team decision is not attributed to the individual', async () => {
  const ctx = setup(), v = await draft(ctx), by = f => v.claims.find(c => c.source_refs[0].field === f);
  assert.deepEqual([by('problem').subject_type, by('problem').claim_type], ['project', 'context']);
  assert.deepEqual([by('contribution').subject_type, by('contribution').subject_id, by('contribution').attribution, by('contribution').claim_type], ['person', OWNER.email, 'individual', 'responsibility']);
  assert.deepEqual([by('decision').subject_type, by('decision').attribution], ['team', 'team'], '"We chose" stays a team decision');
  assert.deepEqual([by('measurement').subject_type, by('outcome').subject_type], ['project', 'project']);
  assert.ok(new Set(v.claims.map(c => c.claim_id)).size === v.claims.length, 'each is its own record with its own id');
  trail(ctx);
});

test('W6 each claim links to its source: session, item, ledger id, exact words, recognition confidence; a metric is never computed from the wording', async () => {
  const ctx = setup(), v = await draft(ctx);
  for (const c of v.claims) {
    const r = c.source_refs[0];
    assert.deepEqual([r.kind, r.session_id], ['interview', 'sess-001']); assert.match(r.ledger_id, /^sess-001:D-\d{3}$/); assert.ok(r.item_id && r.quote === c.statement, 'the statement is the consultant\'s exact words');
  }
  const m = v.claims.find(c => c.claim_type === 'metric');
  assert.deepEqual([m.value, m.unit, m.baseline, m.period, m.source_refs[0].ledger_status, m.source_refs[0].asr_min_conf], [null, null, null, null, 'uncertain', 0.7], 'figures stay null until a person fills them; uncertainty travels with the claim');
  // Honest limit (COVERAGE.md PARTIAL): there is no artifact upload or artifact registry in the interview or the evidence store; an "artifact" is a sentence naming one.
  assert.equal(ctx.l.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%artifact%'")[0].n, 0);
  trail(ctx);
});

test('W7 evidence needs an accountable reviewer: no approval by the owner or by anyone as themselves, and an approval names the exact revision and hash', async () => {
  const ctx = setup(), { l, ev } = ctx;
  // The accountable N+1 comes from the staffing record; a manager the consultant types on the reference is not an approver (G1 L2).
  ensureOutreach(l); l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('PRJ-1', 'alex@mantu.com', 'sam@mantu.com', 'Sam', '', '', 'staffing-csv', 'x')");
  const ref = await l.upsert(OWNER, { localId: 'p1', reference: REF() }), v = await queued(ctx, 'sess-001', { ref_id: ref.id }), at = { expected_revision: 1, content_hash: v.content_hash };
  const go = (who, p) => ev.review(who, v.id, 'approve', p);
  await rejects(go(OWNER, at), 403, 'ROLE_NOT_PERMITTED'); await rejects(go({ ...OWNER, role: 'reviewer' }, at), 403, 'SELF_APPROVAL'); await rejects(go({ ...OWNER, role: 'admin' }, at), 403, 'SELF_APPROVAL');
  await rejects(go(REV, { expected_revision: 1 }), 400); await rejects(go(REV, { expected_revision: 2, content_hash: v.content_hash }), 409, 'REVISION_MISMATCH'); await rejects(go(REV, { expected_revision: 1, content_hash: 'f'.repeat(64) }), 409, 'CONTENT_HASH_MISMATCH');
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM approvals')[0].n, 0, 'every refusal changed nothing');
  const done = await go(N1, at); assert.deepEqual([done.state, done.approval.revision, done.approval.content_hash, done.approval.approver_sub], ['approved', 1, v.content_hash, N1.email], 'the resolved N+1 is an accountable reviewer');
  trail(ctx);
});

test('W8 a rejection routes to clarify, correct or dispute and preserves the revision that was rejected', async () => {
  const ctx = setup(), { ev } = ctx, v = await queued(ctx), why = { expected_revision: 1, content_hash: v.content_hash };
  await rejects(ev.review(REV, v.id, 'reject', why), 400, undefined); // a reason is required
  const r = await ev.review(REV, v.id, 'reject', { ...why, reason: 'The 40-to-12 figure has no source.' });
  assert.deepEqual([r.state, r.revision, r.content_hash, r.claims.length], ['rejected', 1, v.content_hash, v.claims.length], 'the rejected revision is kept whole');
  const cl = await ev.review(REV2, v.id, 'clarify', { expected_revision: 1, note: 'Please add the dashboard export.' }); assert.equal(cl.state, 'needs_clarification');
  const am = await ev.review(OWNER, v.id, 'amend', { expected_revision: 1, claims: [{ claim_id: v.claims[0].claim_id, statement: 'Claims bounced between two teams.' }] });
  assert.equal(am.revision, 2); assert.equal(ev.get(OWNER, v.id, { revision: 1 }).claims[0].statement, v.claims[0].statement, 'the previous revision is still readable, unchanged');
  assert.equal(ev.submit(OWNER.email, v.id, 2).state, 'reviewer_queue', 'and the corrected revision goes back to review');
  const d2 = await queued(ctx, 'sess-D'); await ev.review(REV, d2.id, 'reject', { expected_revision: 1, content_hash: d2.content_hash, reason: 'No source.' });
  assert.equal((await ev.review(OWNER, d2.id, 'dispute', { expected_revision: 1, rationale: 'The export is the source.' })).state, 'disputed', 'or the consultant disputes it');
  trail(ctx);
});

test('W9 approval creates independent branch records for DNA, MeChat, IMP, MAAP, Project Review and Spotlight (and the evidence card), each with its own permission check', async () => {
  const ctx = setup(), { l, ad } = ctx, ok = await approved(ctx, { grants: ['skills_profile', 'cv'] }); // no matching grant
  assert.deepEqual(Object.keys(status(l, ok.id)).sort(), [...BRANCH_IDS].sort());
  assert.deepEqual(status(l, ok.id), { evidence: 'evidence_approved', maap: 'maap_pending', project_review: 'project_review_pending', dna: 'mock_acknowledged', mechat: 'mock_acknowledged', imp: 'permission_pending', spotlight: 'spotlight_draft' });
  assert.equal(reasons(l, ok.id).imp, 'PURPOSE_NOT_GRANTED:matching', 'IMP waits for ITS permission while DNA and MeChat went ahead');
  assert.equal(ad.IMP_CAPABILITY.calls.length, 0);
  trail(ctx);
});

test('W10 MAAP and Project Review are separate workflows: separate state, separate completion status, separate reasons and separate shells', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx), view = B.statusView(ev, OWNER, ok.id);
  assert.deepEqual([card(view, 'maap').label, card(view, 'project_review').label], ['MAAP Review', 'Project Review']);
  assert.deepEqual([status(l, ok.id).maap, status(l, ok.id).project_review, reasons(l, ok.id).maap, reasons(l, ok.id).project_review], ['maap_pending', 'project_review_pending', 'MAAP_NOT_CONFIGURED', 'PROJECT_REVIEW_NOT_CONFIGURED']);
  assert.notEqual(ad.MAAP, ad.PROJECT_REVIEW); assert.deepEqual([ad.MAAP.rate().reason, ad.PROJECT_REVIEW.rate().reason], ['MAAP_NOT_CONFIGURED', 'PROJECT_REVIEW_NOT_CONFIGURED']);
  assert.ok(WORKFLOW_CONFIG.workflow.global_rules.includes('maap_and_project_review_are_distinct'));
  // Honest limit (COVERAGE.md PARTIAL): no owner is assigned to either review (the process owners are not named in the pack), and neither can complete.
  assert.ok(!Object.keys(card(view, 'maap')).includes('owner') && !Object.keys(card(view, 'project_review')).includes('owner'));
  trail(ctx);
});

test('W11 a failure in one branch does not fail the others or roll back what succeeded: a thrown error is that branch\'s state only', async () => {
  const ctx = setup(), { l, ev, ad } = ctx; ad.IMP_CAPABILITY.send = async () => { throw new Error('socket hang up'); };
  const ok = await approved(ctx), view = B.statusView(ev, OWNER, ok.id);
  assert.deepEqual([card(view, 'imp').display_status, card(view, 'imp').reason, card(view, 'dna').display_status, card(view, 'mechat').display_status], ['in_progress', 'ADAPTER_EXCEPTION', 'mock_acknowledged', 'mock_acknowledged']);
  assert.equal(ev.get(OWNER, ok.id).state, 'approved'); assert.equal(l.rows("SELECT COUNT(*) AS n FROM approvals WHERE status = 'approved'")[0].n, 1);
  assert.deepEqual([status(l, ok.id).spotlight, status(l, ok.id).evidence], ['spotlight_draft', 'evidence_approved'], 'unrelated branches are untouched');
  trail(ctx);
});

test('W12 Spotlight cannot publish without the exact-revision authorization and every required permission and gate; a new revision voids all of them', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx, { ref: true, grants: PURPOSES }), id = ok.id, at = { expected_revision: 1, content_hash: ok.content_hash };
  assert.equal((await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL })).reason, 'STORY_NOT_AWAITING_APPROVAL:spotlight_draft', 'a candidate is not publishable');
  B.requestSpotlightApproval(ev, RV, id, at);
  for (let i = 0; i < GATES.length; i++) {
    assert.equal((await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL })).reason, `SPOTLIGHT_GATE_OPEN:${GATES[i]}`, `gate ${GATES[i]} still open`);
    B.approveSpotlightGate(ev, GATE_ACTOR[GATES[i]], id, GATES[i], { ...at, channel: CHANNEL, ...(GATES[i] === 'privacy_legal_review_if_required' ? { decision: 'not_required', reason: 'No legal check needed.' } : {}) });
  }
  assert.equal(ad.SPOTLIGHT_CMS.calls.length, 0, 'the CMS was not asked while a gate was open');
  await ev.review(OWNER, id, 'amend', { expected_revision: 1, add: [{ statement: 'We also reduced rework.', claim_type: 'outcome' }] }); // a new revision after every gate had closed
  const q = ev.submit(OWNER.email, id, 2), again = await ev.review(REV, id, 'approve', { expected_revision: 2, content_hash: q.content_hash });
  B.requestSpotlightApproval(ev, RV, id, { expected_revision: 2, content_hash: again.content_hash });
  assert.equal((await B.publishSpotlight(ev, SA, id, { expected_revision: 2, content_hash: again.content_hash, channel: CHANNEL })).reason, 'SPOTLIGHT_GATE_OPEN:claim_level_evidence', 'the earlier approvals were for revision 1');
  assert.equal(ad.SPOTLIGHT_CMS.calls.length, 0); assert.ok(!l.rows('SELECT status FROM branch_status').some(r => r.status === 'published'));
  trail(ctx);
});

// =============================================================================================================================================================
// MAAP Review Specification section 8 (a shell: the official rubric, cadence and owners were not supplied, so what can be tested is what must NOT happen)
// =============================================================================================================================================================

test('MAAP-1 a review cannot close: with no configured sections or rubric, close is denied rather than allowed with gaps', async () => {
  const ctx = setup(), { ev, ad } = ctx, ok = await approved(ctx), entity = ev.entity(ev.load(ok.id));
  assert.deepEqual(ad.MAAP.close(), { allow: false, reason: 'MAAP_NOT_CONFIGURED' });
  for (const person of [RV, actor('admin@mantu.com', 'admin'), actor('mgr@mantu.com', 'manager')]) assert.equal(decide(person, 'maap_close', entity, { sections_complete: true }).allow, false, 'not even with a claim that the sections are complete');
});

test('MAAP-2 acknowledgement is distinct from agreement: there is no acknowledge or agree action to mistake for the other (not built; the gate denies both as unknown)', () => {
  const owner = actor(OWNER.email, 'owner');
  for (const a of ['maap_acknowledge', 'maap_agree']) { const r = decide(owner, a, {}, {}); assert.equal(r.allow, false); assert.match(r.reason, /UNKNOWN/, a); }
});

test('MAAP-3 disagreement is retained and visible to permitted reviewers (at the evidence level, where it exists today)', async () => {
  const ctx = setup(), { ev } = ctx, v = await queued(ctx);
  await ev.review(REV, v.id, 'reject', { expected_revision: 1, content_hash: v.content_hash, reason: 'Not supported.' });
  const d = await ev.review(OWNER, v.id, 'dispute', { expected_revision: 1, rationale: 'It is supported by the export.', adjudicator: REV2.email });
  for (const who of [REV, REV2, OWNER]) { const seen = ev.get(who, v.id); assert.ok(seen.dispute.rationale && seen.rejection.reason, `${who.email} sees both views`); }
  assert.throws(() => ev.get(OTHER, v.id), e => e.status === 404, 'nobody else does');
  assert.equal(d.dispute.rejection.reason, 'Not supported.');
});

test('MAAP-4 a closed review cannot be overwritten: there is no MAAP record to close, and an approved evidence revision is never edited in place', async () => {
  const ctx = setup(), { l, ev } = ctx, ok = await approved(ctx);
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND (name LIKE '%maap%' OR name LIKE '%review_response%')")[0].n, 0, 'no MAAP tables exist: the data model of section 7 is not built');
  const am = await ev.review(OWNER, ok.id, 'amend', { expected_revision: 1, claims: [{ claim_id: ok.claims[0].claim_id, statement: 'Changed after approval.' }] });
  assert.equal(am.revision, 2); assert.equal(ev.get(OWNER, ok.id, { revision: 1 }).claims[0].statement, ok.claims[0].statement, 'the approved revision is kept, never overwritten');
  assert.equal(l.rows('SELECT status FROM approvals ORDER BY revision').map(r => r.status).join(), 'superseded');
});

test('MAAP-5 a MAAP summary cannot reach Spotlight without its own permission: MAAP is not a purpose, and no purpose grant opens the Spotlight gate', async () => {
  const ctx = setup(), { ev, ad } = ctx, ok = await approved(ctx, { ref: true, grants: ['skills_profile', 'cv', 'matching'] }), id = ok.id, at = { expected_revision: 1, content_hash: ok.content_hash };
  await rejects(() => ev.grantPermission(OWNER, id, { expected_revision: 1, purpose: 'maap' }), 403, 'UNKNOWN_PURPOSE');
  B.requestSpotlightApproval(ev, RV, id, at); closeGates(ev, id, at);
  assert.equal((await B.publishSpotlight(ev, SA, id, { ...at, channel: CHANNEL })).reason, 'PURPOSE_NOT_GRANTED:public_spotlight');
  assert.equal(ad.SPOTLIGHT_CMS.calls.length, 0);
  assert.ok(!/maap/i.test(JSON.stringify(ad.SPOTLIGHT_CMS.calls)), 'and no MAAP content is in anything the CMS was sent');
});

test('MAAP-6 a MAAP outcome cannot change DNA skill proficiency or employment status: no such action exists and the DNA payload has no review field', async () => {
  const ctx = setup(), { ev, ad } = ctx, ok = await approved(ctx), entity = ev.entity(ev.load(ok.id));
  for (const a of ['maap_outcome', 'update_skill_proficiency', 'decide_employment', 'decide_promotion', 'decide_compensation', 'predict_attrition', 'infer_sentiment', 'rate_consultant']) {
    for (const person of [RV, actor('admin@mantu.com', 'admin'), actor('atlas', 'system')]) assert.equal(decide(person, a, entity, {}).allow, false, `${person.roles} ${a}`);
  }
  const sent = JSON.stringify(ad.DNA_SKILLS_WRITEBACK.calls[0].payload);
  assert.ok(!/maap|rating|proficiency|performance|promotion|attrition|sentiment/i.test(sent), 'what DNA is sent is the approved evidence only');
});

// =============================================================================================================================================================
// Release gates (framework section 4) that can be checked offline
// =============================================================================================================================================================

test('G1 default deny: an actor with no role is refused every known action; unknown and people-inference actions are refused for everyone (no bypass found; absence of bypass is not provable)', async () => {
  const ctx = setup(), { ev } = ctx, ok = await approved(ctx), entity = ev.entity(ev.load(ok.id)), nobody = actor('nobody@x.test');
  const known = ['submit', 'amend', 'withdraw', 'dispute', 'approve', 'reject', 'request_clarification', 'grant_permission', 'revoke_permission', 'use_for_purpose', 'project_destination', 'spotlight_nominate',
    'approve_gate', 'spotlight_schedule', 'spotlight_publish', 'record_sync_complete', 'record_published', 'export'];
  for (const a of known) assert.equal(decide(nobody, a, entity, { now: ev.now() }).allow, false, `nobody may not ${a}`);
  for (const a of ['rate_consultant', 'infer_sentiment', 'predict_attrition', 'decide_promotion', 'map_library_status_to_spotlight', 'definitely_not_an_action', '__proto__', 'constructor']) for (const person of [RV, actor('admin@mantu.com', 'admin', 'reviewer', 'owner')]) assert.equal(decide(person, a, entity, {}).allow, false, a);
  assert.equal(decide(null, 'approve', entity, {}).allow, false); assert.equal(decide(RV, 'approve', null, {}).allow, false);
});

test('G2 nothing is published, so nothing unsupported can be: no path in this build sets published, and a claim typed in by hand is not validated until a reviewer approves its revision', async () => {
  const ctx = setup(), { l, ev, ad } = ctx, ok = await approved(ctx, { ref: true, grants: PURPOSES });
  const am = await ev.review(OWNER, ok.id, 'amend', { expected_revision: 1, add: [{ statement: 'We saved the client a million.', claim_type: 'outcome' }] });
  const typed = am.claims.at(-1); assert.deepEqual([typed.source_refs[0].kind, typed.review_status], ['typed', 'draft'], 'a hand-typed claim carries no interview source and starts as a draft');
  assert.equal(am.approved, false, 'and the earlier approval no longer covers the record');
  assert.ok(!l.rows('SELECT status FROM branch_status').some(r => r.status === 'published'));
  assert.equal(ad.SPOTLIGHT_CMS.calls.length, 0);
  // Not provable offline: that a live Spotlight channel will never receive an unsupported claim (no live channel exists; the human gates are the control).
});

test('G3 no silent revision overwrite: every content change is a new revision with its hash, the earlier revision stays readable, and approval is bound to one hash', async () => {
  const ctx = setup(), { ev } = ctx, ok = await approved(ctx), hashes = [ok.content_hash];
  for (const [i, s] of ['One.', 'Two.'].entries()) {
    const am = await ev.review(OWNER, ok.id, 'amend', { expected_revision: i + 1, add: [{ statement: s + ' We did a thing.', claim_type: 'deliverable' }] });
    assert.equal(am.revision, i + 2); hashes.push(am.content_hash); ev.submit(OWNER.email, ok.id, am.revision);
    await ev.review(REV, ok.id, 'approve', { expected_revision: am.revision, content_hash: am.content_hash });
  }
  assert.equal(new Set(hashes).size, 3, 'a hash per revision'); assert.deepEqual(ev.get(OWNER, ok.id).revisions.map(r => r.revision), [3, 2, 1]);
  const listed = ev.get(OWNER, ok.id).revisions; for (const r of [1, 2, 3]) assert.equal(listed.find(x => x.revision === r).content_hash, hashes[r - 1], `revision ${r} keeps its hash`);
  assert.equal(ev.get(OWNER, ok.id, { revision: 1 }).claims.length, ok.claims.length, 'and revision 1 still reads as it did (one claim fewer than revision 3)');
  trail(ctx);
});

test('G4 no duplicate writes under retry: a destination that failed once and recovered holds ONE record for the revision, however often the job runs', async () => {
  const ctx = setup(), { l, ev, ad, clock } = ctx; ad.DNA_SKILLS_WRITEBACK.failNext(1, { retryable: true, error: 'MOCK_BLIP' });
  const ok = await approved(ctx), J = jobs(l);
  assert.equal(status(l, ok.id).dna, 'retrying'); clock.t = T0 + 500; await B.pump(ev); clock.t = T0 + 5000; await B.pump(ev); await B.pump(ev);
  assert.equal(status(l, ok.id).dna, 'mock_acknowledged'); assert.equal(ad.DNA_SKILLS_WRITEBACK.calls.length, 2, 'one failed attempt, one that landed, and no third');
  assert.equal(ad.DNA_SKILLS_WRITEBACK.records.size, 1); assert.equal(J.list(ok.id).filter(j => j.destination === 'DNA').length, 1);
  assert.equal(l.rows('SELECT COUNT(DISTINCT idempotency_key) AS n, COUNT(*) AS c FROM jobs')[0].n, l.rows('SELECT COUNT(*) AS c FROM jobs')[0].c, 'every job has its own idempotency key');
  trail(ctx);
});

test('G5 setup: withdraw from every state the store can reach, and a clarification straight from the queue', async () => {
  const ctx = setup(), { ev } = ctx, w = (id, rev = 1, who = OWNER) => ev.review(who, id, 'withdraw', { expected_revision: rev, reason: 'Not needed.' });
  assert.equal((await w((await draft(ctx, 'w-draft')).id)).state, 'withdrawn');
  const q = await queued(ctx, 'w-queue'); assert.equal((await w(q.id)).state, 'withdrawn');
  const c = await queued(ctx, 'w-clar'); await ev.review(REV, c.id, 'clarify', { expected_revision: 1, note: 'More detail please.' }); assert.equal((await w(c.id)).state, 'withdrawn');
  const r = await queued(ctx, 'w-rej'); await ev.review(REV, r.id, 'reject', { expected_revision: 1, content_hash: r.content_hash, reason: 'No.' }); assert.equal((await w(r.id)).state, 'withdrawn');
  const d = await queued(ctx, 'w-dis'); await ev.review(REV, d.id, 'reject', { expected_revision: 1, content_hash: d.content_hash, reason: 'No.' });
  await ev.review(OWNER, d.id, 'dispute', { expected_revision: 1, rationale: 'Yes.' }); assert.equal((await w(d.id)).state, 'withdrawn');
  trail(ctx);
});

test('G5 transition coverage: every evidence-machine transition this suite did not exercise is named here, and each is one the store cannot reach today (defined and parity-tested in the machine, not wired to an action)', () => {
  const all = TRANSITIONS.evidence.map(([e, f, t]) => [e, f, t].join('>')), missing = all.filter(t => !SEEN.has(t)).sort();
  // submitted_for_review is the instant between submit and enqueue (never at rest) and downstream_proposals is entered only by propose_downstream, which nothing fires yet.
  assert.deepEqual(missing, ['close_rejected>disputed>closed_rejected', 'close_rejected>rejected>closed_rejected', 'propose_downstream>approved>downstream_proposals', 'reopen_review>disputed>reviewer_queue',
    'withdraw>downstream_proposals>impact_review', 'withdraw>submitted_for_review>withdrawn'], 'if one of these gets wired (or another stops being covered) this pin must change with it, and COVERAGE.md with it');
  for (const critical of ['submit', 'enqueue', 'approve', 'reject', 'request_clarification', 'revise', 'dispute', 'withdraw', 'complete_impact_review']) assert.ok(all.some(t => t.startsWith(critical + '>') && SEEN.has(t)), `${critical} was exercised`);
});

test('G6 consequential decisions are a person\'s: ATLAS itself (the system actor) cannot approve, reject, grant, revoke, close a gate, publish or withdraw', async () => {
  const ctx = setup(), { ev } = ctx, ok = await approved(ctx), entity = ev.entity(ev.load(ok.id)), atlas = actor('atlas', 'system');
  for (const a of ['approve', 'reject', 'request_clarification', 'grant_permission', 'revoke_permission', 'withdraw', 'dispute', 'approve_gate', 'spotlight_publish', 'spotlight_schedule', 'submit'])
    assert.equal(decide(atlas, a, entity, { now: ev.now(), expected_revision: 1, content_hash: ok.content_hash, to: 'approved', transitions: {} }).allow, false, `the system actor may not ${a}`);
  await rejects(ev.review({ email: 'atlas', role: 'system' }, ok.id, 'approve', { expected_revision: 1, content_hash: ok.content_hash }), 404);
});
