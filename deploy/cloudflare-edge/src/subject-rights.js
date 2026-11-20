// Data subject rights inside the LibraryStore (v2.2 G2): the machine-readable export (Art 15 and 20), erasure (Art 17) and the DPO's list of what erasure held back.
// The Worker (`GET /api/me/export`, `POST /api/me/erase`) forwards here and then says the Interview Durable Object was not opened: checkpoint, consent state
// and private memory are listed as not covered. This slice does not import those stores. Identity is the verified sign-in the Worker forwarded; a body never names a person.
//
// Erasure replaces CONTENT with a tombstone ({erased: true, at}) and keeps the non-personal ids, so counts, joins and the audit chain stay intact. What it does NOT silently delete:
// approved evidence, published references and bids (they may already be used in a bid or sent downstream). Those are flagged `erasure_pending_review` with a reason in
// erasure_holds for the DPO, withdrawn from processing, and the person is told. Consent receipts stay (the record that a choice was made). Platform backups (Durable
// Object point-in-time recovery) can outlast deletion for a period the notice states as to-verify.
import { cleanReference } from './library.js';
import * as privacy from './privacy.js';
import { subjectHash } from './privacy.js';
import { str, obj, fail } from './util.js';
import { TENANT_ID } from './authz.js';
import { eraseJourneyFor, eraseTelemetryFor, eraseManagerTrustFor, eraseDirectoryFor, eraseSubjectInvitations } from './operate.js';
import { placeholders } from './sql-bound.js';

const randomToken = () => 'erased:' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const LIMIT = 2000;
const tableExists = (lib, name) => lib.rows("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
// A verified tenant is required before any row is read or rewritten. Blank-tenant rows stay quarantined: they are not this tenant's and they are not reported.
function requireTenant(user) {
  const tenant = String(user?.tenant || '').trim().toLowerCase();
  if (!TENANT_ID.test(tenant)) throw fail(403, 'A verified tenant is required.');
  return tenant;
}
function hasTenantColumn(lib, table) {
  return tableExists(lib, table) && lib.rows("SELECT 1 AS x FROM pragma_table_info('" + table + "') WHERE name = 'tenant'").length > 0;
}
const TENANT_SQL = "lower(COALESCE(tenant, '')) = ?";
const IDENT = /^[a-z_]+$/;
function columnsOf(lib, table) {
  if (!IDENT.test(table) || !tableExists(lib, table)) return [];
  return lib.rows(`SELECT name FROM pragma_table_info('${table}')`).map(r => r.name);
}
function ready(lib, table, columns) {
  const have = new Set(columnsOf(lib, table));
  return columns.every(c => IDENT.test(c) && have.has(c));
}
// The tenant test wraps the whole subject condition. `tenant AND a OR b` would let another tenant's `b` through.
function whereSubject(tenantColumn, subjectSql) {
  if (!IDENT.test(tenantColumn)) throw new Error('Bad column.');
  return `lower(COALESCE(${tenantColumn}, '')) = ? AND (${subjectSql})`;
}
// Tables this slice creates and can bind to the verified tenant. teams_conversations.tenant_id is the only tenant column that table has.
// Journey and telemetry use the same functions as privacy delete.
// Trust and directory are called with mode "subject": a manager-only trust address is replaced, and another person's directory manager address is replaced. Privacy delete calls them with mode "tenant" and keeps main's deletes.
// A staffing row where this person is only the manager is pseudonymised, not deleted.
const SUBJECT_TABLES = [
  { table: 'outreach', column: 'to_email', tenant: 'tenant', key: 'outreach' },
  { table: 'staffing', column: 'consultant_email', tenant: 'tenant', key: 'staffingRows' },
  { table: 'teams_conversations', column: 'email', tenant: 'tenant_id', key: 'teamsConversations' },
  { table: 'journey', key: 'journey', erase: eraseJourneyFor },
  { table: 'telemetry', key: 'telemetry', erase: eraseTelemetryFor },
  { table: 'manager_trust', key: 'managerTrust', erase: eraseManagerTrustFor },
  { table: 'directory', key: 'directory', erase: eraseDirectoryFor },
  { table: 'staffing', key: 'staffingManager', erase: eraseStaffingManager },
];
function eraseStaffingManager(lib, user, { tenant, token }) {
  if (!ready(lib, 'staffing', ['manager_email', 'consultant_email', 'tenant'])) return 0;
  const aliases = [...new Set([user.email, user.mail].map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
  if (!aliases.length) return 0;
  const marks = placeholders(aliases.length);
  let n = 0;
  for (const alias of aliases) {
    const where = whereSubject('tenant', `lower(manager_email) = ? AND lower(consultant_email) NOT IN (${marks})`);
    const c = lib.rows(`SELECT COUNT(*) AS n FROM staffing WHERE ${where}`, tenant, alias, ...aliases)[0].n;
    if (c) lib.exec(`UPDATE staffing SET manager_email = ? WHERE ${where}`, token, tenant, alias, ...aliases);
    n += c;
  }
  return n;
}
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
// Replaces one whole address. A longer address that merely contains it is left as it is.
function replaceAddress(text, email, token) {
  const src = String(text ?? ''), needle = String(email || '').toLowerCase();
  if (!needle) return src;
  let out = '', from = 0;
  const lower = src.toLowerCase();
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (!mentions(src.slice(Math.max(0, at - 1), at + needle.length + 2), email)) continue;
    out += src.slice(from, at) + token;
    from = at + needle.length;
  }
  return out + src.slice(from);
}
function subjectAddresses(user) {
  return [...new Set([user?.email, user?.mail].map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
}
function scrubManagerEmails(lib, tenant, addresses, token) {
  if (!hasTenantColumn(lib, 'profiles') || !addresses.length) return 0;
  const marks = placeholders(addresses.length);
  let n = 0;
  for (const row of lib.rows('SELECT subject, edits FROM profiles WHERE ' + TENANT_SQL + ' AND lower(subject) NOT IN (' + marks + ')', tenant, ...addresses)) {
    const edits = parse(row.edits, {});
    const field = edits.managerEmail;
    const value = field && typeof field === 'object' ? field.value : field;
    if (!addresses.includes(String(value || '').toLowerCase())) continue;
    edits.managerEmail = field && typeof field === 'object' ? { ...field, value: token } : token;
    lib.exec('UPDATE profiles SET edits = ? WHERE subject = ? AND ' + TENANT_SQL, JSON.stringify(edits), row.subject, tenant);
    n++;
  }
  return n;
}
function scrubImportAuthors(lib, tenant, addresses, token) {
  if (!ready(lib, 'directory_imports', ['by', 'tenant']) || !addresses.length) return 0;
  let n = 0;
  for (const email of addresses) {
    const count = lib.rows('SELECT COUNT(*) AS n FROM directory_imports WHERE ' + TENANT_SQL + ' AND lower(by) = ?', tenant, email)[0].n;
    if (count) { lib.exec('UPDATE directory_imports SET by = ? WHERE ' + TENANT_SQL + ' AND lower(by) = ?', token, tenant, email); n += count; }
  }
  return n;
}
function scrubOutreachPayloads(lib, tenant, addresses, token) {
  if (!ready(lib, 'outreach', ['payload', 'to_email', 'tenant']) || !addresses.length) return 0;
  const marks = placeholders(addresses.length);
  let n = 0;
  for (const row of lib.rows('SELECT id, payload FROM outreach WHERE ' + TENANT_SQL + ' AND lower(to_email) NOT IN (' + marks + ')', tenant, ...addresses)) {
    let next = String(row.payload ?? '');
    for (const email of addresses) next = replaceAddress(next, email, token);
    if (next === String(row.payload ?? '')) continue;
    lib.exec('UPDATE outreach SET payload = ? WHERE id = ?', next, row.id);
    n++;
  }
  return n;
}

// ---- tombstones shared with the retention sweep ----
export const tombstoneRef = at => ({ ...cleanReference({ title: '[erased]' }), erased: true, erasedAt: at });
// Replaces a reference's content (and every revision, claim and duplicate pair) with a tombstone. The row stays so ids and joins keep working; it is excluded everywhere
// (merged_into = 'erased'), and its owner becomes an erasure token.
export function eraseRefContent(lib, id, token, at) {
  lib.recorded(() => {
    lib.exec(`UPDATE refs SET title = '[erased]', status = 'withdrawn', owner = ?, local_id = NULL, content_hash = '', practice = '', industry = '', country = '', manager_email = '', members = ',',
      quality_score = NULL, updated_by = ?, data = ?, state = ?, embedding = NULL, merged_into = 'erased', updated_at = ? WHERE id = ?`,
    token, token, JSON.stringify(tombstoneRef(at)), JSON.stringify({ erased: true, erasedAt: at, withdrawn: true, quality: null, validation: { status: 'pending' } }), at, id);
    lib.exec('DELETE FROM revisions WHERE id = ?', id);
    if (tableExists(lib, 'duplicate_pairs')) lib.exec('DELETE FROM duplicate_pairs WHERE a = ? OR b = ?', id, id);
    if (tableExists(lib, 'claims')) lib.exec('DELETE FROM claims WHERE ref_id = ?', id);
    if (tableExists(lib, 'confirmation_requests')) lib.exec('DELETE FROM confirmation_requests WHERE ref_id = ?', id);
    lib.log(id, 'privacy', 'story erased', '1 reference');
  });
}
// Audit rows about a person (actor, or named in the detail text) become a tombstone: actor is the token, detail is empty.
// A keyed row keeps its hash and stores the proof. A legacy row is overwritten in place and stays unverified.
// A broken keyed chain is not rewritten. Legacy rows are still tombstoned.
// The audit table has no tenant column. Rows are rewritten only when their id is a reference in THIS tenant, or when
// the row is a privacy, library, directory or profile log and it actually contains one of the identities.
// Another tenant's story stays.
const PRIVACY_LOG = new Set(['privacy', 'library', 'directory', 'profile']);
export function pseudonymiseAudit(lib, emails, token, { ids = null } = {}) {
  const list = (Array.isArray(emails) ? emails : [emails]).map(e => String(e || '').toLowerCase()).filter(Boolean);
  if (!list.length) return { changed: 0, head: null };
  const allow = ids == null ? null : new Set(ids);
  const seqs = lib.rows('SELECT seq, id, actor, detail FROM audit').filter(r => {
    const id = String(r.id || '');
    const actorHit = list.includes(String(r.actor || '').toLowerCase());
    const detailHit = list.some(e => mentions(r.detail, e));
    if (!actorHit && !detailHit) return false;
    if (allow && !allow.has(id) && !PRIVACY_LOG.has(id)) return false;
    return true;
  }).map(r => Number(r.seq));
  if (!seqs.length) return { changed: 0, head: null };
  return lib.rewriteAudit(token, seqs);
}

const inBids = (lib, refId) => tableExists(lib, 'bid_references') && lib.rows('SELECT 1 AS x FROM bid_references WHERE ref_id = ? LIMIT 1', refId).length > 0;

// ---- export ----
// X1 (red L4): every optional table is checked first, so a store that never created one (profiles, evidence, outreach, ...) exports an empty section instead of failing.
export function exportMine(lib, user, subj) {
  privacy.ensure(lib);
  const tenant = requireTenant(user);
  const email = user.email, at = lib.now(), cap = rows => rows.slice(0, LIMIT);
  const q = (sql, ...p) => cap(lib.rows(sql, ...p));
  const scoped = (table, tenantColumn, columns, subjectSql, selectSql, order, ...params) => ready(lib, table, [tenantColumn, ...columns])
    ? q(`SELECT ${selectSql} FROM ${table} WHERE ${whereSubject(tenantColumn, subjectSql)}${order ? ' ORDER BY ' + order : ''}`, tenant, ...params) : [];
  const refs = q('SELECT id, title, status, revision, created_at, updated_at, data, state FROM refs WHERE owner = ? AND ' + TENANT_SQL + ' AND merged_into IS NULL ORDER BY created_at', email, tenant)
    .map(r => ({ id: r.id, title: r.title, status: r.status, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, reference: parse(r.data, null), state: parse(r.state, {}) }));
  const revisions = q('SELECT v.id, v.revision, v.at, v.data FROM revisions v JOIN refs r ON r.id = v.id WHERE (v.author = ? OR r.owner = ?) AND lower(COALESCE(r.tenant, \'\')) = ? ORDER BY v.id, v.revision', email, email, tenant).map(r => ({ id: r.id, revision: r.revision, at: r.at, reference: parse(r.data, null) }));
  const listedOn = q('SELECT id, title, status FROM refs WHERE owner != ? AND instr(members, ?) > 0 AND merged_into IS NULL AND ' + TENANT_SQL, email, ',' + email + ',', tenant).map(r => ({ id: r.id, title: r.title, status: r.status }));
  // X1 (red L5): references of other people where this person is the named N+1 or recorded the validation (id and title only). Same tenant only.
  const named = q('SELECT id, title, status, manager_email, state FROM refs WHERE owner != ? AND merged_into IS NULL AND ' + TENANT_SQL + ' AND (manager_email = ? OR instr(state, ?) > 0)', email, tenant, email, '"' + email + '"');
  const n1Of = named.filter(r => r.manager_email === email).map(r => ({ id: r.id, title: r.title, status: r.status }));
  const validatedByMe = named.filter(r => parse(r.state, {}).validation?.by === email).map(r => ({ id: r.id, title: r.title, status: r.status }));
  // evidence_records, evidence_claims and approvals are not created by this slice. They are not read here.
  const evidence = [], approvalsByMe = [];
  const prof = hasTenantColumn(lib, 'profiles') ? lib.rows('SELECT edits, signin, consents, created_at, updated_at, seen_at FROM profiles WHERE subject = ? AND ' + TENANT_SQL, email, tenant)[0] : null;
  const out = {
    schema: 'atlas.subject-export.v1', exportedAt: at, subject: email,
    note: 'Machine-readable copy of what this verified tenant holds about you in the shared library. Other tenants are not included. This is not a certification of GDPR compliance; wording and lawful bases still need the DPO. Audit rows list ids and actions only.',
    profile: prof ? { edits: parse(prof.edits, {}), signin: parse(prof.signin, {}), consents: parse(prof.consents, {}), createdAt: prof.created_at, updatedAt: prof.updated_at, seenAt: prof.seen_at } : null,
    references: refs, revisions, listedOn, namedAsN1On: n1Of, validatedByMeOn: validatedByMe, evidence, approvalsMade: approvalsByMe,
    consentReceipts: privacy.receiptsOf(lib, subj), privacyFlags: privacy.flagsOf(lib, email),
    invitations: hasTenantColumn(lib, 'invitations') ? q('SELECT id, project_id AS projectId, title, reason, slot, status, created_at AS createdAt, source FROM invitations WHERE email = ? AND ' + TENANT_SQL + ' ORDER BY created_at', email, tenant) : [],
    outreach: hasTenantColumn(lib, 'outreach') ? q('SELECT id, kind, channel, status, reason, payload, created_at AS createdAt, sent_at AS sentAt FROM outreach WHERE ' + TENANT_SQL + ' AND to_email = ? ORDER BY created_at', tenant, email).map(r => ({ ...r, payload: parse(r.payload, r.payload) })) : [],
    staffing: scoped('staffing', 'tenant', ['consultant_email'], 'lower(consultant_email) = ?', 'project_id AS projectId, project_title AS projectTitle, end_date AS endDate, source, updated_at AS updatedAt', '', email),
    gapRequests: hasTenantColumn(lib, 'gap_requests') ? q('SELECT id, status, created_at AS createdAt, answered_at AS answeredAt, results FROM gap_requests WHERE ' + whereSubject('tenant', 'lower(email) = ?') + ' ORDER BY created_at', tenant, email).map(r => ({ ...r, results: parse(r.results, null) })) : [],
    confirmationRequests: scoped('confirmation_requests', 'tenant', ['created_by', 'to_email'], 'lower(created_by) = ? OR lower(to_email) = ?', 'id, ref_id AS refId, kind, status, created_at AS createdAt, decided_at AS decidedAt', 'created_at', email, email),
    bids: scoped('bids', 'tenant', ['owner'], 'lower(owner) = ?', 'id, title, alias, status, outcome, created_at AS createdAt', 'created_at', email),
    // X1 (red L6): rows whose actor is the person, or whose detail names the whole address (never a longer address that merely contains it).
    audit: cap(lib.rows('SELECT seq, id, action, at, actor, detail FROM audit WHERE id IN (SELECT id FROM refs WHERE ' + TENANT_SQL + ') AND (actor = ? OR instr(lower(detail), ?) > 0) ORDER BY seq', tenant, email, email.toLowerCase()).filter(a => a.actor === email || mentions(a.detail, email))).map(a => ({ seq: a.seq, id: a.id, action: a.action, at: a.at })),
  };
  lib.log('privacy', email, 'data export', 'machine-readable export'); // who exported and when; never what
  return out;
}

// ---- erasure ----
export function eraseMine(lib, user, subj, opts = {}) {
  privacy.ensure(lib);
  const tenant = requireTenant(user);
  if (typeof lib.transactionSync !== 'function') throw fail(500, 'Erasure cannot be made atomic on this store, so nothing was erased.');
  return lib.transactionSync(() => eraseWithin(lib, user, subj, tenant, opts));
}
function eraseWithin(lib, user, subj, tenant, { now = lib.now() } = {}) {
  const email = user.email, token = randomToken(), counts = {}, pending = [], touched = [];
  const addresses = subjectAddresses(user);
  const bump = (k, n = 1) => { if (n) counts[k] = (counts[k] || 0) + n; };
  const has = n => tableExists(lib, n);
  const hold = (kind, entity, reason) => {
    lib.exec('INSERT INTO erasure_holds (id, kind, entity, subject_hash, reason, at, status, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', lib.newId(), kind, entity, subjectHash(subj), reason, now, 'pending_dpo', tenant);
    pending.push({ kind, entity, reason });
  };
  // X1 (red M5): a reference that was EVER shared (validated or published, cited in a bid, used or put into a one-pager) is held for the DPO even if its owner withdrew it first.
  const heldReason = (r, s) => (r.status === 'published' || s.validation?.status === 'validated' ? 'published_reference'
    : inBids(lib, r.id) || lib.rows("SELECT 1 AS x FROM audit WHERE id = ? AND action IN ('one-pager generated', 'used in bid', 'validated') LIMIT 1", r.id).length ? 'used_in_bid' : '');
  // 1. references the person owns
  for (const r of lib.rows("SELECT id, status, state FROM refs WHERE owner = ? AND " + TENANT_SQL + " AND (merged_into IS NULL OR merged_into != 'erased')", email, tenant)) {
    const s = parse(r.state, {}), reason = s.draft ? '' : heldReason(r, s);
    if (reason) {
      lib.exec('UPDATE refs SET state = ? WHERE id = ?', JSON.stringify({ ...s, withdrawn: true, erasure_pending_review: { reason, at: now } }), r.id);
      lib.exec("UPDATE refs SET status = 'withdrawn' WHERE id = ?", r.id);
      hold('reference', r.id, reason); bump('referencesPendingReview'); touched.push(r.id);
    } else { eraseRefContent(lib, r.id, token, now); bump('referencesErased'); touched.push(r.id); }
  }
  // 2. what is about the person on OTHER people's references: listed as a consultant, named as the N+1, recorded as the validator, last editor, or an author of a revision. Names and
  // emails become "[erased]" / the erasure token in the live data and in every revision. content_hash is left alone: it still names the revision that was rated and approved (X1, red L5).
  for (const r of lib.rows('SELECT id, data, state, members, manager_email, updated_by FROM refs WHERE owner != ? AND ' + TENANT_SQL + ' AND (instr(members, ?) > 0 OR manager_email = ? OR updated_by = ? OR instr(data, ?) > 0 OR instr(state, ?) > 0)',
    email, tenant, ',' + email + ',', email, email, '"' + email + '"', '"' + email + '"')) {
    const listed = String(r.members).includes(',' + email + ',');
    const scrub = d => {
      const x = parse(d, null); if (!x) return d;
      if (x.details?.consultants) x.details.consultants = x.details.consultants.map(c => (String(c.email || '').toLowerCase() === email ? { name: '[erased]', email: '', role: '' } : c));
      if (String(x.validation?.manager?.email || '').toLowerCase() === email) x.validation.manager = { name: '[erased]', email: '' };
      return JSON.stringify(x);
    };
    const st = parse(r.state, {}); if (st.validation?.by === email) st.validation.by = token;
    const rest = String(r.members).split(',').filter(m => m && m !== email).join(',');
    lib.exec('UPDATE refs SET data = ?, state = ?, members = ?, manager_email = ?, updated_by = ? WHERE id = ?', scrub(r.data), JSON.stringify(st), rest ? ',' + rest + ',' : ',',
      r.manager_email === email ? '' : r.manager_email, r.updated_by === email ? token : r.updated_by, r.id);
    for (const v of lib.rows('SELECT revision, data FROM revisions WHERE id = ?', r.id)) lib.exec('UPDATE revisions SET data = ? WHERE id = ? AND revision = ?', scrub(v.data), r.id, v.revision);
    touched.push(r.id);
    bump(listed ? 'listingsRemoved' : 'otherRecordsScrubbed');
  }
  { const n = lib.rows('SELECT COUNT(*) AS n FROM revisions WHERE author = ? AND id IN (SELECT id FROM refs WHERE owner != ? AND ' + TENANT_SQL + ')', email, email, tenant)[0].n;
    if (n) { lib.exec('UPDATE revisions SET author = ? WHERE author = ? AND id IN (SELECT id FROM refs WHERE owner != ? AND ' + TENANT_SQL + ')', token, email, email, tenant); bump('revisionAuthors', n); } }
  // evidence_records, approvals, jobs and job_events are not created by this slice. They are not rewritten here.
  // Invitations use the same helper as privacy delete: either address is deleted, and a sent
  // source matches the alias or the 60-character form invite stored.
  const invitations = eraseSubjectInvitations(lib, user, tenant);
  bump('invitations', invitations.removed);
  bump('invitationSources', invitations.scrubbed);
  // Each statement rewrites one subject column, and the tenant test wraps that condition.
  for (const spec of SUBJECT_TABLES) {
    if (typeof spec.erase === 'function') {
      const n = spec.erase(lib, user, { mode: 'subject', tenant, token, email });
      if (n) bump(spec.key, n);
      continue;
    }
    if (!ready(lib, spec.table, [spec.column, spec.tenant])) continue;
    const aliases = spec.table === 'outreach' ? addresses : [String(email || '').trim().toLowerCase()].filter(Boolean);
    for (const alias of aliases) {
      const where = whereSubject(spec.tenant, `lower(${spec.column}) = ?`);
      const n = lib.rows(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE ${where}`, tenant, alias)[0].n;
      if (n) { lib.exec(`DELETE FROM ${spec.table} WHERE ${where}`, tenant, alias); bump(spec.key, n); }
    }
  }
  if (ready(lib, 'gap_requests', ['email', 'tenant'])) {
    const where = whereSubject('tenant', 'lower(email) = ?');
    const n = lib.rows(`SELECT COUNT(*) AS n FROM gap_requests WHERE ${where}`, tenant, email)[0].n;
    if (n) { lib.exec(`UPDATE gap_requests SET email = ?, assignee_name = '', results = NULL, pseudo = NULL WHERE ${where}`, token, tenant, email); bump('proofRequests', n); }
  }
  if (ready(lib, 'gap_requests', ['created_by', 'tenant', 'created_by_mail'])) {
    const where = whereSubject('tenant', 'lower(created_by) = ?');
    lib.exec(`UPDATE gap_requests SET created_by = ?, created_by_mail = '' WHERE ${where}`, token, tenant, email);
  }
  if (ready(lib, 'confirmation_requests', ['to_email', 'tenant'])) {
    const where = whereSubject('tenant', 'lower(to_email) = ?');
    lib.exec(`UPDATE confirmation_requests SET to_email = ? WHERE ${where}`, token, tenant, email);
  }
  if (ready(lib, 'confirmation_requests', ['created_by', 'tenant'])) {
    const mail = ready(lib, 'confirmation_requests', ['created_by_mail']) ? ", created_by_mail = ''" : '';
    const where = whereSubject('tenant', 'lower(created_by) = ?');
    lib.exec(`UPDATE confirmation_requests SET created_by = ?${mail} WHERE ${where}`, token, tenant, email);
  }
  if (has('claims')) {
    lib.exec('UPDATE claims SET by_mail = ? WHERE by_mail = ? AND ref_id IN (SELECT id FROM refs WHERE ' + TENANT_SQL + ')', token, email, tenant);
    lib.exec('UPDATE claims SET created_by = ? WHERE created_by = ? AND ref_id IN (SELECT id FROM refs WHERE ' + TENANT_SQL + ')', token, email, tenant);
  }
  if (hasTenantColumn(lib, 'bids')) for (const b of lib.rows('SELECT id FROM bids WHERE ' + whereSubject('tenant', 'lower(owner) = ?'), tenant, email)) { hold('bid', b.id, 'bid_record'); bump('bidsPendingReview'); }
  if (ready(lib, 'bids', ['id', 'tenant']) && ready(lib, 'bid_references', ['bid_id', 'used_by'])) {
    lib.exec('UPDATE bid_references SET used_by = ? WHERE lower(used_by) = ? AND bid_id IN (SELECT id FROM bids WHERE lower(COALESCE(tenant, \'\')) = ?)', token, email, tenant);
  }
  // 5. the profile and the flags (the receipts stay), then the audit trail.
  // Another person's row stays. Only the address copied onto it, in this tenant, is replaced.
  bump('profileManagerEmail', scrubManagerEmails(lib, tenant, addresses, token));
  bump('directoryImports', scrubImportAuthors(lib, tenant, addresses, token));
  bump('outreachPayloads', scrubOutreachPayloads(lib, tenant, addresses, token));
  if (hasTenantColumn(lib, 'profiles')) { const prof = lib.rows('SELECT COUNT(*) AS n FROM profiles WHERE subject = ? AND ' + TENANT_SQL, email, tenant)[0].n; if (prof) { lib.exec('DELETE FROM profiles WHERE subject = ? AND ' + TENANT_SQL, email, tenant); bump('profile'); } }
  // privacy_flags is keyed by email and has no tenant. Leaving it keeps another tenant's restriction from being cleared or set by this erasure.
  lib.log('privacy', 'atlas', 'erasure completed', 'subject ' + subjectHash(subj).slice(0, 8)); // a pseudonym of a pseudonym, never an email; written before the rewrite so the head it returns is final
  const sameTenantRefs = has('refs') ? lib.rows('SELECT id FROM refs WHERE ' + TENANT_SQL, tenant).map(r => r.id) : [];
  const audit = pseudonymiseAudit(lib, addresses, token, { ids: [...new Set([...touched, ...sameTenantRefs])] });
  if (audit.refused) hold('audit', 'chain', 'audit_chain_unverified'); // X1 (red M8): a chain that does not verify is not re-sealed; the DPO is told the audit part is pending
  else bump('auditRows', audit.changed);
  lib.exec('INSERT INTO erasure_log (id, subject_hash, at, counts) VALUES (?, ?, ?, ?)', lib.newId(), subjectHash(subj), now, JSON.stringify(counts));
  return { erased: true, at: now, counts, pendingReview: pending, auditHead: audit.refused ? null : audit.head, auditPreviousHead: audit.refused ? null : audit.previousHead,
    ...(audit.refused ? { auditRefused: { reason: audit.reason, brokenSeq: audit.brokenSeq } } : {}),
    note: (pending.length ? 'Approved or published material, and bids, are kept for the DPO to review before deletion (legal-hold exception); they are withdrawn from processing.' + (audit.refused ? ' Your name could not be removed from the audit trail yet: it failed its integrity check and the DPO has been asked to look at it first.' : '') : '') + ' Rows in other tenants were not changed. This is not a certification of GDPR compliance.',
    outside: 'Platform backups (Durable Object recovery) can keep a copy for a short period; the privacy notice states it as to-verify.' };
}

// ---- the DPO's list of what erasure held back (admin only) ----
export function holdRoutes(ctx) {
  const { lib, user, method, parts, body } = ctx;
  const tenant = requireTenant(user);
  if (user.role !== 'admin') throw fail(403, 'Only an admin can review erasure holds.');
  privacy.ensure(lib);
  const id = parts[1] || '', verb = parts[2] || '';
  const mine = "lower(COALESCE(tenant, '')) = ?";
  if (method === 'GET' && !id) return { body: { items: lib.rows(`SELECT id, kind, entity, reason, at, status, resolved_at AS resolvedAt, note FROM erasure_holds WHERE ${mine} ORDER BY at DESC LIMIT 200`, tenant) } };
  if (method === 'POST' && id && verb === 'resolve') {
    const h = lib.rows(`SELECT * FROM erasure_holds WHERE id = ? AND ${mine}`, str(id, 64), tenant)[0], b = obj(body);
    if (!h) throw fail(404, 'Hold not found.');
    if (h.status !== 'pending_dpo') throw fail(409, 'This hold was already resolved.');
    if (!['erase', 'retain'].includes(b.action)) throw fail(400, 'Choose erase or retain.');
    const note = str(b.note, 300), now = lib.now();
    if (b.action === 'retain' && !note) throw fail(400, 'Record the legal ground for keeping it.');
    if (b.action === 'erase' && h.kind === 'audit') throw fail(409, 'The audit trail failed its integrity check. Investigate it first (handoff/SECURITY_RUNBOOK.md); the person then runs the erasure again.');
    const status = b.action === 'erase' ? 'erased' : 'retained';
    lib.recorded(() => {
      if (b.action === 'erase' && h.kind === 'reference') eraseRefContent(lib, h.entity, randomToken(), now);
      lib.exec(`UPDATE erasure_holds SET status = ?, resolved_at = ?, resolved_by = ?, note = ? WHERE id = ? AND ${mine}`, status, now, user.email, note, h.id, tenant);
      lib.log('privacy', user.email, 'erasure hold ' + status, h.kind + ' ' + h.entity);
    });
    return { body: { id: h.id, status } };
  }
  throw fail(404, 'Not found.');
}
