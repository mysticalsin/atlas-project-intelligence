// Evidence store and review (plan §4, D8-D13, D19; pack: Domain Model §3-§6, End-to-End Workflows §3, Governance §2): what a
// consultant said in an interview becomes atomic claims with source references, reviewed by an accountable person, approved
// against ONE exact revision and content hash. Runs inside the LibraryStore Durable Object on the Library's SQL adapter
// (additive CREATE TABLE IF NOT EXISTS; nothing ALTERs a library table). Every mutation goes through the policy gate
// (policy-gate.js decide, default deny) and then fires the EVIDENCE state machine (conversation-state.js); either refusing
// changes nothing. Draft claims are visible to their owner only (D19); after submission the owner and the resolved N+1 or
// a reviewer see them; everyone else gets 404.
//
// - Claims are immutable per (claim_id, revision): revision N is a full snapshot of the record at revision N, so a prior
//   revision is always readable (W8). Only review_status changes after the write, as a projection of the record's state.
// - The content hash covers the record's claim content (never review_status), so a review or an approval never changes it
//   and any amendment does. An approval is bound to its revision and hash; an amendment supersedes it.
// - workflow_transitions is the audit trail and carries NO claim text: the reason text lives in the record (state_json).
// - Identity is always the verified sign-in the Worker forwarded (x-atlas-user); a body never names an owner.
import { decide } from './policy-gate.js';
import { Machine, StateError, TRANSITIONS, WORKFLOW_VERSION } from './conversation-state.js';
import { FIELDS } from './policy.generated.js';
import { managerOf } from './claims.js';
import { str, para, obj, fail } from './util.js';
import * as branches from './branches.js'; // T15: the approval fan-out and its hooks; inert until the Library is configured with the Worker's env

// Claim vocabulary: the pack's Claim schema, plus context and learning (D13, an Atlas extension).
export const CLAIM_TYPES = ['responsibility', 'deliverable', 'technology', 'outcome', 'metric', 'credential', 'context', 'learning'];
export const SUBJECT_TYPES = ['person', 'project', 'team', 'client'];
export const ATTRIBUTIONS = ['individual', 'team', 'client', 'unknown'];
export const ORIGINS = ['consultant_reported', 'artifact_supported', 'manager_validated', 'client_validated', 'independently_measured', 'estimated', 'unknown'];
const OWNER_ORIGINS = ['consultant_reported', 'estimated', 'unknown']; // the owner cannot mark their own claim as validated by someone else
// Interview ledger field -> [claim_type, base subject_type] (D13). Every ledger field has one (tested against FIELDS).
export const FIELD_CLAIM = { problem: ['context', 'project'], stakes: ['context', 'project'], contribution: ['responsibility', 'person'],
  intervention: ['deliverable', 'project'], decision: ['responsibility', 'person'], adoption: ['outcome', 'project'], outcome: ['outcome', 'project'],
  measurement: ['metric', 'project'], evidence: ['context', 'project'], limitations: ['learning', 'project'], customer_fit: ['learning', 'project'], poor_fit: ['learning', 'project'] };
// Review status enum (Domain Model §4) as a projection of the machine state.
const REVIEW_STATUS = { evidence_draft: 'draft', submitted_for_review: 'submitted', reviewer_queue: 'submitted', needs_clarification: 'needs_clarification',
  approved: 'validated', downstream_proposals: 'validated', impact_review: 'withdrawn', rejected: 'rejected', closed_rejected: 'rejected', disputed: 'disputed', withdrawn: 'withdrawn' };
const MAX_CLAIMS = 100, MAX_LIST = 200, SHORT = 200;
const NOT_FOUND = 'Evidence not found.';

const DDL = [
  `CREATE TABLE IF NOT EXISTS evidence_records (id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, project_ref TEXT, ref_id TEXT, session_id TEXT, notes_hash TEXT,
    status TEXT, revision INTEGER, content_hash TEXT, state_json TEXT, created_at TEXT, updated_at TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS evidence_session ON evidence_records(session_id) WHERE session_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS evidence_owner ON evidence_records(owner_sub)',
  'CREATE TABLE IF NOT EXISTS evidence_revisions (entity TEXT, revision INTEGER, content_hash TEXT, author TEXT, author_role TEXT, kind TEXT, at TEXT, PRIMARY KEY (entity, revision))',
  `CREATE TABLE IF NOT EXISTS evidence_claims (claim_id TEXT, revision INTEGER, entity TEXT, subject_type TEXT, subject_id TEXT, claim_type TEXT, statement TEXT,
    value TEXT, unit TEXT, baseline TEXT, after_state TEXT, period TEXT, attribution TEXT, origin TEXT, review_status TEXT, supersedes TEXT, conflicts_with TEXT,
    source_refs TEXT, created_by TEXT, created_at TEXT, PRIMARY KEY (claim_id, revision))`,
  'CREATE INDEX IF NOT EXISTS evidence_claims_entity ON evidence_claims(entity, revision)',
  `CREATE TABLE IF NOT EXISTS workflow_transitions (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT, revision INTEGER, from_state TEXT, to_state TEXT, event TEXT,
    actor TEXT, actor_role TEXT, at TEXT, workflow_version TEXT, reason TEXT)`,
  'CREATE INDEX IF NOT EXISTS workflow_transitions_entity ON workflow_transitions(entity)',
  `CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, entity TEXT, revision INTEGER, content_hash TEXT, channel TEXT, purpose TEXT, approver_sub TEXT, status TEXT, at TEXT)`,
  'CREATE INDEX IF NOT EXISTS approvals_entity ON approvals(entity)',
  `CREATE TABLE IF NOT EXISTS permission_grants (id TEXT PRIMARY KEY, entity TEXT, subject TEXT, purpose TEXT, destination TEXT, scope TEXT, channel TEXT, geography TEXT,
    expires_at TEXT, grantor TEXT, legal_basis_ref TEXT, status TEXT, revoked_at TEXT, revision INTEGER, content_hash TEXT, created_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS permission_grants_entity ON permission_grants(entity)',
  // One row per (evidence, branch), written only by branches.js (T15): the status, the revision and hash it was derived from, whether the last
  // acknowledgement was a mock, a stable reason code and the job it reflects.
  `CREATE TABLE IF NOT EXISTS branch_status (entity TEXT, branch TEXT, status TEXT, updated_at TEXT, revision INTEGER, content_hash TEXT, mock INTEGER, reason TEXT, job_id TEXT,
    PRIMARY KEY (entity, branch))`,
  // v2.2 M1: the CV destination is MiChat (the pack's "MeChat" was a typo). A row stored under the old branch key reads as michat; an existing
  // michat row wins over a stale mechat one. Idempotent, so it runs on every ensure.
  `UPDATE OR IGNORE branch_status SET branch = 'michat' WHERE branch = 'mechat'`,
  `DELETE FROM branch_status WHERE branch = 'mechat'`,
];
const ensured = new WeakSet();
export function ensure(lib) {
  if (ensured.has(lib)) return;
  for (const q of DDL) lib.sql.exec(q);
  ensured.add(lib);
}
const stores = new WeakMap();
export function evidence(lib) {
  if (!stores.has(lib)) { ensure(lib); stores.set(lib, new Evidence(lib)); }
  return stores.get(lib);
}

// ---- pure helpers ----
const text = v => typeof v === 'string' && v.trim() !== '';
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v ?? null);
async function sha256(s) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const one = (v, list, dflt) => (list.includes(v) ? v : dflt);
const pick = (v, list, message) => { if (!list.includes(v)) throw fail(400, message); return v; };
const optional = (v, n = SHORT) => str(typeof v === 'number' && Number.isFinite(v) ? String(v) : v, n) || null;
const asUser = u => (typeof u === 'string' ? { email: u, role: 'user' } : obj(u));
const MACHINE_TABLE = (() => { const t = {}; for (const [, from, to] of TRANSITIONS.evidence) (t[from] ||= []).push(to); return t; })();

// Attribution default from the first-person cue (D13): "I" alone is individual, "we" alone is team, both or neither unknown.
// A default for the reviewer to correct, never a finding; subject pronouns only, so "gave me" or "US" never decide it.
const I_CUE = /\b(?:I|I'm|I’m|I've|I’ve|I'd|I’d|I'll|I’ll|my|myself)\b/, WE_CUE = /\b(?:[Ww]e|[Ww]e're|[Ww]e’re|[Ww]e've|[Ww]e’ve|[Ww]e'd|[Ww]e’d|[Oo]ur)\b/;
export function attributionFrom(quote) {
  const i = I_CUE.test(quote), w = WE_CUE.test(quote);
  return i && !w ? 'individual' : w && !i ? 'team' : 'unknown';
}

// The content hash covers what a reviewer approves: every claim's content, not its review status or its row metadata.
const CONTENT_KEYS = ['claim_id', 'subject_type', 'subject_id', 'claim_type', 'statement', 'value', 'unit', 'baseline', 'after_state', 'period', 'attribution', 'origin', 'supersedes', 'conflicts_with', 'source_refs'];
const contentOf = c => Object.fromEntries(CONTENT_KEYS.map(k => [k, c[k] ?? null]));
export const hashClaims = (head, claims) => sha256(stable({ project_ref: head.project_ref || null, ref_id: head.ref_id || null,
  claims: [...claims].sort((a, b) => (a.claim_id < b.claim_id ? -1 : 1)).map(contentOf) }));

// Interview notes, server-bounded: the ledger's active details (plan §4; T11 posts them from the Interview DO). Anything a browser
// could shape is cut to size; unknown keys are dropped.
const NOTE_STATUSES = ['reported', 'uncertain', 'unknown'];
export function cleanNotes(raw) {
  const n = obj(raw), session = str(n.session_id ?? n.sessionId, 100), list = Array.isArray(n.details) ? n.details : null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(session)) throw fail(400, 'Notes need the interview session id.');
  if (!list || !list.length || list.length > MAX_CLAIMS) throw fail(400, `Notes need 1 to ${MAX_CLAIMS} details.`);
  const asr = obj(n.asr), seen = new Set();
  const details = list.map(raw1 => {
    const d = obj(raw1), id = str(d.id, 20), field = str(d.field, 40), item = str(d.item_id, 160), quote = para(d.quote, 1800), meta = obj(asr[item]);
    if (!/^D-\d{3,6}$/.test(id) || seen.has(id)) throw fail(400, 'Each detail needs a unique ledger id such as D-001.');
    seen.add(id);
    if (!Object.hasOwn(FIELD_CLAIM, field) || !item || !quote) throw fail(400, 'Each detail needs a known field, a transcript item and its quote.');
    const conf = d.asr_min_conf ?? meta.min_conf, off = d.audio_offset_ms ?? meta.audio_offset_ms;
    return { id, field, item_id: item, quote, status: one(d.status, NOTE_STATUSES, 'reported'), active: d.active !== false, withheld: d.withheld === true,
      supersedes: str(d.supersedes, 20), provenance: str(d.provenance, 60) || 'unverified_speech_recognition',
      asr_min_conf: typeof conf === 'number' && conf >= 0 && conf <= 1 ? conf : null, audio_offset_ms: Number.isInteger(off) && off >= 0 && off <= 1e9 ? off : null,
      value: optional(d.value), unit: optional(d.unit), baseline: optional(d.baseline), after_state: optional(d.after_state), period: optional(d.period) };
  });
  return { session_id: session, project_ref: str(n.project_ref ?? n.projectRef, 100) || null, ref_id: str(n.ref_id ?? n.refId, 64) || null, details };
}

// Ledger details -> claims (D13). Superseded, withheld ("keep private") and unknown details are not claims: an "I don't know"
// stays an open gap, and the consultant's exact words become the statement (nothing is paraphrased or computed).
export function claimsFromNotes(recordId, owner, notes, at) {
  const usable = notes.details.filter(d => d.active && !d.withheld && d.status !== 'unknown');
  return usable.map((d, i) => {
    const [claim_type, base] = FIELD_CLAIM[d.field], attribution = attributionFrom(d.quote);
    return { claim_id: `${recordId}-c${i + 1}`, subject_type: attribution === 'team' && base === 'person' ? 'team' : base,
      subject_id: base === 'person' ? owner : notes.project_ref, claim_type, statement: d.quote, value: d.value, unit: d.unit, baseline: d.baseline, after_state: d.after_state,
      period: d.period, attribution, origin: 'consultant_reported', supersedes: null, conflicts_with: [],
      source_refs: [{ kind: 'interview', session_id: notes.session_id, item_id: d.item_id, ledger_id: `${notes.session_id}:${d.id}`, field: d.field, quote: d.quote, provenance: d.provenance,
        ledger_status: d.status, asr_min_conf: d.asr_min_conf, audio_offset_ms: d.audio_offset_ms, supersedes_ledger_id: d.supersedes ? `${notes.session_id}:${d.supersedes}` : null }],
      created_by: owner, created_at: at };
  });
}

// A gate refusal as an HTTP error: stale views are conflicts, everything else is a refusal. `reason` is the stable code.
const denial = reason => Object.assign(fail(/^(REVISION_MISMATCH|CONTENT_HASH_MISMATCH|TRANSITION_NOT_ALLOWED)/.test(reason) ? 409 : 403, `Not allowed: ${reason}`), { reason });
const stateFailure = e => Object.assign(fail(e.code === 'actor_not_allowed' ? 403 : e.code === 'illegal_transition' ? 409 : 400, e.message), { reason: 'STATE_' + e.code.toUpperCase() });
const revisionOf = p => { if (!Number.isInteger(p.expected_revision)) throw fail(400, 'expected_revision is required: the revision you were looking at.'); return p.expected_revision; };

// What each review action is to the gate (gate action) and to the machine (event, and who takes it there). `to` is the gate's view of the target.
const MOVES = {
  approve: { gate: 'approve', event: 'approve', as: 'reviewer', to: () => 'approved', bind: true },
  reject: { gate: 'reject', event: 'reject', as: 'reviewer', to: () => 'rejected', bind: true, why: 'Say why this is rejected, so it can be corrected.' },
  clarify: { gate: 'request_clarification', event: 'request_clarification', as: 'reviewer', to: () => 'needs_clarification', why: 'Say what needs clarifying.' },
  dispute: { gate: 'dispute', event: 'dispute', as: 'user', to: () => 'disputed', why: 'Say why you dispute the rejection.' },
  withdraw: { gate: 'withdraw', event: 'withdraw', as: 'user', to: s => (s === 'approved' || s === 'downstream_proposals' ? 'impact_review' : 'withdrawn'), why: 'Say why this is withdrawn.' },
  complete_impact_review: { gate: 'withdraw', event: 'complete_impact_review', as: 'reviewer', to: () => 'withdrawn' },
};
const OWNER_AMEND = new Set(['evidence_draft', 'needs_clarification', 'approved', 'downstream_proposals']);
const REVIEWER_AMEND = new Set(['reviewer_queue', 'approved', 'downstream_proposals']);

class Evidence {
  constructor(lib) { this.lib = lib; }
  rows(q, ...p) { return this.lib.rows(q, ...p); }
  now() { return this.lib.now(); }

  load(id) {
    const r = this.rows('SELECT * FROM evidence_records WHERE id = ?', String(id || ''))[0];
    if (!r) return null;
    const state = parse(r.state_json, null);
    let machine;
    try { machine = Machine.fromDict(state.machine); } catch (e) { if (e instanceof StateError) throw fail(500, 'This evidence record could not be restored.'); throw e; }
    return { ...r, state, machine };
  }
  claimsOf(id, revision) {
    return this.rows('SELECT * FROM evidence_claims WHERE entity = ? AND revision = ? ORDER BY rowid', id, revision)
      .map(c => ({ ...c, conflicts_with: parse(c.conflicts_with, []), source_refs: parse(c.source_refs, []) }));
  }

  // The resolved N+1 (the library's own resolution: staffing, then the DNA directory). The N+1 the consultant typed on the reference (source
  // 'self_declared') is not an approver: the owner could pick, or change, who reviews their own evidence. Entra users are `tid:oid`, which never equals
  // a directory email, so in Entra mode only ATLAS.Reviewer / ATLAS.Admin review (fails closed; see the DECISION_LOG).
  n1(rec) {
    const ref = rec.ref_id ? this.lib.row(rec.ref_id) : null, data = ref ? ref.data : { details: { projectId: rec.project_ref || '' }, validation: {} };
    try { const m = managerOf(this.lib, { owner: rec.owner_sub, data }); return m.source === 'self_declared' ? '' : m.to || ''; } catch { return ''; }
  }
  // Who this person is to this record, or null when it does not exist for them. Drafts are the owner's alone (D19).
  access(rec, user) {
    if (!rec || !text(user.email)) return null;
    const owner = user.email === rec.owner_sub, role = ['admin', 'reviewer'].includes(user.role) ? user.role : '';
    const resolved = !owner && !role && this.n1(rec) === user.email; // a reviewer or admin needs no resolution (and none is paid for)
    const reviewer = !!role || resolved;
    if (!owner && !(reviewer && rec.state.ever_submitted && rec.status !== 'evidence_draft')) return null;
    return { owner, reviewer, roles: [role, resolved ? 'reviewer' : ''].filter(Boolean) };
  }
  actor(user, acc) { return { sub: user.email, roles: acc.roles }; }
  approvalOf(id) { return this.rows("SELECT * FROM approvals WHERE entity = ? AND status = 'approved' ORDER BY rowid DESC", id)[0] || null; }
  entity(rec) {
    const ap = this.approvalOf(rec.id), au = this.rows('SELECT author FROM evidence_revisions WHERE entity = ? AND revision = ?', rec.id, rec.revision)[0];
    return { id: rec.id, owner_sub: rec.owner_sub, revision: rec.revision, content_hash: rec.content_hash, status: rec.status,
      approved_revision: ap ? ap.revision : null, approved_hash: ap ? ap.content_hash : null, revision_author: au ? au.author : null };
  }
  check(user, acc, rec, action, ctx) {
    const v = decide(this.actor(user, acc), action, this.entity(rec), { now: this.now(), expected_revision: ctx.expected_revision, content_hash: ctx.content_hash ?? rec.content_hash,
      to: ctx.to, transitions: MACHINE_TABLE, ...ctx.extra });
    if (!v.allow) throw denial(v.reason);
  }

  // Appends the machine's newest audit entry (or a non-machine event) to workflow_transitions: codes and ids only, never text.
  log(rec, revision, entry, asRole, actor) {
    this.lib.sql.exec(`INSERT INTO workflow_transitions (entity, revision, from_state, to_state, event, actor, actor_role, at, workflow_version, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id, revision, entry.from, entry.to, entry.event, actor, asRole, entry.at, entry.workflow_version ?? WORKFLOW_VERSION, entry.reason ? 'text_recorded' : null);
  }
  fire(rec, event, as, actor, reason) {
    const at = this.now();
    try { rec.machine.fire(event, as, { reason: reason || null, at }); } catch (e) { if (e instanceof StateError) throw stateFailure(e); throw e; }
    this.log(rec, rec.revision, rec.machine.audit.at(-1), as, actor);
  }
  save(rec, extra = {}) {
    const state = { ...rec.state, ...extra, machine: rec.machine.toDict() };
    this.lib.sql.exec('UPDATE evidence_records SET status = ?, state_json = ?, revision = ?, content_hash = ?, updated_at = ? WHERE id = ?',
      rec.machine.state, JSON.stringify(state), rec.revision, rec.content_hash, this.now(), rec.id);
    this.lib.sql.exec('UPDATE evidence_claims SET review_status = ? WHERE entity = ? AND revision = ?', REVIEW_STATUS[rec.machine.state], rec.id, rec.revision);
    rec.state = state; rec.status = rec.machine.state;
  }
  derivatives(id) {
    return [...this.rows('SELECT branch, status FROM branch_status WHERE entity = ? ORDER BY branch', id).map(b => ({ kind: 'branch', branch: b.branch, status: b.status })),
      ...this.rows("SELECT purpose, destination, status FROM permission_grants WHERE entity = ? AND status = 'active' ORDER BY rowid", id).map(g => ({ kind: 'permission', purpose: g.purpose, destination: g.destination }))];
  }
  grantsFor(id) {
    return this.rows('SELECT * FROM permission_grants WHERE entity = ? ORDER BY rowid', id).map(g => ({ id: g.id, entity_id: g.entity, purpose: g.purpose, destination: g.destination, scope: g.scope,
      channel: g.channel, geography: g.geography, expires_at: g.expires_at, revoked_at: g.revoked_at, status: g.status, revision: g.revision, hash: g.content_hash, grantor: g.grantor, legal_basis_ref: g.legal_basis_ref }));
  }

  // ---- reading ----
  view(rec, acc, { revision = rec.revision } = {}) {
    const m = rec.machine, ap = this.approvalOf(rec.id);
    const approved = !!ap && ap.revision === rec.revision && ap.content_hash === rec.content_hash && ['approved', 'downstream_proposals'].includes(rec.status);
    const actions = [];
    if (acc.owner) for (const [name, ev, as] of [['submit', 'submit', 'user'], ['dispute', 'dispute', 'user'], ['withdraw', 'withdraw', 'user']]) if (m.canFire(ev, as)) actions.push(name);
    if (acc.owner && OWNER_AMEND.has(rec.status)) actions.push('amend');
    if (!acc.owner && acc.reviewer) {
      for (const [name, spec] of Object.entries(MOVES)) if (spec.as === 'reviewer' && m.canFire(spec.event, 'reviewer')) actions.push(name);
      if (REVIEWER_AMEND.has(rec.status)) actions.push('amend');
    }
    return { id: rec.id, status: m.status, state: rec.status, revision: rec.revision, content_hash: rec.content_hash, project_ref: rec.project_ref, ref_id: rec.ref_id,
      mine: acc.owner, access: acc.owner ? 'owner' : 'reviewer', created_at: rec.created_at, updated_at: rec.updated_at, viewing_revision: revision,
      claims: this.claimsOf(rec.id, revision).map(({ entity, created_by, created_at, ...c }) => c),
      revisions: this.rows('SELECT revision, content_hash, author, author_role, kind, at FROM evidence_revisions WHERE entity = ? ORDER BY revision DESC', rec.id),
      approval: ap ? { revision: ap.revision, content_hash: ap.content_hash, approver_sub: ap.approver_sub, at: ap.at } : null, approved,
      history: m.audit, clarifications: rec.state.clarifications, rejection: rec.state.rejection, dispute: rec.state.dispute, impact: rec.state.impact,
      derivatives: this.derivatives(rec.id), grants: this.grantsFor(rec.id), actions };
  }
  get(user, id, { revision } = {}) {
    user = asUser(user);
    const rec = this.load(id), acc = this.access(rec, user);
    if (!acc) throw fail(404, NOT_FOUND);
    if (revision !== undefined && !(Number.isInteger(revision) && revision >= 1 && revision <= rec.revision)) throw fail(404, 'Revision not found.');
    return this.view(rec, acc, revision === undefined ? {} : { revision });
  }
  // Visibility is decided in SQL first (the owner's records, plus anything past draft for the people who might review it), then per row on the
  // raw record, and only what the person may see is replayed through its state machine: the cost follows what they can see, not the library.
  list(user) {
    user = asUser(user);
    if (!text(user.email)) return [];
    const out = [];
    for (const r of this.rows("SELECT * FROM evidence_records WHERE owner_sub = ? OR status != 'evidence_draft' ORDER BY updated_at DESC, rowid DESC", user.email)) {
      const state = parse(r.state_json, null);
      if (!state || !this.access({ ...r, state }, user)) continue;
      let rec; try { rec = this.load(r.id); } catch { rec = null; } // one unreadable record never hides the others
      const acc = rec && this.access(rec, user);
      if (acc) out.push({ id: rec.id, status: rec.machine.status, state: rec.status, revision: rec.revision, project_ref: rec.project_ref, mine: acc.owner,
        claims: this.claimsOf(rec.id, rec.revision).length, updated_at: rec.updated_at });
      if (out.length >= MAX_LIST) break;
    }
    return out;
  }

  // ---- creating: interview notes -> a draft only the owner can see (D19) ----
  // SERVER-SIDE ONLY: `sub` is the verified identity the Worker forwarded to the Interview DO, never a body field. Idempotent
  // per interview session: the same notes again return the same record; different notes for a captured session are a conflict.
  async createDraftFromNotes(sub, notes) {
    const who = asUser(sub);
    if (!text(who.email)) throw fail(401, 'Sign in first.');
    const n = cleanNotes(notes), notesHash = await sha256(stable(n));
    const found = () => this.rows('SELECT id, owner_sub, notes_hash FROM evidence_records WHERE session_id = ?', n.session_id)[0];
    const again = f => {
      if (f.owner_sub !== who.email) throw fail(409, 'This interview was already captured.');
      if (f.notes_hash !== notesHash) throw fail(409, 'This interview was already captured as evidence; amend that record instead.');
      return { ...this.get(who, f.id), unchanged: true };
    };
    let f = found(); if (f) return again(f);
    if (n.ref_id) { const ref = this.lib.row(n.ref_id); if (!ref || !this.lib.canEdit(ref, who)) throw fail(404, 'Reference not found.'); }
    const id = this.lib.newId(), at = this.now(), claims = claimsFromNotes(id, who.email, n, at);
    if (!claims.length) throw fail(400, 'These notes have no usable details: unknown, withheld and replaced answers are not claims.');
    const hash = await hashClaims(n, claims);
    if ((f = found())) return again(f); // another post of the same notes finished while we hashed
    const m = new Machine('evidence');
    this.lib.sql.exec(`INSERT INTO evidence_records (id, owner_sub, project_ref, ref_id, session_id, notes_hash, status, revision, content_hash, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`, id, who.email, n.project_ref, n.ref_id, n.session_id, notesHash, m.state, hash,
    JSON.stringify({ machine: m.toDict(), cycle: 1, ever_submitted: false, clarifications: [], rejection: null, dispute: null, impact: null }), at, at);
    this.insertClaims(id, 1, claims, REVIEW_STATUS[m.state]);
    this.lib.sql.exec('INSERT INTO evidence_revisions (entity, revision, content_hash, author, author_role, kind, at) VALUES (?, 1, ?, ?, ?, ?, ?)', id, hash, who.email, 'user', 'created_from_notes', at);
    this.log({ id }, 1, { from: null, to: m.state, event: 'create_from_notes', at, reason: null }, 'user', who.email);
    return { ...this.get(who, id), unchanged: false };
  }
  insertClaims(id, revision, claims, reviewStatus) {
    for (const c of claims) this.lib.sql.exec(`INSERT INTO evidence_claims (claim_id, revision, entity, subject_type, subject_id, claim_type, statement, value, unit, baseline, after_state, period,
      attribution, origin, review_status, supersedes, conflicts_with, source_refs, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.claim_id, revision, id, c.subject_type, c.subject_id, c.claim_type, c.statement, c.value, c.unit, c.baseline, c.after_state, c.period, c.attribution, c.origin,
    reviewStatus, c.supersedes, JSON.stringify(c.conflicts_with || []), JSON.stringify(c.source_refs || []), c.created_by, c.created_at);
  }

  // ---- submitting: an explicit act of the owner (D19) ----
  submit(sub, id, expected_revision) {
    const user = asUser(sub), rec = this.load(id), acc = this.access(rec, user);
    if (!acc) throw fail(404, NOT_FOUND);
    revisionOf({ expected_revision });
    this.check(user, acc, rec, 'submit', { expected_revision, to: 'submitted_for_review' });
    if (!this.claimsOf(rec.id, rec.revision).length) throw fail(400, 'There is nothing to submit.');
    this.fire(rec, 'submit', 'user', user.email); // the gate's decision covers both moves: the queue entry is the system's follow-up
    this.fire(rec, 'enqueue', 'system', user.email);
    this.save(rec, { ever_submitted: true });
    return this.view(rec, acc);
  }

  // ---- reviewing: approve | amend | clarify | dispute | reject | withdraw (+ complete_impact_review) ----
  async review(user, id, action, payload = {}) {
    user = asUser(user);
    const p = obj(payload), rec = this.load(id), acc = this.access(rec, user);
    if (!acc) throw fail(404, NOT_FOUND);
    if (action === 'amend') return this.amend(user, rec, acc, p);
    const spec = Object.hasOwn(MOVES, action) ? MOVES[action] : null;
    if (!spec) throw fail(400, 'Choose approve, amend, clarify, dispute, reject, withdraw or complete_impact_review.');
    const expected = revisionOf(p);
    if (spec.bind && !text(p.content_hash)) throw fail(400, 'content_hash is required: the content you reviewed.');
    this.check(user, acc, rec, spec.gate, { expected_revision: expected, content_hash: spec.bind ? p.content_hash : undefined, to: spec.to(rec.status) });
    // The machine's actor is the role in the process: a reviewer decision is never the owner's, and the owner's act is never an admin's.
    if ((spec.as === 'user' && !acc.owner) || (spec.as === 'reviewer' && (acc.owner || !acc.reviewer))) throw Object.assign(fail(403, 'Not allowed: EVENT_ACTOR_NOT_ALLOWED'), { reason: 'EVENT_ACTOR_NOT_ALLOWED' });
    const reason = str(p.reason ?? p.rationale ?? p.note, 500), from = rec.status;
    if (spec.why && !reason) throw fail(400, spec.why);
    const at = this.now(), extra = {};
    this.fire(rec, spec.event, spec.as, user.email, reason);
    const decision = { revision: rec.revision, content_hash: rec.content_hash, by: user.email, at };
    const sql = this.lib.sql, aid = () => this.lib.newId();
    if (action === 'approve') sql.exec(`INSERT INTO approvals (id, entity, revision, content_hash, channel, purpose, approver_sub, status, at) VALUES (?, ?, ?, ?, NULL, 'evidence_review', ?, 'approved', ?)`, aid(), rec.id, rec.revision, rec.content_hash, user.email, at);
    if (action === 'reject') {
      sql.exec(`INSERT INTO approvals (id, entity, revision, content_hash, channel, purpose, approver_sub, status, at) VALUES (?, ?, ?, ?, NULL, 'evidence_review', ?, 'rejected', ?)`, aid(), rec.id, rec.revision, rec.content_hash, user.email, at);
      extra.rejection = { ...decision, reason }; // the prior revision stays readable beside it (W8)
    }
    if (action === 'clarify') extra.clarifications = [...rec.state.clarifications, { ...decision, note: reason }].slice(-20);
    if (action === 'dispute') { // both views are kept: the reviewer's rejection and the owner's rationale, with who adjudicates
      extra.dispute = { ...decision, rationale: reason, adjudicator: str(p.adjudicator, 100) || null, claim_ids: (Array.isArray(p.claim_ids) ? p.claim_ids : []).map(c => str(c, 80)).filter(Boolean).slice(0, MAX_CLAIMS), rejection: rec.state.rejection };
    }
    if (action === 'withdraw' || action === 'complete_impact_review') {
      if (rec.machine.state === 'impact_review') { // withdrawn after approval: the approval is revoked and the derivatives are listed for review (D11)
        sql.exec("UPDATE approvals SET status = 'revoked' WHERE entity = ? AND status = 'approved'", rec.id);
        extra.impact = { revision: rec.revision, by: user.email, at, from, derivatives: this.derivatives(rec.id) };
      } else if (action === 'complete_impact_review') extra.impact = { ...rec.state.impact, completed_by: user.email, completed_at: at };
    }
    this.save(rec, extra);
    if (action === 'approve') await branches.afterApprove(this, rec); // seven independent branch records (T15); an approval is never undone by them
    else if (action === 'withdraw' && rec.machine.state === 'impact_review') branches.onWithdrawn(this, rec);
    else if (action === 'complete_impact_review') branches.onImpactReviewCompleted(this, rec);
    return this.view(rec, acc);
  }

  // Amend: a new revision whose content hash differs, never an edit in place. Prior approvals are superseded. After approval the
  // record starts review again as a new cycle (the machine has no way back from approved), and the derivatives are listed.
  async amend(user, rec, acc, p) {
    const expected = revisionOf(p);
    if (!(acc.owner ? OWNER_AMEND : REVIEWER_AMEND).has(rec.status)) throw Object.assign(fail(409, 'Not allowed: AMEND_NOT_ALLOWED_IN_STATE'), { reason: 'AMEND_NOT_ALLOWED_IN_STATE:' + rec.status });
    this.check(user, acc, rec, 'amend', { expected_revision: expected });
    const by = acc.owner ? 'owner' : 'reviewer', at = this.now(), next = rec.revision + 1, current = this.claimsOf(rec.id, rec.revision);
    const claims = new Map(current.map(c => [c.claim_id, { ...c }]));
    const origins = acc.owner ? OWNER_ORIGINS : ORIGINS;
    const edits = (Array.isArray(p.claims) ? p.claims : []).slice(0, MAX_CLAIMS), adds = (Array.isArray(p.add) ? p.add : []).slice(0, MAX_CLAIMS), removes = Array.isArray(p.remove) ? p.remove : [];
    if (!edits.length && !adds.length && !removes.length) throw fail(400, 'Say what to change: claims, add or remove.');
    const seq = () => this.rows('SELECT COUNT(DISTINCT claim_id) AS n FROM evidence_claims WHERE entity = ?', rec.id)[0].n;
    const apply = (c, e) => {
      if ('statement' in e) { c.statement = para(e.statement, 1800); if (!c.statement) throw fail(400, 'A claim needs a statement.'); }
      for (const k of ['value', 'unit', 'baseline', 'after_state', 'period']) if (k in e) c[k] = optional(e[k]);
      if ('claim_type' in e) c.claim_type = pick(e.claim_type, CLAIM_TYPES, 'Unknown claim_type.');
      if ('subject_type' in e) c.subject_type = pick(e.subject_type, SUBJECT_TYPES, 'Unknown subject_type.');
      if ('attribution' in e) c.attribution = pick(e.attribution, ATTRIBUTIONS, 'Unknown attribution.');
      if ('origin' in e) c.origin = pick(e.origin, origins, 'That origin cannot be set by you.');
      if ('conflicts_with' in e) c.conflicts_with = (Array.isArray(e.conflicts_with) ? e.conflicts_with : []).map(x => str(x, 80)).filter(x => x && x !== c.claim_id).slice(0, 20);
      if ('supersedes' in e) c.supersedes = str(e.supersedes, 80) || null;
    };
    for (const e0 of edits) {
      const e = obj(e0), c = claims.get(str(e.claim_id, 80));
      if (!c) throw fail(404, 'Claim not found on this record.');
      const before = stable(contentOf(c)); apply(c, e);
      if (stable(contentOf(c)) !== before) c.source_refs = [...c.source_refs, { kind: 'amendment', revision: next, by }];
    }
    for (const id of removes) if (!claims.delete(str(id, 80))) throw fail(404, 'Claim not found on this record.');
    let n = seq();
    for (const a0 of adds) {
      const a = obj(a0), c = { claim_id: `${rec.id}-c${++n}`, subject_type: 'project', subject_id: rec.project_ref, claim_type: 'context', statement: '', value: null, unit: null, baseline: null, after_state: null, period: null,
        attribution: attributionFrom(para(a.statement, 1800)), origin: acc.owner ? 'consultant_reported' : 'unknown', supersedes: null, conflicts_with: [], source_refs: [{ kind: 'typed', revision: next, by }], created_by: user.email, created_at: at };
      apply(c, a); if (!c.statement) throw fail(400, 'A claim needs a statement.');
      claims.set(c.claim_id, c);
    }
    for (const c of claims.values()) for (const x of [...c.conflicts_with, c.supersedes].filter(Boolean)) if (!claims.has(x)) throw fail(400, 'conflicts_with and supersedes must name claims on this record.');
    if (!claims.size) throw fail(400, 'A record needs at least one claim.');
    const list = [...claims.values()], hash = await hashClaims(rec, list);
    if (hash === rec.content_hash) return { ...this.view(rec, acc), unchanged: true };
    const fresh = this.load(rec.id); // the hash took a tick: nothing may have been written meanwhile
    if (fresh.revision !== rec.revision || fresh.status !== rec.status) throw denial('REVISION_MISMATCH');
    const sql = this.lib.sql, from = rec.status, after = ['approved', 'downstream_proposals'].includes(from);
    const derivatives = after ? this.derivatives(rec.id) : [];
    rec.revision = next; rec.content_hash = hash;
    sql.exec('UPDATE evidence_claims SET review_status = ? WHERE entity = ? AND revision < ?', 'superseded', rec.id, next);
    this.insertClaims(rec.id, next, list, REVIEW_STATUS[from]);
    sql.exec('INSERT INTO evidence_revisions (entity, revision, content_hash, author, author_role, kind, at) VALUES (?, ?, ?, ?, ?, ?, ?)', rec.id, next, hash, user.email, by, after ? 'amended_after_approval' : 'amended', at);
    sql.exec("UPDATE approvals SET status = 'superseded' WHERE entity = ? AND status = 'approved'", rec.id);
    const extra = {};
    if (from === 'needs_clarification') this.fire(rec, 'revise', 'user', user.email);
    else if (after) { // a new cycle: the earlier cycle's trail stays in workflow_transitions
      this.log(rec, next, { from, to: 'evidence_draft', event: 'amend_after_approval', at, reason: null }, by, user.email);
      rec.machine = new Machine('evidence'); extra.cycle = rec.state.cycle + 1; extra.superseded = { revision: next - 1, at, derivatives };
    } else this.log(rec, next, { from, to: from, event: 'amend', at, reason: null }, by, user.email);
    this.save(rec, extra);
    branches.onRevisionChanged(this, rec, { afterApproval: after }); // jobs for older revisions stop, story approvals reset, derivatives flagged (T15)
    return { ...this.view(rec, acc), unchanged: false, derivatives };
  }

  // ---- permissions (Governance §2): bound to the exact revision and content hash; T15 reads them for destinations ----
  grantPermission(user, id, p) {
    user = asUser(user); p = obj(p);
    const rec = this.load(id), acc = this.access(rec, user);
    if (!acc) throw fail(404, NOT_FOUND);
    const expected = revisionOf(p), purpose = str(p.purpose, 40), expires = str(p.expires_at, 40);
    if (expires && !Number.isFinite(Date.parse(expires))) throw fail(400, 'expires_at must be a date.');
    this.check(user, acc, rec, 'grant_permission', { expected_revision: expected, extra: { purpose } });
    const gid = this.lib.newId();
    this.lib.sql.exec(`INSERT INTO permission_grants (id, entity, subject, purpose, destination, scope, channel, geography, expires_at, grantor, legal_basis_ref, status, revoked_at, revision, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`, gid, rec.id, rec.owner_sub, purpose, optional(p.destination), optional(p.scope, 300), optional(p.channel), optional(p.geography),
    expires || null, user.email, optional(p.legal_basis_ref), rec.revision, rec.content_hash, this.now());
    return this.grantsFor(rec.id).find(g => g.id === gid);
  }
  revokePermission(user, id, grantId, p = {}) {
    user = asUser(user); p = obj(p);
    const rec = this.load(id), acc = this.access(rec, user), g = this.rows('SELECT * FROM permission_grants WHERE id = ? AND entity = ?', str(grantId, 80), String(id || ''))[0];
    if (!acc || !g) throw fail(404, NOT_FOUND);
    this.check(user, acc, rec, 'revoke_permission', { expected_revision: revisionOf(p), extra: { purpose: g.purpose } });
    this.lib.sql.exec("UPDATE permission_grants SET status = 'revoked', revoked_at = ? WHERE id = ?", this.now(), g.id);
    branches.onPermissionRevoked(this, rec, g.purpose); // what was derived under it goes to impact review (T15)
    return this.grantsFor(rec.id).find(x => x.id === g.id);
  }
}

// ---- HTTP surface, called by library-routes.js (the verified identity is already in ctx.user) ----
// `internal` is the Durable Object's own path (/api/evidence), which only the Interview DO reaches; the browser's path
// (/api/library/evidence/...) can read, submit and review but can never create a draft from notes.
export function target(pathname) {
  const internal = pathname.match(/^\/api\/evidence(?:\/(.*))?$/), browser = pathname.match(/^\/api\/library\/evidence(?:\/(.*))?$/);
  const m = internal || browser;
  return m ? { internal: !!internal, rest: (m[1] || '').split('/').filter(Boolean) } : null;
}
const NOT_FOUND_ROUTE = { status: 404, body: { error: 'Not found.' } };
export async function routes(ctx) {
  const { lib, user, method, rest, body, internal, url } = ctx, ev = evidence(lib), [id, action, extra, verb] = rest, b = obj(body);
  if (ctx.env !== undefined) branches.configure(lib, { env: ctx.env }); // the Worker's variables (ATLAS_ADAPTERS, ATLAS_EVIDENCE_WORKFLOW) reach the branches here
  if (!id) {
    if (method === 'POST') return internal ? created(await ev.createDraftFromNotes(user.email, b.notes)) : NOT_FOUND_ROUTE;
    return method === 'GET' ? { body: { items: ev.list(user) } } : NOT_FOUND_ROUTE;
  }
  if (method === 'GET' && !action) { const r = url.searchParams.get('revision'); return { body: ev.get(user, id, r === null ? {} : { revision: /^\d{1,6}$/.test(r) ? Number(r) : 0 }) }; }
  if (method === 'GET' && action === 'status' && !extra) return { body: branches.statusView(ev, user, id) }; // seven cards, never one generic "done" (T15)
  if (method !== 'POST') return NOT_FOUND_ROUTE;
  if (action === 'submit' && !extra) return { body: ev.submit(user, id, b.expected_revision) };
  if (action === 'sync' && !extra) return { body: await branches.sync(ev, user, id, b) }; // a reviewer's recovery: re-check, run due jobs, recover one failed job
  if (action === 'permissions' && !extra) { const g = ev.grantPermission(user, id, b); await branches.afterGrant(ev, id); return { status: 201, body: g }; }
  if (action === 'permissions' && extra && verb === 'revoke') return { body: ev.revokePermission(user, id, extra, b) };
  if (action === 'review' && !extra) return { body: await ev.review(user, id, str(b.action, 40), b) };
  return NOT_FOUND_ROUTE;
}
const created = r => ({ status: r.unchanged ? 200 : 201, body: r });

// SERVER-TO-SERVER (T11 calls this from the Interview DO when the consultant confirms the summary, D19). It posts the ledger's
// notes to the global LibraryStore under the verified identity the Worker forwarded; the draft is owner-only until the owner
// submits it. Returns { status, body } (never throws): 201 created, 200 same notes again, 4xx refused, 0 when no library is bound.
export async function postDraftFromInterview(env, identity, notes) {
  if (!env?.LIBRARY || !identity?.user) return { status: 0, body: { error: 'The library is not available.' } };
  try {
    const headers = new Headers({ 'Content-Type': 'application/json', 'x-atlas-user': String(identity.user), 'x-atlas-role': String(identity.role || 'user'), 'x-atlas-email': String(identity.mail || '') });
    const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(new Request('https://atlas.internal/api/evidence', { method: 'POST', headers, body: JSON.stringify({ notes }) }));
    return { status: res.status, body: await res.json() };
  } catch { return { status: 0, body: { error: 'The library could not be reached.' } }; }
}
