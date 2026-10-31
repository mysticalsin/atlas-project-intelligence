// Branches after approval (plan §4, D1-D5, D11, D12, D17; pack: Canonical Workflow §9-§11, Integration Contracts §7-§8): approving
// an evidence revision creates seven INDEPENDENT branch records (evidence, maap, project_review, dna, michat, imp, spotlight), each with
// its own permission check (policy-gate decide, default deny, with the record's own grants) and its own status. One branch failing
// never fails or rolls back another (W11). Destination work goes through the reliable job envelope (jobs.js) to mock adapters
// (adapters.js); a mock acknowledgement is shown as `mock_acknowledged`, never as synced or published (D12), and the only way to
// `sync_complete` / `published` is the gate's record_sync_complete / record_published with a non-mock acknowledgement bound to this
// exact revision, which no adapter in this repository can produce.
//
// Evidence calls these hooks (afterApprove, onRevisionChanged, onWithdrawn, onImpactReviewCompleted, onPermissionRevoked); `ev` is the
// Evidence store, passed in so this module needs no import of evidence.js. The hooks do nothing until the Library is configured
// (library-routes.js calls configure with the Worker's env on every request), so evidence on its own behaves exactly as in T13.
// Status codes are stable ids for the audit and the UI; user-facing words live in the browser (workflow-core.js).
import { decide } from './policy-gate.js';
import { jobs, configure as configureJobs, clock, idempotencyKey } from './jobs.js';
import { adapterMode, adapterModeFor, liveAdapter, evidenceWorkflowOn, registry, buildPayload, CONTRACTS, ADAPTER_BY_DESTINATION, ADAPTER_BY_BRANCH } from './adapters.js';
import { Spotlight, FINAL_GATE } from './spotlight.js';
import { str, obj, fail } from './util.js';

export const BRANCHES = [
  { id: 'evidence', label: 'Evidence' }, { id: 'maap', label: 'MAAP Review' }, { id: 'project_review', label: 'Project Review' },
  { id: 'dna', label: 'DNA' }, { id: 'michat', label: 'MiChat CV' }, { id: 'imp', label: 'IMP' }, { id: 'spotlight', label: 'Spotlight' },
];
const DESTINATION_BRANCHES = new Set(['dna', 'michat', 'imp', 'spotlight']);
const SHELL_STATUS = { maap: ['maap_pending', 'MAAP_NOT_CONFIGURED'], project_review: ['project_review_pending', 'PROJECT_REVIEW_NOT_CONFIGURED'] };
const SYSTEM = { sub: 'atlas-system', roles: ['system'] }; // the workflow's own actor: never an owner, never a person
export const BRANCH_STATUSES = ['evidence_approved', 'maap_pending', 'project_review_pending', 'permission_pending', 'projection_pending', 'syncing', 'retrying', 'mock_acknowledged',
  'sync_complete', 'failed', 'needs_reconciliation', 'blocked_external', 'spotlight_draft', 'spotlight_approval_pending', 'publication_held', 'published', 'impact_review', 'withdrawn', 'superseded'];
// Stored status -> the display_status a card shows.
const DISPLAY = { evidence_approved: 'approved', maap_pending: 'pending', project_review_pending: 'pending', permission_pending: 'waiting_permission', projection_pending: 'pending',
  syncing: 'in_progress', retrying: 'in_progress', mock_acknowledged: 'mock_acknowledged', sync_complete: 'sync_complete', failed: 'failed', needs_reconciliation: 'needs_reconciliation',
  blocked_external: 'blocked_external', spotlight_draft: 'draft', spotlight_approval_pending: 'awaiting_approval', publication_held: 'held', published: 'published',
  impact_review: 'impact_review', withdrawn: 'withdrawn', superseded: 'superseded' };
// The evidence card follows the live record, not a stored row.
const EVIDENCE_DISPLAY = { evidence_draft: 'draft', submitted_for_review: 'in_review', reviewer_queue: 'in_review', needs_clarification: 'needs_clarification', approved: 'approved',
  downstream_proposals: 'approved', rejected: 'rejected', closed_rejected: 'rejected', disputed: 'disputed', impact_review: 'impact_review', withdrawn: 'withdrawn' };
// What "finished" means per card. MAAP and Project Review can never close here (no rubric), so an overall "complete" is unreachable by design.
const COMPLETE = { evidence: ['approved'], maap: ['closed'], project_review: ['closed'], dna: ['sync_complete'], michat: ['sync_complete'], imp: ['sync_complete'], spotlight: ['published'] };
const ATTENTION = ['failed', 'needs_reconciliation', 'impact_review', 'blocked_external', 'rejected', 'disputed', 'withdrawn'];
const DERIVED = new Set(['syncing', 'retrying', 'mock_acknowledged', 'sync_complete', 'failed', 'needs_reconciliation', 'spotlight_draft', 'spotlight_approval_pending', 'publication_held', 'published']);
const PURPOSE_BRANCH = { skills_profile: 'dna', cv: 'michat', matching: 'imp', public_spotlight: 'spotlight' };
const APPROVED_STATES = ['approved', 'downstream_proposals'];

// ---- configuration ----
const state = new WeakMap();
// configure(lib, { env, mode, adapters, now, random, maxAttempts, baseMs, capMs, leaseMs }): env is the Worker's; mode ('off'|'mock'|'live') overrides it
// (tests); adapters replaces registry entries; the rest is the job clock and retry policy.
export function configure(lib, { env, mode, adapters, ...timing } = {}) {
  state.set(lib, { ...(state.get(lib) || {}), configured: true, ...(env !== undefined ? { env } : {}), ...(mode !== undefined ? { mode } : {}) });
  if (Object.keys(timing).length) configureJobs(lib, timing);
  if (adapters) Object.assign(adapterSet(lib), adapters);
}
const adapterSet = lib => registry(lib, { now: () => clock(lib) });
export const enabled = lib => { const s = state.get(lib); return !!s?.configured && evidenceWorkflowOn(s.env); };
const envOf = lib => { const s = state.get(lib) || {}; return s.mode !== undefined ? { ...s.env, ATLAS_ADAPTERS: s.mode } : s.env; };
export const modeOf = lib => adapterMode(envOf(lib));
// One adapter's mode: under `live` a destination is live only when its connection is ready (connectors.js), else blocked_external.
export const modeFor = (lib, name) => adapterModeFor(envOf(lib), name);
const runs = m => m.mode === 'mock' || m.mode === 'live'; // a mode that makes delivery attempts

// ---- branch rows ----
const rowsOf = (ev, id) => ev.rows('SELECT * FROM branch_status WHERE entity = ?', String(id));
function liveGate(ev, rec, ack, kind) {
  return decide(SYSTEM, kind, ev.entity(rec), { now: ev.now(), expected_revision: rec.revision, content_hash: rec.content_hash, destination_ack: ack });
}
// The one writer of branch_status. sync_complete and published are refused unless the gate accepts a live acknowledgement for this revision.
function setBranch(ev, rec, branch, status, { reason = null, ack = null, jobId = null } = {}) {
  if (!BRANCH_STATUSES.includes(status)) throw new Error(`Unknown branch status ${status}.`);
  if (status === 'sync_complete' || status === 'published') {
    const v = liveGate(ev, rec, ack, status === 'published' ? 'record_published' : 'record_sync_complete');
    if (!v.allow) throw new Error(`BRANCH_STATUS_REFUSED:${v.reason}`);
  }
  const mock = ack ? (ack.mock === false ? 0 : 1) : null;
  ev.lib.sql.exec(`INSERT INTO branch_status (entity, branch, status, updated_at, revision, content_hash, mock, reason, job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity, branch) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, revision = excluded.revision, content_hash = excluded.content_hash,
    mock = excluded.mock, reason = excluded.reason, job_id = excluded.job_id`, rec.id, branch, status, ev.now(), rec.revision, rec.content_hash, mock, reason, jobId);
  return status;
}
const mark = (ev, id, branch, status, reason) => ev.lib.sql.exec('UPDATE branch_status SET status = ?, reason = ?, updated_at = ? WHERE entity = ? AND branch = ?', status, reason, ev.now(), String(id), branch);
const approvedNow = (ev, rec) => { const ap = ev.approvalOf(rec.id); return ap && ap.revision === rec.revision && ap.content_hash === rec.content_hash && APPROVED_STATES.includes(rec.status) ? ap : null; };

// A job's state as the branch's state. A live acknowledgement the gate will not accept is a reconciliation problem, never a success.
function reflect(ev, rec, job) {
  const branch = CONTRACTS[ADAPTER_BY_DESTINATION[job.destination]].branch;
  if (job.source_revision !== rec.revision) return null; // a job for an older revision never speaks for this one
  const spot = branch === 'spotlight';
  let status, reason = job.last_error || null, ack = job.destination_ack;
  if (job.status === 'queued' || job.status === 'running') status = 'syncing';
  else if (job.status === 'retrying') status = 'retrying';
  else if (job.status === 'failed') status = 'failed';
  else if (job.status === 'needs_reconciliation') status = 'needs_reconciliation';
  else if (ack && ack.mock === false) {
    const v = liveGate(ev, rec, ack, spot ? 'record_published' : 'record_sync_complete');
    status = v.allow ? (spot ? 'published' : 'sync_complete') : 'needs_reconciliation'; reason = v.allow ? null : v.reason;
  } else { status = spot ? 'publication_held' : 'mock_acknowledged'; reason = spot ? 'MOCK_CMS_NOT_PUBLISHED' : 'MOCK_NOT_SYNCED'; }
  if (spot && ['publication_held', 'published'].includes(status)) new Spotlight(ev).setStatus(rec.id, status);
  return setBranch(ev, rec, branch, status, { reason, ack, jobId: job.job_id });
}

const sendFor = (lib, name) => (envelope, payload) => (modeFor(lib, name).mode === 'live' ? liveAdapter(envOf(lib), name, { now: () => Date.parse(clock(lib)) }) : adapterSet(lib)[name]).send(envelope, payload);
// Enqueue (a duplicate is a no-op) and, when mock adapters are on, make the first attempt; then show the job's state on its card.
async function dispatch(ev, rec, adapterName, payload, actor) {
  const lib = ev.lib, J = jobs(lib), c = CONTRACTS[adapterName];
  let { job } = await J.enqueue({ entity: rec.id, revision: rec.revision, hash: rec.content_hash, destination: c.destination, payload, actor });
  if (runs(modeFor(lib, adapterName))) {
    const r = await J.run(job.job_id, sendFor(lib, adapterName));
    job = r.job;
    const row = rowsOf(ev, rec.id).find(x => x.branch === c.branch); // stopped while in flight (a revocation, a new revision): the halt stands, and a person's impact_review flag is not repainted
    if (r.halted && row && row.revision === rec.revision && row.status === 'impact_review') return row.status;
  }
  return reflect(ev, rec, job);
}

// ---- fan-out ----
// The delivery gate: the policy gate re-run NOW, against the grants as they stand now. It decides first-time delivery and every later attempt (fan-out
// of an existing job, pump, recovery), so a revoked or expired permission stops delivery even for a job that was enqueued while it was valid.
function deliveryGate(ev, rec, ap, branch) {
  const grants = ev.grantsFor(rec.id), at = { now: ev.now(), expected_revision: rec.revision, content_hash: rec.content_hash };
  if (branch === 'spotlight') { // the CMS job follows the publication gate: every Spotlight gate for this revision, the public_spotlight grant, the named channel
    const sp = new Spotlight(ev), gates = sp.gatesFor(rec.id);
    return decide({ sub: SYSTEM.sub, roles: ['publisher'] }, 'spotlight_publish', ev.entity(rec), { ...at, channel: gates[FINAL_GATE]?.channel, gates, grants, derived_from_library_status: false });
  }
  // Independent permission check for this destination: evidence approved, its own purpose grant (revision-bound, unexpired, unrevoked), a reviewer's approval.
  return decide(SYSTEM, 'project_destination', ev.entity(rec), { ...at, destination: branch, channel: branch, grants,
    reviewer_approval: { revision: ap.revision, hash: ap.content_hash, sub: ap.approver_sub } });
}
// A denied delivery: the job stops (needs_reconciliation, never silently dropped) and the card waits for permission. A card already flagged for impact
// review at this revision keeps that flag: a person has to clear it.
function stopDelivery(ev, rec, branch, reason, jobId = null) {
  jobs(ev.lib).halt(rec.id, { reason: `PERMISSION_DENIED:${reason}`.slice(0, 80), destinations: [CONTRACTS[ADAPTER_BY_BRANCH[branch]].destination], jobId });
  const row = rowsOf(ev, rec.id).find(r => r.branch === branch);
  return row && row.revision === rec.revision && row.status === 'impact_review' ? 'impact_review' : setBranch(ev, rec, branch, 'permission_pending', { reason });
}
async function destination(ev, rec, ap, branch) {
  const lib = ev.lib, name = ADAPTER_BY_BRANCH[branch], c = CONTRACTS[name], existing = jobs(lib).byKey(idempotencyKey(rec.content_hash, c.destination, rec.id, rec.revision));
  const v = deliveryGate(ev, rec, ap, branch); // before reflecting an existing job too: its state must not speak for a permission that is gone
  if (!v.allow) return stopDelivery(ev, rec, branch, v.reason, existing?.job_id ?? null);
  if (existing) return reflect(ev, rec, existing);
  const grants = ev.grantsFor(rec.id);
  const mode = modeFor(lib, name);
  if (mode.mode === 'blocked') return setBranch(ev, rec, branch, 'blocked_external', { reason: mode.code });
  if (mode.mode === 'off') return setBranch(ev, rec, branch, 'projection_pending', { reason: 'ADAPTERS_OFF' }); // nothing is queued or sent
  const payload = buildPayload(name, { entity: rec, claims: ev.claimsOf(rec.id, rec.revision), approval: ap, grants });
  return dispatch(ev, rec, name, payload, SYSTEM.sub);
}

function spotlightBranch(ev, rec, claims) {
  const v = decide(SYSTEM, 'spotlight_nominate', ev.entity(rec), { now: ev.now(), expected_revision: rec.revision, content_hash: rec.content_hash }); // nomination is not publication
  if (!v.allow) return setBranch(ev, rec, 'spotlight', 'permission_pending', { reason: v.reason });
  const s = new Spotlight(ev).nominate(rec, claims);
  return setBranch(ev, rec, 'spotlight', s.status, { reason: s.status === 'publication_held' ? 'MOCK_CMS_NOT_PUBLISHED' : null });
}

// Create or refresh the seven records for the approved revision. Idempotent: a second call re-checks permissions and keeps what is settled.
// A branch that was flagged impact_review for THIS revision stays flagged until a person clears it (a new revision recomputes everything).
export async function fanOut(ev, id) {
  const rec = ev.load(id);
  if (!rec) return null;
  const ap = approvedNow(ev, rec);
  if (!ap) return { entity_id: rec.id, skipped: 'NOT_APPROVED', branches: [] };
  const kept = new Set(rowsOf(ev, rec.id).filter(r => r.revision === rec.revision && r.status === 'impact_review').map(r => r.branch)), claims = ev.claimsOf(rec.id, rec.revision);
  const out = [];
  for (const { id: branch } of BRANCHES) { // each branch in its own try: a failure is that branch's state, never another's (W11)
    if (kept.has(branch)) { out.push({ branch, status: 'impact_review' }); continue; }
    try {
      let status;
      if (branch === 'evidence') status = setBranch(ev, rec, 'evidence', 'evidence_approved');
      else if (SHELL_STATUS[branch]) status = setBranch(ev, rec, branch, SHELL_STATUS[branch][0], { reason: SHELL_STATUS[branch][1] });
      else if (branch === 'spotlight') status = spotlightBranch(ev, rec, claims);
      else status = await destination(ev, rec, ap, branch);
      out.push({ branch, status });
    } catch (e) {
      try { setBranch(ev, rec, branch, 'failed', { reason: 'BRANCH_ERROR' }); } catch { /* the row stays as it was */ }
      out.push({ branch, status: 'failed', error: 'BRANCH_ERROR' });
    }
  }
  return { entity_id: rec.id, revision: rec.revision, branches: out };
}

// ---- hooks called by evidence.js (all no-ops until configured) ----
export async function afterApprove(ev, rec) {
  if (!enabled(ev.lib)) return null;
  try { return await fanOut(ev, rec.id); } catch { return null; } // an approval is never undone by what follows it
}
export async function afterGrant(ev, id) { // a new grant may let a waiting branch proceed
  if (!enabled(ev.lib)) return null;
  try { return await fanOut(ev, id); } catch { return null; }
}
function flag(ev, id, status, reason, { only = null, all = false } = {}) {
  for (const r of rowsOf(ev, id)) {
    if ((only && !only.includes(r.branch)) || (!all && (r.branch === 'evidence' || !DERIVED.has(r.status)))) continue;
    mark(ev, id, r.branch, status, reason);
  }
}
// A new revision: open jobs for older revisions stop, every Spotlight gate is superseded and the story's flags go back to false (T14 follow-up).
// After approval, what was derived from the old revision is flagged for impact review (D11).
export function onRevisionChanged(ev, rec, { afterApproval = false } = {}) {
  if (!enabled(ev.lib)) return;
  jobs(ev.lib).halt(rec.id, { reason: 'SOURCE_SUPERSEDED', keepRevision: rec.revision });
  new Spotlight(ev).reset(rec.id);
  if (afterApproval) { flag(ev, rec.id, 'impact_review', 'EVIDENCE_REVISION_CHANGED'); mark(ev, rec.id, 'evidence', 'superseded', 'EVIDENCE_REVISION_CHANGED'); }
}
export function onWithdrawn(ev, rec) { // withdrawn after approval: every branch needs impact review and nothing more is sent (D11)
  if (!enabled(ev.lib)) return;
  jobs(ev.lib).halt(rec.id, { reason: 'EVIDENCE_WITHDRAWN' });
  new Spotlight(ev).reset(rec.id);
  flag(ev, rec.id, 'impact_review', 'WITHDRAWN_AFTER_APPROVAL', { all: true });
}
export function onImpactReviewCompleted(ev, rec) {
  if (enabled(ev.lib)) flag(ev, rec.id, 'withdrawn', 'IMPACT_REVIEW_COMPLETED', { all: true });
}
// A revoked permission flags what was derived under it, unless another grant for the same purpose still allows it.
export function onPermissionRevoked(ev, rec, purpose) {
  const branch = PURPOSE_BRANCH[purpose];
  if (!enabled(ev.lib) || !branch) return;
  const channel = branch === 'spotlight' ? new Spotlight(ev).gatesFor(rec.id)[FINAL_GATE]?.channel : branch;
  const still = decide({ sub: SYSTEM.sub, roles: ['reviewer'] }, 'use_for_purpose', ev.entity(rec), // a read-only check: 'use_for_purpose' has no system role
    { now: ev.now(), expected_revision: rec.revision, content_hash: rec.content_hash, purpose, grants: ev.grantsFor(rec.id), channel });
  if (still.allow) return;
  jobs(ev.lib).halt(rec.id, { reason: 'PERMISSION_REVOKED', destinations: [CONTRACTS[ADAPTER_BY_BRANCH[branch]].destination] });
  flag(ev, rec.id, 'impact_review', `PERMISSION_REVOKED:${purpose}`, { only: [branch] });
}

// ---- running and recovery ----
// Run every job that is due (queued, retrying whose time has come, or an attempt past its lease). Called by the daily trigger, a person's sync, and tests.
export async function pump(ev, { entity = null, limit = 50 } = {}) {
  const lib = ev.lib;
  if (!enabled(lib) || !['mock', 'live'].includes(modeOf(lib).mode)) return { ran: 0, jobs: [] };
  const J = jobs(lib), out = [];
  for (const j of J.due().filter(x => !entity || x.source_entity_id === entity).slice(0, limit)) {
    const rec = ev.load(j.source_entity_id), ap = rec && approvedNow(ev, rec);
    if (!rec || j.source_revision !== rec.revision || !ap) { J.halt(j.source_entity_id, { reason: 'SOURCE_SUPERSEDED', keepRevision: ap ? rec.revision : null }); continue; }
    const branch = CONTRACTS[ADAPTER_BY_DESTINATION[j.destination]].branch, v = deliveryGate(ev, rec, ap, branch); // permissions as they stand now, not when the job was queued
    if (!v.allow) { stopDelivery(ev, rec, branch, v.reason, j.job_id); continue; }
    if (!runs(modeFor(lib, ADAPTER_BY_DESTINATION[j.destination]))) continue; // live is per connection: a destination that is not ready waits
    const r = await J.run(j.job_id, sendFor(lib, ADAPTER_BY_DESTINATION[j.destination]));
    if (r.ran && !r.halted) { reflect(ev, rec, r.job); out.push({ job_id: j.job_id, status: r.job.status }); } // a job halted while in flight is not the card's to show
  }
  return { ran: out.length, jobs: out };
}
// A person (reviewer, admin or the resolved N+1) re-checks permissions, runs due jobs and may put one dead-lettered job back in the queue.
export async function sync(ev, user, id, p = {}) {
  const lib = ev.lib, rec = ev.load(id), acc = ev.access(rec, user);
  if (!enabled(lib) || !acc) throw fail(404, 'Evidence not found.');
  if (!acc.reviewer || acc.owner) throw fail(403, 'Only a reviewer who is not the owner can run recovery.'); // nobody recovers delivery of their own record
  const jobId = str(obj(p).recover_job, 80);
  if (jobId) {
    const j = jobs(lib).get(jobId);
    if (!j || j.source_entity_id !== rec.id) throw fail(404, 'Job not found.');
    if (!jobs(lib).recover(jobId, user.email)) throw Object.assign(fail(409, 'Only a failed job can be recovered.'), { reason: 'JOB_NOT_FAILED' });
  }
  await fanOut(ev, rec.id);
  await pump(ev, { entity: rec.id });
  return statusView(ev, user, id);
}

// ---- Spotlight steps (module API; the browser has no gate route because no role directory for the gate roles exists yet) ----
const spotlightRec = (ev, id) => { const rec = ev.load(id); if (!rec || !enabled(ev.lib)) throw fail(404, 'Evidence not found.'); return rec; };
const refuse = reason => Object.assign(fail(403, `Not allowed: ${reason}`), { reason });
export function requestSpotlightApproval(ev, actor, id, p = {}) {
  const rec = spotlightRec(ev, id), sp = new Spotlight(ev), s = sp.story(rec.id);
  if (!s || s.revision !== rec.revision) throw Object.assign(fail(409, 'There is no story candidate for this revision.'), { reason: 'NO_STORY_FOR_REVISION' });
  const v = decide(actor, 'spotlight_nominate', ev.entity(rec), { now: ev.now(), expected_revision: obj(p).expected_revision, content_hash: obj(p).content_hash });
  if (!v.allow) throw refuse(v.reason);
  if (s.status !== 'spotlight_draft') throw Object.assign(fail(409, 'The story is already past draft.'), { reason: 'STORY_NOT_DRAFT' });
  sp.setStatus(rec.id, 'spotlight_approval_pending');
  return setBranch(ev, rec, 'spotlight', 'spotlight_approval_pending');
}
export function approveSpotlightGate(ev, actor, id, gate, p = {}) {
  const rec = spotlightRec(ev, id), sp = new Spotlight(ev);
  return sp.recordGate(actor, rec, gate, p);
}
// Publication: the policy gate is the judge (every gate closed for THIS revision, public_spotlight granted, the named channel), then the mock CMS is
// asked. Whatever it answers, the card reads publication_held: the mock can never set `published`.
export async function publishSpotlight(ev, actor, id, p = {}) {
  p = obj(p);
  const rec = spotlightRec(ev, id), sp = new Spotlight(ev), s = sp.story(rec.id);
  if (!s || s.revision !== rec.revision) return { allow: false, reason: 'NO_STORY_FOR_REVISION' };
  if (s.status !== 'spotlight_approval_pending') return { allow: false, reason: `STORY_NOT_AWAITING_APPROVAL:${s.status}` };
  const v = decide(actor, 'spotlight_publish', ev.entity(rec), { now: ev.now(), expected_revision: p.expected_revision, content_hash: p.content_hash, channel: p.channel,
    gates: sp.gatesFor(rec.id), grants: ev.grantsFor(rec.id), derived_from_library_status: false });
  if (!v.allow) { setBranch(ev, rec, 'spotlight', 'spotlight_approval_pending', { reason: v.reason }); return { allow: false, reason: v.reason }; }
  const mode = modeFor(ev.lib, 'SPOTLIGHT_CMS');
  if (!runs(mode)) { const reason = mode.mode === 'blocked' ? mode.code : 'ADAPTERS_OFF'; setBranch(ev, rec, 'spotlight', 'spotlight_approval_pending', { reason }); return { allow: true, sent: false, reason }; }
  let story;
  try { story = sp.project(rec, 'public'); } catch (e) { const reason = `PROJECTION_${String(e.code || 'error').toUpperCase()}`; setBranch(ev, rec, 'spotlight', 'spotlight_approval_pending', { reason }); return { allow: false, reason }; }
  const payload = { audience: 'public', channel: str(p.channel, 100), story_revision_id: `${rec.id}:${rec.revision}`, revision_hash: rec.content_hash, content_hash: rec.content_hash, story };
  const status = await dispatch(ev, rec, 'SPOTLIGHT_CMS', payload, actor.sub);
  return { allow: true, sent: true, status };
}

// ---- the status view ----
export const overallOf = cards => {
  const done = cards.every(c => (COMPLETE[c.branch] || []).includes(c.display_status));
  return { status: done ? 'complete' : cards.some(c => ATTENTION.includes(c.display_status)) ? 'attention' : 'in_progress', complete: done };
};
export function cardsOf(ev, rec) {
  const rows = new Map(rowsOf(ev, rec.id).map(r => [r.branch, r]));
  return BRANCHES.map(({ id, label }) => {
    if (id === 'evidence') return { branch: id, label, status: rec.status, display_status: EVIDENCE_DISPLAY[rec.status] || 'in_review', mock: false, updated_at: rec.updated_at, reason: null };
    const r = rows.get(id), dest = DESTINATION_BRANCHES.has(id);
    if (!r) return { branch: id, label, status: 'not_started', display_status: 'not_started', mock: dest, updated_at: null, reason: 'AWAITING_EVIDENCE_APPROVAL' };
    return { branch: id, label, status: r.status, display_status: DISPLAY[r.status] || 'pending', mock: dest && r.mock !== 0, updated_at: r.updated_at, reason: r.reason };
  });
}
export function statusView(ev, user, id) {
  const rec = ev.load(id), acc = rec && ev.access(rec, user);
  if (!enabled(ev.lib) || !acc) throw fail(404, 'Evidence not found.');
  const cards = cardsOf(ev, rec);
  return { entity_id: rec.id, revision: rec.revision, state: rec.status, adapters: modeOf(ev.lib).mode, overall: overallOf(cards), cards,
    jobs: jobs(ev.lib).list(rec.id).map(({ job_id, destination, status, attempt, max_attempts, next_attempt_at, last_error, payload_hash, destination_ack: a, source_revision }) =>
      ({ job_id, destination, status, attempt, max_attempts, next_attempt_at, last_error, payload_hash, source_revision, mock: a ? a.mock !== false : null })) };
}
