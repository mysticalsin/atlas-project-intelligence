// F4 "Zero-effort capture" (WOW_SPEC §F4): the outreach approval queue, the staffing import, the daily sweep and the
// Teams events the Worker forwards (system word `teams-event`). Words `outreach` and `staffing` are for reviewers.
// NOTHING IS AUTO-SENT: webhooks, imports and the cron only create PENDING rows. A row leaves ATLAS only when an admin
// or reviewer approves that exact row: an email becomes a draft the approver sends from their own mail client, a
// Teams card is sent only through a connected client (BLOCKED_EXTERNAL in this build), phone is always blocked.
// Previews, cards and audit rows never carry client names (record masking; audit = kind and channel only).
import { str, email, obj, fail, uuidish } from './util.js';
import { TENANT_ID } from './authz.js';
import { neutralizeFormula } from './csvsafe.js';
import { recordText, forOthers } from './scrub.js';
import * as claims from './claims.js';
import * as gaps from './gaps.js';
import { interviewCard, messageCard } from './teams.js';
import { invitationTransition, noteInvitation, INVITATION_CLOSED, INVITATION_REFUSAL, OPEN_INVITATION_SQL } from './invitation.js';
import { profileFold } from './profile.js';
import { placeholders, readChunks } from './sql-bound.js';

export const READY = true;

const KINDS = ['interview_invite', 'gap_request', 'confirmation_request'];
const QUEUED = ['teams', 'email_draft']; // phone is never queued: it is BLOCKED_EXTERNAL (§F4.5)
const STATUSES = ['pending_approval', 'drafted', 'sent', 'failed', 'blocked_external', 'dismissed'];
const ACTIONABLE = new Set(['pending_approval', 'blocked_external', 'failed']);
const REVIEWERS = ['admin', 'reviewer'];
const HEADER = ['project_id', 'consultant_email', 'manager_email', 'manager_name', 'project_title', 'end_date'];
const MAX_ROWS = 2000, MAX_CHARS = 200000, DUE_AHEAD_DAYS = 7, DUE_BACK_DAYS = 30, SEEN_KEEP_MS = 2 * 864e5;
export const REASONS = Object.freeze({
  teamsOff: 'Teams is not connected: tenant app, bot credentials and TEAMS_* settings are missing.',
  notInstalled: "ATLAS is not installed in this person's Teams.",
  stopped: 'This person asked ATLAS to stop Teams messages.',
  blocked: 'This person blocked messages from ATLAS in Teams (MessageWritesBlocked).',
  phone: 'Phone interviews are not connected: they need a Twilio account (SID, Auth Token, number, budget and DPA) or Teams Phone with an existing ACS resource.',
  closed: 'The invitation or request is no longer open.',
});
const SUBJECT = { interview_invite: "12 minutes while it's fresh?", gap_request: 'Can you give 5 minutes of proof for a bid?', confirmation_request: 'Can you confirm a few points? (about 60 seconds)' };
// /go/ links survive an interactive sign-in (WOW_ZERO_CONFIG §3.9); rows queued earlier keep their stored fragment path.
const PATH = { interview_invite: id => `/go/invitation/${id}`, gap_request: id => `/go/gap/${id}`, confirmation_request: id => `/go/confirm/${id}` };
const REASON_LABEL = { project_end: 'project ending', milestone: 'project milestone', six_month_update: 'six-month update', periodic_review: 'periodic review', manual: 'interview request' };

// §2.4 DDL (new tables only). The unique index makes the per-(subject, channel) dedupe atomic.
const STAFFING_TABLE = `CREATE TABLE staffing_v2 (
    project_id TEXT NOT NULL, consultant_email TEXT NOT NULL, manager_email TEXT, manager_name TEXT, project_title TEXT,
    end_date TEXT, source TEXT, updated_at TEXT, tenant TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (project_id, consultant_email, tenant))`;
function migrateStaffing(lib) {
  const exists = lib.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staffing'")[0];
  if (!exists) { lib.exec(STAFFING_TABLE.replace('staffing_v2', 'staffing')); return; }
  const pk = lib.rows("SELECT name FROM pragma_table_info('staffing') WHERE pk > 0 ORDER BY pk").map(r => r.name);
  if (pk.length === 3 && pk[0] === 'project_id' && pk[1] === 'consultant_email' && pk[2] === 'tenant') return;
  const cols = lib.rows("SELECT name FROM pragma_table_info('staffing')").map(r => r.name);
  lib.exec(STAFFING_TABLE);
  const tenantSql = cols.includes('tenant') ? "COALESCE(tenant, '')" : "''";
  lib.exec(`INSERT INTO staffing_v2 (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at, tenant)
    SELECT project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at, ${tenantSql} FROM staffing`);
  lib.exec('DROP TABLE staffing');
  lib.exec('ALTER TABLE staffing_v2 RENAME TO staffing');
}
const DDL = [
  `CREATE TABLE IF NOT EXISTS outreach (id TEXT PRIMARY KEY, kind TEXT, subject_id TEXT, channel TEXT, to_email TEXT, status TEXT, reason TEXT,
    payload TEXT, aad_object_id TEXT, created_at TEXT, approved_by TEXT, approved_at TEXT, sent_at TEXT, activity_id TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS outreach_subject ON outreach(kind, subject_id, channel)',
  'CREATE INDEX IF NOT EXISTS outreach_status ON outreach(status, created_at)',
  `CREATE TABLE IF NOT EXISTS teams_conversations (subject TEXT PRIMARY KEY, aad_object_id TEXT, tenant_id TEXT, teams_user_id TEXT,
    conversation_id TEXT, service_url TEXT, email TEXT, status TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS teams_conversations_email ON teams_conversations(email)',
  'CREATE TABLE IF NOT EXISTS teams_seen (activity_id TEXT PRIMARY KEY, at TEXT)',
];
const ensured = new WeakSet();
export function ensure(lib) {
  if (ensured.has(lib)) return;
  lib.schema(() => {
  migrateStaffing(lib);
  for (const q of DDL) lib.exec(q);
  const outreachCols = lib.rows("SELECT name FROM pragma_table_info('outreach')").map(r => r.name);
  if (outreachCols.length && !outreachCols.includes('tenant')) lib.exec("ALTER TABLE outreach ADD COLUMN tenant TEXT NOT NULL DEFAULT ''");
  const withDirectory = lib.rows("SELECT name FROM pragma_table_info('outreach')").map(r => r.name);
  if (withDirectory.length && !withDirectory.includes('directory_tenant')) lib.exec("ALTER TABLE outreach ADD COLUMN directory_tenant TEXT NOT NULL DEFAULT ''");
  const withConversation = lib.rows("SELECT name FROM pragma_table_info('outreach')").map(r => r.name);
  if (withConversation.length && !withConversation.includes('conversation_id')) lib.exec("ALTER TABLE outreach ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''");
  const withKey = lib.rows("SELECT name FROM pragma_table_info('outreach')").map(r => r.name);
  if (withKey.length && !withKey.includes('idempotency_key')) lib.exec('ALTER TABLE outreach ADD COLUMN idempotency_key TEXT');
  });
  ensured.add(lib);
}

const parsed = t => { try { return obj(JSON.parse(t)); } catch { return {}; } };
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const isoDate = v => { const s = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s ? s : ''; };
const originOf = ctx => { for (const v of [ctx.env?.ORIGIN, ctx.url?.href]) { try { const o = new URL(String(v)).origin; if (/^https?:\/\//.test(o)) return o; } catch { /* next */ } } return ''; };

function view(o) {
  const p = parsed(o.payload), pv = obj(p.preview);
  return { id: o.id, kind: o.kind, subjectId: o.subject_id, channel: o.channel, toEmail: o.to_email, status: o.status, reason: o.reason || '',
    createdAt: o.created_at, approvedBy: o.approved_by || null, approvedAt: o.approved_at || null, sentAt: o.sent_at || null,
    preview: { title: String(pv.title || ''), text: String(pv.text || '') } };
}
const rowOf = (lib, id) => lib.rows('SELECT * FROM outreach WHERE id = ?', id)[0];

// Queue one row per channel (teams, email_draft), deduped per (kind, subject, channel). Returns the rows and how many
// were new. Previews are masked here again (record masking, then the uniform labels), whatever the caller passed.
function queueRows(lib, item) {
  ensure(lib);
  const it = obj(item), kind = it.kind, subjectId = str(it.subjectId, 64), to = email(it.toEmail), tenant = String(it.tenant || '').toLowerCase();
  if (!KINDS.includes(kind) || !subjectId || !to) throw fail(400, 'An outreach item needs a kind, a subject and an email.');
  const clean = (s, n) => forOthers(recordText(lib)(str(s, n)));
  const p = obj(it.preview), payload = JSON.stringify({ preview: { title: clean(p.title, 140), text: clean(p.text, 300) }, subject: clean(it.subject, 200) || SUBJECT[kind], path: PATH[kind](subjectId) });
  const rows = [];
  let created = 0;
  for (const channel of QUEUED) {
    if (!lib.rows('SELECT id FROM outreach WHERE kind = ? AND subject_id = ? AND channel = ?', kind, subjectId, channel)[0]) {
      const id = lib.newId();
      lib.recorded(() => {
        lib.exec(`INSERT OR IGNORE INTO outreach (id, kind, subject_id, channel, to_email, status, reason, payload, created_at, tenant)
          VALUES (?, ?, ?, ?, ?, 'pending_approval', '', ?, ?, ?)`, id, kind, subjectId, channel, to, payload, lib.now(), tenant);
        lib.log(id, 'atlas', 'outreach pending_approval', `${kind} ${channel}`);
      });
      created++;
    }
    rows.push(lib.rows('SELECT * FROM outreach WHERE kind = ? AND subject_id = ? AND channel = ?', kind, subjectId, channel)[0]);
  }
  return { rows, created };
}
export function queue(lib, item) {
  if (!READY) return [];
  return queueRows(lib, item).rows.map(view);
}

// An invitation's outreach: its project reference is the project id or title through the record masking.
function queueInvite(lib, inv) {
  const ref = recordText(lib)(str(inv.project_id, 60) || str(inv.title, 140)) || 'your recent project';
  return queueRows(lib, { kind: 'interview_invite', subjectId: inv.id, toEmail: inv.email, tenant: inv.tenant || '', subject: SUBJECT.interview_invite,
    preview: { title: ref, text: `12 minutes while it's fresh? A short interview about ${ref} (${REASON_LABEL[inv.reason] || 'interview request'}).` } });
}

function assignmentProject(id) {
  return str(typeof id === 'string' ? id : '', 60);
}
function tenantKey(value) {
  return String(value || '').trim().toLowerCase();
}
export function personAliases(lib, address, tenant) {
  const keys = new Set([profileFold(address)].filter(Boolean));
  const want = profileFold(tenant);
  if (!lib.rows("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'profiles'")[0]) return [...keys];
  const rows = lib.rows('SELECT subject, email, tenant FROM profiles').filter(row => profileFold(row.tenant) === want);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      const subject = profileFold(row.subject);
      const mail = profileFold(row.email);
      if (!keys.has(subject) && !keys.has(mail)) continue;
      if (subject && !keys.has(subject)) { keys.add(subject); grew = true; }
      if (mail && !keys.has(mail)) { keys.add(mail); grew = true; }
    }
  }
  return [...keys];
}
function reconcileStaffing(lib, s) {
  const project = assignmentProject(s.projectId);
  const consultant = email(s.consultantEmail) || String(s.consultantEmail || '').trim().toLowerCase();
  const tenant = tenantKey(s.tenant);
  if (!project || !consultant) throw fail(400, 'A staffing row needs a project id and a consultant email.');
  const existing = lib.rows("SELECT project_id, consultant_email, tenant FROM staffing WHERE lower(project_id) = lower(?) AND lower(consultant_email) = ? AND lower(COALESCE(tenant, '')) = ?", project, consultant, tenant);
  if (existing.length > 1) throw fail(409, 'This staffing assignment matches more than one stored row. Nothing was changed.');
  const managerEmail = s.managerEmail || '';
  if (existing.length === 1) {
    const row = existing[0];
    lib.exec(`UPDATE staffing SET consultant_email = ?, tenant = ?,
      manager_email = CASE WHEN ? != '' THEN ? ELSE manager_email END,
      manager_name = CASE WHEN ? != '' THEN ? ELSE manager_name END,
      project_title = CASE WHEN ? != '' THEN ? ELSE project_title END,
      end_date = CASE WHEN ? != '' THEN ? ELSE end_date END,
      source = ?, updated_at = ?
      WHERE project_id = ? AND consultant_email = ? AND tenant = ?`,
      consultant, tenant,
      managerEmail, managerEmail,
      managerEmail ? (s.managerName || '') : '', managerEmail ? (s.managerName || '') : '',
      s.projectTitle || '', s.projectTitle || '',
      s.endDate || '', s.endDate || '',
      s.source || '', lib.now(),
      row.project_id, row.consultant_email, row.tenant);
    return row.project_id;
  }
  lib.exec(`INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at, tenant)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    project, consultant, managerEmail, managerEmail ? (s.managerName || '') : '', s.projectTitle || '', s.endDate || '', s.source || '', lib.now(), tenant);
  return project;
}
function applyStaffingAssignment(lib, actor, s) {
  const storedProject = reconcileStaffing(lib, s);
  const consultant = email(s.consultantEmail) || String(s.consultantEmail || '').trim().toLowerCase();
  const tenant = tenantKey(s.tenant);
  lib.bindTrust(actor, { owner: consultant, email: s.managerEmail, source: 'staffing', tenant, tenantEnforced: actor.tenantEnforced === true });
  s.projectId = storedProject;
  const aliases = personAliases(lib, consultant, tenant);
  const current = new Set(readChunks(lib, aliases, {
    fixed: 1,
    sql: chunk => `SELECT lower(manager_email) AS email FROM staffing WHERE lower(consultant_email) IN (${placeholders(chunk.length)}) AND lower(COALESCE(tenant, '')) = ? AND trim(manager_email) != ''`,
    params: chunk => [...chunk, tenant],
  }).map(r => r.email));
  for (const grant of readChunks(lib, aliases, {
    fixed: 1,
    sql: chunk => `SELECT owner, email, source FROM manager_trust WHERE lower(owner) IN (${placeholders(chunk.length)}) AND lower(COALESCE(tenant, '')) = ?`,
    params: chunk => [...chunk, tenant],
  })) {
    const source = String(grant.source || '');
    if (source !== 'staffing' || current.has(String(grant.email || '').toLowerCase())) continue;
    lib.exec("DELETE FROM manager_trust WHERE lower(owner) = ? AND lower(email) = ? AND lower(COALESCE(tenant, '')) = ? AND source = 'staffing'", String(grant.owner || '').toLowerCase(), String(grant.email || '').toLowerCase(), tenant);
  }
}
function inTransaction(lib, fn) {
  if (typeof lib.transactionSync !== 'function') throw fail(503, 'Atomic staffing changes need storage.transactionSync.');
  return lib.transactionSync(fn);
}
// Due staffing rows (end date within [today - 30, today + 7]) with no reference yet for (project, consultant) and no
// earlier project_end invitation (any status, so a dismissed invitation is never re-created) get one invitation plus
// pending outreach rows.
function consultantOwners(lib, address, tenant) {
  return personAliases(lib, address, tenant);
}
function inviteDue(lib, rows, today) {
  const ahead = addDays(today, DUE_AHEAD_DAYS), back = addDays(today, -DUE_BACK_DAYS);
  let invited = 0, queued = 0;
  for (const s of rows) {
    if (!s.endDate || s.endDate > ahead || s.endDate < back) continue;
    const owners = consultantOwners(lib, s.consultantEmail, s.tenant);
    const hasRef = readChunks(lib, owners, {
      fixed: 3,
      sql: chunk => `SELECT id FROM refs WHERE merged_into IS NULL AND lower(COALESCE(tenant, '')) = ? AND (lower(owner) IN (${placeholders(chunk.length)}) OR instr(members, ?) > 0)
      AND json_extract(data, '$.details.projectId') = ? COLLATE NOCASE LIMIT 1`,
      params: chunk => [String(s.tenant || '').toLowerCase(), ...chunk, ',' + s.consultantEmail + ',', s.projectId],
    })[0];
    if (hasRef || lib.rows("SELECT id FROM invitations WHERE lower(email) = ? AND lower(project_id) = lower(?) AND reason = 'project_end' AND lower(COALESCE(tenant, '')) = ? LIMIT 1", String(s.consultantEmail || '').toLowerCase(), s.projectId, tenantKey(s.tenant))[0]) continue;
    const inv = lib.invite(s.source, { email: s.consultantEmail, reason: 'project_end', projectId: s.projectId, title: s.projectTitle, source: s.source, tenant: s.tenant || '' });
    invited++;
    queued += queueInvite(lib, inv).created;
  }
  return { invited, queued };
}

// ---- Webhook (system `trigger`): today's invitation, unchanged; then staffing and outreach when READY.
export function onTrigger(lib, actor, body, user) {
  const caller = user || (actor && typeof actor === 'object' ? actor : null);
  const name = typeof actor === 'string' ? actor : (caller?.email || 'system');
  if (caller?.tenantEnforced === true && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(caller.tenant || ''))) {
    throw fail(403, 'A verified tenant is required.');
  }
  const tenant = caller?.tenantEnforced === true ? String(caller.tenant || '').toLowerCase() : '';
  if (!READY) return lib.invite(name, { ...body, source: name, tenant });
  ensure(lib);
  const b = obj(body), pid = assignmentProject(b.projectId), who = email(b.email), mgr = email(b.managerEmail);
  const finish = () => {
    const inv = lib.invite(name, { ...body, source: name, tenant });
    if (['open', 'scheduled'].includes(inv.status)) queueInvite(lib, inv);
    return inv;
  };
  if (pid && who && mgr && mgr !== who) {
    const row = { projectId: pid, consultantEmail: who, managerEmail: mgr, managerName: str(b.managerName, 100), projectTitle: str(b.title, 140), endDate: isoDate(b.endDate), source: str(name, 60), tenant };
    const actor = { email: name, role: 'system', tenant, tenantEnforced: caller?.tenantEnforced === true };
    const write = () => {
      if (tenant && lib.bindTrust) applyStaffingAssignment(lib, actor, row);
      else reconcileStaffing(lib, row);
      lib.log('library', name, 'staffing updated', 'webhook: 1 row');
      return finish();
    };
    if (tenant && lib.bindTrust) return inTransaction(lib, write);
    return typeof lib.transactionSync === 'function' ? lib.transactionSync(write) : write();
  }
  return finish();
}

// Quote-aware CSV reader: quotes with "" escapes, commas and newlines inside quotes, CRLF/LF/CR, a leading BOM.
// Returns {header, rows: [{line, cells}], rejected: [{line, error}]}; line = 1-based line where the record starts.
// Blank records are skipped. An unterminated quote rejects the record it starts (and swallows the rest of the text).
export function parseCsv(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const records = [], rejected = [];
  let field = '', row = [], line = 1, start = 1, quoted = false, i = 0;
  const endRecord = () => { row.push(field); if (row.some(c => c.trim() !== '')) records.push({ line: start, cells: row }); row = []; field = ''; };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; } else { quoted = false; i++; } continue; }
      if (ch === '\r' && s[i + 1] === '\n') { field += '\r\n'; i += 2; line++; continue; }
      if (ch === '\n' || ch === '\r') line++;
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') { endRecord(); i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1; line++; start = line; continue; }
    field += ch; i++;
  }
  if (quoted) rejected.push({ line: start, error: 'Unterminated quote: this row and the rest of the file were not read.' });
  else if (field !== '' || row.length) endRecord();
  const [head, ...rows] = records;
  return { header: head ? head.cells : [], rows, rejected };
}

// ---- POST /staffing/import (admin, reviewer). Only the six named columns are ever read: any other column (and so
// any client, customer or account column) is dropped right after parsing and reported by name in ignoredColumns.
function importCsv(lib, user, body) {
  const csv = typeof obj(body).csv === 'string' ? body.csv : '';
  if (csv.length > MAX_CHARS) throw fail(413, 'The CSV is larger than 200,000 characters.');
  if (!csv.trim()) throw fail(400, 'Paste or upload the staffing CSV.');
  const p = parseCsv(csv);
  if (p.rows.length > MAX_ROWS) throw fail(413, 'At most 2,000 rows per import.');
  const names = p.header.map(h => String(h).trim().toLowerCase()), idx = Object.fromEntries(HEADER.map(h => [h, names.indexOf(h)]));
  const missing = HEADER.filter(h => idx[h] < 0);
  if (missing.length) throw fail(400, `The first row must be the header ${HEADER.join(',')} (missing: ${missing.join(', ')}).`);
  const used = new Set(Object.values(idx)), ignoredColumns = p.header.map((h, i) => used.has(i) ? null : (str(h, 80) || `column ${i + 1}`)).filter(Boolean);
  if (user.tenantEnforced === true && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(user.tenant || ''))) {
    throw fail(403, 'A verified tenant is required before a staffing import.');
  }
  const tenant = user.tenantEnforced === true ? String(user.tenant || '').toLowerCase() : '';
  const rejected = [...p.rejected], staffed = [];
  for (const r of p.rows) {
    const cell = h => String(r.cells[idx[h]] ?? '').trim();
    const projectId = str(cell('project_id'), 60), consultantEmail = email(cell('consultant_email')), mgrRaw = cell('manager_email'), managerEmail = email(mgrRaw), end = cell('end_date');
    const error = !projectId ? 'project_id is required.' : !consultantEmail ? 'consultant_email is not a valid email.' : mgrRaw && !managerEmail ? 'manager_email is not a valid email.'
      : managerEmail && managerEmail === consultantEmail ? 'The N+1 cannot be the consultant.' : end && !isoDate(end) ? 'end_date must be a real date written YYYY-MM-DD.' : '';
    if (error) { rejected.push({ line: r.line, error }); continue; }
    staffed.push({ line: r.line, projectId: assignmentProject(neutralizeFormula(projectId)), consultantEmail, managerEmail, managerName: managerEmail ? neutralizeFormula(str(cell('manager_name'), 100)) : '', projectTitle: neutralizeFormula(str(cell('project_title'), 140)), endDate: isoDate(end), source: 'staffing-csv', tenant });
  }
  ensure(lib);
  // Each CSV row is its own transaction. An earlier row that committed stays.
  // A failed row writes no staffing, trust, or invitation. The request is not one atomic unit.
  let trustSkipped = 0, invited = 0, queued = 0;
  const applied = [], blocked = [];
  const today = lib.now().slice(0, 10);
  const actor = { email: 'staffing-csv', role: 'system', tenant, tenantEnforced: user.tenantEnforced === true };
  for (const s of staffed) {
    const write = () => {
      if (s.managerEmail && tenant && lib.bindTrust) applyStaffingAssignment(lib, actor, s);
      else reconcileStaffing(lib, s);
      const due = inviteDue(lib, [s], today);
      lib.log('library', user.email, 'staffing updated', 'csv: 1 row');
      return due;
    };
    try {
      if (s.managerEmail && tenant && lib.bindTrust && typeof lib.transactionSync !== 'function') throw fail(503, 'Atomic staffing changes need storage.transactionSync.');
      const due = typeof lib.transactionSync === 'function' ? lib.transactionSync(write) : write();
      applied.push(s);
      invited += due.invited;
      queued += due.queued;
    } catch (error) {
      trustSkipped++;
      blocked.push({ line: s.line, projectId: s.projectId, error: error.message || 'The staffing row was not saved.' });
    }
  }
  // The summary is a request log. A blocked row does not change staffing, trust, invitations, or claims.
  lib.log('library', user.email, 'staffing import', `${applied.length} rows, ${rejected.length} rejected, ${invited} invited, ${blocked.length} blocked`);
  return { rows: p.rows.length, staffed: applied.length, invited, outreachQueued: queued, ignoredColumns, trustSkipped, blocked, rejected: rejected.sort((a, b) => a.line - b.line) };
}

function staffingPage(lib, user, { project = '', afterUpdatedAt = '', afterProjectId = '', afterConsultant = '' } = {}) {
  const enforced = user.tenantEnforced === true;
  const tenant = String(user.tenant || '').toLowerCase();
  if (enforced && !TENANT_ID.test(tenant)) return { status: 403, body: { error: 'A verified tenant is required.' } };
  const cursor = [afterUpdatedAt, afterProjectId, afterConsultant];
  if (cursor.some(Boolean) && cursor.some(v => !v)) return { status: 400, body: { error: 'The staffing page cursor is not valid.' } };
  if (afterUpdatedAt.length > 40 || afterProjectId.length > 80 || afterConsultant.length > 200) return { status: 400, body: { error: 'The staffing page cursor is not valid.' } };
  const where = ["lower(COALESCE(tenant, '')) = ?"], params = [tenant];
  if (project) { where.push('project_id = ? COLLATE NOCASE'); params.push(project); }
  if (afterUpdatedAt) {
    where.push('(updated_at < ? OR (updated_at = ? AND (project_id > ? OR (project_id = ? AND consultant_email > ?))))');
    params.push(afterUpdatedAt, afterUpdatedAt, afterProjectId, afterProjectId, afterConsultant);
  }
  const limit = 500;
  const rows = lib.rows(`SELECT * FROM staffing WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, project_id ASC, consultant_email ASC LIMIT ?`, ...params, limit + 1);
  const truncated = rows.length > limit, page = truncated ? rows.slice(0, limit) : rows, last = page.at(-1);
  return { body: { items: page.map(staffView), truncated, limit, next: truncated && last ? { afterUpdatedAt: last.updated_at, afterProjectId: last.project_id, afterConsultant: last.consultant_email } : null } };
}
const staffView = s => ({ projectId: s.project_id, consultantEmail: s.consultant_email, managerEmail: s.manager_email || '', managerName: s.manager_name || '',
  projectTitle: s.project_title || '', endDate: s.end_date || '', source: s.source || '', updatedAt: s.updated_at });

// ---- POST /outreach/:id (admin, reviewer). One action on one row; every result is audited (kind and channel only).
const inflight = new WeakMap(); // per Library instance: a Teams send in progress (the DO is the only writer)
function setStatus(lib, o, status, reason, user, extra = {}) {
  const approved = extra.approved ? [user.email, lib.now()] : [o.approved_by, o.approved_at];
  return lib.recorded(() => {
    lib.exec(`UPDATE outreach SET status = ?, reason = ?, approved_by = ?, approved_at = ?, sent_at = ?, activity_id = ?, aad_object_id = ?, directory_tenant = ?, conversation_id = ? WHERE id = ?`,
      status, reason, approved[0] ?? null, approved[1] ?? null, extra.sentAt ?? o.sent_at ?? null, extra.activityId ?? o.activity_id ?? null, extra.aadObjectId ?? o.aad_object_id ?? null, extra.directoryTenant ?? o.directory_tenant ?? '', extra.conversationId ?? o.conversation_id ?? '', o.id);
    lib.log(o.id, user.email, 'outreach ' + status, `${o.kind} ${o.channel}`);
    return view(rowOf(lib, o.id));
  });
}

function subjectOpen(lib, o) {
  if (o.kind === 'interview_invite') return ['open', 'scheduled'].includes(lib.rows('SELECT status FROM invitations WHERE id = ?', o.subject_id)[0]?.status);
  if (o.kind === 'confirmation_request') { claims.ensure(lib); const r = lib.rows('SELECT status, expires_at FROM confirmation_requests WHERE id = ?', o.subject_id)[0]; return !!r && r.status === 'open' && r.expires_at > lib.now(); }
  gaps.ensure(lib);
  return lib.rows('SELECT status FROM gap_requests WHERE id = ?', o.subject_id)[0]?.status === 'open';
}

const ics = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function emailDraft(lib, o, origin) {
  const p = parsed(o.payload), pv = obj(p.preview), link = origin + (p.path || PATH[o.kind](o.subject_id)), subject = p.subject || SUBJECT[o.kind];
  const body = o.kind === 'confirmation_request' ? link
    : o.kind === 'interview_invite' ? `A short ATLAS interview about ${pv.title || 'your recent project'} is ready (about 12 minutes).\n\nStart it here: ${link}`
      : `${pv.text || 'A bid team asks for 5 minutes of proof.'}\n\nOpen it here: ${link}`;
  const draft = { to: o.to_email, subject, body };
  const slot = o.kind === 'interview_invite' ? String(lib.rows('SELECT slot FROM invitations WHERE id = ?', o.subject_id)[0]?.slot || '') : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(slot);
  if (m) {
    const stamp = lib.now().replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 15) + 'Z';
    draft.ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ATLAS//Interview//EN', 'BEGIN:VEVENT', `UID:${o.id}@atlas`, `DTSTAMP:${stamp}`,
      `DTSTART:${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00`, 'DURATION:PT15M', `SUMMARY:${ics(subject)}`, `DESCRIPTION:${ics(link)}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  }
  return draft;
}

function activityFor(o, origin, approver) {
  const p = parsed(o.payload), pv = obj(p.preview);
  const card = o.kind === 'interview_invite'
    ? interviewCard({ invitationId: o.subject_id, outreachId: o.id, projectRef: pv.title, approverName: approver, origin })
    : messageCard({ title: p.subject || SUBJECT[o.kind], text: pv.text, url: origin + (p.path || PATH[o.kind](o.subject_id)), label: 'Open ATLAS' });
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] };
}

const SENDING = 'This message is already sending. It stays sending until a reviewer releases it.';
// Claim the row before the network call. A later mark that rolls back leaves status 'sending'
// and the same idempotency key. A retry sees that status and does not send again.
function claimSend(lib, o, user) {
  const key = lib.newId();
  return lib.recorded(() => {
    const cur = rowOf(lib, o.id);
    if (!cur || !ACTIONABLE.has(cur.status)) {
      const status = String(cur?.status || '');
      throw fail(409, status === 'sending' ? SENDING : `This item is already ${status.replace(/_/g, ' ')}.`);
    }
    lib.exec("UPDATE outreach SET status = 'sending', reason = '', idempotency_key = ? WHERE id = ? AND status = ?", key, o.id, cur.status);
    const claimed = rowOf(lib, o.id);
    if (!claimed || claimed.status !== 'sending' || claimed.idempotency_key !== key) throw fail(409, SENDING);
    lib.log(o.id, user.email, 'outreach sending', `${o.kind} ${o.channel}`);
    return claimed;
  });
}
async function sendTeams(ctx, o) {
  const { lib, user } = ctx, teams = lib.services?.teams;
  if (!teams) return setStatus(lib, o, 'blocked_external', REASONS.teamsOff, user, { approved: true });
  // The conversation tenant_id is the Teams directory. o.tenant is the ATLAS tenant.
  // One active conversation with one directory id is the allowed mapping. Equality of the
  // two namespaces is not required. Several directories, or none, is refused.
  const convs = lib.rows('SELECT * FROM teams_conversations WHERE email = ? ORDER BY updated_at DESC', o.to_email);
  const active = convs.filter(c => c.status === 'active' && guid(c.tenant_id) && guid(c.aad_object_id) && c.conversation_id && /^https:/.test(String(c.service_url || '')));
  const directories = new Set(active.map(c => String(c.tenant_id).toLowerCase()));
  const conv = active.length === 1 && directories.size === 1 ? active[0] : null;
  if (!conv) return setStatus(lib, o, 'blocked_external', convs.some(c => c.status === 'stopped') ? REASONS.stopped : REASONS.notInstalled, user, { approved: true });
  const busy = inflight.get(lib) || new Set();
  if (busy.has(o.id)) throw fail(409, 'This item is being sent.');
  busy.add(o.id); inflight.set(lib, busy);
  try {
    claimSend(lib, o, user);
    let sent;
    try {
      sent = await teams.send({ serviceUrl: conv.service_url, conversationId: conv.conversation_id, tenantId: conv.tenant_id, aadObjectId: conv.aad_object_id },
        activityFor(o, originOf(ctx), user.email));
    } catch (e) {
      if (e?.status === 403 && /MessageWritesBlocked/i.test(`${e.code || ''} ${e.message || ''}`)) {
        return lib.recorded(() => {
          lib.exec("UPDATE teams_conversations SET status = 'stopped', updated_at = ? WHERE subject = ?", lib.now(), conv.subject);
          lib.exec('UPDATE outreach SET status = ?, reason = ?, approved_by = ?, approved_at = ? WHERE id = ?', 'failed', REASONS.blocked, user.email, lib.now(), o.id);
          lib.log(o.id, user.email, 'outreach failed', `${o.kind} ${o.channel}`);
          return view(rowOf(lib, o.id));
        });
      }
      return setStatus(lib, rowOf(lib, o.id), 'failed', `Teams did not accept the message (${e?.status ? 'HTTP ' + e.status : 'no answer'}).`, user, { approved: true });
    }
    return setStatus(lib, rowOf(lib, o.id), 'sent', '', user, { approved: true, sentAt: lib.now(), activityId: str(sent?.id, 200) || null, aadObjectId: conv.aad_object_id, directoryTenant: conv.tenant_id, conversationId: conv.conversation_id });
  } finally { busy.delete(o.id); }
}

function sameOutreachTenant(row, user) {
  return String(row?.tenant || '').toLowerCase() === String(user?.tenant || '').toLowerCase();
}
async function act(ctx, id) {
  const { lib, user } = ctx, action = obj(ctx.body).action;
  if (user?.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
  if (!['approve', 'dismiss', 'release'].includes(action)) throw fail(400, "action must be 'approve', 'dismiss' or 'release'.");
  const o = rowOf(lib, str(id, 64));
  if (!o || !sameOutreachTenant(o, user)) throw fail(404, 'Outreach item not found.');
  if (inflight.get(lib)?.has(o.id)) throw fail(409, 'This item is being sent.');
  if (o.status === 'sending') {
    if (action !== 'release') throw fail(409, SENDING);
    return { item: setStatus(lib, o, 'failed', 'A reviewer released a send that did not finish.', user) };
  }
  if (action === 'release') throw fail(409, 'This item is not sending.');
  // An approved email draft lives only in the approver's page: approving it again returns the same draft while its
  // subject is open. The row keeps its status and first approver; the audit gets one more `outreach drafted` row.
  if (action === 'approve' && o.status === 'drafted' && o.channel === 'email_draft') {
    if (!subjectOpen(lib, o)) throw fail(409, REASONS.closed);
    lib.log(o.id, user.email, 'outreach drafted', `${o.kind} ${o.channel}`);
    return { item: view(o), draft: emailDraft(lib, o, originOf(ctx)) };
  }
  if (!ACTIONABLE.has(o.status)) throw fail(409, `This item is already ${String(o.status).replace(/_/g, ' ')}.`);
  if (action === 'dismiss') return { item: setStatus(lib, o, 'dismissed', '', user) };
  if (!subjectOpen(lib, o)) return { item: setStatus(lib, o, 'dismissed', REASONS.closed, user) };
  if (o.channel === 'email_draft') { const draft = emailDraft(lib, o, originOf(ctx)); return { item: setStatus(lib, o, 'drafted', '', user, { approved: true }), draft }; }
  if (o.channel === 'teams') return { item: await sendTeams(ctx, o) };
  return { item: setStatus(lib, o, 'blocked_external', REASONS.phone, user, { approved: true }) };
}

// Words `outreach` and `staffing` (admin and reviewer only).
export async function routes(ctx) {
  const { parts, method, user, lib } = ctx, [word, a, b] = parts, q = k => ctx.url?.searchParams?.get(k) || '';
  if (!REVIEWERS.includes(user.role)) return { status: 403, body: { error: 'Outreach and staffing are for reviewers.' } };
  // Tenant rejection happens before ensure(). ensure() is schema initialization for an authorized caller.
  // A rejected caller does not create the outreach tables. An authorized caller still does.
  if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) return { status: 403, body: { error: 'A verified tenant is required.' } };
  ensure(lib);
  if (word === 'staffing') {
    if (method === 'POST' && a === 'import' && !b) return { body: importCsv(lib, user, ctx.body) };
    if (method === 'GET' && !a) return staffingPage(lib, user, { project: str(q('project'), 60), afterUpdatedAt: q('afterUpdatedAt'), afterProjectId: q('afterProjectId'), afterConsultant: q('afterConsultant') });
  } else if (word === 'outreach') {
    if (method === 'GET' && !a) {
      if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) return { status: 403, body: { error: 'A verified tenant is required.' } };
      const tenant = String(user.tenant || '').toLowerCase();
      const st = q('status');
      const where = ["lower(COALESCE(tenant, '')) = ?"], args = [tenant];
      if (STATUSES.includes(st)) { where.push('status = ?'); args.push(st); }
      const rows = lib.rows(`SELECT * FROM outreach WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id ASC LIMIT 201`, ...args);
      const truncated = rows.length > 200, page = truncated ? rows.slice(0, 200) : rows;
      return { body: { items: page.map(view), truncated, channels: { teams: lib.services?.teams ? 'connected' : 'BLOCKED_EXTERNAL', email_draft: 'available', phone: 'BLOCKED_EXTERNAL' } } };
    }
    if (method === 'POST' && a && !b) return { body: await act(ctx, a) };
  }
  return { status: 404, body: { error: 'Not found.' } };
}

// ---- Daily sweep (system `scan-stale`): expiries always run; staffing due dates and the Teams dedupe prune when READY.
// Returns only the counts that are non-zero, so a quiet day adds nothing to the cron response. It never sends.
export function daily(lib, user = {}) {
  const now = lib.now(), gapsExpired = gaps.expire(lib, now, user), claimsExpired = claims.expire(lib, now, user);
  if (!READY) return {};
  ensure(lib);
  const today = now.slice(0, 10);
  const scoped = String(user.tenant || '').toLowerCase();
  if (user.tenantEnforced === true && !TENANT_ID.test(scoped)) return { maintenanceRefused: 'A verified tenant is required.' };
  const due = (user.tenantEnforced === true
    ? lib.rows("SELECT * FROM staffing WHERE lower(tenant) = ? AND end_date != '' AND end_date <= ? AND end_date >= ?", scoped, addDays(today, DUE_AHEAD_DAYS), addDays(today, -DUE_BACK_DAYS))
    : lib.rows("SELECT * FROM staffing WHERE lower(COALESCE(tenant, '')) = '' AND end_date != '' AND end_date <= ? AND end_date >= ?", addDays(today, DUE_AHEAD_DAYS), addDays(today, -DUE_BACK_DAYS)))
    .map(s => ({ projectId: s.project_id, consultantEmail: s.consultant_email, projectTitle: s.project_title || '', endDate: s.end_date, source: s.source || 'staffing', tenant: user.tenantEnforced === true ? scoped : '' }));
  const { invited, queued } = inviteDue(lib, due, today);
  const cutoff = new Date(Date.parse(now) - SEEN_KEEP_MS).toISOString(), pruned = lib.rows('SELECT COUNT(*) AS n FROM teams_seen WHERE at < ?', cutoff)[0].n;
  if (pruned) lib.housekeeping('teams-seen', () => lib.exec('DELETE FROM teams_seen WHERE at < ?', cutoff));
  return Object.fromEntries(Object.entries({ gapsExpired, claimsExpired, staffingInvited: invited, outreachQueued: queued, teamsSeenPruned: pruned }).filter(([, n]) => n));
}

// The seen row and the audit line commit together. A 503 from lib.log rolls both back.
function recorded(lib, fn) {
  if (typeof lib.transactionSync !== 'function') throw fail(500, 'The Teams event was not recorded.');
  return lib.transactionSync(fn);
}
// ---- System word `teams-event` (from the Worker's verified bot endpoint only; user `teams-bot`, role `system`).
const guid = v => { const s = uuidish(v); return s.includes('-') ? s : ''; };
const OTHERS_CARD = () => messageCard({ title: 'This card belongs to someone else.', text: 'Nothing was changed.' });
function teamsActionBound(lib, user, event) {
  const o = rowOf(lib, str(event.outreachId, 64));
  const inv = o?.kind === 'interview_invite' ? lib.rows('SELECT tenant FROM invitations WHERE id = ?', o.subject_id)[0] : null;
  if (!o || !inv) return false;
  const outreachTenant = String(o.tenant || '').toLowerCase();
  const inviteTenant = String(inv.tenant || '').toLowerCase();
  if (outreachTenant !== inviteTenant) return false;
  if (user?.tenantEnforced === true && outreachTenant !== String(user.tenant || '').toLowerCase()) return false;
  return true;
}
function teamsActorBound(lib, user, event, tid, oid) {
  if (!teamsActionBound(lib, user, event)) return false;
  const o = rowOf(lib, str(event.outreachId, 64));
  const destination = String(o?.directory_tenant || '').toLowerCase();
  const conversation = String(o?.conversation_id || '');
  const eventConversation = String(event?.conversationId || '');
  return !!(o && o.channel === 'teams' && o.status === 'sent' && o.aad_object_id === oid && destination && conversation && eventConversation
    && destination === String(tid).toLowerCase() && conversation === eventConversation
    && lib.rows('SELECT 1 AS ok FROM teams_conversations WHERE aad_object_id = ? AND lower(tenant_id) = ? AND conversation_id = ?', oid, destination, conversation)[0]);
}
export async function system(ctx) {
  const { lib } = ctx, e = obj(ctx.body), kind = e.kind, activityId = str(e.activityId, 256);
  if (!['install', 'uninstall', 'stop', 'action'].includes(kind) || !activityId) throw fail(400, 'Unknown Teams event.');
  const tid = guid(e.tenantId), oid = guid(e.aadObjectId);
  if (!tid || !oid) throw fail(400, 'A Teams event needs the tenant and the user object id.');
  let service = '';
  try { const u = new URL(String(e.serviceUrl || '')); service = u.protocol === 'https:' ? u.href : ''; } catch { service = ''; }
  const conversationId = str(e.conversationId, 512);
  if (kind === 'install' && (!service || !conversationId)) throw fail(400, 'An install event needs the conversation and its service URL.');
  const user = ctx.user || {};
  if (user.tenantEnforced === true && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
  ensure(lib);
  const now = lib.now();
  if (kind === 'action') {
    if (!teamsActorBound(lib, user, e, tid, oid)) return { body: { ok: true, card: OTHERS_CARD() } };
    if (lib.rows('SELECT 1 AS seen FROM teams_seen WHERE activity_id = ?', activityId)[0]) return { body: { ok: true, duplicate: true } };
    const o = rowOf(lib, str(e.outreachId, 64));
    const inv = o?.kind === 'interview_invite' ? lib.rows('SELECT * FROM invitations WHERE id = ?', o.subject_id)[0] : null;
    if (!inv || !['snooze', 'decline'].includes(e.verb)) return { body: { ok: true, card: messageCard({ title: 'Nothing to change.', text: 'Open ATLAS to see your interviews.' }) } };
    const inviteEvent = e.verb === 'decline' ? 'dismiss' : 'schedule';
    const step = noteInvitation(invitationTransition({ id: inv.id, status: inv.status }, { type: inviteEvent }));
    if (!step.ok) return { body: { ok: true, card: messageCard({ title: 'This invitation is closed.', text: 'Nothing was changed.' }) } };
    const viewer = { email: String(inv.email || '').toLowerCase(), mail: String(inv.email || '').toLowerCase(), role: 'user', tenant: String(inv.tenant || ''), tenantEnforced: user.tenantEnforced === true };
    const linked = inv.reference_id && lib.row ? lib.row(inv.reference_id) : null;
    const storyOpen = !!(linked && lib.access && lib.access(linked, viewer));
    const hiddenRef = !!inv.reference_id && !storyOpen;
    if (hiddenRef && e.verb !== 'decline') return { body: { ok: true, card: messageCard({ title: 'Nothing was changed.', text: 'This invitation can only be declined from here.' }) } };
    const auditOn = storyOpen && typeof lib.auditFor === 'function' ? lib.auditFor(viewer, inv.reference_id, inv.tenant) : 'library';
    const p = parsed(o.payload), origin = originOf(ctx);
    let slot = '';
    if (e.verb !== 'decline') {
      const base = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(inv.slot || '') ? inv.slot.slice(0, 16) : now.slice(0, 16);
      slot = new Date(Date.parse(base + ':00Z') + 864e5).toISOString().slice(0, 16);
    }
    try {
      return recorded(lib, () => {
        lib.exec('INSERT OR IGNORE INTO teams_seen (activity_id, at) VALUES (?, ?)', activityId, now);
        if (e.verb === 'decline') lib.exec(`UPDATE invitations SET status = 'dismissed' WHERE id = ? AND ${OPEN_INVITATION_SQL}`, inv.id);
        else lib.exec(`UPDATE invitations SET slot = ?, status = 'scheduled' WHERE id = ? AND ${OPEN_INVITATION_SQL}`, slot, inv.id);
        if (Number(lib.rows('SELECT changes() AS n')[0]?.n || 0) !== 1) {
          const closed = fail(409, INVITATION_REFUSAL);
          closed.code = INVITATION_CLOSED;
          throw closed;
        }
        if (e.verb === 'decline') {
          lib.log(hiddenRef ? 'library' : auditOn, inv.email, 'invitation dismiss', `${inv.reason} (Teams card)`);
          return { body: { ok: true, card: messageCard({ title: 'Understood: no interview for this project.', text: 'Nothing else will be sent about it.' }) } };
        }
        lib.log(auditOn, inv.email, 'invitation schedule', `${inv.reason} (Teams card: tomorrow)`);
        return { body: { ok: true, card: interviewCard({ invitationId: inv.id, outreachId: o.id, projectRef: obj(p.preview).title, origin, note: 'Moved to tomorrow. Start whenever it suits you.' }) } };
      });
    } catch (err) {
      if (err?.code !== INVITATION_CLOSED) throw err;
      noteInvitation({ rejection: { id: inv.id, phase: inv.status, event: inviteEvent } });
      return { body: { ok: true, card: messageCard({ title: 'This invitation is closed.', text: 'Nothing was changed.' }) } };
    }
  }
  if (lib.rows('SELECT 1 AS seen FROM teams_seen WHERE activity_id = ?', activityId)[0]) return { body: { ok: true, duplicate: true } };
  const subject = `${tid}:${oid}`;
  return recorded(lib, () => {
    lib.exec('INSERT OR IGNORE INTO teams_seen (activity_id, at) VALUES (?, ?)', activityId, now);
    if (kind === 'install') {
      lib.exec(`INSERT INTO teams_conversations (subject, aad_object_id, tenant_id, teams_user_id, conversation_id, service_url, email, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?) ON CONFLICT (subject) DO UPDATE SET aad_object_id = excluded.aad_object_id, tenant_id = excluded.tenant_id,
        teams_user_id = excluded.teams_user_id, conversation_id = excluded.conversation_id, service_url = excluded.service_url,
        email = CASE WHEN excluded.email != '' THEN excluded.email ELSE teams_conversations.email END, status = 'active', updated_at = excluded.updated_at`,
      subject, oid, tid, str(e.teamsUserId, 256), conversationId, service, email(e.email), now);
      lib.log('teams', 'teams-bot', 'teams install', 'personal scope');
      return { body: { ok: true } };
    }
    if (kind === 'uninstall' || kind === 'stop') {
      lib.exec('UPDATE teams_conversations SET status = ?, updated_at = ? WHERE subject = ?', kind === 'stop' ? 'stopped' : 'uninstalled', now, subject);
      lib.log('teams', 'teams-bot', 'teams ' + kind, 'personal scope');
      return { body: { ok: true } };
    }
    throw fail(400, 'Unknown Teams event.');
  });
}
