// Spotlight story candidate and its approval gates (Spotlight workflow §3-§4; plan D4, D17): the storage side. A story is derived from
// the approved evidence revision, never from the library's `published` status (D17), and is bound to that revision and content hash.
// The seven gates are stored per (entity, gate) with the revision and hash they were given for; the policy gate (policy-gate.js decide,
// default deny) is the only judge of who may close one and whether publication may proceed. Any new evidence revision supersedes every
// gate and resets the story's approval_state flags (T14 follow-up). The orchestration (status cards, jobs, the mock CMS) is branches.js.
import { decide } from './policy-gate.js';
import { WORKFLOW_CONFIG } from './policy.generated.js';
import { projectForAudience } from './story-projection.js';
import { str, obj, fail } from './util.js';

export const GATES = WORKFLOW_CONFIG.workflow.branches.spotlight.requires;
export const FINAL_GATE = 'exact_revision_publication_authorization';
// approval_state flag (success_story schema) -> the gate that closes it.
const FLAG_GATE = { project_owner_approved: 'project_owner_approval', customer_approved: 'customer_permission_if_required', confidentiality_reviewed: 'confidentiality_review',
  brand_approved: 'brand_approval', public_release_authorized: FINAL_GATE };
const NO_FLAGS = { evidence_validated: false, project_owner_approved: false, customer_approved: false, confidentiality_reviewed: false, brand_approved: false, public_release_authorized: false };

const DDL = [
  'CREATE TABLE IF NOT EXISTS spotlight_stories (entity TEXT PRIMARY KEY, revision INTEGER, content_hash TEXT, status TEXT, story_json TEXT, created_at TEXT, updated_at TEXT)',
  `CREATE TABLE IF NOT EXISTS spotlight_gates (entity TEXT, gate TEXT, status TEXT, revision INTEGER, content_hash TEXT, approver_sub TEXT, channel TEXT, reason TEXT,
    decided_by TEXT, at TEXT, PRIMARY KEY (entity, gate))`,
];
const ensured = new WeakSet();
const ensure = lib => { if (!ensured.has(lib)) { for (const q of DDL) lib.sql.exec(q); ensured.add(lib); } };
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// The consultant's own approved words, joined per field in claim order: nothing is paraphrased, summarised or computed. A field with no
// claim stays absent (missing is unknown, never negative); a person completes the story before the gates.
const joined = (claims, field) => claims.filter(c => c.source_refs?.[0]?.field === field).map(c => c.statement).join(' ') || undefined;
const set = (o, k, v) => { if (v !== undefined && v !== null && v !== '') o[k] = v; return o; };
export function storyFromEvidence(rec, claims, ref) {
  const d = obj(obj(ref).details), year = Number.parseInt(String(d.start || '').slice(0, 4), 10);
  const project = { client_permission: 'anonymize' }; // named only when a person records named_allowed
  set(project, 'client_display', obj(obj(ref).client).name); set(project, 'industry', obj(ref).sector); set(project, 'country', d.country);
  if (Number.isInteger(year) && year > 1990) project.year = year;
  return { project, summary: {}, kpis: [], // KPIs are never promoted automatically from metric claims: a person supplies status, period and permission
    challenge: set(set({}, 'problem', joined(claims, 'problem')), 'why_important', joined(claims, 'stakes')),
    solution: set({}, 'what_we_did', joined(claims, 'intervention')), results: set({}, 'new_capability', joined(claims, 'outcome')),
    approval_state: { ...NO_FLAGS, evidence_validated: true } };
}

export class Spotlight {
  constructor(ev) { this.ev = ev; this.lib = ev.lib; ensure(this.lib); }
  rows(q, ...p) { return this.lib.rows(q, ...p); }
  story(id) {
    const r = this.rows('SELECT * FROM spotlight_stories WHERE entity = ?', String(id))[0];
    return r && { entity: r.entity, revision: r.revision, content_hash: r.content_hash, status: r.status, story: parse(r.story_json, {}), updated_at: r.updated_at };
  }
  // Create or refresh the candidate for the CURRENT revision. Never changes a candidate that is already bound to this revision.
  nominate(rec, claims) {
    const have = this.story(rec.id);
    if (have && have.revision === rec.revision && have.content_hash === rec.content_hash) return have;
    const ref = rec.ref_id ? this.lib.row(rec.ref_id)?.data : null, at = this.lib.now();
    this.lib.sql.exec(`INSERT INTO spotlight_stories (entity, revision, content_hash, status, story_json, created_at, updated_at) VALUES (?, ?, ?, 'spotlight_draft', ?, ?, ?)
      ON CONFLICT(entity) DO UPDATE SET revision = excluded.revision, content_hash = excluded.content_hash, status = 'spotlight_draft', story_json = excluded.story_json, updated_at = excluded.updated_at`,
    rec.id, rec.revision, rec.content_hash, JSON.stringify(storyFromEvidence(rec, claims, ref)), at, at);
    return this.story(rec.id);
  }
  setStatus(id, status) { this.lib.sql.exec('UPDATE spotlight_stories SET status = ?, updated_at = ? WHERE entity = ?', status, this.lib.now(), String(id)); }

  // gate name -> record, in the shape the policy gate reads.
  gatesFor(id) {
    return Object.fromEntries(this.rows('SELECT * FROM spotlight_gates WHERE entity = ?', String(id)).map(g => [g.gate,
      { status: g.status, revision: g.revision, hash: g.content_hash, approver_sub: g.approver_sub, channel: g.channel, reason: g.reason, decided_by: g.decided_by, at: g.at }]));
  }
  // Close (or declare not required) one gate. The policy gate decides who may; the record is bound to this revision and hash.
  recordGate(actor, rec, gate, p) {
    p = obj(p);
    const channel = str(p.channel, 100) || undefined, notRequired = p.decision === 'not_required', reason = str(p.reason, 300);
    const v = decide(actor, 'approve_gate', this.ev.entity(rec), { now: this.lib.now(), expected_revision: p.expected_revision, content_hash: p.content_hash, gate, channel });
    if (!v.allow) throw Object.assign(fail(403, `Not allowed: ${v.reason}`), { reason: v.reason });
    if (notRequired && (!gate.endsWith('_if_required') || !reason)) throw fail(400, 'Only an _if_required gate can be not required, and it needs a reason.');
    this.lib.sql.exec(`INSERT OR REPLACE INTO spotlight_gates (entity, gate, status, revision, content_hash, approver_sub, channel, reason, decided_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id, gate, notRequired ? 'not_required' : 'approved', rec.revision, rec.content_hash, notRequired ? null : actor.sub, gate === FINAL_GATE ? channel ?? null : null, notRequired ? reason : null,
      notRequired ? actor.sub : null, this.lib.now());
    this.refreshFlags(rec);
    return this.gatesFor(rec.id);
  }
  // approval_state flags as the gates stand for this exact revision (the final word on publication is still decide()).
  flagsFor(rec) {
    const gates = this.gatesFor(rec.id), closed = g => { const r = gates[g]; return !!r && ['approved', 'not_required'].includes(r.status) && r.revision === rec.revision && r.hash === rec.content_hash; };
    const approved = ['approved', 'downstream_proposals'].includes(rec.status);
    return { ...NO_FLAGS, evidence_validated: approved, ...Object.fromEntries(Object.entries(FLAG_GATE).map(([flag, gate]) => [flag, closed(gate)])) };
  }
  refreshFlags(rec) {
    const s = this.story(rec.id);
    if (!s || s.revision !== rec.revision) return;
    this.lib.sql.exec('UPDATE spotlight_stories SET story_json = ?, updated_at = ? WHERE entity = ?', JSON.stringify({ ...s.story, approval_state: this.flagsFor(rec) }), this.lib.now(), rec.id);
  }
  // A new revision (or a withdrawal): every gate is superseded, the flags go back to false and the story goes back to draft.
  reset(id) {
    this.lib.sql.exec("UPDATE spotlight_gates SET status = 'superseded' WHERE entity = ? AND status != 'superseded'", String(id));
    const s = this.story(id);
    if (!s) return null;
    this.lib.sql.exec('UPDATE spotlight_stories SET status = ?, story_json = ?, updated_at = ? WHERE entity = ?', 'spotlight_draft', JSON.stringify({ ...s.story, approval_state: { ...NO_FLAGS } }), this.lib.now(), String(id));
    return this.story(id);
  }
  // The public audience projection of the candidate. Throws ProjectionError when a gate flag is missing: nothing public is built on a guess.
  project(rec, audience = 'public') {
    const s = this.story(rec.id);
    if (!s || s.revision !== rec.revision || s.content_hash !== rec.content_hash) throw Object.assign(new Error('NO_STORY_FOR_REVISION'), { code: 'no_story' });
    return projectForAudience({ ...s.story, approval_state: this.flagsFor(rec) }, audience);
  }
}
