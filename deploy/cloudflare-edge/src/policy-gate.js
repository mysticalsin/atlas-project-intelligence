// Policy gate (plan §4, decisions D2-D7, D12, D17, D18): the one place that says whether an actor may do an action to an
// entity. Pure and deterministic: no clock (ctx.now), no storage, no model, nothing thrown. DEFAULT DENY: an action is
// allowed only when it is known, the role permits it and every check for it passes; an unknown action, a malformed
// input or an internal error is a denial. Reasons are stable codes (CODE or CODE:detail) for audit and UI, never prose.
//
//   decide(actor, action, entity, ctx) -> { allow, reason }
//   actor   { sub, roles?: [..] | role?: '..' }       roles are what the caller authenticated; 'owner' is never taken from
//                                                      here but derived: actor.sub === entity.owner_sub.
//   entity  { id, owner_sub, revision, content_hash, status, approved_revision, approved_hash, revision_author? }
//            revision_author: who wrote the current revision; the author of the revision under review cannot approve it (AUTHOR_CANNOT_APPROVE).
//   ctx     { now, expected_revision, content_hash, to?, transitions?, destination?, purpose?, channel?, grants?, gates?,
//             reviewer_approval?, destination_ack?, gate?, audience?, fields?, derived_from_library_status? }
// The state machine is built elsewhere (T8); a transition is checked against the table the caller passes as
// ctx.transitions ({ from: [to, ...] }), never imported here. Policy data comes from policy.generated.js (WORKFLOW_CONFIG,
// VISIBILITY_POLICY), so the Spotlight gate order and destination requirements are the pack's, not a copy.
import { WORKFLOW_CONFIG, VISIBILITY_POLICY } from './policy.generated.js';

const deny = reason => ({ allow: false, reason });
const ok = () => ({ allow: true, reason: 'ALLOWED' });
const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
const text = v => typeof v === 'string' && v.trim() !== '';
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Governance §3, §5 and Spotlight/MAAP specs: Atlas never rates, ranks, infers or decides about people. Named so the denial
// is explicit; anything else unknown is denied as UNKNOWN_ACTION anyway.
const FORBIDDEN = new Set(['rate_consultant', 'compare_consultants', 'rank_consultants', 'score_performance', 'infer_sentiment', 'infer_emotion',
  'infer_personality', 'infer_sensitive_trait', 'predict_attrition', 'decide_promotion', 'decide_compensation', 'decide_termination',
  'decide_employment', 'map_library_status_to_spotlight']);
// MAAP and Project Review outcomes belong to authorized people using the owner's rubric (D2, D3). Atlas holds a shell only.
const REVIEW_DECISIONS = { maap_rate: 'MAAP', maap_close: 'MAAP', maap_outcome: 'MAAP', project_review_rate: 'PROJECT_REVIEW', project_review_close: 'PROJECT_REVIEW' };

// Known actions. roles: who may ask (declared roles, plus the derived 'owner'); review: the owner may not do it to their own
// entity (no self-approval); move: it is a state transition, so ctx.to and ctx.transitions are required.
const ACTIONS = {
  submit: { roles: ['owner'], move: true },
  amend: { roles: ['owner', 'reviewer', 'admin'] },
  withdraw: { roles: ['owner', 'reviewer', 'admin'], move: true },
  dispute: { roles: ['owner', 'reviewer', 'admin'], move: true },
  accept_rejection: { roles: ['owner'], move: true }, // the owner closes a rejection (or their own dispute of it): close_rejected as the user
  uphold_rejection: { roles: ['reviewer', 'admin'], review: true, move: true }, // a dispute adjudicated: the rejection stands (close_rejected as a reviewer)
  reopen_review: { roles: ['reviewer', 'admin'], review: true, move: true }, // a dispute adjudicated: the record goes back to the reviewer queue
  approve: { roles: ['reviewer', 'admin'], review: true, move: true },
  reject: { roles: ['reviewer', 'admin'], review: true, move: true },
  request_clarification: { roles: ['reviewer', 'admin'], review: true, move: true },
  grant_permission: { roles: ['owner'] },
  revoke_permission: { roles: ['owner', 'admin'] },
  use_for_purpose: { roles: ['owner', 'reviewer', 'admin', 'member'] },
  project_destination: { roles: ['reviewer', 'admin', 'system'], review: true },
  spotlight_nominate: { roles: ['reviewer', 'admin', 'system'], review: true },
  approve_gate: { roles: [], review: true }, // the role comes from the gate (GATE_ROLES)
  spotlight_schedule: { roles: ['spotlight_approver', 'publisher'], review: true },
  spotlight_publish: { roles: ['spotlight_approver', 'publisher'], review: true },
  record_sync_complete: { roles: ['system'], review: true },
  record_published: { roles: ['system'], review: true },
  export: { roles: ['owner', 'reviewer', 'admin', 'member'] },
};
const SPOTLIGHT_ACTIONS = new Set(['spotlight_nominate', 'spotlight_schedule', 'spotlight_publish', 'record_published']);
// Who may close each Spotlight gate (Spotlight workflow §4). 'admin' is deliberately absent: no gate has an override.
const GATE_ROLES = { claim_level_evidence: 'reviewer', project_owner_approval: 'project_owner', customer_permission_if_required: 'customer_liaison',
  confidentiality_review: 'confidentiality_reviewer', privacy_legal_review_if_required: 'legal_reviewer', brand_approval: 'brand_approver',
  exact_revision_publication_authorization: 'spotlight_approver' };
const FINAL_GATE = 'exact_revision_publication_authorization';
const TERMINAL = new Set(['withdrawn', 'disputed', 'rejected', 'superseded']);

const toMs = v => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : null; };
const rolesOf = (actor, entity) => {
  const declared = (Array.isArray(actor.roles) ? actor.roles : [actor.role]).filter(text).map(r => r.trim().toLowerCase()).filter(r => r !== 'owner');
  return new Set(actor.sub === entity.owner_sub ? [...declared, 'owner'] : declared);
};

// Approval is of one exact revision: the revision and content hash that were approved must be the entity's current ones.
const evidenceApproved = e => Number.isInteger(e.approved_revision) && e.approved_revision === e.revision && text(e.approved_hash)
  && e.approved_hash === e.content_hash && !TERMINAL.has(e.status);
const bound = (rec, e) => obj(rec) && Number.isInteger(rec.revision) && rec.revision === e.revision && text(rec.hash) && rec.hash === e.content_hash;

// null when the grant is usable now for this exact revision and channel, else a code.
function grantProblem(g, e, ctx, nowMs) {
  if (!obj(g)) return 'PURPOSE_GRANT_MALFORMED';
  const rev = toMs(g.revoked_at);
  const revoked = text(g.revoked_at) || typeof g.revoked_at === 'number';
  if (g.status === 'revoked' || (revoked && (rev === null || rev <= nowMs))) return 'PURPOSE_REVOKED';
  if (g.status !== 'active') return 'PURPOSE_GRANT_INACTIVE';
  if (g.expires_at !== undefined && g.expires_at !== null && g.expires_at !== '') {
    const exp = toMs(g.expires_at);
    if (exp === null) return 'PURPOSE_GRANT_MALFORMED';
    if (exp <= nowMs) return 'PURPOSE_EXPIRED';
  }
  if (!bound(g, e) || (g.entity_id !== undefined && g.entity_id !== e.id)) return 'PURPOSE_GRANT_NOT_BOUND_TO_REVISION';
  if (g.channel !== undefined && g.channel !== null && g.channel !== ctx.channel) return 'PURPOSE_GRANT_CHANNEL_MISMATCH';
  return null;
}
function purposeCheck(purpose, e, ctx) {
  if (!(WORKFLOW_CONFIG.purposes || []).some(p => p.id === purpose)) return `UNKNOWN_PURPOSE:${purpose}`;
  const nowMs = toMs(ctx.now);
  if (nowMs === null) return 'NO_CLOCK';
  const grants = (Array.isArray(ctx.grants) ? ctx.grants : []).filter(g => obj(g) && g.purpose === purpose);
  if (!grants.length) return `PURPOSE_NOT_GRANTED:${purpose}`;
  const problems = grants.map(g => grantProblem(g, e, ctx, nowMs));
  return problems.includes(null) ? null : `${problems[0]}:${purpose}`;
}

function gateOpen(name, rec, e, ctx) {
  if (!obj(rec) || rec.source === 'library_status') return true; // a library label is never a gate (D17)
  if (rec.status === 'not_required') return !(name.endsWith('_if_required') && text(rec.reason) && text(rec.decided_by) && rec.decided_by !== e.owner_sub && bound(rec, e)); // a waiver is of this exact revision too
  if (rec.status !== 'approved' || !bound(rec, e) || !text(rec.approver_sub) || rec.approver_sub === e.owner_sub) return true;
  return name === FINAL_GATE && !(text(ctx.channel) && rec.channel === ctx.channel);
}
function spotlightGates(e, ctx) {
  const gates = obj(ctx.gates) ? ctx.gates : {};
  for (const name of WORKFLOW_CONFIG.workflow.branches.spotlight.requires) { // pack order; the first open gate is the reason
    const rec = own(gates, name) ? gates[name] : undefined;
    if (gateOpen(name, rec, e, ctx) || (name === 'claim_level_evidence' && !evidenceApproved(e))) return `SPOTLIGHT_GATE_OPEN:${name}`;
  }
  return purposeCheck('public_spotlight', e, ctx);
}

function destinationCheck(e, ctx) {
  const dest = WORKFLOW_CONFIG.workflow.branches.purpose_specific_projections.destinations.find(d => d.id === ctx.destination);
  if (!dest) return `UNKNOWN_DESTINATION:${String(ctx.destination).slice(0, 40)}`;
  for (const req of dest.requires) {
    let problem = null;
    if (req === 'evidence_approved') problem = evidenceApproved(e) ? null : `REQUIREMENT_UNMET:${req}`;
    else if (req === 'reviewer_approval') {
      const r = ctx.reviewer_approval;
      problem = bound(r, e) && text(r.sub) && r.sub !== e.owner_sub ? null : `REQUIREMENT_UNMET:${req}`;
    } else if (own(WORKFLOW_CONFIG.requirement_purposes, req)) problem = purposeCheck(WORKFLOW_CONFIG.requirement_purposes[req], e, ctx);
    else problem = `UNKNOWN_REQUIREMENT:${req}`;
    if (problem) return problem;
  }
  return null;
}

// Internal notes never leave in an external export; external fields must be on the public allowlist (Governance, visibility policy).
function exportCheck(actor, roles, e, ctx) {
  const { public_story: pub, internal_only: internal } = VISIBILITY_POLICY.sections;
  const fields = Array.isArray(ctx.fields) ? ctx.fields : null;
  if (!fields || !fields.length || !fields.every(text)) return 'EXPORT_FIELDS_REQUIRED';
  const within = (f, p) => f === p || f.startsWith(`${p}.`);
  const isInternal = f => internal.fields.some(p => within(f, p) || within(p, f));
  const external = ctx.audience === 'public' || internal.never_export_to.includes(ctx.audience);
  if (!external && ctx.audience !== 'internal') return `UNKNOWN_AUDIENCE:${String(ctx.audience).slice(0, 40)}`;
  const leak = fields.find(isInternal);
  if (external) {
    if (leak) return `INTERNAL_FIELD_IN_EXTERNAL_EXPORT:${leak}`;
    const off = fields.find(f => !pub.fields.some(p => within(f, p)));
    if (off) return `EXPORT_FIELD_NOT_PUBLIC:${off}`;
    return evidenceApproved(e) ? null : 'REQUIREMENT_UNMET:evidence_approved';
  }
  return !leak || internal.access_roles.some(r => roles.has(r)) ? null : `INTERNAL_FIELD_ROLE_REQUIRED:${leak}`;
}

function evaluate(actor, action, entity, ctx) {
  if (!obj(actor) || !text(actor.sub)) return deny('INVALID_ACTOR');
  if (!text(action)) return deny('INVALID_ACTION');
  if (FORBIDDEN.has(action)) return deny(action === 'map_library_status_to_spotlight' ? 'LIBRARY_PUBLISHED_NOT_SPOTLIGHT' : 'FORBIDDEN_ACTION');
  if (own(REVIEW_DECISIONS, action)) {
    const branch = REVIEW_DECISIONS[action], key = branch === 'MAAP' ? 'maap_review' : 'project_review';
    return deny(WORKFLOW_CONFIG.workflow.branches[key].rubric === 'MUST_BE_CONFIGURED_BY_PROCESS_OWNER' ? `${branch}_NOT_CONFIGURED` : 'HUMAN_DECISION_ONLY');
  }
  if (!own(ACTIONS, action)) return deny('UNKNOWN_ACTION');
  const spec = ACTIONS[action];
  if (!obj(entity) || !text(entity.owner_sub)) return deny('INVALID_ENTITY');
  if (!obj(ctx)) return deny('INVALID_CONTEXT');

  const roles = rolesOf(actor, entity);
  let allowedRoles = spec.roles;
  if (action === 'approve_gate') {
    if (!own(GATE_ROLES, ctx.gate) || !WORKFLOW_CONFIG.workflow.branches.spotlight.requires.includes(ctx.gate)) return deny(`UNKNOWN_GATE:${String(ctx.gate).slice(0, 40)}`);
    allowedRoles = [GATE_ROLES[ctx.gate]];
  }
  if (!allowedRoles.some(r => roles.has(r))) return deny('ROLE_NOT_PERMITTED');

  // Exact revision: the caller saw this revision and this content (optimistic concurrency, approvals bind to a hash).
  if (!Number.isInteger(entity.revision) || ctx.expected_revision !== entity.revision) return deny('REVISION_MISMATCH');
  if (!text(entity.content_hash) || ctx.content_hash !== entity.content_hash) return deny('CONTENT_HASH_MISMATCH');
  if (spec.review && actor.sub === entity.owner_sub) return deny('SELF_APPROVAL');
  if (action === 'approve' && text(entity.revision_author) && entity.revision_author === actor.sub) return deny('AUTHOR_CANNOT_APPROVE'); // a reviewer who rewrote the claims needs a different approver

  if (spec.move) {
    if (!text(ctx.to) || !text(entity.status)) return deny('TRANSITION_TARGET_REQUIRED');
    if (!obj(ctx.transitions)) return deny('NO_TRANSITION_TABLE');
    const next = own(ctx.transitions, entity.status) ? ctx.transitions[entity.status] : null;
    if (!Array.isArray(next) || !next.includes(ctx.to)) return deny(`TRANSITION_NOT_ALLOWED:${entity.status}>${String(ctx.to).slice(0, 40)}`);
  }
  if (SPOTLIGHT_ACTIONS.has(action) && ctx.derived_from_library_status === true) return deny('LIBRARY_PUBLISHED_NOT_SPOTLIGHT');

  let problem = null;
  switch (action) {
    case 'project_destination': problem = destinationCheck(entity, ctx); break;
    case 'use_for_purpose': problem = evidenceApproved(entity) ? purposeCheck(ctx.purpose, entity, ctx) : 'REQUIREMENT_UNMET:evidence_approved'; break;
    case 'grant_permission': case 'revoke_permission':
      problem = (WORKFLOW_CONFIG.purposes || []).some(p => p.id === ctx.purpose) ? null : `UNKNOWN_PURPOSE:${String(ctx.purpose).slice(0, 40)}`; break;
    case 'spotlight_nominate': problem = evidenceApproved(entity) ? null : 'REQUIREMENT_UNMET:evidence_approved'; break; // nomination is not publication
    case 'spotlight_schedule': case 'spotlight_publish': problem = spotlightGates(entity, ctx); break;
    case 'record_sync_complete': case 'record_published': { // D12: a mock acknowledgement is never sync or publication
      const ack = ctx.destination_ack;
      problem = !obj(ack) ? 'NO_DESTINATION_ACK' : ack.mock !== false ? 'DESTINATION_ACK_NOT_LIVE' : !bound(ack, entity) ? 'DESTINATION_ACK_NOT_BOUND_TO_REVISION' : null;
      break;
    }
    case 'export': problem = exportCheck(actor, roles, entity, ctx); break;
    case 'approve_gate': problem = ctx.gate === FINAL_GATE && !text(ctx.channel) ? 'CHANNEL_REQUIRED' : null; break; // the final approval names its channel
    default: break; // the moves have no further condition
  }
  return problem ? deny(problem) : ok();
}

export function decide(actor, action, entity, ctx = {}) {
  try { return evaluate(actor, action, entity, ctx); } catch { return deny('GATE_ERROR'); }
}
