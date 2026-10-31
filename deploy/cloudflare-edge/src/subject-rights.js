// Data subject rights inside the LibraryStore (v2.2 G2): the machine-readable export (Art 15 and 20), erasure (Art 17) and the DPO's list of what erasure held back.
// Orchestrated by the Worker (`GET /api/me/export`, `POST /api/me/erase`), which adds the parts that live in the person's own Interview Durable Object (checkpoint,
// private memory). Identity is always the verified sign-in the Worker forwarded; a body never names a person.
//
// Erasure replaces CONTENT with a tombstone ({erased: true, at}) and keeps the non-personal ids, so counts, joins and the audit chain stay intact. What it does NOT silently delete:
// approved evidence, published references and bids (they may already be used in a bid or sent downstream). Those are flagged `erasure_pending_review` with a reason in
// erasure_holds for the DPO, withdrawn from processing, and the person is told. Consent receipts stay (the record that a choice was made). Platform backups (Durable
// Object point-in-time recovery) can outlast deletion for a period the notice states as to-verify.
import { cleanReference } from './library.js';
import { rewriteRows, sha256Hex } from './audit-chain.js';
import * as privacy from './privacy.js';
import { str, obj, fail } from './util.js';

const randomToken = () => 'erased:' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const LIMIT = 2000;
const tableExists = (lib, name) => lib.rows("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
const like = email => '%' + String(email).replace(/[\\%_]/g, '\\$&') + '%';

// ---- tombstones shared with the retention sweep ----
export const tombstoneRef = at => ({ ...cleanReference({ title: '[erased]' }), erased: true, erasedAt: at });
// Replaces a reference's content (and every revision, claim and duplicate pair) with a tombstone. The row stays so ids and joins keep working; it is excluded everywhere
// (merged_into = 'erased'), and its owner becomes an erasure token.
export function eraseRefContent(lib, id, token, at) {
  lib.sql.exec(`UPDATE refs SET title = '[erased]', status = 'withdrawn', owner = ?, local_id = NULL, content_hash = '', practice = '', industry = '', country = '', manager_email = '', members = ',',
    quality_score = NULL, updated_by = ?, data = ?, state = ?, embedding = NULL, merged_into = 'erased', updated_at = ? WHERE id = ?`,
  token, token, JSON.stringify(tombstoneRef(at)), JSON.stringify({ erased: true, erasedAt: at, withdrawn: true, quality: null, validation: { status: 'pending' } }), at, id);
  lib.sql.exec('DELETE FROM revisions WHERE id = ?', id);
  lib.sql.exec('DELETE FROM duplicate_pairs WHERE a = ? OR b = ?', id, id);
  if (tableExists(lib, 'claims')) { lib.sql.exec('DELETE FROM claims WHERE ref_id = ?', id); lib.sql.exec('DELETE FROM confirmation_requests WHERE ref_id = ?', id); }
}
// Evidence: claims keep their ids and review status but lose their words; the record loses its free text and its owner; the revision, transition and grant rows lose the person.
export function eraseEvidenceContent(lib, id, token, at) {
  const rec = lib.rows('SELECT state_json FROM evidence_records WHERE id = ?', id)[0];
  if (!rec) return;
  const state = parse(rec.state_json, {});
  lib.sql.exec('UPDATE evidence_records SET owner_sub = ?, project_ref = NULL, ref_id = NULL, notes_hash = NULL, state_json = ?, updated_at = ? WHERE id = ?',
    token, JSON.stringify({ machine: state.machine, cycle: state.cycle ?? 1, ever_submitted: false, clarifications: [], rejection: null, dispute: null, impact: null, erased: { erased: true, at } }), at, id);
  lib.sql.exec(`UPDATE evidence_claims SET statement = '[erased]', value = NULL, unit = NULL, baseline = NULL, after_state = NULL, period = NULL, subject_id = ?, created_by = ?,
    source_refs = ?, conflicts_with = '[]' WHERE entity = ?`, token, token, JSON.stringify([{ erased: true, at }]), id);
  lib.sql.exec('UPDATE evidence_revisions SET author = ? WHERE entity = ?', token, id);
  lib.sql.exec('UPDATE workflow_transitions SET actor = ?, reason = NULL WHERE entity = ?', token, id);
  lib.sql.exec("UPDATE permission_grants SET subject = ?, grantor = ?, legal_basis_ref = NULL, status = CASE WHEN status = 'active' THEN 'revoked' ELSE status END WHERE entity = ?", token, token, id);
}
// Audit rows about a person (actor, or named in the detail text): the actor becomes the token and the detail is cleared. The hash chain is re-sealed and the new head returned.
export function pseudonymiseAudit(lib, emails, token) {
  const list = (Array.isArray(emails) ? emails : [emails]).map(e => String(e || '').toLowerCase()).filter(Boolean);
  if (!list.length) return { changed: 0, head: null };
  return rewriteRows(lib.sql, r => {
    const hit = list.includes(String(r.actor || '').toLowerCase()) || list.some(e => String(r.detail || '').toLowerCase().includes(e));
    return hit ? { actor: list.includes(String(r.actor || '').toLowerCase()) ? token : r.actor, detail: '' } : null;
  });
}

const inBids = (lib, refId) => tableExists(lib, 'bid_references') && lib.rows('SELECT 1 AS x FROM bid_references WHERE ref_id = ? LIMIT 1', refId).length > 0;
const approvedEvidence = (lib, rec) => ['approved', 'downstream_proposals'].includes(rec.status) || lib.rows("SELECT 1 AS x FROM approvals WHERE entity = ? AND status = 'approved' LIMIT 1", rec.id).length > 0;

// ---- export ----
export function exportMine(lib, user, subj) {
  const email = user.email, at = lib.now(), cap = rows => rows.slice(0, LIMIT);
  const has = n => tableExists(lib, n), q = (sql, ...p) => cap(lib.rows(sql, ...p));
  const refs = q('SELECT id, title, status, revision, created_at, updated_at, data, state FROM refs WHERE owner = ? AND merged_into IS NULL ORDER BY created_at', email)
    .map(r => ({ id: r.id, title: r.title, status: r.status, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, reference: parse(r.data, null), state: parse(r.state, {}) }));
  const revisions = q('SELECT v.id, v.revision, v.at, v.data FROM revisions v JOIN refs r ON r.id = v.id WHERE v.author = ? OR r.owner = ? ORDER BY v.id, v.revision', email, email).map(r => ({ id: r.id, revision: r.revision, at: r.at, reference: parse(r.data, null) }));
  const listedOn = q('SELECT id, title, status FROM refs WHERE owner != ? AND instr(members, ?) > 0 AND merged_into IS NULL', email, ',' + email + ',').map(r => ({ id: r.id, title: r.title, status: r.status }));
  const evidenceRows = q('SELECT * FROM evidence_records WHERE owner_sub = ? ORDER BY created_at', email);
  const evidence = evidenceRows.map(r => ({ id: r.id, status: r.status, revision: r.revision, projectRef: r.project_ref, refId: r.ref_id, createdAt: r.created_at, updatedAt: r.updated_at,
    claims: lib.rows('SELECT claim_id, revision, claim_type, statement, value, unit, baseline, after_state AS afterState, period, attribution, origin, review_status AS reviewStatus, source_refs AS sourceRefs FROM evidence_claims WHERE entity = ? ORDER BY revision, rowid', r.id)
      .map(c => ({ ...c, sourceRefs: parse(c.sourceRefs, []) })),
    revisions: lib.rows('SELECT revision, kind, author_role AS role, at FROM evidence_revisions WHERE entity = ? ORDER BY revision', r.id),
    transitions: lib.rows('SELECT revision, from_state AS "from", to_state AS "to", event, actor_role AS role, at FROM workflow_transitions WHERE entity = ? ORDER BY seq', r.id),
    approvals: lib.rows('SELECT revision, channel, purpose, status, at FROM approvals WHERE entity = ? ORDER BY rowid', r.id),
    grants: lib.rows('SELECT purpose, destination, scope, channel, status, expires_at AS expiresAt, created_at AS createdAt FROM permission_grants WHERE entity = ? ORDER BY rowid', r.id) }));
  const approvalsByMe = q('SELECT entity, revision, purpose, status, at FROM approvals WHERE approver_sub = ? ORDER BY at', email);
  const prof = lib.rows('SELECT edits, signin, consents, created_at, updated_at, seen_at FROM profiles WHERE subject = ?', email)[0];
  const out = {
    schema: 'atlas.subject-export.v1', exportedAt: at, subject: email,
    note: 'Machine-readable copy of what ATLAS holds about you in the shared library. Other parts (interview in progress, private memory) are added by the service. Audit rows list ids and actions only.',
    profile: prof ? { edits: parse(prof.edits, {}), signin: parse(prof.signin, {}), consents: parse(prof.consents, {}), createdAt: prof.created_at, updatedAt: prof.updated_at, seenAt: prof.seen_at } : null,
    references: refs, revisions, listedOn, evidence, approvalsMade: approvalsByMe,
    consentReceipts: privacy.receiptsOf(lib, subj), privacyFlags: privacy.flagsOf(lib, email),
    invitations: q('SELECT id, project_id AS projectId, title, reason, slot, status, created_at AS createdAt, source FROM invitations WHERE email = ? ORDER BY created_at', email),
    outreach: has('outreach') ? q('SELECT id, kind, channel, status, reason, payload, created_at AS createdAt, sent_at AS sentAt FROM outreach WHERE to_email = ? ORDER BY created_at', email).map(r => ({ ...r, payload: parse(r.payload, r.payload) })) : [],
    staffing: has('staffing') ? q('SELECT project_id AS projectId, project_title AS projectTitle, end_date AS endDate, source, updated_at AS updatedAt FROM staffing WHERE consultant_email = ?', email) : [],
    gapRequests: has('gap_requests') ? q('SELECT id, status, created_at AS createdAt, answered_at AS answeredAt, results FROM gap_requests WHERE email = ? ORDER BY created_at', email).map(r => ({ ...r, results: parse(r.results, null) })) : [],
    confirmationRequests: has('confirmation_requests') ? q('SELECT id, ref_id AS refId, kind, status, created_at AS createdAt, decided_at AS decidedAt FROM confirmation_requests WHERE created_by = ? OR to_email = ? ORDER BY created_at', email, email) : [],
    bids: has('bids') ? q('SELECT id, title, alias, status, outcome, created_at AS createdAt FROM bids WHERE owner = ? ORDER BY created_at', email) : [],
    audit: q('SELECT seq, id, action, at FROM audit WHERE actor = ? OR lower(detail) LIKE ? ESCAPE ? ORDER BY seq', email, like(email.toLowerCase()), '\\'),
  };
  lib.log('privacy', email, 'data export', 'machine-readable export'); // who exported and when; never what
  return out;
}

// ---- erasure ----
// The hash of the pseudonymous subject key: enough to show that a subject was erased, not enough to identify who.
const subjectHash = subj => sha256Hex('erasure|' + subj).slice(0, 24);
export function eraseMine(lib, user, subj, { now = lib.now() } = {}) {
  const email = user.email, token = randomToken(), counts = {}, pending = [];
  const bump = (k, n = 1) => { if (n) counts[k] = (counts[k] || 0) + n; };
  const hold = (kind, entity, reason) => {
    lib.sql.exec('INSERT INTO erasure_holds (id, kind, entity, subject_hash, reason, at, status) VALUES (?, ?, ?, ?, ?, ?, ?)', lib.newId(), kind, entity, subjectHash(subj), reason, now, 'pending_dpo');
    pending.push({ kind, entity, reason });
  };
  // 1. references the person owns
  for (const r of lib.rows("SELECT id, status, state FROM refs WHERE owner = ? AND (merged_into IS NULL OR merged_into != 'erased')", email)) {
    const s = parse(r.state, {}), held = !s.draft && (r.status === 'published' || inBids(lib, r.id));
    if (held) {
      lib.sql.exec('UPDATE refs SET state = ? WHERE id = ?', JSON.stringify({ ...s, withdrawn: true, erasure_pending_review: { reason: r.status === 'published' ? 'published_reference' : 'used_in_bid', at: now } }), r.id);
      lib.sql.exec("UPDATE refs SET status = 'withdrawn' WHERE id = ?", r.id);
      hold('reference', r.id, r.status === 'published' ? 'published_reference' : 'used_in_bid'); bump('referencesPendingReview');
    } else { eraseRefContent(lib, r.id, token, now); bump('referencesErased'); }
  }
  // 2. the person listed on someone else's reference: their name and email become "[erased]" in the live data and in every revision
  for (const r of lib.rows('SELECT id, data, members FROM refs WHERE owner != ? AND instr(members, ?) > 0', email, ',' + email + ',')) {
    const scrub = d => { const x = parse(d, null); if (!x?.details?.consultants) return d; x.details.consultants = x.details.consultants.map(c => (String(c.email || '').toLowerCase() === email ? { name: '[erased]', email: '', role: '' } : c)); return JSON.stringify(x); };
    const rest = String(r.members).split(',').filter(m => m && m !== email).join(',');
    lib.sql.exec('UPDATE refs SET data = ?, members = ? WHERE id = ?', scrub(r.data), rest ? ',' + rest + ',' : ',', r.id);
    for (const v of lib.rows('SELECT revision, data FROM revisions WHERE id = ?', r.id)) lib.sql.exec('UPDATE revisions SET data = ? WHERE id = ? AND revision = ?', scrub(v.data), r.id, v.revision);
    bump('listingsRemoved');
  }
  // 3. evidence the person owns
  for (const r of lib.rows('SELECT id, status FROM evidence_records WHERE owner_sub = ?', email)) {
    if (approvedEvidence(lib, r)) {
      const rec = lib.rows('SELECT state_json FROM evidence_records WHERE id = ?', r.id)[0], s = parse(rec.state_json, {});
      lib.sql.exec('UPDATE evidence_records SET state_json = ? WHERE id = ?', JSON.stringify({ ...s, erasure_pending_review: { reason: 'approved_evidence', at: now } }), r.id);
      hold('evidence', r.id, 'approved_evidence'); bump('evidencePendingReview');
    } else { eraseEvidenceContent(lib, r.id, token, now); bump('evidenceErased'); }
  }
  lib.sql.exec('UPDATE approvals SET approver_sub = ? WHERE approver_sub = ?', token, email);
  // 4. what is about the person: invitations, outreach, staffing, Teams, proof requests, confirmations, bids, jobs
  const del = (table, where, key, ...p) => { const n = lib.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...p)[0].n; if (n) { lib.sql.exec(`DELETE FROM ${table} WHERE ${where}`, ...p); bump(key, n); } };
  del('invitations', 'email = ?', 'invitations', email);
  if (tableExists(lib, 'outreach')) {
    del('outreach', 'to_email = ?', 'outreach', email);
    del('staffing', 'consultant_email = ?', 'staffingRows', email);
    del('teams_conversations', 'email = ?', 'teamsConversations', email);
  }
  if (tableExists(lib, 'gap_requests')) {
    const n = lib.rows('SELECT COUNT(*) AS n FROM gap_requests WHERE email = ?', email)[0].n;
    if (n) { lib.sql.exec("UPDATE gap_requests SET email = ?, assignee_name = '', results = NULL, pseudo = NULL, created_by = ?, created_by_mail = '' WHERE email = ?", token, token, email); bump('proofRequests', n); }
  }
  if (tableExists(lib, 'confirmation_requests')) {
    lib.sql.exec("UPDATE confirmation_requests SET to_email = ? WHERE to_email = ?", token, email);
    lib.sql.exec("UPDATE confirmation_requests SET created_by = ?, created_by_mail = '' WHERE created_by = ?", token, email);
    lib.sql.exec("UPDATE claims SET by_mail = ?, created_by = CASE WHEN created_by = ? THEN ? ELSE created_by END WHERE by_mail = ? OR created_by = ?", token, email, token, email, email);
  }
  if (tableExists(lib, 'bids')) for (const b of lib.rows('SELECT id FROM bids WHERE owner = ?', email)) { hold('bid', b.id, 'bid_record'); bump('bidsPendingReview'); }
  if (tableExists(lib, 'jobs')) lib.sql.exec('UPDATE jobs SET actor = ? WHERE actor = ?', token, email), lib.sql.exec('UPDATE job_events SET actor = ? WHERE actor = ?', token, email);
  if (tableExists(lib, 'bid_references')) lib.sql.exec('UPDATE bid_references SET used_by = ? WHERE used_by = ?', token, email);
  // 5. the profile and the flags (the receipts stay), then the audit trail
  const prof = lib.rows('SELECT COUNT(*) AS n FROM profiles WHERE subject = ?', email)[0].n;
  if (prof) { lib.sql.exec('DELETE FROM profiles WHERE subject = ?', email); bump('profile'); }
  lib.sql.exec('DELETE FROM privacy_flags WHERE subject = ?', email);
  // Held material (kept for the DPO) stays out of processing: the person is restricted until the DPO resolves every hold.
  if (pending.length) lib.sql.exec('INSERT OR REPLACE INTO privacy_flags (subject, restricted, object_scoring, object_matching, object_memory, updated_at) VALUES (?, 1, 1, 1, 1, ?)', email, now);
  lib.log('privacy', 'atlas', 'erasure completed', 'subject ' + subjectHash(subj).slice(0, 8)); // a pseudonym of a pseudonym, never an email; written before the rewrite so the head it returns is final
  const audit = pseudonymiseAudit(lib, [email], token); bump('auditRows', audit.changed);
  lib.sql.exec('INSERT INTO erasure_log (id, subject_hash, at, counts) VALUES (?, ?, ?, ?)', lib.newId(), subjectHash(subj), now, JSON.stringify(counts));
  return { erased: true, at: now, counts, pendingReview: pending, auditHead: audit.head,
    note: pending.length ? 'Approved or published material, and bids, are kept for the DPO to review before deletion (legal-hold exception); they are withdrawn from processing.' : '',
    outside: 'Platform backups (Durable Object recovery) can keep a copy for a short period; the privacy notice states it as to-verify.' };
}

// ---- the DPO's list of what erasure held back (admin only) ----
export function holdRoutes(ctx) {
  const { lib, user, method, parts, body } = ctx, [, action, id, verb] = parts;
  if (user.role !== 'admin') throw fail(403, 'Only an admin can review erasure holds.');
  privacy.ensure(lib);
  if (method === 'GET' && action === 'holds' && !id) return { body: { items: lib.rows("SELECT id, kind, entity, reason, at, status, resolved_at AS resolvedAt, note FROM erasure_holds ORDER BY at DESC LIMIT 200") } };
  if (method === 'POST' && action === 'holds' && id && verb === 'resolve') {
    const h = lib.rows('SELECT * FROM erasure_holds WHERE id = ?', str(id, 64))[0], b = obj(body);
    if (!h) throw fail(404, 'Hold not found.');
    if (h.status !== 'pending_dpo') throw fail(409, 'This hold was already resolved.');
    if (!['erase', 'retain'].includes(b.action)) throw fail(400, 'Choose erase or retain.');
    const note = str(b.note, 300), now = lib.now();
    if (b.action === 'retain' && !note) throw fail(400, 'Record the legal ground for keeping it.');
    if (b.action === 'erase') {
      const token = randomToken();
      if (h.kind === 'reference') eraseRefContent(lib, h.entity, token, now);
      else if (h.kind === 'evidence') eraseEvidenceContent(lib, h.entity, token, now);
      // (a bid is the business's own record: the DPO decides in the bids tool; this only records the decision)
    }
    lib.sql.exec('UPDATE erasure_holds SET status = ?, resolved_at = ?, resolved_by = ?, note = ? WHERE id = ?', b.action === 'erase' ? 'erased' : 'retained', now, user.email, note, h.id);
    lib.log('privacy', user.email, 'erasure hold ' + (b.action === 'erase' ? 'erased' : 'retained'), h.kind + ' ' + h.entity);
    return { body: { id: h.id, status: b.action === 'erase' ? 'erased' : 'retained' } };
  }
  throw fail(404, 'Not found.');
}
