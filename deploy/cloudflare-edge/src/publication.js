// Story publication. Pure transitions. deriveStatus in library.js is this derive function.
// The reducer is the only writer of validation, withdrawn and test.
// upsert applies `revised`. A rating applies `reviewed`. A lane applies `decided`.
// An admin bypass applies `admin_published`. Withdraw, reinstate and merge apply their events.
// A rejection marker is the story id, the phase and the event. The caller logs it.
// Never the story text, an address or a key. publicationTransition does not log.
export const PUBLICATION_VERSION = 1;
export const PUBLICATION_PHASES = Object.freeze(['in_review', 'needs_work', 'changes_requested', 'awaiting_validation', 'published', 'admin_test', 'withdrawn']);
export const PUBLICATION_EVENTS = Object.freeze(['revised', 'derive', 'merged', 'reviewed', 'decided', 'admin_published', 'withdrawn', 'reinstated']);
// revised, derive, merged and reviewed are legal from every phase. revised from withdrawn keeps
// withdrawn: version 1, quality reset and both lanes pending still apply. Only reinstated clears it.
// reviewed stays legal from withdrawn so a rating already in flight can settle; withdrawn still wins the status.
// decided, admin_published and withdrawn are not legal from withdrawn. reinstated is legal only from withdrawn.
// mergedInto is a separate guard on reinstated. Anything absent from this table is an illegal pair.
const ACTIVE_PHASES = Object.freeze(PUBLICATION_PHASES.filter(phase => phase !== 'withdrawn'));
const tableRows = (phases, event) => phases.map(from => Object.freeze({ from, event }));
export const PUBLICATION_TABLE = Object.freeze([
  ...tableRows(PUBLICATION_PHASES, 'revised'),
  ...tableRows(PUBLICATION_PHASES, 'derive'),
  ...tableRows(PUBLICATION_PHASES, 'merged'),
  ...tableRows(PUBLICATION_PHASES, 'reviewed'),
  ...tableRows(ACTIVE_PHASES, 'decided'),
  ...tableRows(ACTIVE_PHASES, 'admin_published'),
  ...tableRows(ACTIVE_PHASES, 'withdrawn'),
  Object.freeze({ from: 'withdrawn', event: 'reinstated' }),
]);

export function publicationPairs() {
  const legal = new Set();
  for (const row of PUBLICATION_TABLE) {
    const from = row.from === 'any' ? PUBLICATION_PHASES : [row.from];
    for (const phase of from) legal.add(phase + ':' + row.event);
  }
  return legal;
}
// The five validation statuses and four decisions the golden table distinguishes. undefined is the missing field.
export const KNOWN_VALIDATION = Object.freeze([undefined, 'pending', 'validated', 'changes_requested', 'admin_bypass']);
export const KNOWN_DECISIONS = Object.freeze([undefined, 'pending', 'approved', 'changes_requested']);

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

function isRecord(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

// main never stored a version. Those rows keep their fields and derive through publicationStatus.
// An unknown version keeps its fields too. Nothing is overlaid and nothing is written.
// This does not mutate raw.
export function loadPublication(raw) {
  if (!isRecord(raw)) return initialPublication();
  return { ...raw };
}

// One read of a stored publication. Version 1 round-trips and keeps the column status (status null).
// A version-less row decodes through publicationStatus and is not rewritten. An unknown version
// keeps every stored field. Its decoded status is withdrawn when the row is withdrawn, otherwise
// in_review. Nothing here is persisted. This does not mutate raw.
export function readPublication(stored) {
  if (!isRecord(stored)) {
    const loaded = initialPublication();
    return { state: loaded, status: publicationStatus(loaded) };
  }
  const state = { ...stored };
  if (stored.version === PUBLICATION_VERSION) return { state, status: null };
  if (stored.version == null) return { state, status: publicationStatus(state) };
  return { state, status: isWithdrawn(state) ? 'withdrawn' : 'in_review' };
}

// Known values follow the previous derive, except that a validated flag publishes only with both approvals.
// merged_into is not read. An unknown validation status or decision is not allowed to publish.
export function publicationStatus(state) {
  if (isWithdrawn(state)) return 'withdrawn';
  if (approvalUnknown(state)) return qualityReady(state) ? 'awaiting_validation' : 'in_review';
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
// The caller logs this when a status is derived from an unknown approval. Withdrawn stays quiet.
export function publicationEffect(state, event = {}) {
  if (!state || typeof state !== 'object' || isWithdrawn(state) || !approvalUnknown(state)) return null;
  return { atlas_metric: 'publication', id: event.id ?? state.id ?? null, phase: publicationStatus(state), event: event.event || 'derive' };
}

function illegal(state, event) {
  const phase = state && typeof state === 'object' ? publicationStatus(state) : 'in_review';
  return {
    ok: false, illegal: true, state, status: phase, effects: [],
    rejection: { atlas_metric: 'publication', id: event?.id ?? state?.id ?? null, phase, event: event?.type || 'unknown' },
  };
}

function priorOf(state) {
  return state && typeof state === 'object' ? state : {};
}

// reinstated is the one guard: a row that was merged into another story stays withdrawn.
export function mergedAway(event) {
  return !!event?.mergedInto;
}

function applyDecided(prior, event) {
  const lane = event.lane === 'manager' ? 'manager' : event.lane === 'presales' ? 'presales' : '';
  const decision = event.decision === 'approved' || event.decision === 'changes_requested' ? event.decision : '';
  if (!lane || !decision) return null;
  const prev = prior.validation || {};
  const current = lane === 'manager' ? prev.managerDecision : prev.presalesDecision;
  const written = typeof event.note === 'string' ? event.note : '';
  const note = written || (prev.note || '');
  // A repeated approval, or the same changes request with the same note, is not a new decision.
  // An empty note on a later decision keeps the note already written.
  if (current === decision && (decision !== 'changes_requested' || (prev.note || '') === note)) return { unchanged: true };
  const validation = { ...(prior.validation || {}), by: event.by || '', at: event.at || '', note, status: 'pending' };
  if (lane === 'manager') validation.managerDecision = decision;
  else validation.presalesDecision = decision;
  if (validation.managerDecision === 'changes_requested' || validation.presalesDecision === 'changes_requested') validation.status = 'changes_requested';
  else if (validation.managerDecision === 'approved' && validation.presalesDecision === 'approved') validation.status = 'validated';
  return { ...prior, validation };
}

export function publicationTransition(state, event) {
  const type = event?.type;
  const phase = state && typeof state === 'object' ? publicationStatus(state) : 'in_review';
  if (!PUBLICATION_EVENTS.includes(type) || !publicationPairs().has(phase + ':' + type)) return illegal(state, event);
  const prior = priorOf(state);
  if (type === 'derive') return done(state, publicationStatus(state));
  if (type === 'merged' || type === 'withdrawn') {
    const next = { ...prior, withdrawn: true };
    return done(next, publicationStatus(next));
  }
  if (type === 'reinstated') {
    if (mergedAway(event)) return illegal(state, event);
    const next = { ...prior, withdrawn: false };
    return done(next, publicationStatus(next));
  }
  if (type === 'reviewed') {
    const next = { ...prior, quality: event.quality ?? null };
    if (event.lastJev) next.lastJev = event.lastJev;
    return done(next, publicationStatus(next));
  }
  if (type === 'decided') {
    const next = applyDecided(prior, event);
    if (!next) return illegal(state, event);
    if (next.unchanged) return { ok: true, illegal: false, unchanged: true, state: prior, status: publicationStatus(prior), effects: [] };
    return done(next, publicationStatus(next));
  }
  if (type === 'admin_published') {
    const test = event.test === true;
    const validation = { ...(prior.validation || {}), status: 'admin_bypass', by: event.by || '', at: event.at || '', note: test ? 'admin test' : 'admin publish' };
    const next = { ...prior, test, validation };
    return done(next, publicationStatus(next));
  }
  const next = {
    ...prior,
    version: PUBLICATION_VERSION,
    quality: null,
    withdrawn: !!prior.withdrawn,
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
