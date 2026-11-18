// Privacy controls (v2.2 G2): consent purposes and receipts, per-person restriction and objection flags, and the privacy notice.
// Controls implemented in code; lawful bases, wording and periods need the DPO's and legal sign-off (nothing here claims compliance).
//
// Consent. The `start` message of an interview carries a consent OBJECT {transcription, draft, checkpoint, memory, notice, version}; a bare `true` (the old bundled tick)
// still works and means transcription only, with the draft following the old `capture` flag and nothing else (parseConsent). The Interview Durable Object keeps the
// person's CURRENT state (what the session checks: checkpoint only with the checkpoint purpose, memory only with the memory purpose) and appends every CHANGE as a
// receipt in the LibraryStore: consent_receipts is append-only (an UPDATE is refused by a trigger; withdrawing appends a "withdrawn" row, it deletes nothing), keyed by the
// person's pseudonymous subject key, with the notice version, the SHA-256 of the exact wording shown, a timestamp and the channel.
// Flags. restricted (Art 18) and the three objections (Art 21) stop scoring, matching and memory for the person's references. The person sets them for themselves only.
import { PRIVACY } from './policy.generated.js';
import { sha256Hex } from './audit-chain.js';
import { obj, fail } from './util.js';

export const NOTICE_VERSION = PRIVACY.version;
export const PURPOSES = Object.freeze([...PRIVACY.purposes]);
const BODY_KEYS = new Set([...PURPOSES, 'version']);
export const FLAG_KEYS = Object.freeze(['restricted', 'objectScoring', 'objectMatching', 'objectMemory']);
export const CHANNELS = Object.freeze(['consent-dialog', 'resume', 'profile', 'api', 'legacy-start']);

// ---- the wording, and its hash ----
const toggleOf = purpose => Object.values(PRIVACY.toggles).find(t => t.purposes.includes(purpose)) || PRIVACY.profile_consents[purpose];
// Receipts also cover the two profile consents (spoken Ask, JEV rating): purposes of their own, not part of the interview dialog.
export const RECEIPT_PURPOSES = Object.freeze([...PRIVACY.purposes, ...Object.keys(PRIVACY.profile_consents)]);
// The exact text a person saw for a purpose: the text-mode variant of the capture toggle when they typed instead of speaking.
export function consentText(purpose, mode = 'voice') {
  const t = toggleOf(purpose);
  if (!t) throw new Error('Unknown consent purpose.');
  return mode === 'text' && t.text_mode_text && (t.text_mode_purposes || []).includes(purpose) ? t.text_mode_text : t.text;
}
export const textHash = (purpose, mode = 'voice') => sha256Hex(consentText(purpose, mode));

// What the browser needs to draw the consent dialog (wording, which toggles are required) and to link the notice. Part of /api/bootstrap.
export function bootstrapView() {
  const t = PRIVACY.toggles;
  return { version: NOTICE_VERSION, noticeUrl: '/privacy', special: PRIVACY.special_category_sentence,
    toggles: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { required: v.required, text: v.text, ...(v.text_mode_text ? { textModeText: v.text_mode_text } : {}) }])),
    profileConsents: Object.fromEntries(Object.entries(PRIVACY.profile_consents).map(([k, v]) => [k, v.text])) };
}

// ---- the start message's consent ----
// raw: true (legacy) or an object with boolean purposes. Returns { purposes: {transcription, draft, checkpoint, memory, notice}, legacy }. A voice interview needs
// transcription AND draft; a typed one needs only the draft (no microphone, nothing to transcribe). Throws a plain Error for anything else.
export function parseConsent(raw, { capture = false, mode = 'voice', required = true } = {}) {
  let purposes, legacy = false;
  if (raw === true) { // the old bundled tick: transcription only; saving a draft follows the old `capture` flag; nothing optional
    legacy = true; purposes = { transcription: true, draft: capture === true, checkpoint: false, memory: false, notice: false };
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(raw)) if (!BODY_KEYS.has(k)) throw new Error('Unknown consent field.');
    if (raw.version !== undefined && raw.version !== NOTICE_VERSION) throw new Error('The consent wording has changed. Reload the page and choose again.');
    purposes = {};
    for (const p of PURPOSES) {
      if (raw[p] !== undefined && typeof raw[p] !== 'boolean') throw new Error('Each consent choice must be true or false.');
      purposes[p] = raw[p] === true;
    }
  } else throw new Error('Fresh voice consent and CSRF token required');
  if (mode === 'text') purposes.transcription = false; // nothing is transcribed when the person types
  if (required && (!purposes.draft || (mode !== 'text' && !purposes.transcription))) throw new Error('Transcription consent is required for this interview'); // (required: the deployment demands transcript capture; a gateway without it does not)
  return { purposes, legacy };
}

// ---- the person's current state, in their own Interview Durable Object ----
const STATE_KEY = 'consent';
export async function loadState(storage) {
  const v = await storage.get(STATE_KEY);
  return v && typeof v === 'object' && v.purposes && typeof v.purposes === 'object' ? v : { v: 1, purposes: {}, blocked: {} };
}
export const grantedIn = (state, purpose) => state?.purposes?.[purpose]?.granted === true;
// Applies the wanted purposes to the state and returns what CHANGED (each entry is a receipt to write): a purpose never granted and not granted now changes nothing.
// `beforeCommit(changes)` runs before the state is stored: when it throws (the receipt could not be written) the state stays as it was, so a choice is never in force
// without its receipt.
export async function applyState(storage, wanted, { mode = 'voice', channel = 'api', now = new Date().toISOString(), beforeCommit = null } = {}) {
  const state = await loadState(storage), changes = [];
  for (const p of PURPOSES) {
    if (wanted[p] === undefined) continue;
    const want = wanted[p] === true, was = state.purposes[p];
    if (want === (was?.granted === true) && (!want || !was || was.version === NOTICE_VERSION)) continue; // unchanged (a re-grant under new wording is a change)
    state.purposes[p] = { granted: want, at: now, version: NOTICE_VERSION };
    changes.push({ purpose: p, granted: want, mode, channel });
  }
  if (changes.length) { if (beforeCommit) await beforeCommit(changes); await storage.put(STATE_KEY, state); }
  return { state, changes };
}
// Appends receipts in the LibraryStore, server to server (the same internal path pattern as the evidence draft). `who`: {user, role, mail, subj} as the Worker verified them.
// Without a library binding there is nowhere to keep receipts: nothing is written and the caller is told (receipted: false).
export async function postReceipts(env, who, changes, channel = 'api') {
  if (!env?.LIBRARY || !changes.length) return { receipted: false };
  const headers = new Headers({ 'Content-Type': 'application/json', 'x-atlas-user': String(who.user || ''), 'x-atlas-role': String(who.role || 'user'), 'x-atlas-email': String(who.mail || ''), 'x-atlas-subj': String(who.subj || '') });
  const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(new Request('https://atlas.internal/api/privacy/receipts', { method: 'POST', headers, body: JSON.stringify({ items: changes, channel }) }));
  if (!res.ok) throw Object.assign(new Error('The consent receipt could not be recorded.'), { code: 'receipt-failed' });
  return { receipted: true };
}
// The one call the Interview Durable Object makes for a consent change: state plus receipts, all or nothing.
export const recordConsent = (storage, env, who, wanted, { mode = 'voice', channel = 'api' } = {}) =>
  applyState(storage, wanted, { mode, channel, beforeCommit: changes => postReceipts(env, who, changes, channel) });
export async function setBlocked(storage, blocked) { const state = await loadState(storage); state.blocked = { ...state.blocked, ...blocked }; await storage.put(STATE_KEY, state); return state; }
export const memoryAllowed = state => grantedIn(state, 'memory') && state?.blocked?.memory !== true;

// ---- the LibraryStore side: receipts and flags (additive tables; nothing ALTERs a library table) ----
const DDL = [
  `CREATE TABLE IF NOT EXISTS consent_receipts (id TEXT PRIMARY KEY, subject TEXT NOT NULL, purpose TEXT NOT NULL, granted INTEGER NOT NULL, notice_version TEXT, text_sha256 TEXT,
    at TEXT NOT NULL, channel TEXT)`,
  'CREATE INDEX IF NOT EXISTS consent_receipts_subject ON consent_receipts(subject, purpose, at)',
  'CREATE TABLE IF NOT EXISTS privacy_flags (subject TEXT PRIMARY KEY, restricted INTEGER, object_scoring INTEGER, object_matching INTEGER, object_memory INTEGER, updated_at TEXT)',
  'CREATE TABLE IF NOT EXISTS erasure_log (id TEXT PRIMARY KEY, subject_hash TEXT, at TEXT, counts TEXT)',
  `CREATE TABLE IF NOT EXISTS erasure_holds (id TEXT PRIMARY KEY, kind TEXT, entity TEXT, subject_hash TEXT, reason TEXT, at TEXT, status TEXT, resolved_at TEXT, resolved_by TEXT, note TEXT)`,
];
const ensured = new WeakSet();
export function ensure(lib) {
  if (ensured.has(lib)) return;
  lib.schema(() => {
  for (const q of DDL) lib.exec(q);
  // Append-only: a receipt is never edited, deleted or replaced. The one exception is the retention sweep, which removes a whole person's old receipts and opens the gate
  // (retentionGate below) for exactly that statement. X1 (red L9): REPLACE (a delete plus an insert) was allowed; SQLite runs a REPLACE's implicit delete without firing
  // delete triggers, so an insert that reuses an existing id is refused as well.
  try {
    lib.exec('CREATE TABLE IF NOT EXISTS privacy_gate (name TEXT PRIMARY KEY, open INTEGER)');
    lib.exec("CREATE TRIGGER IF NOT EXISTS consent_receipts_no_update BEFORE UPDATE ON consent_receipts BEGIN SELECT RAISE(ABORT, 'consent receipts are append-only'); END");
    lib.exec("CREATE TRIGGER IF NOT EXISTS consent_receipts_no_delete BEFORE DELETE ON consent_receipts WHEN COALESCE((SELECT open FROM privacy_gate WHERE name = 'receipts'), 0) != 1 BEGIN SELECT RAISE(ABORT, 'consent receipts are append-only'); END");
    lib.exec("CREATE TRIGGER IF NOT EXISTS consent_receipts_no_replace BEFORE INSERT ON consent_receipts WHEN EXISTS (SELECT 1 FROM consent_receipts WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'consent receipts are append-only'); END");
  } catch { /* a platform without triggers: the module still exposes no update path */ }
  const holds = lib.rows("SELECT name FROM pragma_table_info('erasure_holds')").map(r => r.name);
  if (holds.length && !holds.includes('tenant')) lib.exec('ALTER TABLE erasure_holds ADD COLUMN tenant TEXT');
  });
  ensured.add(lib);
}
// Runs `fn` (the retention sweep's receipt delete) with the delete gate open, and always closes it again.
export function retentionGate(lib, fn) {
  ensure(lib);
  return lib.housekeeping('consent-retention', () => {
    try { lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)"); } catch { /* no gate table: no triggers either */ }
    try { return fn(); } finally { try { lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)"); } catch { /* as above */ } }
  });
}
// The hash of the pseudonymous subject key kept on an erasure hold: enough to show that a subject was erased, not enough to identify who.
export const subjectHash = subj => sha256Hex('erasure|' + subj).slice(0, 24);

const SUBJECT = /^[0-9a-f]{16,64}$/;
export const subjectOf = v => { const s = String(v || '').toLowerCase(); return SUBJECT.test(s) ? s : ''; };

export function stateFromReceipts(lib, subject) {
  ensure(lib);
  const out = {};
  for (const r of lib.rows('SELECT purpose, granted, notice_version, at, channel FROM consent_receipts WHERE subject = ? ORDER BY at, rowid', subject)) out[r.purpose] = { granted: r.granted === 1, version: r.notice_version, at: r.at, channel: r.channel };
  return out;
}

// items: [{ purpose, granted, mode?, channel? }]. A receipt is appended only when the latest one for that purpose differs (granted flips, or the wording version changed).
export function recordReceipts(lib, subject, items, { channel = 'api', now = lib.now() } = {}) {
  ensure(lib);
  const subj = subjectOf(subject);
  if (!subj) throw fail(400, 'A subject key is required.');
  const list = Array.isArray(items) ? items.slice(0, RECEIPT_PURPOSES.length * 2) : [], latest = stateFromReceipts(lib, subj), pending = [];
  for (const it of list) {
    const i = obj(it), purpose = String(i.purpose || '');
    if (!RECEIPT_PURPOSES.includes(purpose) || typeof i.granted !== 'boolean') continue;
    const prev = latest[purpose];
    if (prev && prev.granted === i.granted && (!i.granted || prev.version === NOTICE_VERSION)) continue;
    if (!prev && !i.granted) continue; // never granted and not granted now: nothing to evidence
    const mode = i.mode === 'text' ? 'text' : 'voice', ch = CHANNELS.includes(i.channel) ? i.channel : CHANNELS.includes(channel) ? channel : 'api';
    const row = { id: lib.newId(), subject: subj, purpose, granted: i.granted ? 1 : 0, notice_version: NOTICE_VERSION, text_sha256: textHash(purpose, mode), at: now, channel: ch };
    pending.push(row);
    latest[purpose] = { granted: i.granted, version: NOTICE_VERSION, at: now, channel: row.channel };
  }
  if (!pending.length) return { recorded: [], state: latest };
  // A healthy chain checkpoints this line with the receipt. A damaged chain stores the receipt and does not append.
  return lib.recorded(() => {
    const out = [];
    for (const row of pending) {
      lib.exec('INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.subject, row.purpose, row.granted, row.notice_version, row.text_sha256, row.at, row.channel);
      out.push({ purpose: row.purpose, granted: row.granted === 1, at: row.at, channel: row.channel });
    }
    const verdict = lib.chainVerdict();
    if (verdict.ok) lib.log('privacy', subj, 'consent receipt', out.map(r => r.purpose).join(','));
    return { recorded: out, state: latest };
  });
}
export const receiptsOf = (lib, subject) => { ensure(lib); return lib.rows('SELECT id, purpose, granted, notice_version AS noticeVersion, text_sha256 AS textSha256, at, channel FROM consent_receipts WHERE subject = ? ORDER BY at, rowid', subject).map(r => ({ ...r, granted: r.granted === 1 })); };

// ---- restriction and objection flags (keyed by the library identity, like the references they govern) ----
const flagsRow = (lib, email) => { ensure(lib); return lib.rows('SELECT * FROM privacy_flags WHERE subject = ?', String(email || ''))[0] || null; };
export function flagsOf(lib, email) {
  const r = flagsRow(lib, email);
  return { restricted: r?.restricted === 1, objectScoring: r?.object_scoring === 1, objectMatching: r?.object_matching === 1, objectMemory: r?.object_memory === 1, updatedAt: r?.updated_at || null };
}
// purpose: 'scoring' | 'matching' | 'memory'. Restriction (Art 18) stops all three.
export function processable(lib, email, purpose) {
  const f = flagsOf(lib, email);
  return !(f.restricted || (purpose === 'scoring' && f.objectScoring) || (purpose === 'matching' && f.objectMatching) || (purpose === 'memory' && f.objectMemory));
}
// The owners whose material must not be processed for `purpose`, as a Set (one query, for filters over many rows).
export function blockedOwners(lib, purpose) {
  ensure(lib);
  const col = { scoring: 'object_scoring', matching: 'object_matching', memory: 'object_memory' }[purpose];
  return new Set(lib.rows(`SELECT subject FROM privacy_flags WHERE restricted = 1${col ? ' OR ' + col + ' = 1' : ''}`).map(r => r.subject));
}
// X1 (red L8): while erasure left material for the DPO (a pending hold under this subject), the restriction erasure set stays until the DPO resolves every hold: the person
// can add flags but not lift one. `subj` is the verified pseudonymous subject key (holds record its hash).
const pendingHolds = (lib, subj) => !!subj && lib.rows("SELECT 1 AS x FROM erasure_holds WHERE subject_hash = ? AND status = 'pending_dpo' LIMIT 1", subjectHash(subj)).length > 0;
export function setFlags(lib, email, patch, { actor = email, subj = '' } = {}) {
  ensure(lib);
  const p = obj(patch), cur = flagsOf(lib, email), next = { ...cur };
  for (const k of FLAG_KEYS) if (p[k] !== undefined) { if (typeof p[k] !== 'boolean') throw fail(400, 'Each flag must be true or false.'); next[k] = p[k]; }
  if (FLAG_KEYS.some(k => cur[k] && !next[k]) && pendingHolds(lib, subj)) throw fail(409, 'Your data stays restricted while the DPO reviews what the erasure kept. It can be lifted once they have resolved it.');
  const at = lib.now();
  return lib.recorded(() => {
    lib.exec('INSERT OR REPLACE INTO privacy_flags (subject, restricted, object_scoring, object_matching, object_memory, updated_at) VALUES (?, ?, ?, ?, ?, ?)', email, +next.restricted, +next.objectScoring, +next.objectMatching, +next.objectMemory, at);
    lib.log('privacy', actor, 'privacy flags', FLAG_KEYS.filter(k => next[k] !== cur[k]).map(k => k + '=' + next[k]).join(',') || 'unchanged'); // names the flags, never the person's content
    return { ...next, updatedAt: at };
  });
}

// ---- the privacy notice, as one HTML page (no script) and as data ----
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const period = c => (c.hours ? c.hours + ' hours' : c.days + ' days');
const ACTION = { delete: 'deleted', erase_content: 'content erased', pseudonymise: 'pseudonymised', platform: 'handled by the platform', forget: 'forgotten' };
export function retentionRows(retention) { return retention.categories.map(c => ({ category: c.label, period: period(c), from: c.from, action: ACTION[c.action] || c.action, status: c.status })); }
export function noticeData(retention) { return { version: NOTICE_VERSION, status: PRIVACY.status, ...PRIVACY.notice, retention: retentionRows(retention) }; }
export function renderNoticeHtml(retention) {
  const n = PRIVACY.notice, rows = retentionRows(retention);
  const sections = n.sections.map(s => `<section id="${esc(s.id)}"><h2>${esc(s.title)}</h2>${s.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}${s.id === 'retention'
    ? `<div class="scroll"><table><thead><tr><th>What</th><th>Kept for</th><th>Counted from</th><th>Then</th><th>Status</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.category)}</td><td>${esc(r.period)}</td><td>${esc(r.from)}</td><td>${esc(r.action)}</td><td>${esc(r.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy notice · ATLAS</title>
<style>:root{color-scheme:dark light}body{margin:0;background:#15151c;color:#e8e8f0;font:16px/1.6 Arial,sans-serif}main{max-width:760px;margin:0 auto;padding:24px 16px 64px}h1{font-size:28px;margin:8px 0 12px}h2{font-size:20px;margin:32px 0 8px}p{margin:8px 0}a{color:#b9a8ff}.status{border:1px solid #2a2a36;border-radius:12px;padding:8px 12px;color:#c9c9d8;font-size:14px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #2a2a36;padding:8px;text-align:left;vertical-align:top}th{color:#c9c9d8}@media (prefers-color-scheme:light){body{background:#fff;color:#1b1b22}a{color:#4b2fc7}.status{border-color:#d4d4de;color:#444}th,td{border-color:#d4d4de}}</style></head>
<body><main><p><a href="/">Back to ATLAS</a></p><h1>${esc(n.title)}</h1><p class="status">Version ${esc(NOTICE_VERSION)}. ${esc(PRIVACY.status)}.</p><p>${esc(n.intro)}</p>${sections}</main></body></html>`;
}
