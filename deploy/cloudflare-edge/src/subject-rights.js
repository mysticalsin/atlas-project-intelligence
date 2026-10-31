// Data subject rights inside the LibraryStore (v2.2 G2): the machine-readable export (Art 15 and 20), erasure (Art 17) and the DPO's list of what erasure held back.
// Orchestrated by the Worker (`GET /api/me/export`, `POST /api/me/erase`), which adds the parts that live in the person's own Interview Durable Object (checkpoint,
// private memory). Identity is always the verified sign-in the Worker forwarded; a body never names a person.
//
// Erasure replaces CONTENT with a tombstone ({erased: true, at}) and keeps the non-personal ids, so counts, joins and the audit chain stay intact. What it does NOT silently delete:
// approved evidence, published references and bids (they may already be used in a bid or sent downstream). Those are flagged `erasure_pending_review` with a reason in
// erasure_holds for the DPO, withdrawn from processing, and the person is told. Consent receipts stay (the record that a choice was made). Platform backups (Durable
// Object point-in-time recovery) can outlast deletion for a period the notice states as to-verify.
import { cleanReference } from './library.js';
import { rewriteRows } from './audit-chain.js';
import * as privacy from './privacy.js';
import { subjectHash } from './privacy.js';
import { str, obj, fail } from './util.js';

const randomToken = () => 'erased:' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const LIMIT = 2000;
const tableExists = (lib, name) => lib.rows("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
// X1 (red L6): an address is mentioned only as a whole address, never as part of a longer one (al@ is not hal@, al@x.com is not al@x.com.au).
export function mentions(text, email) {
  const t = String(text || '').toLowerCase(), e = String(email || '').toLowerCase();
  if (!e) return false;
  for (let i = t.indexOf(e); i >= 0; i = t.indexOf(e, i + 1)) {
    const b = t[i - 1], a = t[i + e.length], a2 = t[i + e.length + 1];
    if ((b === undefined || !/[a-z0-9._%+@-]/.test(b)) && (a === undefined || !(/[a-z0-9_%+@-]/.test(a) || (a === '.' && a2 !== undefined && /[a-z0-9]/.test(a2))))) return true;
  }
  return false;
}

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
// X1 (red M8): the chain is verified first (rewriteRows); a chain that no longer verifies is left untouched and { refused: true, reason, brokenSeq } is returned instead.
export function pseudonymiseAudit(lib, emails, token) {
  const list = (Array.isArray(emails) ? emails : [emails]).map(e => String(e || '').toLowerCase()).filter(Boolean);
  if (!list.length) return { changed: 0, head: null };
  return rewriteRows(lib.sql, r => {
    const actor = list.includes(String(r.actor || '').toLowerCase());
    return actor || list.some(e => mentions(r.detail, e)) ? { actor: actor ? token : r.actor, detail: '' } : null;
  });
}

const inBids = (lib, refId) => tableExists(lib, 'bid_references') && lib.rows('SELECT 1 AS x FROM bid_references WHERE ref_id = ? LIMIT 1', refId).length > 0;
const approvedEvidence = (lib, rec) => ['approved', 'downstream_proposals'].includes(rec.status) || (tableExists(lib, 'approvals') && lib.rows("SELECT 1 AS x FROM approvals WHERE entity = ? AND status = 'approved' LIMIT 1", rec.id).length > 0);

// ---- export ----
// X1 (red L4): every optional table is checked first, so a store that never created one (profiles, evidence, outreach, ...) exports an empty section instead of failing.
export function exportMine(lib, user, subj) {
  privacy.ensure(lib);
  const email = user.email, at = lib.now(), cap = rows => rows.slice(0, LIMIT);
  const has = n => tableExists(lib, n), q = (sql, ...p) => cap(lib.rows(sql, ...p)), qi = (table, sql, ...p) => (has(table) ? q(sql, ...p) : []);
  const refs = q('SELECT id, title, status, revision, created_at, updated_at, data, state FROM refs WHERE owner = ? AND merged_into IS NULL ORDER BY created_at', email)
    .map(r => ({ id: r.id, title: r.title, status: r.status, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, reference: parse(r.data, null), state: parse(r.state, {}) }));
  const revisions = q('SELECT v.id, v.revision, v.at, v.data FROM revisions v JOIN refs r ON r.id = v.id WHERE v.author = ? OR r.owner = ? ORDER BY v.id, v.revision', email, email).map(r => ({ id: r.id, revision: r.revision, at: r.at, reference: parse(r.data, null) }));
  const listedOn = q('SELECT id, title, status FROM refs WHERE owner != ? AND instr(members, ?) > 0 AND merged_into IS NULL', email, ',' + email + ',').map(r => ({ id: r.id, title: r.title, status: r.status }));
  // X1 (red L5): references of other people where this person is the named N+1 or recorded the validation (id and title only).
  const named = q('SELECT id, title, status, manager_email, state FROM refs WHERE owner != ? AND merged_into IS NULL AND (manager_email = ? OR instr(state, ?) > 0)', email, email, '"' + email + '"');
  const n1Of = named.filter(r => r.manager_email === email).map(r => ({ id: r.id, title: r.title, status: r.status }));
  const validatedByMe = named.filter(r => parse(r.state, {}).validation?.by === email).map(r => ({ id: r.id, title: r.title, status: r.status }));
  const evidenceRows = qi('evidence_records', 'SELECT * FROM evidence_records WHERE owner_sub = ? ORDER BY created_at', email);
  const evidence = evidenceRows.map(r => ({ id: r.id, status: r.status, revision: r.revision, projectRef: r.project_ref, refId: r.ref_id, createdAt: r.created_at, updatedAt: r.updated_at,
    claims: lib.rows('SELECT claim_id, revision, claim_type, statement, value, unit, baseline, after_state AS afterState, period, attribution, origin, review_status AS reviewStatus, source_refs AS sourceRefs FROM evidence_claims WHERE entity = ? ORDER BY revision, rowid', r.id)
      .map(c => ({ ...c, sourceRefs: parse(c.sourceRefs, []) })),
    revisions: lib.rows('SELECT revision, kind, author_role AS role, at FROM evidence_revisions WHERE entity = ? ORDER BY revision', r.id),
    transitions: lib.rows('SELECT revision, from_state AS "from", to_state AS "to", event, actor_role AS role, at FROM workflow_transitions WHERE entity = ? ORDER BY seq', r.id),
    approvals: lib.rows('SELECT revision, channel, purpose, status, at FROM approvals WHERE entity = ? ORDER BY rowid', r.id),
    grants: lib.rows('SELECT purpose, destination, scope, channel, status, expires_at AS expiresAt, created_at AS createdAt FROM permission_grants WHERE entity = ? ORDER BY rowid', r.id) }));
  const approvalsByMe = qi('approvals', 'SELECT entity, revision, purpose, status, at FROM approvals WHERE approver_sub = ? ORDER BY at', email);
  const prof = has('profiles') ? lib.rows('SELECT edits, signin, consents, created_at, updated_at, seen_at FROM profiles WHERE subject = ?', email)[0] : null;
  const out = {
    schema: 'atlas.subject-export.v1', exportedAt: at, subject: email,
    note: 'Machine-readable copy of what ATLAS holds about you in the shared library. Other parts (interview in progress, private memory) are added by the service. Audit rows list ids and actions only.',
    profile: prof ? { edits: parse(prof.edits, {}), signin: parse(prof.signin, {}), consents: parse(prof.consents, {}), createdAt: prof.created_at, updatedAt: prof.updated_at, seenAt: prof.seen_at } : null,
    references: refs, revisions, listedOn, namedAsN1On: n1Of, validatedByMeOn: validatedByMe, evidence, approvalsMade: approvalsByMe,
    consentReceipts: privacy.receiptsOf(lib, subj), privacyFlags: privacy.flagsOf(lib, email),
    invitations: q('SELECT id, project_id AS projectId, title, reason, slot, status, created_at AS createdAt, source FROM invitations WHERE email = ? ORDER BY created_at', email),
    outreach: has('outreach') ? q('SELECT id, kind, channel, status, reason, payload, created_at AS createdAt, sent_at AS sentAt FROM outreach WHERE to_email = ? ORDER BY created_at', email).map(r => ({ ...r, payload: parse(r.payload, r.payload) })) : [],
    staffing: qi('staffing', 'SELECT project_id AS projectId, project_title AS projectTitle, end_date AS endDate, source, updated_at AS updatedAt FROM staffing WHERE consultant_email = ?', email),
    gapRequests: has('gap_requests') ? q('SELECT id, status, created_at AS createdAt, answered_at AS answeredAt, results FROM gap_requests WHERE email = ? ORDER BY created_at', email).map(r => ({ ...r, results: parse(r.results, null) })) : [],
    confirmationRequests: qi('confirmation_requests', 'SELECT id, ref_id AS refId, kind, status, created_at AS createdAt, decided_at AS decidedAt FROM confirmation_requests WHERE created_by = ? OR to_email = ? ORDER BY created_at', email, email),
    bids: qi('bids', 'SELECT id, title, alias, status, outcome, created_at AS createdAt FROM bids WHERE owner = ? ORDER BY created_at', email),
    // X1 (red L6): rows whose actor is the person, or whose detail names the whole address (never a longer address that merely contains it).
    audit: cap(lib.rows('SELECT seq, id, action, at, actor, detail FROM audit WHERE actor = ? OR instr(lower(detail), ?) > 0 ORDER BY seq', email, email.toLowerCase()).filter(a => a.actor === email || mentions(a.detail, email))).map(a => ({ seq: a.seq, id: a.id, action: a.action, at: a.at })),
  };
  lib.log('privacy', email, 'data export', 'machine-readable export'); // who exported and when; never what
  return out;
}

// ---- erasure ----
export function eraseMine(lib, user, subj, { now = lib.now() } = {}) {
  privacy.ensure(lib);
  const email = user.email, token = randomToken(), counts = {}, pending = [];
  const bump = (k, n = 1) => { if (n) counts[k] = (counts[k] || 0) + n; };
  const has = n => tableExists(lib, n);
  const hold = (kind, entity, reason) => {
    lib.sql.exec('INSERT INTO erasure_holds (id, kind, entity, subject_hash, reason, at, status) VALUES (?, ?, ?, ?, ?, ?, ?)', lib.newId(), kind, entity, subjectHash(subj), reason, now, 'pending_dpo');
    pending.push({ kind, entity, reason });
  };
  // X1 (red M5): a reference that was EVER shared (validated or published, cited in a bid, used or put into a one-pager) is held for the DPO even if its owner withdrew it first.
  const heldReason = (r, s) => (r.status === 'published' || s.validation?.status === 'validated' ? 'published_reference'
    : inBids(lib, r.id) || lib.rows("SELECT 1 AS x FROM audit WHERE id = ? AND action IN ('one-pager generated', 'used in bid', 'validated') LIMIT 1", r.id).length ? 'used_in_bid' : '');
  // 1. references the person owns
  for (const r of lib.rows("SELECT id, status, state FROM refs WHERE owner = ? AND (merged_into IS NULL OR merged_into != 'erased')", email)) {
    const s = parse(r.state, {}), reason = s.draft ? '' : heldReason(r, s);
    if (reason) {
      lib.sql.exec('UPDATE refs SET state = ? WHERE id = ?', JSON.stringify({ ...s, withdrawn: true, erasure_pending_review: { reason, at: now } }), r.id);
      lib.sql.exec("UPDATE refs SET status = 'withdrawn' WHERE id = ?", r.id);
      hold('reference', r.id, reason); bump('referencesPendingReview');
    } else { eraseRefContent(lib, r.id, token, now); bump('referencesErased'); }
  }
  // 2. what is about the person on OTHER people's references: listed as a consultant, named as the N+1, recorded as the validator, last editor, or an author of a revision. Names and
  // emails become "[erased]" / the erasure token in the live data and in every revision. content_hash is left alone: it still names the revision that was rated and approved (X1, red L5).
  for (const r of lib.rows('SELECT id, data, state, members, manager_email, updated_by FROM refs WHERE owner != ? AND (instr(members, ?) > 0 OR manager_email = ? OR updated_by = ? OR instr(data, ?) > 0 OR instr(state, ?) > 0)',
    email, ',' + email + ',', email, email, '"' + email + '"', '"' + email + '"')) {
    const listed = String(r.members).includes(',' + email + ',');
    const scrub = d => {
      const x = parse(d, null); if (!x) return d;
      if (x.details?.consultants) x.details.consultants = x.details.consultants.map(c => (String(c.email || '').toLowerCase() === email ? { name: '[erased]', email: '', role: '' } : c));
      if (String(x.validation?.manager?.email || '').toLowerCase() === email) x.validation.manager = { name: '[erased]', email: '' };
      return JSON.stringify(x);
    };
    const st = parse(r.state, {}); if (st.validation?.by === email) st.validation.by = token;
    const rest = String(r.members).split(',').filter(m => m && m !== email).join(',');
    lib.sql.exec('UPDATE refs SET data = ?, state = ?, members = ?, manager_email = ?, updated_by = ? WHERE id = ?', scrub(r.data), JSON.stringify(st), rest ? ',' + rest + ',' : ',',
      r.manager_email === email ? '' : r.manager_email, r.updated_by === email ? token : r.updated_by, r.id);
    for (const v of lib.rows('SELECT revision, data FROM revisions WHERE id = ?', r.id)) lib.sql.exec('UPDATE revisions SET data = ? WHERE id = ? AND revision = ?', scrub(v.data), r.id, v.revision);
    bump(listed ? 'listingsRemoved' : 'otherRecordsScrubbed');
  }
  { const n = lib.rows('SELECT COUNT(*) AS n FROM revisions WHERE author = ? AND id NOT IN (SELECT id FROM refs WHERE owner = ?)', email, email)[0].n;
    if (n) { lib.sql.exec('UPDATE revisions SET author = ? WHERE author = ? AND id NOT IN (SELECT id FROM refs WHERE owner = ?)', token, email, email); bump('revisionAuthors', n); } }
  // 3. evidence the person owns
  if (has('evidence_records')) for (const r of lib.rows('SELECT id, status FROM evidence_records WHERE owner_sub = ?', email)) {
    if (approvedEvidence(lib, r)) {
      const rec = lib.rows('SELECT state_json FROM evidence_records WHERE id = ?', r.id)[0], s = parse(rec.state_json, {});
      lib.sql.exec('UPDATE evidence_records SET state_json = ? WHERE id = ?', JSON.stringify({ ...s, erasure_pending_review: { reason: 'approved_evidence', at: now } }), r.id);
      hold('evidence', r.id, 'approved_evidence'); bump('evidencePendingReview');
    } else { eraseEvidenceContent(lib, r.id, token, now); bump('evidenceErased'); }
  }
  if (has('approvals')) lib.sql.exec('UPDATE approvals SET approver_sub = ? WHERE approver_sub = ?', token, email);
  // 4. what is about the person: invitations, outreach, staffing, Teams, proof requests, confirmations, bids, jobs
  // Each UPDATE below rewrites a column only on the rows where THAT column is the person (X1, red H1/M7): a request they were ASSIGNED is not a request they CREATED, and a claim they
  // created is not a claim they confirmed. One shared WHERE over two columns rewrote someone else's column.
  const del = (table, where, key, ...p) => { if (!has(table)) return; const n = lib.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...p)[0].n; if (n) { lib.sql.exec(`DELETE FROM ${table} WHERE ${where}`, ...p); bump(key, n); } };
  del('invitations', 'email = ?', 'invitations', email);
  if (has('outreach')) {
    del('outreach', 'to_email = ?', 'outreach', email);
    del('staffing', 'consultant_email = ?', 'staffingRows', email);
    del('teams_conversations', 'email = ?', 'teamsConversations', email);
  }
  if (has('gap_requests')) {
    const n = lib.rows('SELECT COUNT(*) AS n FROM gap_requests WHERE email = ?', email)[0].n;
    if (n) { lib.sql.exec("UPDATE gap_requests SET email = ?, assignee_name = '', results = NULL, pseudo = NULL WHERE email = ?", token, email); bump('proofRequests', n); }
    lib.sql.exec("UPDATE gap_requests SET created_by = ?, created_by_mail = '' WHERE created_by = ?", token, email);
  }
  if (has('confirmation_requests')) {
    lib.sql.exec('UPDATE confirmation_requests SET to_email = ? WHERE to_email = ?', token, email);
    lib.sql.exec("UPDATE confirmation_requests SET created_by = ?, created_by_mail = '' WHERE created_by = ?", token, email);
  }
  if (has('claims')) {
    lib.sql.exec('UPDATE claims SET by_mail = ? WHERE by_mail = ?', token, email); // the confirmer; claims.by_source keeps WHO the confirmer was (N+1 or self-named), so a tombstone never upgrades a claim
    lib.sql.exec('UPDATE claims SET created_by = ? WHERE created_by = ?', token, email);
  }
  if (has('bids')) for (const b of lib.rows('SELECT id FROM bids WHERE owner = ?', email)) { hold('bid', b.id, 'bid_record'); bump('bidsPendingReview'); }
  if (has('jobs')) lib.sql.exec('UPDATE jobs SET actor = ? WHERE actor = ?', token, email), lib.sql.exec('UPDATE job_events SET actor = ? WHERE actor = ?', token, email);
  if (has('bid_references')) lib.sql.exec('UPDATE bid_references SET used_by = ? WHERE used_by = ?', token, email);
  // 5. the profile and the flags (the receipts stay), then the audit trail
  if (has('profiles')) { const prof = lib.rows('SELECT COUNT(*) AS n FROM profiles WHERE subject = ?', email)[0].n; if (prof) { lib.sql.exec('DELETE FROM profiles WHERE subject = ?', email); bump('profile'); } }
  lib.sql.exec('DELETE FROM privacy_flags WHERE subject = ?', email);
  // Held material (kept for the DPO) stays out of processing: the person is restricted until the DPO resolves every hold.
  if (pending.length) lib.sql.exec('INSERT OR REPLACE INTO privacy_flags (subject, restricted, object_scoring, object_matching, object_memory, updated_at) VALUES (?, 1, 1, 1, 1, ?)', email, now);
  lib.log('privacy', 'atlas', 'erasure completed', 'subject ' + subjectHash(subj).slice(0, 8)); // a pseudonym of a pseudonym, never an email; written before the rewrite so the head it returns is final
  const audit = pseudonymiseAudit(lib, [email], token);
  if (audit.refused) hold('audit', 'chain', 'audit_chain_unverified'); // X1 (red M8): a chain that does not verify is not re-sealed; the DPO is told the audit part is pending
  else bump('auditRows', audit.changed);
  lib.sql.exec('INSERT INTO erasure_log (id, subject_hash, at, counts) VALUES (?, ?, ?, ?)', lib.newId(), subjectHash(subj), now, JSON.stringify(counts));
  return { erased: true, at: now, counts, pendingReview: pending, auditHead: audit.refused ? null : audit.head, auditPreviousHead: audit.refused ? null : audit.previousHead,
    ...(audit.refused ? { auditRefused: { reason: audit.reason, brokenSeq: audit.brokenSeq } } : {}),
    note: pending.length ? 'Approved or published material, and bids, are kept for the DPO to review before deletion (legal-hold exception); they are withdrawn from processing.' + (audit.refused ? ' Your name could not be removed from the audit trail yet: it failed its integrity check and the DPO has been asked to look at it first.' : '') : '',
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
    if (b.action === 'erase' && h.kind === 'audit') throw fail(409, 'The audit trail failed its integrity check. Investigate it first (handoff/SECURITY_RUNBOOK.md); the person then runs the erasure again.');
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
