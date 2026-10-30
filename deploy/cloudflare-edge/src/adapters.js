// Destination adapters (plan §4, decisions D1-D5, D12; Integration Contracts §1-§5): contract-driven MOCKS only. No live DNA,
// MeChat, IMP or Spotlight CMS endpoint, schema or credential exists in this repository, so nothing here calls a network; a mock
// answers from memory and every acknowledgement carries mock:true. A mock acknowledgement is never "synced" or "published"
// (D12): the policy gate refuses record_sync_complete / record_published unless destination_ack.mock === false.
//
// ATLAS_ADAPTERS = off (default) | mock. `live` is refused and reported BLOCKED_EXTERNAL; anything else is off.
// Payloads are built ONLY from an approved revision's claims (statement and typed fields): never the interview transcript, never
// source_refs, ledger or session ids. The Spotlight payload is the audience projection (story-projection.js), built elsewhere.
// MAAP and Project Review are shells: their rubric is MUST_BE_CONFIGURED_BY_PROCESS_OWNER, so rating or closing is denied by the
// gate with MAAP_NOT_CONFIGURED / PROJECT_REVIEW_NOT_CONFIGURED.
import { decide } from './policy-gate.js';

export const adapterMode = env => {
  const v = String(env?.ATLAS_ADAPTERS ?? 'off').trim().toLowerCase();
  if (v === 'mock') return { mode: 'mock' };
  if (v === 'live') return { mode: 'blocked', code: 'BLOCKED_EXTERNAL', reason: 'Live adapters need the system owners\' endpoints, schemas and credentials; none are configured.' };
  return { mode: 'off' };
};
// ATLAS_EVIDENCE_WORKFLOW=off turns the fan-out, the status route and the sync route off (rollback); anything else is on.
export const evidenceWorkflowOn = env => String(env?.ATLAS_EVIDENCE_WORKFLOW ?? 'on').trim().toLowerCase() !== 'off';

// The four destination adapters. `destination` is the job envelope's destination, `branch` the status card it feeds.
export const CONTRACTS = {
  DNA_SKILLS_WRITEBACK: { branch: 'dna', destination: 'DNA', purpose: 'skills_profile', label: 'DNA — skills write-back (mock, not connected)' },
  MECHAT_CV: { branch: 'mechat', destination: 'MeChat', purpose: 'cv', label: 'MeChat (CV) — not connected, mock' },
  IMP_CAPABILITY: { branch: 'imp', destination: 'IMP', purpose: 'matching', label: 'IMP — capability signal (mock, not connected)' },
  SPOTLIGHT_CMS: { branch: 'spotlight', destination: 'Spotlight', purpose: 'public_spotlight', label: 'Spotlight CMS — mock, can never publish' },
};
export const ADAPTER_BY_DESTINATION = Object.fromEntries(Object.entries(CONTRACTS).map(([name, c]) => [c.destination, name]));
export const ADAPTER_BY_BRANCH = Object.fromEntries(Object.entries(CONTRACTS).map(([name, c]) => [c.branch, name]));

// ---- payloads, from the approved revision only ----
const SKILL_TYPES = ['responsibility', 'deliverable', 'technology', 'credential'];
const CV_TYPES = ['responsibility', 'deliverable', 'technology', 'credential', 'outcome', 'metric'];
const typed = c => ({ claim_id: c.claim_id, claim_type: c.claim_type, statement: c.statement, attribution: c.attribution, origin: c.origin });
const measured = c => ({ ...typed(c), value: c.value ?? null, unit: c.unit ?? null, baseline: c.baseline ?? null, after_state: c.after_state ?? null, period: c.period ?? null });
const grantRef = (grants, purpose) => (grants || []).filter(g => g.purpose === purpose && g.status === 'active')
  .map(g => ({ grant_id: g.id, purpose: g.purpose, scope: g.scope ?? null, expires_at: g.expires_at ?? null, revision: g.revision }));
const base = (entity, approval) => ({ entity_id: entity.id, source_revision: entity.revision, content_hash: entity.content_hash, approved_at: approval?.at ?? null });

// `input` = { entity, claims, approval, grants }. Nothing about the interview itself (quotes, ledger ids, ASR meta) is in a payload.
export function buildPayload(adapter, { entity, claims, approval, grants }) {
  const list = Array.isArray(claims) ? claims : [];
  switch (adapter) {
    case 'DNA_SKILLS_WRITEBACK': // proposal only: no taxonomy id or level is invented (null until DNA's taxonomy maps it); a story approval is not a skill approval
      return { ...base(entity, approval), consultant_id: entity.owner_sub, reviewer: approval?.approver_sub ?? null, effective_date: String(approval?.at ?? '').slice(0, 10) || null,
        assertions: list.filter(c => SKILL_TYPES.includes(c.claim_type) && c.attribution !== 'client')
          .map(c => ({ ...typed(c), skill_taxonomy_id: null, level: null, status: 'proposed', evidence_refs: [{ claim_id: c.claim_id, revision: entity.revision }] })) };
    case 'MECHAT_CV': // approved contribution claims only; context and learning may carry restricted client detail and stay out
      return { ...base(entity, approval), consultant_id: entity.owner_sub, profile_revision: entity.revision, language: null, target_role: null, template: null,
        claims: list.filter(c => CV_TYPES.includes(c.claim_type) && c.attribution !== 'client').map(measured), permissions: grantRef(grants, 'cv') };
    case 'IMP_CAPABILITY': // a capability signal; availability and allocation are IMP's, never computed here
      return { ...base(entity, approval), consultant_id: entity.owner_sub, availability: null,
        signals: list.filter(c => SKILL_TYPES.includes(c.claim_type) && c.attribution !== 'client').map(typed), permissions: grantRef(grants, 'matching') };
    default: throw new Error(`No payload builder for ${adapter}.`);
  }
}

// ---- mock destinations ----
// Failure injection for tests: failNext(n, { error, retryable, throws }), failAlways(error), setDestinationRevision(entity, revision), reset().
// `calls` records every attempt (payload included) so a test can assert what was, and was not, sent.
const FORBIDDEN_IN_CMS = ['internal_notes', 'source_refs', 'approval_state', 'ledger_id', 'session_id', 'item_id'];
export function createMockAdapter(name, { now = () => new Date().toISOString() } = {}) {
  const contract = CONTRACTS[name];
  if (!contract) throw new Error(`Unknown adapter ${name}.`);
  const records = new Map(), acks = new Map(), failures = [], calls = [];
  let always = null;
  const adapter = {
    name, label: contract.label, mock: true, calls, records,
    failNext(n = 1, failure = {}) { for (let i = 0; i < n; i++) failures.push({ error: 'MOCK_INJECTED_FAILURE', ...failure }); },
    failAlways(error = 'MOCK_INJECTED_FAILURE', retryable = true) { always = { error, retryable }; },
    setDestinationRevision(entity, revision) { records.set(entity, { revision, version: (records.get(entity)?.version ?? 0) + 1 }); },
    reset() { records.clear(); acks.clear(); failures.length = 0; calls.length = 0; always = null; },
    async send(job, payload) {
      calls.push({ job_id: job.job_id, idempotency_key: job.idempotency_key, destination: job.destination, source_revision: job.source_revision, payload_hash: job.payload_hash, payload });
      const injected = failures.shift() || always;
      if (injected) { if (injected.throws) throw new Error(injected.error); return { ok: false, retryable: injected.retryable !== false, error: injected.error }; }
      if (name === 'SPOTLIGHT_CMS') {
        const text = JSON.stringify(payload);
        if (payload?.audience !== 'public' || FORBIDDEN_IN_CMS.some(k => text.includes(`"${k}"`))) return { ok: false, retryable: false, error: 'CMS_REJECTED_NOT_PUBLIC_SAFE' };
      }
      if (acks.has(job.idempotency_key)) return { ok: true, ack: acks.get(job.idempotency_key), duplicate: true }; // the destination dedupes by key
      const known = records.get(job.source_entity_id);
      if (known && known.revision > job.source_revision) return { ok: false, conflict: true, error: 'DESTINATION_NEWER_REVISION', destination_revision: known.revision }; // never overwrite
      const version = (known?.version ?? 0) + 1;
      records.set(job.source_entity_id, { revision: job.source_revision, version });
      const ack = { mock: true, adapter: name, destination: contract.destination, destination_record_id: `mock-${name.toLowerCase()}-${job.source_entity_id}`, destination_version: version,
        destination_revision: job.source_revision, revision: job.source_revision, hash: payload?.content_hash ?? null, payload_hash: job.payload_hash, acknowledged_at: now(),
        note: 'Mock acknowledgement. Nothing was sent to a real system.' };
      if (name === 'SPOTLIGHT_CMS') Object.assign(ack, { publication_state: 'mock_held', published: false, canonical_url: null, published_at: null, revision_hash: payload.revision_hash ?? null });
      acks.set(job.idempotency_key, ack);
      return { ok: true, ack };
    },
  };
  return adapter;
}

// ---- MAAP and Project Review shells (D2, D3) ----
export function createShell(name) {
  const key = name === 'MAAP' ? 'maap' : 'project_review';
  const denied = action => decide({ sub: 'atlas-system', roles: ['system'] }, `${key}_${action}`, {}, {});
  return { name, mock: true, rubric: 'MUST_BE_CONFIGURED_BY_PROCESS_OWNER', configured: false,
    rate: () => denied('rate'), close: () => denied('close'), // { allow:false, reason:'MAAP_NOT_CONFIGURED' | 'PROJECT_REVIEW_NOT_CONFIGURED' }
    async send() { return { ok: false, retryable: false, error: `${name.toUpperCase()}_NOT_CONFIGURED` }; } };
}

// One registry per Library (Durable Object); tests may replace an entry or call the injection hooks on it.
const registries = new WeakMap();
export function registry(lib, { now } = {}) {
  if (!registries.has(lib)) {
    const r = Object.fromEntries(Object.keys(CONTRACTS).map(n => [n, createMockAdapter(n, { now })]));
    r.MAAP = createShell('MAAP'); r.PROJECT_REVIEW = createShell('PROJECT_REVIEW');
    registries.set(lib, r);
  }
  return registries.get(lib);
}
