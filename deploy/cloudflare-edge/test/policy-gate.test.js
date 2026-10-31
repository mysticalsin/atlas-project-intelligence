// The policy gate is default-deny: every denial below names the first thing that is wrong, and the happy paths show what is
// allowed. Fixtures are synthetic; the state machine is T8's, so a small transitions table stands in for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/policy-gate.js';
import { WORKFLOW_CONFIG } from '../src/policy.generated.js';

const NOW = '2026-11-01T12:00:00Z';
const H = 'sha256:abc';
const TRANSITIONS = { evidence_draft: ['submitted_for_review'], submitted_for_review: ['evidence_approved', 'needs_clarification', 'rejected', 'disputed'], evidence_approved: ['withdrawn'] };
const owner = { sub: 'u-owner' }, reviewer = { sub: 'u-rev', roles: ['reviewer'] };
const entity = (o = {}) => ({ id: 'ev-1', owner_sub: 'u-owner', revision: 3, content_hash: H, status: 'submitted_for_review', approved_revision: 3, approved_hash: H, ...o });
const ctx = (o = {}) => ({ now: NOW, expected_revision: 3, content_hash: H, transitions: TRANSITIONS, channel: 'spotlight-web', ...o });
const grant = (purpose, o = {}) => ({ purpose, status: 'active', revision: 3, hash: H, entity_id: 'ev-1', expires_at: '2027-01-01T00:00:00Z', ...o });
const gate = (o = {}) => ({ status: 'approved', revision: 3, hash: H, approver_sub: 'u-gate', ...o });
const GATES = WORKFLOW_CONFIG.workflow.branches.spotlight.requires;
const allGates = () => Object.fromEntries(GATES.map(g => [g, gate(g.endsWith('_if_required') ? { status: 'not_required', reason: 'no customer name used', decided_by: 'u-gate' } : g === 'exact_revision_publication_authorization' ? { channel: 'spotlight-web' } : {})]));
const publisher = { sub: 'u-pub', roles: ['spotlight_approver'] };
const publish = (c = {}, a = publisher, e = entity()) => decide(a, 'spotlight_publish', e, ctx({ gates: allGates(), grants: [grant('public_spotlight', { channel: 'spotlight-web' })], ...c }));
const denied = (r, reason) => { assert.equal(r.allow, false); assert.equal(r.reason, reason); };
const allowed = r => assert.deepEqual(r, { allow: true, reason: 'ALLOWED' });

test('input checks: bad actors, entities, contexts and actions are denials, never throws', () => {
  for (const bad of [undefined, null, 'x', 5, [], {}, { sub: '' }, { sub: 7 }]) denied(decide(bad, 'approve', entity(), ctx()), 'INVALID_ACTOR');
  for (const bad of [undefined, null, '', 7, {}, []]) denied(decide(reviewer, bad, entity(), ctx()), 'INVALID_ACTION');
  for (const bad of [undefined, null, 'x', [], {}, { owner_sub: '' }]) denied(decide(reviewer, 'approve', bad, ctx()), 'INVALID_ENTITY');
  for (const bad of [null, 'x', 5, []]) denied(decide(reviewer, 'approve', entity(), bad), 'INVALID_CONTEXT');
  denied(decide(reviewer, 'approve', entity()), 'REVISION_MISMATCH'); // ctx defaults to {}: nothing proves the caller saw this revision
  assert.doesNotThrow(() => decide()); denied(decide(), 'INVALID_ACTOR');
  // hostile shapes: getters that throw, prototype keys as names
  const boom = { get sub() { throw new Error('x'); } };
  denied(decide(boom, 'approve', entity(), ctx()), 'GATE_ERROR');
  denied(decide(reviewer, 'approve', { ...entity(), get revision() { throw new Error('x'); } }, ctx({ to: 'evidence_approved' })), 'GATE_ERROR');
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) denied(decide(reviewer, name, entity(), ctx()), 'UNKNOWN_ACTION');
  denied(decide(reviewer, 'approve', entity({ status: '__proto__' }), ctx({ to: 'evidence_approved' })), 'TRANSITION_NOT_ALLOWED:__proto__>evidence_approved');
});

test('unknown and people-inference actions are denied (D6, D18)', () => {
  for (const a of ['rate_consultant', 'compare_consultants', 'infer_sentiment', 'predict_attrition', 'rank_consultants', 'infer_emotion', 'decide_promotion', 'decide_termination']) {
    for (const who of [owner, reviewer, { sub: 'x', roles: ['admin', 'reviewer', 'system'] }]) denied(decide(who, a, entity(), ctx()), 'FORBIDDEN_ACTION');
  }
  for (const a of ['publish', 'delete', 'sync', 'noop', 'approve ', 'APPROVE']) denied(decide({ sub: 'x', roles: ['admin'] }, a, entity(), ctx()), 'UNKNOWN_ACTION');
});

test('MAAP and Project Review rating or closing is not configured (D2, D3)', () => {
  assert.equal(WORKFLOW_CONFIG.workflow.branches.maap_review.rubric, 'MUST_BE_CONFIGURED_BY_PROCESS_OWNER');
  for (const a of ['maap_rate', 'maap_close', 'maap_outcome']) for (const who of [owner, reviewer, { sub: 'a', roles: ['admin', 'process_owner'] }]) denied(decide(who, a, entity(), ctx()), 'MAAP_NOT_CONFIGURED');
  for (const a of ['project_review_rate', 'project_review_close']) denied(decide(reviewer, a, entity(), ctx()), 'PROJECT_REVIEW_NOT_CONFIGURED');
  denied(decide(reviewer, 'maap_rate', null, null), 'MAAP_NOT_CONFIGURED'); // needs no entity to refuse
});

test('role must permit the action; the owner role is derived, not claimed', () => {
  denied(decide(owner, 'approve', entity(), ctx({ to: 'evidence_approved' })), 'ROLE_NOT_PERMITTED');
  denied(decide({ sub: 'u-x' }, 'submit', entity({ status: 'evidence_draft' }), ctx({ to: 'submitted_for_review' })), 'ROLE_NOT_PERMITTED');
  denied(decide({ sub: 'u-x', roles: ['owner'] }, 'submit', entity({ status: 'evidence_draft' }), ctx({ to: 'submitted_for_review' })), 'ROLE_NOT_PERMITTED'); // claiming owner is not being the owner
  denied(decide({ sub: 'u-x', roles: ['member'] }, 'approve', entity(), ctx({ to: 'evidence_approved' })), 'ROLE_NOT_PERMITTED');
  denied(decide({ sub: 'u-x', role: 'viewer' }, 'amend', entity(), ctx()), 'ROLE_NOT_PERMITTED');
  allowed(decide({ sub: 'u-x', role: 'Reviewer' }, 'approve', entity(), ctx({ to: 'evidence_approved' }))); // single role string, case-insensitive
});

test('no self-approval: the owner cannot decide on their own entity even with a reviewer role', () => {
  const both = { sub: 'u-owner', roles: ['reviewer', 'admin'] };
  for (const a of ['approve', 'reject', 'request_clarification']) denied(decide(both, a, entity(), ctx({ to: a === 'approve' ? 'evidence_approved' : 'rejected' })), 'SELF_APPROVAL');
  denied(decide(both, 'spotlight_nominate', entity(), ctx()), 'SELF_APPROVAL');
  denied(decide({ sub: 'u-owner', roles: ['spotlight_approver'] }, 'spotlight_publish', entity(), ctx({ gates: allGates() })), 'SELF_APPROVAL');
  denied(decide({ sub: 'u-owner', roles: ['brand_approver'] }, 'approve_gate', entity(), ctx({ gate: 'brand_approval' })), 'SELF_APPROVAL');
  allowed(decide(owner, 'submit', entity({ status: 'evidence_draft' }), ctx({ to: 'submitted_for_review' }))); // the owner may still submit and amend their own
  allowed(decide(both, 'amend', entity(), ctx()));
});

test('expected revision and content hash must match the entity', () => {
  const c = { to: 'evidence_approved' };
  denied(decide(reviewer, 'approve', entity(), ctx({ ...c, expected_revision: 2 })), 'REVISION_MISMATCH');
  denied(decide(reviewer, 'approve', entity(), ctx({ ...c, expected_revision: undefined })), 'REVISION_MISMATCH');
  denied(decide(reviewer, 'approve', entity(), ctx({ ...c, expected_revision: '3' })), 'REVISION_MISMATCH');
  denied(decide(reviewer, 'approve', entity({ revision: '3' }), ctx({ ...c, expected_revision: '3' })), 'REVISION_MISMATCH');
  denied(decide(reviewer, 'approve', entity(), ctx({ ...c, content_hash: 'sha256:other' })), 'CONTENT_HASH_MISMATCH');
  denied(decide(reviewer, 'approve', entity(), ctx({ ...c, content_hash: undefined })), 'CONTENT_HASH_MISMATCH');
  denied(decide(reviewer, 'approve', entity({ content_hash: '' }), ctx({ ...c, content_hash: '' })), 'CONTENT_HASH_MISMATCH');
  denied(decide(reviewer, 'amend', entity(), ctx({ expected_revision: 4 })), 'REVISION_MISMATCH'); // every action, not only approvals
});

test('a transition must be allowed by the table the caller passes', () => {
  denied(decide(reviewer, 'approve', entity(), ctx()), 'TRANSITION_TARGET_REQUIRED');
  denied(decide(reviewer, 'approve', entity(), ctx({ to: 'evidence_approved', transitions: undefined })), 'NO_TRANSITION_TABLE');
  denied(decide(reviewer, 'approve', entity(), ctx({ to: 'evidence_approved', transitions: [] })), 'NO_TRANSITION_TABLE');
  denied(decide(reviewer, 'approve', entity({ status: 'evidence_draft' }), ctx({ to: 'evidence_approved' })), 'TRANSITION_NOT_ALLOWED:evidence_draft>evidence_approved');
  denied(decide(reviewer, 'approve', entity({ status: 'unlisted' }), ctx({ to: 'evidence_approved' })), 'TRANSITION_NOT_ALLOWED:unlisted>evidence_approved');
  denied(decide(reviewer, 'approve', entity(), ctx({ to: 'needs_clarification', transitions: { submitted_for_review: 'needs_clarification' } })), 'TRANSITION_NOT_ALLOWED:submitted_for_review>needs_clarification'); // a string is not a list
  allowed(decide(reviewer, 'approve', entity(), ctx({ to: 'evidence_approved' })));
  allowed(decide(reviewer, 'request_clarification', entity(), ctx({ to: 'needs_clarification' })));
  allowed(decide(reviewer, 'dispute', entity(), ctx({ to: 'disputed' })));
  allowed(decide({ sub: 'u-admin', roles: ['admin'] }, 'withdraw', entity({ status: 'evidence_approved' }), ctx({ to: 'withdrawn' })));
});

test('destination projections need approved evidence, the purpose grant and (DNA) a reviewer approval', () => {
  const system = { sub: 'job-runner', roles: ['system'] };
  const proj = (destination, c = {}, e = entity()) => decide(system, 'project_destination', e, ctx({ destination, reviewer_approval: { sub: 'u-rev', revision: 3, hash: H }, grants: [grant('cv'), grant('skills_profile'), grant('matching')], ...c }));
  allowed(proj('michat')); allowed(proj('dna')); allowed(proj('imp'));
  denied(proj('crm'), 'UNKNOWN_DESTINATION:crm');
  denied(proj('spotlight'), 'UNKNOWN_DESTINATION:spotlight'); // Spotlight is not a projection
  denied(proj('michat', {}, entity({ approved_revision: 2 })), 'REQUIREMENT_UNMET:evidence_approved');
  denied(proj('michat', {}, entity({ approved_hash: 'sha256:old' })), 'REQUIREMENT_UNMET:evidence_approved');
  denied(proj('michat', {}, entity({ approved_revision: undefined })), 'REQUIREMENT_UNMET:evidence_approved');
  denied(proj('michat', {}, entity({ status: 'withdrawn' })), 'REQUIREMENT_UNMET:evidence_approved');
  denied(proj('michat', { grants: [] }), 'PURPOSE_NOT_GRANTED:cv');
  denied(proj('michat', { grants: [grant('skills_profile')] }), 'PURPOSE_NOT_GRANTED:cv'); // another purpose is not this one
  denied(proj('imp', { grants: [grant('cv')] }), 'PURPOSE_NOT_GRANTED:matching');
  denied(proj('dna', { reviewer_approval: undefined }), 'REQUIREMENT_UNMET:reviewer_approval');
  denied(proj('dna', { reviewer_approval: { sub: 'u-owner', revision: 3, hash: H } }), 'REQUIREMENT_UNMET:reviewer_approval'); // the owner's own approval
  denied(proj('dna', { reviewer_approval: { sub: 'u-rev', revision: 2, hash: H } }), 'REQUIREMENT_UNMET:reviewer_approval');
  denied(proj('dna', { reviewer_approval: { sub: 'u-rev', revision: 3, hash: 'sha256:x' } }), 'REQUIREMENT_UNMET:reviewer_approval');
  denied(decide({ sub: 'u-x', roles: ['member'] }, 'project_destination', entity(), ctx({ destination: 'michat', grants: [grant('cv')] })), 'ROLE_NOT_PERMITTED');
});

test('purpose grants must be unexpired, unrevoked and bound to the revision, hash and channel', () => {
  const use = (g, c = {}) => decide({ sub: 'u-m', roles: ['member'] }, 'use_for_purpose', entity(), ctx({ purpose: 'bid_client_facing', grants: [g], ...c }));
  allowed(use(grant('bid_client_facing')));
  allowed(use(grant('bid_client_facing', { expires_at: null })));
  denied(use(grant('bid_client_facing', { expires_at: '2026-10-31T00:00:00Z' })), 'PURPOSE_EXPIRED:bid_client_facing');
  denied(use(grant('bid_client_facing', { expires_at: NOW })), 'PURPOSE_EXPIRED:bid_client_facing'); // expiry instant is already expired
  denied(use(grant('bid_client_facing', { expires_at: 'not a date' })), 'PURPOSE_GRANT_MALFORMED:bid_client_facing');
  denied(use(grant('bid_client_facing', { status: 'revoked' })), 'PURPOSE_REVOKED:bid_client_facing');
  denied(use(grant('bid_client_facing', { revoked_at: '2026-10-30T00:00:00Z' })), 'PURPOSE_REVOKED:bid_client_facing');
  denied(use(grant('bid_client_facing', { revoked_at: 'garbage' })), 'PURPOSE_REVOKED:bid_client_facing');
  allowed(use(grant('bid_client_facing', { revoked_at: '2027-06-01T00:00:00Z' }))); // a future revocation is not in force yet
  denied(use(grant('bid_client_facing', { status: 'pending' })), 'PURPOSE_GRANT_INACTIVE:bid_client_facing');
  denied(use(grant('bid_client_facing', { revision: 2 })), 'PURPOSE_GRANT_NOT_BOUND_TO_REVISION:bid_client_facing');
  denied(use(grant('bid_client_facing', { hash: 'sha256:old' })), 'PURPOSE_GRANT_NOT_BOUND_TO_REVISION:bid_client_facing');
  denied(use(grant('bid_client_facing', { entity_id: 'ev-2' })), 'PURPOSE_GRANT_NOT_BOUND_TO_REVISION:bid_client_facing');
  denied(use(grant('bid_client_facing', { channel: 'email' }), { channel: 'deck' }), 'PURPOSE_GRANT_CHANNEL_MISMATCH:bid_client_facing');
  allowed(use(grant('bid_client_facing', { channel: 'deck' }), { channel: 'deck' }));
  denied(use('not a grant'), 'PURPOSE_NOT_GRANTED:bid_client_facing');
  denied(use(grant('bid_client_facing'), { now: undefined }), 'NO_CLOCK');
  denied(use(grant('bid_client_facing'), { now: 'soon' }), 'NO_CLOCK');
  denied(use(grant('bid_client_facing'), { purpose: 'sell_to_third_parties' }), 'UNKNOWN_PURPOSE:sell_to_third_parties');
  denied(use(grant('bid_client_facing'), { grants: 'all' }), 'PURPOSE_NOT_GRANTED:bid_client_facing');
  allowed(decide({ sub: 'u-m', roles: ['member'] }, 'use_for_purpose', entity(), ctx({ purpose: 'bid_client_facing', grants: [grant('bid_client_facing', { status: 'revoked' }), grant('bid_client_facing')] }))); // one valid grant is enough
  denied(decide({ sub: 'u-m', roles: ['member'] }, 'use_for_purpose', entity({ approved_revision: 1 }), ctx({ purpose: 'bid_client_facing', grants: [grant('bid_client_facing')] })), 'REQUIREMENT_UNMET:evidence_approved'); // a grant is not an approval
});

test('purposes include the four pack purposes and the two pending ones; granting needs a known purpose', () => {
  const ids = WORKFLOW_CONFIG.purposes.map(p => p.id);
  assert.deepEqual(ids, ['internal_knowledge', 'cv', 'bid_client_facing', 'public_spotlight', 'skills_profile', 'matching']);
  for (const id of ids) allowed(decide(owner, 'grant_permission', entity(), ctx({ purpose: id })));
  denied(decide(owner, 'grant_permission', entity(), ctx({ purpose: 'everything' })), 'UNKNOWN_PURPOSE:everything');
  denied(decide(reviewer, 'grant_permission', entity(), ctx({ purpose: 'cv' })), 'ROLE_NOT_PERMITTED'); // only the person it concerns grants
  allowed(decide({ sub: 'u-admin', roles: ['admin'] }, 'revoke_permission', entity(), ctx({ purpose: 'cv' })));
});

test('Spotlight: nomination is not publication', () => {
  allowed(decide(reviewer, 'spotlight_nominate', entity(), ctx()));
  denied(decide(reviewer, 'spotlight_nominate', entity({ approved_revision: 2 }), ctx()), 'REQUIREMENT_UNMET:evidence_approved');
  denied(decide(reviewer, 'spotlight_publish', entity(), ctx({ gates: allGates() })), 'ROLE_NOT_PERMITTED'); // a reviewer is not the named approver
});

test('Spotlight gates run in pack order and the first open gate is the reason', () => {
  assert.deepEqual(GATES, ['claim_level_evidence', 'project_owner_approval', 'customer_permission_if_required', 'confidentiality_review', 'privacy_legal_review_if_required', 'brand_approval', 'exact_revision_publication_authorization']);
  allowed(publish());
  denied(publish({ gates: {} }), 'SPOTLIGHT_GATE_OPEN:claim_level_evidence');
  denied(publish({ gates: undefined }), 'SPOTLIGHT_GATE_OPEN:claim_level_evidence');
  denied(publish({ gates: 'approved' }), 'SPOTLIGHT_GATE_OPEN:claim_level_evidence');
  for (const [i, g] of GATES.entries()) {
    const gates = allGates(); delete gates[g];
    denied(publish({ gates }), `SPOTLIGHT_GATE_OPEN:${g}`);
    // everything after the first open gate may also be open: the earliest one is still the reason
    const later = allGates(); for (const l of GATES.slice(i)) delete later[l];
    denied(publish({ gates: later }), `SPOTLIGHT_GATE_OPEN:${g}`);
  }
  denied(publish({}, publisher, entity({ approved_revision: 2 })), 'SPOTLIGHT_GATE_OPEN:claim_level_evidence'); // claim evidence is the approved evidence revision
});

test('Spotlight gate records must be approved, bound to the exact revision and hash, and not the owner\'s own', () => {
  const open = (name, rec) => denied(publish({ gates: { ...allGates(), [name]: rec } }), `SPOTLIGHT_GATE_OPEN:${name}`);
  open('brand_approval', gate({ status: 'pending' }));
  open('brand_approval', gate({ revision: 2 }));
  open('brand_approval', gate({ hash: 'sha256:old' }));
  open('brand_approval', gate({ approver_sub: '' }));
  open('brand_approval', gate({ approver_sub: 'u-owner' }));
  open('brand_approval', 'approved');
  open('brand_approval', null);
  open('brand_approval', gate({ source: 'library_status' })); // library "published" label (D17)
  open('confidentiality_review', gate({ status: 'not_required', reason: 'x', decided_by: 'u-gate' })); // only the *_if_required gates can be waived
  open('customer_permission_if_required', { status: 'not_required', decided_by: 'u-gate' }); // a waiver needs a reason
  open('customer_permission_if_required', { status: 'not_required', reason: 'x', decided_by: 'u-owner' });
  open('privacy_legal_review_if_required', { status: 'not_required', reason: 'x' });
  // L11: a waiver is of one exact revision and content, like an approval
  open('privacy_legal_review_if_required', { status: 'not_required', reason: 'x', decided_by: 'u-gate' }); // unbound
  open('privacy_legal_review_if_required', gate({ status: 'not_required', reason: 'x', decided_by: 'u-gate', revision: 2 })); // an older revision
  open('privacy_legal_review_if_required', gate({ status: 'not_required', reason: 'x', decided_by: 'u-gate', hash: 'sha256:old' }));
  open('exact_revision_publication_authorization', gate({ channel: 'other-channel' })); // approval names the channel
  open('exact_revision_publication_authorization', gate({ channel: undefined }));
  denied(publish({ channel: undefined, grants: [grant('public_spotlight')] }), 'SPOTLIGHT_GATE_OPEN:exact_revision_publication_authorization');
  const waived = allGates(); waived.customer_permission_if_required = gate({ status: 'approved' });
  allowed(publish({ gates: waived })); // or actually approved
});

test('Spotlight also needs a live public_spotlight grant for the exact revision and channel, after the gates', () => {
  const g = o => publish({ grants: [grant('public_spotlight', { channel: 'spotlight-web', ...o })] });
  allowed(g({}));
  denied(publish({ grants: [] }), 'PURPOSE_NOT_GRANTED:public_spotlight');
  denied(publish({ grants: [grant('internal_knowledge'), grant('cv'), grant('bid_client_facing')] }), 'PURPOSE_NOT_GRANTED:public_spotlight'); // the four purposes are independent
  denied(g({ expires_at: '2026-10-01T00:00:00Z' }), 'PURPOSE_EXPIRED:public_spotlight');
  denied(g({ status: 'revoked' }), 'PURPOSE_REVOKED:public_spotlight');
  denied(g({ revision: 2 }), 'PURPOSE_GRANT_NOT_BOUND_TO_REVISION:public_spotlight');
  denied(g({ channel: 'print' }), 'PURPOSE_GRANT_CHANNEL_MISMATCH:public_spotlight');
  denied(publish({ gates: {}, grants: [] }), 'SPOTLIGHT_GATE_OPEN:claim_level_evidence'); // a gate is reported before the grant
  allowed(publish({}, { sub: 'u-pub', roles: ['publisher'] }));
  allowed(decide(publisher, 'spotlight_schedule', entity(), ctx({ gates: allGates(), grants: [grant('public_spotlight', { channel: 'spotlight-web' })] })));
  denied(decide({ sub: 'a', roles: ['admin'] }, 'spotlight_publish', entity(), ctx({ gates: allGates() })), 'ROLE_NOT_PERMITTED'); // admin has no override
});

test('gates are approved by the role that owns them; admin and owner cannot close them', () => {
  for (const [name, role] of Object.entries({ claim_level_evidence: 'reviewer', project_owner_approval: 'project_owner', customer_permission_if_required: 'customer_liaison', confidentiality_review: 'confidentiality_reviewer', privacy_legal_review_if_required: 'legal_reviewer', brand_approval: 'brand_approver' })) {
    allowed(decide({ sub: 'u-g', roles: [role] }, 'approve_gate', entity(), ctx({ gate: name })));
    denied(decide({ sub: 'u-g', roles: ['admin'] }, 'approve_gate', entity(), ctx({ gate: name })), 'ROLE_NOT_PERMITTED');
  }
  allowed(decide(publisher, 'approve_gate', entity(), ctx({ gate: 'exact_revision_publication_authorization' })));
  denied(decide(publisher, 'approve_gate', entity(), ctx({ gate: 'exact_revision_publication_authorization', channel: undefined })), 'CHANNEL_REQUIRED');
  denied(decide(publisher, 'approve_gate', entity(), ctx({ gate: 'brand_approval' })), 'ROLE_NOT_PERMITTED');
  denied(decide(publisher, 'approve_gate', entity(), ctx({ gate: 'made_up' })), 'UNKNOWN_GATE:made_up');
  denied(decide(publisher, 'approve_gate', entity(), ctx({ gate: '__proto__' })), 'UNKNOWN_GATE:__proto__');
  denied(decide(publisher, 'approve_gate', entity(), ctx({})), 'UNKNOWN_GATE:undefined');
});

test('library "published" never maps to Spotlight (D17)', () => {
  denied(decide({ sub: 'x', roles: ['admin', 'system', 'spotlight_approver'] }, 'map_library_status_to_spotlight', entity({ status: 'published' }), ctx()), 'LIBRARY_PUBLISHED_NOT_SPOTLIGHT');
  denied(publish({ derived_from_library_status: true }), 'LIBRARY_PUBLISHED_NOT_SPOTLIGHT');
  denied(decide(reviewer, 'spotlight_nominate', entity({ status: 'published' }), ctx({ derived_from_library_status: true })), 'LIBRARY_PUBLISHED_NOT_SPOTLIGHT');
  // a library status of published opens no Spotlight gate by itself
  denied(publish({ gates: {} }, publisher, entity({ status: 'published' })), 'SPOTLIGHT_GATE_OPEN:claim_level_evidence');
  denied(publish({ gates: { ...allGates(), claim_level_evidence: { status: 'published', source: 'library_status', revision: 3, hash: H, approver_sub: 'u-g' } } }), 'SPOTLIGHT_GATE_OPEN:claim_level_evidence');
});

test('a mock acknowledgement is never sync_complete or published (D12)', () => {
  const system = { sub: 'job-runner', roles: ['system'] };
  const rec = (a, ack) => decide(system, a, entity(), ctx({ destination_ack: ack }));
  for (const a of ['record_sync_complete', 'record_published']) {
    allowed(rec(a, { mock: false, revision: 3, hash: H }));
    denied(rec(a, undefined), 'NO_DESTINATION_ACK');
    denied(rec(a, 'ok'), 'NO_DESTINATION_ACK');
    denied(rec(a, { mock: true, revision: 3, hash: H }), 'DESTINATION_ACK_NOT_LIVE');
    denied(rec(a, { revision: 3, hash: H }), 'DESTINATION_ACK_NOT_LIVE'); // mock must be exactly false
    denied(rec(a, { mock: 'false', revision: 3, hash: H }), 'DESTINATION_ACK_NOT_LIVE');
    denied(rec(a, { mock: false, revision: 2, hash: H }), 'DESTINATION_ACK_NOT_BOUND_TO_REVISION');
    denied(decide(reviewer, a, entity(), ctx({ destination_ack: { mock: false, revision: 3, hash: H } })), 'ROLE_NOT_PERMITTED');
  }
  denied(decide(system, 'record_published', entity(), ctx({ destination_ack: { mock: false, revision: 3, hash: H }, derived_from_library_status: true })), 'LIBRARY_PUBLISHED_NOT_SPOTLIGHT');
});

test('exports: internal notes never leave in an external export; external fields are an allowlist', () => {
  const exp = (audience, fields, who = { sub: 'u-m', roles: ['member'] }, e = entity()) => decide(who, 'export', e, ctx({ audience, fields }));
  for (const aud of ['client_docx', 'spotlight_cms', 'public_pdf', 'external_presentation', 'public']) {
    allowed(exp(aud, ['summary.text', 'kpis', 'project.client_display', 'kpis.label']));
    denied(exp(aud, ['summary.text', 'internal_notes.manager']), 'INTERNAL_FIELD_IN_EXTERNAL_EXPORT:internal_notes.manager');
    denied(exp(aud, ['internal_notes']), 'INTERNAL_FIELD_IN_EXTERNAL_EXPORT:internal_notes'); // the whole object contains internal fields
    denied(exp(aud, ['internal_notes.date'], { sub: 'a', roles: ['member', 'authorized_manager'] }), 'INTERNAL_FIELD_IN_EXTERNAL_EXPORT:internal_notes.date'); // not even for an authorized manager
    denied(exp(aud, ['summary.text', 'consultant.salary']), 'EXPORT_FIELD_NOT_PUBLIC:consultant.salary');
    denied(exp(aud, ['summary.textual']), 'EXPORT_FIELD_NOT_PUBLIC:summary.textual'); // prefixes match on a dot boundary only
    denied(exp(aud, ['summary.text'], undefined, entity({ approved_revision: 1 })), 'REQUIREMENT_UNMET:evidence_approved');
  }
  allowed(exp('internal', ['summary.text']));
  denied(exp('internal', ['internal_notes.manager']), 'INTERNAL_FIELD_ROLE_REQUIRED:internal_notes.manager');
  allowed(exp('internal', ['internal_notes.manager'], { sub: 'a', roles: ['member', 'authorized_manager'] }));
  denied(exp('internal', ['internal_notes.manager'], { sub: 'a', roles: ['authorized_manager'] }), 'ROLE_NOT_PERMITTED'); // the export action itself needs a role too
  allowed(exp('internal', ['internal_notes.consultant'], { sub: 'a', roles: ['member', 'authorized_internal_operations'] }));
  denied(exp('partner_portal', ['summary.text']), 'UNKNOWN_AUDIENCE:partner_portal');
  denied(exp(undefined, ['summary.text']), 'UNKNOWN_AUDIENCE:undefined');
  for (const f of [undefined, [], 'summary.text', [''], [5]]) denied(exp('public_pdf', f), 'EXPORT_FIELDS_REQUIRED');
});

test('decide is deterministic and does not mutate its inputs', () => {
  const a = { sub: 'u-pub', roles: ['spotlight_approver'] }, e = entity(), c = ctx({ gates: allGates(), grants: [grant('public_spotlight', { channel: 'spotlight-web' })] });
  const snap = JSON.stringify([a, e, c]);
  const first = decide(a, 'spotlight_publish', e, c);
  for (let i = 0; i < 5; i++) assert.deepEqual(decide(a, 'spotlight_publish', e, c), first);
  assert.equal(JSON.stringify([a, e, c]), snap);
  assert.deepEqual(Object.keys(first), ['allow', 'reason']);
});

test('M2: the author of the revision under review cannot approve it (AUTHOR_CANNOT_APPROVE), whoever they are', () => {
  const t = { ...ctx({ to: 'evidence_approved' }), transitions: TRANSITIONS };
  const e = entity({ revision_author: 'u-rev' });
  denied(decide(reviewer, 'approve', e, t), 'AUTHOR_CANNOT_APPROVE');
  denied(decide({ sub: 'u-rev', roles: ['admin'] }, 'approve', e, t), 'AUTHOR_CANNOT_APPROVE');
  allowed(decide({ sub: 'u-rev2', roles: ['reviewer'] }, 'approve', e, t));
  allowed(decide(reviewer, 'approve', entity({ revision_author: 'u-owner' }), t)); // the owner wrote it: a reviewer approves
  allowed(decide(reviewer, 'approve', entity(), t)); // no author recorded: unchanged behaviour
  allowed(decide(reviewer, 'reject', e, { ...t, to: 'rejected' })); // only approval is author-bound
});
