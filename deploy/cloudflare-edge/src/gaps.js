// F2 gap requests (WOW_SPEC §F2.1, §F2.2): a bid owner asks one consultant for up to three specific proof points; the
// consultant answers in a ~5-minute voice interview (session.js gap mode) and sends the answers back only on an explicit
// click. Access mode only: the assignee is authorised by the Access-verified email (features.js turns the word off in
// Entra mode). Ask texts stay in the bid's placeholder form; answers are pseudonymised with a per-request map. The bid's
// author (owner or admin) sees the asks un-masked; everyone else, the assignee and the talker included, sees uniform
// labels. The assignee sees their own words back; everyone else sees the answers with uniform labels. Nothing is sent:
// the response carries a mailto draft, and outreach rows wait for an approver (outreach.js).
import { obj, email, para, fail, inList } from './util.js';
import { pseudonymise, unmask, forOthers, recordText } from './scrub.js';
import { clientScrub } from './review.js';
import { getRequirement, bidView, ensure as ensureBids } from './bids.js';
import * as outreach from './outreach.js';
import * as profile from './profile.js';
import { FIELDS, GAP_MAX } from './policy.generated.js';
import { sameTenant } from './authz.js';

export const READY = true;

export const EXPIRY_DAYS = 30;
export const SUBJECT = 'Can you give 5 minutes of proof for a bid?';
// Requirement kind -> the ledger FIELDS an ask can target, in order of preference. Two asks never share a field: a later
// one takes its next field, and a request whose asks cannot all get their own field must be split.
export const KIND_FIELDS = Object.freeze({ capability: ['contribution', 'intervention'], outcome: ['outcome', 'measurement'], credential: ['evidence'],
  sector: ['problem', 'customer_fit'], constraint: ['customer_fit', 'limitations'] });
const STATUSES = ['answered_unverified', 'unknown', 'deferred', 'open'];
const ASK_CHARS = 160, QUOTE_CHARS = 400, QUOTES = 5;
const ID = /^[a-f0-9]{32}$/;

// §2.4 DDL (new table only; nothing ALTERs an existing table). Memoised per Library instance. Gap requests read the bid
// they belong to, so the bids tables are ensured too (bids.js owns that DDL).
const DDL = [`CREATE TABLE IF NOT EXISTS gap_requests (id TEXT PRIMARY KEY, bid_id TEXT, requirement_ids TEXT, asks TEXT, email TEXT, assignee_name TEXT,
  reference_id TEXT, project_id TEXT, status TEXT, created_by TEXT, created_by_mail TEXT, created_at TEXT, answered_at TEXT, results TEXT, pseudo TEXT, source TEXT)`];
const ensured = new WeakSet();
export function ensure(lib) {
  if (ensured.has(lib)) return;
  ensureBids(lib);
  for (const q of DDL) lib.sql.exec(q);
  const cols = lib.rows("SELECT name FROM pragma_table_info('gap_requests')").map(r => r.name);
  if (cols.length && !cols.includes('tenant')) lib.sql.exec("ALTER TABLE gap_requests ADD COLUMN tenant TEXT NOT NULL DEFAULT ''");
  ensured.add(lib);
}

const parsed = (text, fallback) => { try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const chars = (s, n) => Array.from(String(s)).slice(0, n).join('');
// An ask is stored whole: 'Proof the bid needs: ' + the requirement in placeholder form. It is cut to 160 characters only
// after it is rendered for the caller (a label cut in half is dropped rather than shown as a fragment), so the author's
// cut falls in their own words whether or not a name is masked for others (ground rule 5).
const askText = text => 'Proof the bid needs: ' + text;
const cutAsk = text => chars(text, ASK_CHARS).replace(/\s*\[[A-Za-z]*(?:\s+\d*)?$/, '').trim();
const originOf = ctx => { for (const v of [ctx.env?.ORIGIN, ctx.url?.href]) { try { const o = new URL(String(v)).origin; if (/^https?:\/\//.test(o)) return o; } catch { /* next */ } } return ''; };
const rowOf = (lib, id) => lib.rows('SELECT * FROM gap_requests WHERE id = ?', id)[0];
const isAssignee = (g, user) => !!user.mail && user.mail === g.email;
const isCreator = (g, user) => !!user.email && user.email === g.created_by;
// The bid's owner, by library identity or verified email. The author view is theirs: the other view of their own words
// would show which names are library clients (ground rule 5), so they are never a request's assignee.
const ownsBid = (lib, bidId, ...ids) => { const b = lib.rows('SELECT owner, owner_mail FROM bids WHERE id = ?', String(bidId ?? ''))[0];
  return !!b && ids.some(e => !!e && (e === b.owner || e === String(b.owner_mail || '').toLowerCase())); };
const cutoff = (now, days) => { const t = Date.parse(now instanceof Date ? now.toISOString() : String(now ?? '')); return new Date((Number.isFinite(t) ? t : Date.now()) - days * 864e5).toISOString(); };
const expired = (lib, g) => g.status === 'open' && g.created_at < cutoff(lib.now(), EXPIRY_DAYS);

// Requests open for more than 30 days become 'expired'. Called by outreach.daily; runs its own ensure. Returns the count.
export function expire(lib, now, user = {}) {
  if (!READY) return 0;
  ensure(lib);
  const enforced = user?.tenantEnforced === true;
  const tenant = enforced ? String(user.tenant || '').toLowerCase() : '';
  if (enforced && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) return 0;
  const before = cutoff(now, EXPIRY_DAYS), n = lib.rows("SELECT COUNT(*) AS n FROM gap_requests WHERE status = 'open' AND created_at < ? AND lower(COALESCE(tenant, '')) = ?", before, tenant)[0].n;
  if (n) lib.sql.exec("UPDATE gap_requests SET status = 'expired' WHERE status = 'open' AND created_at < ? AND lower(COALESCE(tenant, '')) = ?", before, tenant);
  return n;
}

// The bid view's gap summaries: for its owner, reviewers and admins only (never an email).
export function listForBid(lib, user, bidId) {
  if (!READY) return [];
  ensure(lib);
  const bid = lib.rows('SELECT owner, tenant FROM bids WHERE id = ?', String(bidId ?? ''))[0];
  if (!bid || !sameTenant(bid.tenant, user?.tenant, user?.tenantEnforced === true) || !(bid.owner === user?.email || ['admin', 'reviewer'].includes(user?.role))) return [];
  return lib.rows("SELECT * FROM gap_requests WHERE bid_id = ? AND lower(COALESCE(tenant, '')) = lower(COALESCE(?, '')) ORDER BY created_at DESC LIMIT 50", String(bidId), bid.tenant).map(g => ({
    id: g.id, requirementIds: parsed(g.requirement_ids, []), status: expired(lib, g) ? 'expired' : g.status, ...(g.assignee_name ? { assigneeName: g.assignee_name } : {}),
    answeredAt: g.answered_at || null }));
}

// A request in the caller's view (§F2.2 GapRequest). Asks and the alias: bid author un-masked, everyone else uniform
// labels. Results: the assignee's own words back, uniform labels for everyone else. The assignee's email: the creator
// (unless it was resolved from a reference they only see publicly), the assignee and admins.
function render(lib, user, g) {
  const view = bidView(lib, user, g.bid_id), bid = lib.rows('SELECT alias FROM bids WHERE id = ?', g.bid_id)[0], results = parsed(g.results, null);
  const mine = isAssignee(g, user), map = obj(parsed(g.pseudo, {})), others = recordText(lib);
  const showEmail = user.role === 'admin' || mine || (isCreator(g, user) && g.source !== 'reference_public');
  return { id: g.id, bidId: g.bid_id, bidAlias: bid ? view(bid.alias || '') : '', requirementIds: parsed(g.requirement_ids, []),
    asks: parsed(g.asks, []).map(a => ({ id: a.id, field: a.field, label: FIELDS[a.field]?.[0] || '', ask: cutAsk(view(a.ask)) })),
    ...(showEmail ? { assigneeEmail: g.email } : {}), ...(g.assignee_name ? { assigneeName: g.assignee_name } : {}),
    referenceId: g.reference_id || null, status: expired(lib, g) ? 'expired' : g.status, createdAt: g.created_at, answeredAt: g.answered_at || null,
    results: Array.isArray(results) ? results.map(r => ({ ...r, quotes: mine ? unmask(r.quotes, map) : forOthers(r.quotes.map(others)) })) : null };
}

// Who is asked: a typed email, or a person on a reference the requester can at least see publicly (0 = its owner,
// n = details.consultants[n-1]). External contacts are never asked.
function resolveAssignee(lib, env, user, raw) {
  const a = obj(raw);
  if (typeof a.refId === 'string') {
    const row = lib.row(a.refId), level = lib.access(row, user);
    if (!level) throw fail(404, 'Reference not found.');
    const n = a.person;
    if (!Number.isInteger(n) || n < 0 || n > 20) throw fail(400, 'Choose a person listed on the reference.');
    const person = n === 0 ? { email: row.owner, name: row.data.consultant?.name } : row.data.details?.consultants?.[n - 1];
    if (n > 0 && !person) throw fail(400, 'Choose a person listed on the reference.');
    const to = email(person.email);
    if (!to) throw fail(400, 'This person has no email on the reference; type their email.');
    if (inList(to, env?.EXTERNAL_EMAILS)) throw fail(400, 'External contacts cannot be asked for proof.');
    return { email: to, name: String(person.name || '').slice(0, 100), source: level === 'full' ? 'reference' : 'reference_public', row };
  }
  const to = email(a.email);
  if (!to) throw fail(400, 'Choose a suggested person or type a valid email.');
  if (inList(to, env?.EXTERNAL_EMAILS)) throw fail(400, 'External contacts cannot be asked for proof.');
  return { email: to, name: '', source: 'typed', row: null };
}

function create(ctx) {
  const { lib, user, body, env } = ctx, b = obj(body), bidId = String(b.bidId ?? '');
  const ids = Array.isArray(b.requirementIds) ? b.requirementIds : [];
  if (ids.length < 1 || ids.length > GAP_MAX || new Set(ids).size !== ids.length || ids.some(x => typeof x !== 'string')) throw fail(400, `Pick 1 to ${GAP_MAX} different requirements.`);
  const reqs = ids.map(id => getRequirement(lib, user, bidId, id)); // bid owner or admin, else 404
  const used = new Set(), asks = reqs.map(({ requirement: r }, i) => {
    const fields = KIND_FIELDS[r.kind];
    if (!fields) throw fail(400, 'Unknown requirement kind.');
    const field = fields.find(f => !used.has(f));
    if (!field) throw fail(400, 'Split these into two requests.');
    used.add(field);
    return { id: 'G' + (i + 1), field, label: FIELDS[field][0], ask: askText(String(r.text || '')) };
  });
  const who = resolveAssignee(lib, env, user, b.assignee);
  if ([user.email, user.mail].includes(who.email) || ownsBid(lib, bidId, who.email)) throw fail(400, 'Ask someone else for proof.');
  // A blank name is filled from the stored DNA directory rows only (never DNA itself, never anyone's profile; §5.8).
  if (!who.name && profile.READY) who.name = String(profile.lookupPerson(lib, who.email, user.tenantEnforced === true ? String(user.tenant || '').toLowerCase() : '')?.name || '').slice(0, 100);
  let ref = who.row;
  if (b.referenceId !== undefined && b.referenceId !== null && b.referenceId !== '') {
    ref = lib.row(String(b.referenceId));
    if (!lib.access(ref, user)) throw fail(404, 'Reference not found.');
  }
  // The business project id only when the assignee may see that reference in full.
  const projectId = ref && lib.access(ref, { email: who.email, mail: who.email, role: 'user', tenant: user.tenant, tenantEnforced: user.tenantEnforced === true }) === 'full' ? clientScrub(ref.data)(String(ref.data.details?.projectId || '')) : '';
  const id = lib.newId(), at = lib.now();
  const tenant = user.tenantEnforced === true ? String(user.tenant || '').toLowerCase() : '';
  lib.recorded(() => {
    lib.sql.exec(`INSERT INTO gap_requests (id, bid_id, requirement_ids, asks, email, assignee_name, reference_id, project_id, status, created_by, created_by_mail,
      created_at, answered_at, results, pseudo, source, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      id, bidId, JSON.stringify(ids), JSON.stringify(asks), who.email, who.name, ref?.id || null, projectId || null, user.email, user.mail || '', at, who.source, tenant);
    lib.log(id, user.email, 'gap requested', `bid ${bidId}; ${asks.length} asks; assignee ${who.source}`);
  });
  // Nothing is sent. The draft names nobody (no client, prospect or person) and links to the request by id only;
  // outreach rows wait for an approver and preview the other view.
  const other = bidView(lib, null, bidId), alias = other(lib.rows('SELECT alias FROM bids WHERE id = ?', bidId)[0]?.alias || '');
  const g = rowOf(lib, id), out = render(lib, user, g), link = `${originOf(ctx)}/go/gap/${id}`, points = asks.length === 1 ? 'one specific proof point' : `${asks.length} specific proof points`;
  const text = `A bid team asks for ${points} from your project experience (${asks.map(a => a.label).join(', ')}). It takes about five minutes by voice with ATLAS, and nothing is shared until you choose to send your answers.`;
  let queued = [];
  try { queued = outreach.queue(lib, { kind: 'gap_request', subjectId: id, toEmail: who.email, tenant, subject: SUBJECT, preview: { title: alias || 'A bid', text } }); }
  catch { queued = []; } // the request and its draft stand even if the approval queue refuses a row
  return { status: 201, body: { ...out, draft: { to: out.assigneeEmail || '', subject: SUBJECT, body: `Hello,\n\n${text}\n\nOpen the request: ${link}\n`, link },
    outreach: queued.map(o => ({ id: o.id, channel: o.channel, status: o.status, reason: o.reason || '' })) } };
}

// The interview's view, for the Interview DO: the assignee only (never the bid's owner, even on a request stored before
// create() refused that), an open request only, always the other view.
function interview(lib, user, g) {
  if (!isAssignee(g, user) || ownsBid(lib, g.bid_id, user.email, user.mail) || g.status !== 'open' || expired(lib, g)) throw fail(404, 'Gap request not found.');
  const other = bidView(lib, null, g.bid_id);
  return { asks: parsed(g.asks, []).map(a => ({ id: a.id, field: a.field, label: FIELDS[a.field]?.[0] || '', ask: cutAsk(other(a.ask)) })),
    bidAlias: other(lib.rows('SELECT alias FROM bids WHERE id = ?', g.bid_id)[0]?.alias || ''), referenceId: g.reference_id || null, projectId: g.project_id || null };
}

// The assignee sends the answers on an explicit click. Quotes are pseudonymised with a per-request map (the bid's
// declared prospects included), stored as unverified speech recognition, and the audit row carries no text.
function answer(ctx, g) {
  const { lib, user, body } = ctx, b = obj(body);
  if (!isAssignee(g, user)) throw fail(404, 'Gap request not found.');
  if (g.status !== 'open' || expired(lib, g)) throw fail(409, 'This request is no longer open.');
  const asks = parsed(g.asks, []), given = new Map();
  for (const r of Array.isArray(b.results) ? b.results.slice(0, GAP_MAX * 2) : []) {
    const x = obj(r);
    if (!asks.some(a => a.id === x.askId)) throw fail(400, 'Unknown ask.');
    if (!STATUSES.includes(x.status)) throw fail(400, 'Unknown answer status.');
    if (!given.has(x.askId)) given.set(x.askId, x);
  }
  if (!given.size) throw fail(400, 'Send at least one answer.');
  const prospects = parsed(lib.rows('SELECT prospects FROM bids WHERE id = ?', g.bid_id)[0]?.prospects ?? null, []);
  let map = {};
  const results = asks.map(a => {
    const x = given.get(a.id), quotes = [];
    for (const q of (Array.isArray(x?.quotes) ? x.quotes : []).slice(0, QUOTES)) {
      const text = chars(para(q, QUOTE_CHARS * 2), QUOTE_CHARS);
      if (!text) continue;
      const p = pseudonymise(lib, text, { prospects: Array.isArray(prospects) ? prospects : [], map });
      map = p.map; quotes.push(p.text);
    }
    return { askId: a.id, field: a.field, status: x ? x.status : 'open', quotes, provenance: 'unverified_speech_recognition' };
  });
  // Where the assignee keeps these answers: only a reference they may see in full.
  const refId = typeof b.referenceId === 'string' && lib.access(lib.row(b.referenceId), user) === 'full' ? b.referenceId : g.reference_id;
  const count = s => results.filter(r => r.status === s).length;
  lib.recorded(() => {
    lib.sql.exec("UPDATE gap_requests SET status = 'answered', answered_at = ?, results = ?, pseudo = ?, reference_id = ? WHERE id = ?",
      lib.now(), JSON.stringify(results), JSON.stringify(map), refId || null, g.id);
    lib.log(g.id, user.email, 'gap answered', `answered ${count('answered_unverified')}, unknown ${count('unknown')}, deferred ${count('deferred')}, open ${count('open')}`);
  });
  return render(lib, user, rowOf(lib, g.id));
}

function dismiss(ctx, g) {
  const { lib, user } = ctx, mine = isAssignee(g, user);
  if (!mine && !isCreator(g, user)) throw fail(404, 'Gap request not found.');
  if (g.status !== 'open') throw fail(409, 'This request is no longer open.');
  para(obj(ctx.body).note, 300); // an optional note is accepted but not stored (the §2.4 table has no column for it)
  lib.recorded(() => {
    lib.sql.exec("UPDATE gap_requests SET status = 'dismissed' WHERE id = ?", g.id);
    lib.log(g.id, user.email, 'gap dismissed', mine ? 'by assignee' : 'by creator');
  });
  return render(lib, user, rowOf(lib, g.id));
}

function gapPage(lib, user, which, params) {
  if (user?.tenantEnforced === true && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
  const q = params?.get ? params : { get: () => '' };
  const prefix = which === 'assigned' ? 'assigned' : 'created';
  const afterAt = q.get(prefix + 'AfterAt') || '', afterId = q.get(prefix + 'AfterId') || '';
  if ((afterAt && !afterId) || (!afterAt && afterId) || afterAt.length > 40 || afterId.length > 80) throw fail(400, 'The page cursor is not valid.');
  const who = which === 'assigned' ? user.mail : user.email;
  if (!who) return { items: [], page: { truncated: false, limit: 100, next: null } };
  const tenant = String(user.tenant || '').toLowerCase();
  const where = [which === 'assigned' ? 'email = ? AND status = \'open\'' : 'created_by = ?', "lower(COALESCE(tenant, '')) = ?"];
  const args = [who, tenant];
  if (which === 'assigned') { where.push('created_at >= ?'); args.push(cutoff(lib.now(), EXPIRY_DAYS)); }
  if (afterAt) { where.push('(created_at < ? OR (created_at = ? AND id > ?))'); args.push(afterAt, afterAt, afterId); }
  const limit = 100;
  const rows = lib.rows(`SELECT * FROM gap_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id ASC LIMIT ?`, ...args, limit + 1);
  const truncated = rows.length > limit, page = truncated ? rows.slice(0, limit) : rows, last = page.at(-1);
  return { items: page.map(g => render(lib, user, g)), page: { truncated, limit, next: truncated && last ? { afterAt: last.created_at, afterId: last.id } : null } };
}
export async function routes(ctx) {
  const { lib, user, method } = ctx, [, rawId, action, extra] = ctx.parts;
  if (user?.tenantEnforced === true && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
  ensure(lib);
  if (!rawId && method === 'POST') return create(ctx);
  if (!rawId && method === 'GET') {
    const q = ctx.url?.searchParams;
    const assigned = gapPage(lib, user, 'assigned', q);
    const created = gapPage(lib, user, 'created', q);
    return { body: { assigned: assigned.items, created: created.items, assignedPage: assigned.page, createdPage: created.page } };
  }
  const id = String(rawId || '').toLowerCase(), g = ID.test(id) && !extra ? rowOf(lib, id) : null;
  if (!g || !sameTenant(g.tenant, user.tenant, user.tenantEnforced === true)) throw fail(404, 'Gap request not found.');
  if (method === 'GET' && !action) {
    if (!isAssignee(g, user) && !isCreator(g, user) && !['admin', 'reviewer'].includes(user.role)) throw fail(404, 'Gap request not found.');
    return { body: render(lib, user, g) };
  }
  if (method === 'GET' && action === 'interview') return { body: interview(lib, user, g) };
  if (method === 'POST' && action === 'answer') return { body: answer(ctx, g) };
  if (method === 'POST' && action === 'dismiss') return { body: dismiss(ctx, g) };
  throw fail(404, 'Not found.');
}

// For the Interview DO (worker.js): the caller's open gap request from the global LibraryStore, asked with the verified
// identity the Worker forwarded. {asks, bidAlias, referenceId, projectId} (other view) or null; never a guess.
export async function resolveForInterview(env, identity, gapId) {
  const id = String(gapId ?? '');
  if (!ID.test(id) || !env?.LIBRARY || !identity?.user) return null;
  try {
    const headers = new Headers({ 'x-atlas-user': String(identity.user), 'x-atlas-role': String(identity.role || 'user'), 'x-atlas-email': String(identity.mail || ''), 'x-atlas-tenant': String(identity.tenant || ''), 'x-atlas-tenant-enforced': identity.tenantEnforced ? '1' : '0' });
    const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(new Request(`https://atlas.internal/api/library/gaps/${id}/interview`, { headers }));
    if (!res.ok) return null;
    const b = obj(await res.json());
    if (!Array.isArray(b.asks) || !b.asks.length) return null;
    return { asks: b.asks, bidAlias: typeof b.bidAlias === 'string' ? b.bidAlias : '', referenceId: b.referenceId || null, projectId: b.projectId || null };
  } catch { return null; }
}
