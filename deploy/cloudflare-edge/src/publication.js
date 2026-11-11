// Story publication. Pure transitions. deriveStatus in library.js is this derive function.
// upsert is the writer for a revision: it applies `revised` and stores that state and its status.
// The status column for a review, an approval, a withdrawal, a reinstatement or a merge is
// publicationStatus of the state the reducer returned. Merge applies `merged`.
// A rejection log is the story id, the phase and the event. Never the story text, an address or a key.
export const PUBLICATION_VERSION = 1;
export const PUBLICATION_PHASES = Object.freeze(['in_review', 'needs_work', 'changes_requested', 'awaiting_validation', 'published', 'admin_test', 'withdrawn']);
export const PUBLICATION_EVENTS = Object.freeze(['revised', 'derive', 'merged']);
// The five validation statuses and four decisions the golden table distinguishes. undefined is the missing field.
export const KNOWN_VALIDATION = Object.freeze([undefined, 'pending', 'validated', 'changes_requested', 'admin_bypass']);
export const KNOWN_DECISIONS = Object.freeze([undefined, 'pending', 'approved', 'changes_requested']);

const defaultLog = line => { try { console.warn(JSON.stringify(line)); } catch { /* logging never changes the status */ } };

export function isWithdrawn(state) {
  return !!state.withdrawn;
}
export function isAdminBypass(state) {
  return (state.validation || {}).status === 'admin_bypass';
}
export function isAdminTest(state) {
  return isAdminBypass(state) && !!state.test;
}
export function qualityMissing(state) {
  return !state.quality;
}
export function qualityReady(state) {
  return !!state.quality && state.quality.status === 'ready';
}
export function changesRequested(state) {
  const v = state.validation || {};
  return v.status === 'changes_requested' || v.managerDecision === 'changes_requested' || v.presalesDecision === 'changes_requested';
}
export function validatedFlag(state) {
  return (state.validation || {}).status === 'validated';
}
// Publish from the approval lanes requires both decisions. The validated flag does not publish by itself.
export function canPublish(state) {
  return bothApproved(state);
}
export function bothApproved(state) {
  const v = state.validation || {};
  return v.managerDecision === 'approved' && v.presalesDecision === 'approved';
}
export function knownValidation(status) {
  return KNOWN_VALIDATION.includes(status);
}
export function knownDecision(decision) {
  return KNOWN_DECISIONS.includes(decision);
}
export function approvalUnknown(state) {
  const v = state.validation || {};
  return !knownValidation(v.status) || !knownDecision(v.managerDecision) || !knownDecision(v.presalesDecision);
}

export function initialPublication() {
  return {
    version: PUBLICATION_VERSION,
    withdrawn: false,
    test: false,
    quality: null,
    validation: { status: 'pending', managerDecision: 'pending', presalesDecision: 'pending', by: '', at: '', note: '', managerStaffIgnored: false },
  };
}

// A stored story round-trips. A missing value becomes a fresh in-review record. Nothing here rewrites a row.
export function loadPublication(raw) {
  if (!raw || typeof raw !== 'object') return initialPublication();
  return { ...raw };
}

// Known values follow the previous derive, except that a validated flag publishes only with both approvals.
// merged_into is not read. An unknown validation status or decision is not allowed to publish.
// The log is the id, the phase and the event.
export function publicationStatus(state, opts = {}) {
  if (isWithdrawn(state)) return 'withdrawn';
  if (approvalUnknown(state)) {
    const phase = qualityReady(state) ? 'awaiting_validation' : 'in_review';
    if (opts.log !== false) (opts.log || defaultLog)({ atlas_metric: 'publication', id: opts.id ?? state.id ?? null, phase, event: opts.event || 'derive' });
    return phase;
  }
  // A verified admin bypass is explicit and audited. The manager-staff checkbox never arrives here as not_required.
  if (isAdminBypass(state)) {
    if (state.test) return 'admin_test';
    if (qualityMissing(state)) return 'in_review';
    if (!qualityReady(state)) return 'needs_work';
    return 'published';
  }
  if (qualityMissing(state)) return 'in_review';
  if (!qualityReady(state)) return 'needs_work';
  if (changesRequested(state)) return 'changes_requested';
  if (canPublish(state)) return 'published';
  return 'awaiting_validation';
}

function done(state, status) {
  return { ok: true, illegal: false, state, status, effects: [] };
}
function illegal(state, event, log) {
  const phase = state && typeof state === 'object' ? publicationStatus(state, { log: false }) : 'in_review';
  log({ atlas_metric: 'publication', id: event?.id ?? state?.id ?? null, phase, event: event?.type || 'unknown' });
  return { ok: false, illegal: true, state, status: phase, effects: [] };
}

export function publicationTransition(state, event, { log = defaultLog } = {}) {
  const type = event?.type;
  if (!PUBLICATION_EVENTS.includes(type)) return illegal(state, event, log);
  if (type === 'derive') return done(state, publicationStatus(state));
  if (type === 'merged') {
    const prior = state && typeof state === 'object' ? state : {};
    const next = { ...prior, withdrawn: true };
    return done(next, publicationStatus(next));
  }
  const prior = state && typeof state === 'object' ? state : {};
  const next = {
    ...prior,
    quality: null,
    withdrawn: false,
    test: false,
    tenant: event.tenant,
    validation: {
      status: 'pending',
      managerDecision: 'pending',
      presalesDecision: 'pending',
      by: '',
      at: '',
      note: '',
      managerStaffIgnored: !!event.managerStaffIgnored,
    },
  };
  return done(next, publicationStatus(next));
}
