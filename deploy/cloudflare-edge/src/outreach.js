// F4 "Zero-effort capture" (WOW_SPEC §F4): the outreach approval queue, the staffing import, the daily sweep and the
// Teams events the Worker forwards (system word `teams-event`). Words `outreach` and `staffing` are for reviewers.
// NOTHING IS AUTO-SENT: webhooks, imports and the cron only create PENDING rows. A row leaves ATLAS only when an admin
// or reviewer approves that exact row: an email becomes a draft the approver sends from their own mail client, a
// Teams card is sent only through a connected client (BLOCKED_EXTERNAL in this build), phone is always blocked.
// Previews, cards and audit rows never carry client names (record masking; audit = kind and channel only).
import { str, email, obj, fail, uuidish } from './util.js';
import { recordText, forOthers } from './scrub.js';
import * as claims from './claims.js';
import * as gaps from './gaps.js';
import { interviewCard, messageCard } from './teams.js';

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
const DDL = [
  `CREATE TABLE IF NOT EXISTS staffing (project_id TEXT, consultant_email TEXT, manager_email TEXT, manager_name TEXT, project_title TEXT,
    end_date TEXT, source TEXT, updated_at TEXT, PRIMARY KEY (project_id, consultant_email))`,
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
  for (const q of DDL) lib.sql.exec(q);
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
  const it = obj(item), kind = it.kind, subjectId = str(it.subjectId, 64), to = email(it.toEmail);
  if (!KINDS.includes(kind) || !subjectId || !to) throw fail(400, 'An outreach item needs a kind, a subject and an email.');
  const clean = (s, n) => forOthers(recordText(lib)(str(s, n)));
  const p = obj(it.preview), payload = JSON.stringify({ preview: { title: clean(p.title, 140), text: clean(p.text, 300) }, subject: clean(it.subject, 200) || SUBJECT[kind], path: PATH[kind](subjectId) });
  const rows = [];
  let created = 0;
  for (const channel of QUEUED) {
    if (!lib.rows('SELECT id FROM outreach WHERE kind = ? AND subject_id = ? AND channel = ?', kind, subjectId, channel)[0]) {
      const id = lib.newId();
      lib.sql.exec(`INSERT OR IGNORE INTO outreach (id, kind, subject_id, channel, to_email, status, reason, payload, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending_approval', '', ?, ?)`, id, kind, subjectId, channel, to, payload, lib.now());
      lib.log(id, 'atlas', 'outreach pending_approval', `${kind} ${channel}`);
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
  return queueRows(lib, { kind: 'interview_invite', subjectId: inv.id, toEmail: inv.email, subject: SUBJECT.interview_invite,
    preview: { title: ref, text: `12 minutes while it's fresh? A short interview about ${ref} (${REASON_LABEL[inv.reason] || 'interview request'}).` } });
}

function upsertStaffing(lib, s) {
  lib.sql.exec(`INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, consultant_email) DO UPDATE SET
    manager_email = CASE WHEN excluded.manager_email != '' THEN excluded.manager_email ELSE staffing.manager_email END,
    manager_name = CASE WHEN excluded.manager_email != '' THEN excluded.manager_name ELSE staffing.manager_name END,
    project_title = CASE WHEN excluded.project_title != '' THEN excluded.project_title ELSE staffing.project_title END,
    end_date = CASE WHEN excluded.end_date != '' THEN excluded.end_date ELSE staffing.end_date END,
    source = excluded.source, updated_at = excluded.updated_at`,
  s.projectId, s.consultantEmail, s.managerEmail, s.managerName, s.projectTitle, s.endDate, s.source, lib.now());
}

// Due staffing rows (end date within [today - 30, today + 7]) with no reference yet for (project, consultant) and no
// earlier project_end invitation (any status, so a dismissed invitation is never re-created) get one invitation plus
// pending outreach rows.
function inviteDue(lib, rows, today) {
  const ahead = addDays(today, DUE_AHEAD_DAYS), back = addDays(today, -DUE_BACK_DAYS);
  let invited = 0, queued = 0;
  for (const s of rows) {
    if (!s.endDate || s.endDate > ahead || s.endDate < back) continue;
    const hasRef = lib.rows(`SELECT id FROM refs WHERE merged_into IS NULL AND (owner = ? OR instr(members, ?) > 0)
      AND json_extract(data, '$.details.projectId') = ? COLLATE NOCASE LIMIT 1`, s.consultantEmail, ',' + s.consultantEmail + ',', s.projectId)[0];
    if (hasRef || lib.rows("SELECT id FROM invitations WHERE email = ? AND project_id = ? AND reason = 'project_end' LIMIT 1", s.consultantEmail, s.projectId)[0]) continue;
    const inv = lib.invite(s.source, { email: s.consultantEmail, reason: 'project_end', projectId: s.projectId, title: s.projectTitle, source: s.source });
    invited++;
    queued += queueInvite(lib, inv).created;
  }
  return { invited, queued };
}

// ---- Webhook (system `trigger`): today's invitation, unchanged; then staffing and outreach when READY.
export function onTrigger(lib, actor, body) {
  const inv = lib.invite(actor, { ...body, source: actor });
  if (!READY) return inv;
  ensure(lib);
  const b = obj(body), pid = str(b.projectId, 60), who = email(b.email), mgr = email(b.managerEmail);
  if (pid && who && mgr && mgr !== who) {
    upsertStaffing(lib, { projectId: pid, consultantEmail: who, managerEmail: mgr, managerName: str(b.managerName, 100), projectTitle: str(b.title, 140), endDate: isoDate(b.endDate), source: str(actor, 60) });
    lib.log('library', actor, 'staffing updated', 'webhook: 1 row');
  }
  if (['open', 'scheduled'].includes(inv.status)) queueInvite(lib, inv);
  return inv;
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
  const rejected = [...p.rejected], staffed = [];
  for (const r of p.rows) {
    const cell = h => String(r.cells[idx[h]] ?? '').trim();
    const projectId = str(cell('project_id'), 60), consultantEmail = email(cell('consultant_email')), mgrRaw = cell('manager_email'), managerEmail = email(mgrRaw), end = cell('end_date');
    const error = !projectId ? 'project_id is required.' : !consultantEmail ? 'consultant_email is not a valid email.' : mgrRaw && !managerEmail ? 'manager_email is not a valid email.'
      : managerEmail && managerEmail === consultantEmail ? 'The N+1 cannot be the consultant.' : end && !isoDate(end) ? 'end_date must be a real date written YYYY-MM-DD.' : '';
    if (error) { rejected.push({ line: r.line, error }); continue; }
    staffed.push({ projectId, consultantEmail, managerEmail, managerName: managerEmail ? str(cell('manager_name'), 100) : '', projectTitle: str(cell('project_title'), 140), endDate: isoDate(end), source: 'staffing-csv' });
  }
  for (const s of staffed) upsertStaffing(lib, s);
  const { invited, queued } = inviteDue(lib, staffed, lib.now().slice(0, 10));
  lib.log('library', user.email, 'staffing import', `${staffed.length} rows, ${rejected.length} rejected, ${invited} invited`);
  return { rows: p.rows.length, staffed: staffed.length, invited, outreachQueued: queued, ignoredColumns, rejected: rejected.sort((a, b) => a.line - b.line) };
}

const staffView = s => ({ projectId: s.project_id, consultantEmail: s.consultant_email, managerEmail: s.manager_email || '', managerName: s.manager_name || '',
  projectTitle: s.project_title || '', endDate: s.end_date || '', source: s.source || '', updatedAt: s.updated_at });

// ---- POST /outreach/:id (admin, reviewer). One action on one row; every result is audited (kind and channel only).
const inflight = new WeakMap(); // per Library instance: a Teams send in progress (the DO is the only writer)
function setStatus(lib, o, status, reason, user, extra = {}) {
  const approved = extra.approved ? [user.email, lib.now()] : [o.approved_by, o.approved_at];
  lib.sql.exec(`UPDATE outreach SET status = ?, reason = ?, approved_by = ?, approved_at = ?, sent_at = ?, activity_id = ?, aad_object_id = ? WHERE id = ?`,
    status, reason, approved[0] ?? null, approved[1] ?? null, extra.sentAt ?? o.sent_at ?? null, extra.activityId ?? o.activity_id ?? null, extra.aadObjectId ?? o.aad_object_id ?? null, o.id);
  lib.log(o.id, user.email, 'outreach ' + status, `${o.kind} ${o.channel}`);
  return view(rowOf(lib, o.id));
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

async function sendTeams(ctx, o) {
  const { lib, user } = ctx, teams = lib.services?.teams;
  if (!teams) return setStatus(lib, o, 'blocked_external', REASONS.teamsOff, user, { approved: true });
  const convs = lib.rows('SELECT * FROM teams_conversations WHERE email = ? ORDER BY updated_at DESC', o.to_email);
  const conv = convs.find(c => c.status === 'active');
  if (!conv) return setStatus(lib, o, 'blocked_external', convs.some(c => c.status === 'stopped') ? REASONS.stopped : REASONS.notInstalled, user, { approved: true });
  const busy = inflight.get(lib) || new Set();
  if (busy.has(o.id)) throw fail(409, 'This item is being sent.');
  busy.add(o.id); inflight.set(lib, busy);
  try {
    const sent = await teams.send({ serviceUrl: conv.service_url, conversationId: conv.conversation_id, tenantId: conv.tenant_id, aadObjectId: conv.aad_object_id },
      activityFor(o, originOf(ctx), user.email));
    return setStatus(lib, rowOf(lib, o.id), 'sent', '', user, { approved: true, sentAt: lib.now(), activityId: str(sent?.id, 200) || null, aadObjectId: conv.aad_object_id });
  } catch (e) {
    if (e?.status === 403 && /MessageWritesBlocked/i.test(`${e.code || ''} ${e.message || ''}`)) {
      lib.sql.exec("UPDATE teams_conversations SET status = 'stopped', updated_at = ? WHERE subject = ?", lib.now(), conv.subject);
      return setStatus(lib, rowOf(lib, o.id), 'failed', REASONS.blocked, user, { approved: true });
    }
    return setStatus(lib, rowOf(lib, o.id), 'failed', `Teams did not accept the message (${e?.status ? 'HTTP ' + e.status : 'no answer'}).`, user, { approved: true });
  } finally { busy.delete(o.id); }
}

async function act(ctx, id) {
  const { lib, user } = ctx, action = obj(ctx.body).action;
  if (action !== 'approve' && action !== 'dismiss') throw fail(400, "action must be 'approve' or 'dismiss'.");
  const o = rowOf(lib, str(id, 64));
  if (!o) throw fail(404, 'Outreach item not found.');
  if (inflight.get(lib)?.has(o.id)) throw fail(409, 'This item is being sent.');
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

// W1: the person's OWN staffing rows, for the project picker ("Which project?"). Only rows whose consultant is the signed-in person, only what the picker shows (the project, its
// title, the end date, the N+1 of record); never another person's row, never the client columns (they are not stored). Everyone may read their own; a reviewer's full list is below.
const mineView = s => ({ projectId: s.project_id, projectTitle: s.project_title || '', endDate: s.end_date || '', managerName: s.manager_name || '', managerEmail: s.manager_email || '' });
function mine(lib, user) {
  const who = String(user.mail || user.email || '').trim().toLowerCase();
  if (!who || !who.includes('@')) return { items: [] };
  ensure(lib);
  return { items: lib.rows(`SELECT * FROM staffing WHERE consultant_email = ? COLLATE NOCASE ORDER BY CASE WHEN end_date = '' THEN 1 ELSE 0 END, end_date DESC, project_id LIMIT 50`, who).map(mineView) };
}

// Words `outreach` and `staffing` (admin and reviewer only, except staffing/mine: the person's own rows).
export async function routes(ctx) {
  const { parts, method, user, lib } = ctx, [word, a, b] = parts, q = k => ctx.url?.searchParams?.get(k) || '';
  if (word === 'staffing' && method === 'GET' && a === 'mine' && !b && user.role !== 'system') return { body: mine(lib, user) };
  if (!REVIEWERS.includes(user.role)) return { status: 403, body: { error: 'Outreach and staffing are for reviewers.' } };
  ensure(lib);
  if (word === 'staffing') {
    if (method === 'POST' && a === 'import' && !b) return { body: importCsv(lib, user, ctx.body) };
    if (method === 'GET' && !a) {
      const pid = str(q('project'), 60);
      return { body: { items: (pid ? lib.rows('SELECT * FROM staffing WHERE project_id = ? COLLATE NOCASE ORDER BY consultant_email', pid)
        : lib.rows('SELECT * FROM staffing ORDER BY updated_at DESC, project_id LIMIT 500')).map(staffView) } };
    }
  } else if (word === 'outreach') {
    if (method === 'GET' && !a) {
      const st = q('status'), items = (STATUSES.includes(st) ? lib.rows('SELECT * FROM outreach WHERE status = ? ORDER BY created_at DESC LIMIT 200', st)
        : lib.rows('SELECT * FROM outreach ORDER BY created_at DESC LIMIT 200')).map(view);
      return { body: { items, channels: { teams: lib.services?.teams ? 'connected' : 'BLOCKED_EXTERNAL', email_draft: 'available', phone: 'BLOCKED_EXTERNAL' } } };
    }
    if (method === 'POST' && a && !b) return { body: await act(ctx, a) };
  }
  return { status: 404, body: { error: 'Not found.' } };
}

// ---- Daily sweep (system `scan-stale`): expiries always run; staffing due dates and the Teams dedupe prune when READY.
// Returns only the counts that are non-zero, so a quiet day adds nothing to the cron response. It never sends.
export function daily(lib) {
  const now = lib.now(), gapsExpired = gaps.expire(lib, now), claimsExpired = claims.expire(lib, now);
  if (!READY) return {};
  ensure(lib);
  const today = now.slice(0, 10);
  const due = lib.rows("SELECT * FROM staffing WHERE end_date != '' AND end_date <= ? AND end_date >= ?", addDays(today, DUE_AHEAD_DAYS), addDays(today, -DUE_BACK_DAYS))
    .map(s => ({ projectId: s.project_id, consultantEmail: s.consultant_email, projectTitle: s.project_title || '', endDate: s.end_date, source: s.source || 'staffing' }));
  const { invited, queued } = inviteDue(lib, due, today);
  const cutoff = new Date(Date.parse(now) - SEEN_KEEP_MS).toISOString(), pruned = lib.rows('SELECT COUNT(*) AS n FROM teams_seen WHERE at < ?', cutoff)[0].n;
  if (pruned) lib.sql.exec('DELETE FROM teams_seen WHERE at < ?', cutoff);
  return Object.fromEntries(Object.entries({ gapsExpired, claimsExpired, staffingInvited: invited, outreachQueued: queued, teamsSeenPruned: pruned }).filter(([, n]) => n));
}

// ---- System word `teams-event` (from the Worker's verified bot endpoint only; user `teams-bot`, role `system`).
const guid = v => { const s = uuidish(v); return s.includes('-') ? s : ''; };
const OTHERS_CARD = () => messageCard({ title: 'This card belongs to someone else.', text: 'Nothing was changed.' });
export async function system(ctx) {
  const { lib } = ctx, e = obj(ctx.body), kind = e.kind, activityId = str(e.activityId, 256);
  if (!['install', 'uninstall', 'stop', 'action'].includes(kind) || !activityId) throw fail(400, 'Unknown Teams event.');
  const tid = guid(e.tenantId), oid = guid(e.aadObjectId);
  if (!tid || !oid) throw fail(400, 'A Teams event needs the tenant and the user object id.');
  let service = '';
  try { const u = new URL(String(e.serviceUrl || '')); service = u.protocol === 'https:' ? u.href : ''; } catch { service = ''; }
  const conversationId = str(e.conversationId, 512);
  if (kind === 'install' && (!service || !conversationId)) throw fail(400, 'An install event needs the conversation and its service URL.');
  ensure(lib);
  // Dedupe here, in the LibraryStore (the one writer): a repeated activity id changes nothing. Validation comes first,
  // so a rejected event is never marked as seen.
  if (lib.rows('SELECT 1 AS seen FROM teams_seen WHERE activity_id = ?', activityId)[0]) return { body: { ok: true, duplicate: true } };
  lib.sql.exec('INSERT OR IGNORE INTO teams_seen (activity_id, at) VALUES (?, ?)', activityId, lib.now());
  const subject = `${tid}:${oid}`, now = lib.now();
  if (kind === 'install') {
    lib.sql.exec(`INSERT INTO teams_conversations (subject, aad_object_id, tenant_id, teams_user_id, conversation_id, service_url, email, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?) ON CONFLICT (subject) DO UPDATE SET aad_object_id = excluded.aad_object_id, tenant_id = excluded.tenant_id,
      teams_user_id = excluded.teams_user_id, conversation_id = excluded.conversation_id, service_url = excluded.service_url,
      email = CASE WHEN excluded.email != '' THEN excluded.email ELSE teams_conversations.email END, status = 'active', updated_at = excluded.updated_at`,
    subject, oid, tid, str(e.teamsUserId, 256), conversationId, service, email(e.email), now);
    lib.log('teams', 'teams-bot', 'teams install', 'personal scope');
    return { body: { ok: true } };
  }
  if (kind === 'uninstall' || kind === 'stop') {
    lib.sql.exec('UPDATE teams_conversations SET status = ?, updated_at = ? WHERE subject = ?', kind === 'stop' ? 'stopped' : 'uninstalled', now, subject);
    lib.log('teams', 'teams-bot', 'teams ' + kind, 'personal scope');
    return { body: { ok: true } };
  }
  // Card action: only the Teams user the card was sent to (same object id, same tenant) can change anything.
  const o = rowOf(lib, str(e.outreachId, 64));
  const bound = o && o.channel === 'teams' && o.status === 'sent' && o.aad_object_id && o.aad_object_id === oid
    && lib.rows('SELECT 1 AS ok FROM teams_conversations WHERE aad_object_id = ? AND tenant_id = ?', oid, tid)[0];
  if (!bound) return { body: { ok: true, card: OTHERS_CARD() } };
  const inv = o.kind === 'interview_invite' ? lib.rows('SELECT * FROM invitations WHERE id = ?', o.subject_id)[0] : null;
  if (!inv || !['snooze', 'decline'].includes(e.verb)) return { body: { ok: true, card: messageCard({ title: 'Nothing to change.', text: 'Open ATLAS to see your interviews.' }) } };
  if (!['open', 'scheduled'].includes(inv.status)) return { body: { ok: true, card: messageCard({ title: 'This invitation is closed.', text: 'Nothing was changed.' }) } };
  const p = parsed(o.payload), origin = originOf(ctx);
  if (e.verb === 'decline') {
    lib.sql.exec("UPDATE invitations SET status = 'dismissed' WHERE id = ?", inv.id);
    lib.log(inv.reference_id || 'library', inv.email, 'invitation dismiss', `${inv.reason} (Teams card)`);
    return { body: { ok: true, card: messageCard({ title: 'Understood: no interview for this project.', text: 'Nothing else will be sent about it.' }) } };
  }
  const base = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(inv.slot || '') ? inv.slot.slice(0, 16) : now.slice(0, 16);
  const slot = new Date(Date.parse(base + ':00Z') + 864e5).toISOString().slice(0, 16);
  lib.sql.exec("UPDATE invitations SET slot = ?, status = 'scheduled' WHERE id = ?", slot, inv.id);
  lib.log(inv.reference_id || 'library', inv.email, 'invitation schedule', `${inv.reason} (Teams card: tomorrow)`);
  return { body: { ok: true, card: interviewCard({ invitationId: inv.id, outreachId: o.id, projectRef: obj(p.preview).title, origin, note: 'Moved to tomorrow. Start whenever it suits you.' }) } };
}
