// F3 "Confirmed by someone else": claim-level confirmation by the N+1 (or, when enabled, a client contact). WOW_SPEC
// §F3. Access mode only (the registry turns `claims` and `confirmations` off in Entra mode, Q6).
// - Claims come from the SAME raw sentence split as the F1 snippets (snippets.js), so a confirmation and a one-pager
//   footnote share one key: claimKey(topic, text). Scrubbed text is never re-split.
// - Confirmations never touch refs.state.validation or the publication status (per-record N+1 validation stays apart).
// - Nothing is sent: a request returns a mailto draft and queues PENDING outreach rows (outreach.js) for approval.
// - Audit rows carry revisions and ids only, never claim text or names.
import { str, email, obj, fail, inList } from './util.js';
import { splitSentences, claimKey } from './snippets.js';
import { recordText, piiText } from './scrub.js';
import { clientScrub } from './review.js';
import * as outreach from './outreach.js';
import * as profile from './profile.js';

export const READY = true;
// Claim currency (§2.4, Q12; Tony decides). 'sentence' (default): a confirmation stays current while its exact sentence
// is still present at the reference's current revision. 'revision' (strict R4): any new revision makes it stale.
// Every function below also accepts a `currency` option (tests; routes read ctx.currency, which only tests set).
export const CURRENCY = 'sentence';

const TOPICS = [1, 2, 3, 4]; // answers index: contribution, approach, outcome, evidence
const MAX_CANDIDATES = 30, MAX_ITEMS = 8, NOTE_MAX = 500, EXPIRY_MS = 14 * 864e5;
const CONFIRMED = new Set(['manager_confirmed', 'client_confirmed']);
const DECISION = new Set(['confirm', 'correct', 'cant_say']);
const FORBIDDEN = { status: 403, body: { error: 'Not available to external confirmers.' } };
const NOT_FOUND = { status: 404, body: { error: 'Not found.' } };

// §2.4 DDL (new tables only; nothing ALTERs an existing table). Memoised per Library instance.
const DDL = [
  `CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, ref_id TEXT, revision INTEGER, topic INTEGER, idx INTEGER, text TEXT, sentence_hash TEXT,
    status TEXT, by_mail TEXT, at TEXT, confirmed_revision INTEGER, note TEXT, created_by TEXT, created_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS claims_ref ON claims(ref_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS claims_sentence ON claims(ref_id, sentence_hash)',
  `CREATE TABLE IF NOT EXISTS confirmation_requests (id TEXT PRIMARY KEY, ref_id TEXT, revision INTEGER, kind TEXT, to_email TEXT, manager_source TEXT,
    claim_ids TEXT, status TEXT, created_by TEXT, created_by_mail TEXT, created_at TEXT, expires_at TEXT, decided_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS confirmation_requests_ref ON confirmation_requests(ref_id)',
  'CREATE INDEX IF NOT EXISTS confirmation_requests_to ON confirmation_requests(to_email, status)',
];
const ensured = new WeakSet();
export function ensure(lib) {
  if (ensured.has(lib)) return;
  for (const q of DDL) lib.sql.exec(q);
  ensured.add(lib);
}

const mode = v => (v === 'sentence' || v === 'revision' ? v : CURRENCY);
const dataOf = row => (typeof row?.data === 'string' ? JSON.parse(row.data) : obj(row?.data));
const sentences = (data, topic) => splitSentences(Array.isArray(data?.answers) ? data.answers[topic] : '');
const idsOf = r => { try { const v = JSON.parse(r.claim_ids); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
// Record masking for a reader without full access: PII first, so the own-client scrub never rewrites a client name
// inside an email or URL (as snippets.js and bids.maskedTitle do).
const masked = (lib, data) => s => recordText(lib)(clientScrub(data)(piiText(s)));
const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');

// Currency of one reference at its current revision: present(c) = the exact sentence is still there; current(c) adds
// the strict rule for decided claims in 'revision' mode (an unverified claim has no confirmation to go stale).
function currencyOf(row, currency) {
  const data = dataOf(row), sets = new Map();
  const present = c => { if (!sets.has(c.topic)) sets.set(c.topic, new Set(sentences(data, c.topic))); return sets.get(c.topic).has(c.text); };
  const current = c => present(c) && (currency !== 'revision' || c.status === 'unverified' || c.confirmed_revision === row.revision);
  return { present, current };
}

function claimRows(lib, refId, ids) {
  if (!ids.length) return [];
  const byId = new Map(lib.rows(`SELECT * FROM claims WHERE ref_id = ? AND id IN (${ids.map(() => '?').join(',')})`, refId, ...ids).map(c => [c.id, c]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

// A claim moves out of 'unverified' once (§F3.1 step 6): while its decision is current, no request may ask it again
// and no other open request may overwrite it. A new sentence is a new claim.
const answered = current => c => c.status !== 'unverified' && current(c);
const CHANGED = 'The reference changed since this request. The consultant can ask again.', ANSWERED = 'These points were already answered in another request.';
// An open request is stale when its reference is gone, a claim's sentence left the current revision, (strict mode)
// the reference moved to a new revision since the request, or a claim already has a current decision from another
// request. Returns the reason, or '' while the request can still be answered.
function staleRequest(lib, r, row, currency) {
  if (!row || row.merged_into) return CHANGED;
  const ids = idsOf(r), cs = claimRows(lib, r.ref_id, ids), { present, current } = currencyOf(row, currency);
  if (cs.length !== ids.length || !cs.every(present) || (currency === 'revision' && r.revision !== row.revision)) return CHANGED;
  return cs.some(answered(current)) ? ANSWERED : '';
}

function requestView(r, status = r.status) {
  return { id: r.id, refId: r.ref_id, revision: r.revision, kind: r.kind, toEmail: r.to_email, managerSource: r.manager_source || null, claimIds: idsOf(r),
    status, createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at || null };
}
const shownStatus = (lib, r, row, currency, now) => r.status !== 'open' ? r.status : r.expires_at <= now ? 'expired' : staleRequest(lib, r, row, currency) ? 'stale' : 'open';

// The request that decided a claim: the done request addressed to the decider, holding the claim, decided at that time.
function decidersOf(lib, refId) {
  const out = new Map();
  for (const r of lib.rows("SELECT * FROM confirmation_requests WHERE ref_id = ? AND status = 'done'", refId))
    for (const id of idsOf(r)) out.set(id + '\n' + r.decided_at + '\n' + r.to_email, r);
  return out;
}
function claimView(c, current, deciders, text = c.text) {
  const out = { id: c.id, refId: c.ref_id, revision: c.revision, topic: c.topic, idx: c.idx, text, status: c.status, current };
  if (c.status !== 'unverified') {
    const r = deciders?.get(c.id + '\n' + c.at + '\n' + c.by_mail);
    Object.assign(out, { confirmedRevision: c.confirmed_revision, byMail: c.by_mail, at: c.at, note: c.note || '', kind: r?.kind || null, source: r?.manager_source || null });
  }
  return out;
}

// ---- GET /claims/:refId (full access): claims, candidate sentences and requests at the current revision.
function claimsFor(lib, user, refId, currency) {
  const row = lib.row(str(refId, 64));
  if (!row || lib.access(row, user) !== 'full') throw fail(404, 'Reference not found.');
  const { current } = currencyOf(row, currency), now = lib.now(), deciders = decidersOf(lib, row.id);
  const candidates = TOPICS.flatMap(topic => sentences(row.data, topic).map((text, idx) => ({ topic, idx, text }))).slice(0, MAX_CANDIDATES);
  const claims = lib.rows('SELECT * FROM claims WHERE ref_id = ? ORDER BY topic, idx, created_at', row.id).map(c => claimView(c, current(c), deciders));
  const requests = lib.rows('SELECT * FROM confirmation_requests WHERE ref_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50', row.id)
    .map(r => requestView(r, shownStatus(lib, r, row, currency, now)));
  return { refId: row.id, revision: row.revision, currency, claims, candidates, requests };
}

// ---- POST /claims (canEdit): each item must be the exact sentence at that index of the current revision.
async function propose(lib, user, body, currency) {
  const b = obj(body), items = Array.isArray(b.items) ? b.items : [];
  if (!items.length || items.length > MAX_ITEMS) throw fail(400, 'Choose 1 to 8 sentences.');
  const asked = items.map(it => { const i = obj(it); return { topic: i.topic, idx: i.idx, text: typeof i.text === 'string' ? i.text : '' }; });
  if (!asked.every(i => TOPICS.includes(i.topic) && Number.isInteger(i.idx) && i.idx >= 0)) throw fail(400, 'Each sentence needs a topic (1 to 4) and an index.');
  const hashes = await Promise.all(asked.map(i => sha256(claimKey(i.topic, i.text))));
  // Everything below is synchronous: the check and the inserts see one revision.
  const row = lib.row(str(b.refId, 64));
  if (!row || row.merged_into || !lib.access(row, user)) throw fail(404, 'Reference not found.');
  if (!lib.canEdit(row, user)) throw fail(403, 'Only the people who can edit this reference can propose points to confirm.');
  if (!asked.every(i => sentences(row.data, i.topic)[i.idx] === i.text)) throw fail(409, 'That sentence is not in the current revision. Reload the reference and choose again.');
  const at = lib.now(), before = lib.rows('SELECT COUNT(*) AS n FROM claims WHERE ref_id = ?', row.id)[0].n;
  const out = new Map();
  asked.forEach((i, k) => {
    lib.sql.exec(`INSERT OR IGNORE INTO claims (id, ref_id, revision, topic, idx, text, sentence_hash, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)`, lib.newId(), row.id, row.revision, i.topic, i.idx, i.text, hashes[k], user.email, at);
    const c = lib.rows('SELECT * FROM claims WHERE ref_id = ? AND sentence_hash = ?', row.id, hashes[k])[0];
    out.set(c.id, c);
  });
  const added = lib.rows('SELECT COUNT(*) AS n FROM claims WHERE ref_id = ?', row.id)[0].n - before;
  if (added) lib.log(row.id, user.email, 'claims proposed', `rev ${row.revision}: ${added} new`);
  const { current } = currencyOf(row, currency), deciders = decidersOf(lib, row.id);
  return { claims: [...out.values()].map(c => claimView(c, current(c), deciders)) };
}

// The N+1: the staffing record (F4) first, then the owner's N+1 in the stored DNA directory (a dna or dna_export row,
// never the owner's own profile edits; WOW_ZERO_CONFIG §5.8), then the N+1 the consultant named on the reference.
export function managerOf(lib, row) {
  outreach.ensure(lib);
  const pid = str(row.data?.details?.projectId, 60);
  const staffed = pid ? email(lib.rows("SELECT manager_email FROM staffing WHERE project_id = ? COLLATE NOCASE AND consultant_email = ? AND manager_email != '' ORDER BY updated_at DESC", pid, row.owner)[0]?.manager_email) : '';
  if (staffed) return { to: staffed, source: 'staffing' };
  const listed = profile.READY ? email(profile.directoryManager(lib, row.owner)?.email) : ''; // a stub while the profile module is not READY
  if (listed) return { to: listed, source: 'directory' };
  const declared = email(row.data?.validation?.manager?.email);
  if (declared) return { to: declared, source: 'self_declared' };
  throw fail(400, 'Name the N+1 on the reference first.');
}

const originOf = ctx => { for (const v of [ctx.env?.ORIGIN, ctx.url?.href]) { try { const o = new URL(String(v)).origin; if (/^https?:\/\//.test(o)) return o; } catch { /* next */ } } return ''; };
const CLIENT_BLOCKED = { status: 503, body: { error: 'Client-contact confirmation is not enabled on this deployment.', status: 'BLOCKED_EXTERNAL',
  reason: "Client contacts can confirm only when CLIENT_CONFIRM=1, the contact's email is listed in EXTERNAL_EMAILS, an Access policy admits that email, and Tony has taken the business and legal decision (Q3).",
  needs: ['CLIENT_CONFIRM=1', "the contact's email in EXTERNAL_EMAILS", 'a Cloudflare Access policy admitting that email (for example One-time PIN)', "Tony's business and legal decision (Q3)"] } };

// ---- POST /confirmations (canEdit, never external): resolve the confirmer, check independence, store, draft, queue.
function createRequest(ctx) {
  const { lib, user, env = {} } = ctx, b = obj(ctx.body);
  const row = lib.row(str(b.refId, 64));
  if (!row || row.merged_into || !lib.access(row, user)) throw fail(404, 'Reference not found.');
  if (!lib.canEdit(row, user)) throw fail(403, 'Only the people who can edit this reference can ask for confirmation.');
  const kind = b.kind === undefined ? 'manager' : b.kind;
  if (kind !== 'manager' && kind !== 'client') throw fail(400, "kind must be 'manager' or 'client'.");
  const ids = [...new Set((Array.isArray(b.claimIds) ? b.claimIds : []).map(x => str(x, 64)).filter(Boolean))];
  if (!ids.length || ids.length > MAX_ITEMS) throw fail(400, 'Choose 1 to 8 points to confirm.');
  let to = '', source = null;
  if (kind === 'client') {
    to = email(b.toEmail);
    if (env.CLIENT_CONFIRM !== '1' || !to || !inList(to, env.EXTERNAL_EMAILS)) return CLIENT_BLOCKED;
  } else ({ to, source } = managerOf(lib, row));
  if (to === row.owner || to === email(user.mail) || to === user.email || String(row.members || '').includes(',' + to + ','))
    throw fail(409, 'The confirmer must be independent: not the consultant, the requester or a team member.');
  const cs = claimRows(lib, row.id, ids);
  if (cs.length !== ids.length) throw fail(404, 'Claim not found on this reference.');
  const { present, current } = currencyOf(row, mode(ctx.currency));
  if (!cs.every(present)) throw fail(409, 'A point changed since it was proposed. Propose the current sentence again.');
  if (cs.some(answered(current))) throw fail(409, 'Already answered: edit the sentence to ask again.');
  const id = lib.newId(), at = lib.now(), expires = new Date(Date.parse(at) + EXPIRY_MS).toISOString();
  lib.sql.exec(`INSERT INTO confirmation_requests (id, ref_id, revision, kind, to_email, manager_source, claim_ids, status, created_by, created_by_mail, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`, id, row.id, row.revision, kind, to, source, JSON.stringify(ids), user.email, email(user.mail), at, expires);
  lib.log(row.id, user.email, 'confirmation requested', `rev ${row.revision} request ${id}: ${ids.length} claims (${kind}, ${source || 'none'})`);
  // The draft names the consultant and the number of points only: no claim text, no client name. Nothing is sent.
  const n = ids.length, name = str(row.data?.consultant?.name, 100) || 'a colleague', link = `${originOf(ctx)}/go/confirm/${id}`; // survives an interactive sign-in (§3.9)
  const subject = `Can you confirm ${n} point${n === 1 ? '' : 's'} from ${name}'s project? (about 60 seconds)`;
  const draft = { to, subject, body: link, link, mailto: `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(link)}` };
  const title = masked(lib, row.data)(row.data.title);
  const queued = outreach.queue(lib, { kind: 'confirmation_request', subjectId: id, toEmail: to, subject,
    preview: { title, text: `Confirm ${n} point${n === 1 ? '' : 's'} from ${name}'s project (about 60 seconds).` } });
  const request = lib.rows('SELECT * FROM confirmation_requests WHERE id = ?', id)[0];
  return { status: 201, body: { request: requestView(request), draft, outreach: queued.map(o => ({ id: o.id, channel: o.channel, status: o.status })) } };
}

// ---- GET /confirmations/inbox (any signed-in, external included): open, unexpired, every claim current.
function inbox(lib, user, currency) {
  const mail = email(user.mail);
  if (!mail) return { items: [] };
  const now = lib.now(), items = [];
  for (const r of lib.rows("SELECT * FROM confirmation_requests WHERE to_email = ? AND status = 'open' AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 50", mail, now)) {
    const row = lib.row(r.ref_id);
    if (staleRequest(lib, r, row, currency)) continue;
    // A confirmer with full access (e.g. the declared N+1) sees the raw sentence; anyone else the record masking.
    const mask = lib.access(row, user) === 'full' ? s => s : masked(lib, row.data);
    items.push({ request: requestView(r), reference: { title: mask(row.data.title), consultant: { name: row.data.consultant?.name || '', role: row.data.consultant?.role || '' }, revision: row.revision },
      claims: claimRows(lib, r.ref_id, idsOf(r)).map(c => ({ id: c.id, topic: c.topic, text: mask(c.text) })) });
  }
  return { items };
}

// ---- POST /confirmations/:id (only the addressed, signed-in email): one decision per claim, all in one submit.
function decide(lib, user, id, body, currency) {
  const r = lib.rows('SELECT * FROM confirmation_requests WHERE id = ?', str(id, 64))[0];
  if (!r) throw fail(404, 'Request not found.');
  const mail = email(user.mail);
  if (!mail || r.to_email !== mail) throw fail(403, 'This request is addressed to someone else.');
  const now = lib.now();
  if (r.status === 'expired' || (r.status === 'open' && r.expires_at <= now)) throw fail(410, 'This request has expired. The consultant can send a new one.');
  if (r.status !== 'open') throw fail(409, r.status === 'cancelled' ? 'This request was cancelled.' : 'This request is already answered.');
  const row = lib.row(r.ref_id);
  const why = staleRequest(lib, r, row, currency);
  if (why) throw fail(409, why);
  const ids = idsOf(r), list = Array.isArray(obj(body).decisions) ? body.decisions : [], byId = new Map();
  for (const d of list) {
    const x = obj(d), cid = str(x.claimId, 64), note = typeof x.note === 'string' ? str(x.note, 2 * NOTE_MAX) : '';
    if (!ids.includes(cid) || byId.has(cid)) throw fail(400, 'Each decision must name a different point of this request.');
    if (!DECISION.has(x.decision)) throw fail(400, "A decision is 'confirm', 'correct' or 'cant_say'.");
    if (note.length > NOTE_MAX) throw fail(400, 'Keep each note under 500 characters.');
    if (x.decision === 'correct' && !note) throw fail(400, 'Say what should be corrected.');
    byId.set(cid, { decision: x.decision, note });
  }
  if (byId.size !== ids.length) throw fail(400, 'Decide every point before sending.');
  const status = { confirm: r.kind === 'client' ? 'client_confirmed' : 'manager_confirmed', correct: 'corrected', cant_say: 'cant_say' };
  for (const cid of ids) {
    const d = byId.get(cid);
    lib.sql.exec('UPDATE claims SET status = ?, by_mail = ?, at = ?, note = ?, confirmed_revision = ? WHERE id = ? AND ref_id = ?',
      status[d.decision], mail, now, d.note, row.revision, cid, r.ref_id);
    lib.log(r.ref_id, mail, 'claim ' + d.decision, `rev ${row.revision} claim ${cid} (${r.kind}, ${r.manager_source || 'none'})`);
  }
  lib.sql.exec("UPDATE confirmation_requests SET status = 'done', decided_at = ? WHERE id = ?", now, r.id);
  const done = lib.rows('SELECT * FROM confirmation_requests WHERE id = ?', r.id)[0], { current } = currencyOf(row, currency);
  const mask = lib.access(row, user) === 'full' ? s => s : masked(lib, row.data), deciders = decidersOf(lib, row.id);
  return { request: requestView(done), claims: claimRows(lib, r.ref_id, ids).map(c => claimView(c, current(c), deciders, mask(c.text))) };
}

// ---- POST /confirmations/:id/cancel (creator, reviewer, admin; never external).
function cancel(lib, user, id) {
  const r = lib.rows('SELECT * FROM confirmation_requests WHERE id = ?', str(id, 64))[0];
  if (!r) throw fail(404, 'Request not found.');
  if (r.created_by !== user.email && !['admin', 'reviewer'].includes(user.role)) throw fail(403, 'Only the requester or a reviewer can cancel this request.');
  if (r.status !== 'open') throw fail(409, 'This request is already closed.');
  lib.sql.exec("UPDATE confirmation_requests SET status = 'cancelled' WHERE id = ?", r.id);
  lib.log(r.ref_id, user.email, 'confirmation cancelled', `rev ${r.revision} request ${r.id}`);
  return { request: requestView(lib.rows('SELECT * FROM confirmation_requests WHERE id = ?', r.id)[0]) };
}

// Words `claims` and `confirmations`. The external role reaches only the inbox and the decision.
export async function routes(ctx) {
  const { parts, method, user, lib } = ctx, [word, a, b, extra] = parts, currency = mode(ctx.currency);
  const decision = word === 'confirmations' && method === 'POST' && a && a !== 'inbox' && !b;
  if (user.role === 'external' && !(decision || (word === 'confirmations' && method === 'GET' && a === 'inbox' && !b))) return FORBIDDEN;
  ensure(lib);
  if (word === 'claims') {
    if (method === 'GET' && a && !b) return { body: claimsFor(lib, user, a, currency) };
    if (method === 'POST' && !a) return { status: 201, body: await propose(lib, user, ctx.body, currency) };
  } else if (word === 'confirmations') {
    if (method === 'GET' && a === 'inbox' && !b) return { body: inbox(lib, user, currency) };
    if (method === 'POST' && !a) return createRequest(ctx);
    if (decision) return { body: decide(lib, user, a, ctx.body, currency) };
    if (method === 'POST' && a && b === 'cancel' && !extra) return { body: cancel(lib, user, a) };
  }
  return NOT_FOUND;
}

// ---- Exports for other modules (F1 results and footnotes, F7 proof type, F4 daily sweep).
// {confirmed: current confirmed claims, total: every claim of the reference, current: current claims}.
export function claimSummary(lib, row, opts = {}) {
  if (!READY || !row?.id) return { confirmed: 0, total: 0, current: 0 };
  ensure(lib);
  const cs = lib.rows('SELECT topic, text, status, confirmed_revision FROM claims WHERE ref_id = ?', row.id), { current } = currencyOf(row, mode(opts.currency));
  let cur = 0, confirmed = 0;
  for (const c of cs) if (current(c)) { cur++; if (CONFIRMED.has(c.status)) confirmed++; }
  return { confirmed, total: cs.length, current: cur };
}
// Map(claimKey(topic, text) -> status) for CURRENT claims only (a footnote only ever cites a current sentence).
export function confirmationStatus(lib, row, opts = {}) {
  const out = new Map();
  if (!READY || !row?.id) return out;
  ensure(lib);
  const { current } = currencyOf(row, mode(opts.currency));
  for (const c of lib.rows('SELECT topic, text, status, confirmed_revision FROM claims WHERE ref_id = ?', row.id)) if (current(c)) out.set(claimKey(c.topic, c.text), c.status);
  return out;
}
// Marks open requests past expires_at as expired (daily sweep). Ensures its own tables first: safe on a fresh schema.
export function expire(lib, now = lib.now()) {
  ensure(lib);
  const n = lib.rows("SELECT COUNT(*) AS n FROM confirmation_requests WHERE status = 'open' AND expires_at <= ?", now)[0].n;
  if (n) {
    lib.sql.exec("UPDATE confirmation_requests SET status = 'expired' WHERE status = 'open' AND expires_at <= ?", now);
    lib.log('library', 'atlas', 'confirmations expired', `${n} requests`);
  }
  return n;
}
