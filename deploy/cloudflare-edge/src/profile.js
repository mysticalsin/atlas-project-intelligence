// Profile prefill (WOW_ZERO_CONFIG §5-§7). The signed-in person's own profile (name, first name shown on screen, job
// title, N+1) is merged per field from five sources, first non-empty wins: you > dna > dna_export > signin > guess.
// It fills forms and the consent heading only: nothing in this module is ever model input (§0.4, §5.9).
// Runs inside the LibraryStore DO; identity arrives only in headers the Worker overwrites (x-atlas-user, x-atlas-email,
// x-atlas-idp). Every DNA or HR path is gated by DATA_MODE=production (§0.7): the test deployment accepts synthetic
// addresses only. The pull connector's shape is ASSUMED (§5.3); push (§5.4) and the CSV export (§5.6) are equal options.
import { Library } from './library.js';
import { str, email as validEmail, obj, fail, inList, rateLimit } from './util.js';
import { TENANT_ID } from './authz.js';
import { placeholders, readChunks, writeChunks } from './sql-bound.js';

// Flipped by the owning track only when the zero-config acceptance suites pass (WOW_SPEC §2.1, §2.5): flipped in Z-S2
// after tests/zero_config_edge_browser.py and tests/zero_config_browser.py passed locally.
export const READY = true;

const DAY = 864e5;
export const DNA_TIMEOUT_MS = 2500;       // a cold first profile read waits at most this long for DNA (§5.3)
const DNA_MAX_BYTES = 65536;
const FIELDS = { name: 100, preferredName: 40, title: 100, managerName: 100, managerEmail: 200 };
const LABEL = { name: 'name', preferredName: 'first name shown on screen', title: 'job title', managerName: 'N+1 name', managerEmail: 'N+1 email' };
const ROW_KEYS = ['email', 'name', 'givenName', 'familyName', 'title', 'managerName', 'managerEmail'];
const SYNTHETIC = 'this test deployment accepts synthetic addresses only';

const PROFILE_V2 = `CREATE TABLE profiles_v2 (
    subject TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT '', email TEXT, edits TEXT, signin TEXT, consents TEXT,
    created_at TEXT, updated_at TEXT, seen_at TEXT, PRIMARY KEY (subject, tenant))`;
const DIRECTORY_V2 = `CREATE TABLE directory_v2 (
    key TEXT NOT NULL, source TEXT NOT NULL, name TEXT, given_name TEXT, title TEXT, manager_name TEXT,
    manager_email TEXT, batch TEXT, fetched_at TEXT, tenant TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (key, source, tenant))`;
const IMPORTS_V2 = `CREATE TABLE directory_imports_v2 (
    batch TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT '', source TEXT, by TEXT, started_at TEXT, finished_at TEXT,
    rows INTEGER, rejected INTEGER, state TEXT, PRIMARY KEY (batch, tenant))`;
const SCHEMA = [];
// spokenAsk: spoken Ask (WOW_SPEC); jevRating: story rating by TypeSafe JEV for the owner's stories (docs/JEV_RATING.md §8).
const CONSENT_KINDS = ['spokenAsk', 'jevRating', 'profileReuse'];
const ensured = new WeakSet();
const COLLAPSED = `CREATE TABLE IF NOT EXISTS profile_collapsed (
  id INTEGER PRIMARY KEY, subject TEXT NOT NULL, tenant TEXT NOT NULL, reason TEXT NOT NULL)`;
// JavaScript trim removes every Unicode whitespace character, including tab. toLowerCase is the Unicode
// default case conversion. Writers store this fold. SQLite lower() folds ASCII only, and SQLite trim()
// removes the space character only, so the profile match does not use either.
export function profileFold(value) { return String(value ?? '').trim().toLowerCase(); }
function tenantKey(user = {}) { return profileFold(user.tenant); }
function tableExists(lib, name) {
  return !!lib.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name)[0];
}
function profilePk(lib, table) {
  return lib.rows(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`).map(r => r.name);
}
function isProfileV2(lib, table = 'profiles') {
  const pk = profilePk(lib, table);
  return pk.length === 2 && pk[0] === 'subject' && pk[1] === 'tenant';
}
function profileInstant(value) {
  const n = Date.parse(value ?? '');
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}
function byNewestProfile(a, b) {
  const delta = profileInstant(b.updated_at) - profileInstant(a.updated_at);
  if (delta) return delta;
  return Number(b.id) - Number(a.id);
}
function profileRows(lib) {
  return lib.rows('SELECT rowid AS id, subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at FROM profiles');
}
// The one subject and tenant match. Export, erasure, read and write all use it. A blank tenant is not a match
// for a verified tenant. Rows are newest parsed updated_at, then greatest rowid.
export function profileSelection(lib, subject, tenant) {
  const wantSubject = profileFold(subject);
  const wantTenant = profileFold(tenant);
  const rows = wantSubject ? profileRows(lib) : [];
  const sameSubject = row => profileFold(row.subject) === wantSubject;
  const matched = rows.filter(row => sameSubject(row) && profileFold(row.tenant) === wantTenant).sort(byNewestProfile);
  const unscoped = wantTenant ? rows.filter(row => sameSubject(row) && profileFold(row.tenant) === '') : [];
  const collapsed = wantSubject && tableExists(lib, 'profile_collapsed')
    ? lib.rows('SELECT id, subject, tenant, reason FROM profile_collapsed').filter(row => sameSubject(row) && (profileFold(row.tenant) === wantTenant || (wantTenant && profileFold(row.tenant) === '')))
    : [];
  return { matched, unscoped, collapsed };
}
function storedIdentity(lib, row, subject, tenant) {
  const nextSubject = profileFold(subject), nextTenant = profileFold(tenant);
  const taken = lib.rows('SELECT rowid AS id FROM profiles WHERE subject = ? AND tenant = ?', nextSubject, nextTenant)[0];
  if (taken && Number(taken.id) !== Number(row.id)) return { subject: row.subject, tenant: row.tenant };
  return { subject: nextSubject, tenant: nextTenant };
}
function demandTenant(user) {
  if (user?.tenantEnforced === true && !TENANT_ID.test(tenantKey(user))) throw fail(403, 'A verified tenant is required.');
}
// Rebuild a subject-only profiles table inside one transactionSync. Blank ownership stays blank. No tenant is
// invented. Exact duplicate (subject, tenant) values cannot share the new primary key: the newest parsed
// updated_at, then the greatest rowid, is kept, and the rest are recorded as duplicate. A parked copy left
// behind by an interrupted migration is renamed back before any empty table is created. Two populated current
// tables are refused: rows are never dropped to make the migration succeed.
const PARKED = { profiles: 'profiles_v2', directory: 'directory_v2', directory_imports: 'directory_imports_v2' };
function recoverParked(lib, live, isCurrent) {
  const parked = PARKED[live];
  if (!parked || !tableExists(lib, parked)) return;
  if (!tableExists(lib, live)) {
    Library.migrate(lib, live === 'profiles' ? 'rename-profiles' : live === 'directory' ? 'rename-directory' : 'rename-directory-imports');
    return;
  }
  const extra = lib.rows(`SELECT COUNT(*) AS n FROM ${parked}`)[0].n;
  if (isCurrent()) {
    const kept = lib.rows(`SELECT COUNT(*) AS n FROM ${live}`)[0].n;
    if (!kept && extra) {
      Library.migrate(lib, live === 'profiles' ? 'drop-profiles' : live === 'directory' ? 'drop-directory' : 'drop-directory-imports');
      Library.migrate(lib, live === 'profiles' ? 'rename-profiles' : live === 'directory' ? 'rename-directory' : 'rename-directory-imports');
      return;
    }
    if (extra) throw new Error(`Refusing to drop ${parked}: both ${live} and ${parked} have rows.`);
    Library.migrate(lib, live === 'profiles' ? 'drop-profiles-v2' : live === 'directory' ? 'drop-directory-v2' : 'drop-directory-imports-v2');
    return;
  }
  lib.exec(`DROP TABLE ${parked}`);
}
function recoverProfilesV2(lib) {
  recoverParked(lib, 'profiles', () => isProfileV2(lib));
}
function collapseProfiles(lib) {
  const cols = lib.rows("SELECT name FROM pragma_table_info('profiles')").map(r => r.name);
  const hasTenant = cols.includes('tenant');
  const raw = lib.rows(`SELECT rowid AS id, subject, ${hasTenant ? 'tenant' : "'' AS tenant"}, email, edits, signin, consents, created_at, updated_at, seen_at FROM profiles`);
  const groups = new Map();
  for (const row of raw) {
    const tenant = row.tenant ?? '';
    const key = String(row.subject) + '\0' + String(tenant);
    const list = groups.get(key) || [];
    list.push({ ...row, tenant });
    groups.set(key, list);
  }
  lib.exec(PROFILE_V2);
  for (const list of groups.values()) {
    list.sort(byNewestProfile);
    const keep = list[0];
    lib.exec(`INSERT INTO profiles_v2 (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, keep.subject, keep.tenant ?? '', keep.email, keep.edits, keep.signin, keep.consents, keep.created_at, keep.updated_at, keep.seen_at);
    for (const extra of list.slice(1)) lib.exec("INSERT INTO profile_collapsed (id, subject, tenant, reason) VALUES (?, ?, ?, 'duplicate')", extra.id, String(extra.subject ?? ''), String(extra.tenant ?? ''));
  }
  Library.migrate(lib, 'drop-profiles');
  Library.migrate(lib, 'rename-profiles');
}
function migrateProfiles(lib) {
  lib.exec(COLLAPSED);
  recoverProfilesV2(lib);
  if (!tableExists(lib, 'profiles')) {
    lib.exec(PROFILE_V2.replace('profiles_v2', 'profiles'));
    return;
  }
  if (isProfileV2(lib)) return;
  collapseProfiles(lib);
}
export function deleteOwnedProfile(lib, user) {
  const tenant = tenantKey(user);
  if (!TENANT_ID.test(tenant)) throw fail(403, 'A verified tenant is required.');
  ensure(lib);
  const { matched } = profileSelection(lib, user.email, tenant);
  const notes = profileSelection(lib, user.email, tenant).collapsed.filter(row => profileFold(row.tenant) === tenant);
  writeChunks(lib, [
    {
      values: matched.map(row => row.id),
      sql: chunk => `DELETE FROM profiles WHERE rowid IN (${placeholders(chunk.length)})`,
      params: chunk => chunk,
    },
    {
      values: notes.map(row => row.id),
      sql: chunk => `DELETE FROM profile_collapsed WHERE id IN (${placeholders(chunk.length)})`,
      params: chunk => chunk,
    },
  ]);
  return matched.length;
}
export function quarantineReport(lib) {
  ensure(lib);
  const blank = lib.rows("SELECT COUNT(*) AS n FROM profiles WHERE tenant = ''")[0].n;
  return { blankProfiles: blank, action: 'none', note: 'Blank ownership stays blank until a reviewed operator migration. A privacy export names a matching subject as legacy_unscoped and does not include the row. Erasure does not delete it. This report does not write a tenant.' };
}
function pkOf(lib, table) {
  return lib.rows(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`).map(r => r.name);
}
function migrateDirectory(lib) {
  const directoryCurrent = () => pkOf(lib, 'directory').join(',') === 'key,source,tenant';
  const importsCurrent = () => pkOf(lib, 'directory_imports').join(',') === 'batch,tenant';
  recoverParked(lib, 'directory', directoryCurrent);
  const dir = tableExists(lib, 'directory');
  if (!dir) lib.exec(DIRECTORY_V2.replace('directory_v2', 'directory'));
  else if (!directoryCurrent()) {
    const cols = lib.rows("SELECT name FROM pragma_table_info('directory')").map(r => r.name);
    lib.exec(DIRECTORY_V2);
    const tenantSql = cols.includes('tenant') ? "COALESCE(tenant, '')" : "''";
    lib.exec(`INSERT INTO directory_v2 (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant)
      SELECT key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, ${tenantSql} FROM directory`);
    Library.migrate(lib, 'drop-directory');
    Library.migrate(lib, 'rename-directory');
  }
  recoverParked(lib, 'directory_imports', importsCurrent);
  const imp = tableExists(lib, 'directory_imports');
  if (!imp) lib.exec(IMPORTS_V2.replace('directory_imports_v2', 'directory_imports'));
  else if (!importsCurrent()) {
    const cols = lib.rows("SELECT name FROM pragma_table_info('directory_imports')").map(r => r.name);
    lib.exec(IMPORTS_V2);
    const tenantSql = cols.includes('tenant') ? "COALESCE(tenant, '')" : "''";
    lib.exec(`INSERT INTO directory_imports_v2 (batch, tenant, source, by, started_at, finished_at, rows, rejected, state)
      SELECT batch, ${tenantSql}, source, by, started_at, finished_at, rows, rejected, state FROM directory_imports`);
    Library.migrate(lib, 'drop-directory-imports');
    Library.migrate(lib, 'rename-directory-imports');
  }
}
function needsRebuild(lib) {
  if (tableExists(lib, 'profiles') && !isProfileV2(lib)) return true;
  if (tableExists(lib, 'directory') && pkOf(lib, 'directory').join(',') !== 'key,source,tenant') return true;
  if (tableExists(lib, 'directory_imports') && pkOf(lib, 'directory_imports').join(',') !== 'batch,tenant') return true;
  return ['profiles', 'directory', 'directory_imports'].some(live => tableExists(lib, PARKED[live]));
}
export function ensure(lib) {
  if (ensured.has(lib)) return;
  if (typeof lib.transactionSync !== 'function') throw new Error('Profile storage requires transactionSync.');
  if (!needsRebuild(lib)) {
    lib.schema(() => {
      if (!tableExists(lib, 'profiles')) lib.exec(PROFILE_V2.replace('profiles_v2', 'profiles'));
      if (!tableExists(lib, 'directory')) lib.exec(DIRECTORY_V2.replace('directory_v2', 'directory'));
      if (!tableExists(lib, 'directory_imports')) lib.exec(IMPORTS_V2.replace('directory_imports_v2', 'directory_imports'));
      lib.exec(COLLAPSED);
    });
    ensured.add(lib);
    return;
  }
  lib.recorded(() => {
    migrateProfiles(lib);
    migrateDirectory(lib);
    lib.log('profile', 'atlas', 'profile rebuild', 'profiles');
  });
  lib.schema(() => { for (const q of SCHEMA) lib.exec(q); });
  ensured.add(lib);
}

const json = s => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const isoBefore = (now, days) => new Date(Date.parse(now) - days * DAY).toISOString();

// ---- Reserved test addresses (RFC 2606 / 6761): the only emails a test deployment accepts from an import. ----
export function testAddress(address) {
  const e = validEmail(address), domain = e.split('@')[1] || '';
  return !!domain && (['example.com', 'example.org', 'example.net'].some(d => domain === d || domain.endsWith('.' + d))
    || /\.(test|example|invalid)$/.test(domain));
}

// ---- Sign-in name claims (§5.5): mapped from the verified Access JWT `custom` object, each at most 100 characters.
export function nameClaims(custom) {
  const c = obj(custom), s = k => typeof c[k] === 'string' ? str(c[k], 100) : '';
  const given = s('given_name'), family = s('family_name'), name = s('name') || str([given, family].filter(Boolean).join(' '), 100), out = {};
  if (name) out.name = name;
  if (given) out.given_name = given;
  if (family) out.family_name = family;
  return out;
}
// x-atlas-idp (base64url JSON, always written by the Worker) -> the same bounded claims; anything else -> {}.
export function idpClaims(header) {
  try {
    const s = String(header || '');
    if (!s || s.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(s)) return {};
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return nameClaims(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))));
  } catch { return {}; }
}

// ---- The email guess and the on-screen first name (§5.7). ----
export function emailGuess(address) {
  const local = (validEmail(address).split('@')[0] || '').split('+')[0];
  const parts = local.split(/[._-]+/).map(p => p.replace(/[^\p{L}\p{M}']/gu, '')).filter(Boolean);
  const cap = p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  const name = str(parts.map(p => p.length === 1 ? cap(p) + '.' : cap(p)).join(' '), 100);
  return parts.length >= 2 && parts[0].length >= 2 ? { name, givenName: str(cap(parts[0]), 40) } : { name };
}
const FIRST = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’. -]{0,28}[\p{L}\p{M}.])?$/u;
const validFirst = v => { const s = String(v ?? '').trim(); return FIRST.test(s) && s.split(/\s+/).length <= 2 ? s : ''; };
// Display only. Never the first word of `name` ("DUPONT Jean"), never an unconfirmed guess.
export function firstName(profile) {
  const f = profile?.fields?.preferredName;
  return f && ['you', 'dna', 'dna_export', 'signin'].includes(f.from) ? validFirst(f.value) : '';
}

// ---- DNA configuration (§5.3, §5.4). Secrets stay in env and in the request header; never in a URL or a log line.
const ASSUMED = [
  'DNA answers HTTPS from the public internet (Cloudflare Workers have no fixed egress IP, so an IP allow-list cannot work)',
  'authentication is a static header or bearer key (mTLS would need a new binding, which is not allowed)',
  'one person can be looked up by email or Entra object id',
  'a production deployment (DATA_MODE=production)',
];
const PUSH_NEEDS = ['the push secret (DIRECTORY_PUSH_SECRET) and a DNA or HR job run by Mantu IT',
  'an Access bypass on /api/directory/push only', 'a production deployment (DATA_MODE=production)'];
const TEST_MODE = 'This is a test deployment (DATA_MODE is not production): real DNA data is not accepted here.';

export function pushConfig(env = {}) {
  if (env.DATA_MODE !== 'production') return { status: 'BLOCKED_EXTERNAL', reason: TEST_MODE, needs: PUSH_NEEDS };
  if (!env.DIRECTORY_PUSH_SECRET) return { status: 'BLOCKED_EXTERNAL', reason: 'The DNA push secret (DIRECTORY_PUSH_SECRET) is not set.', needs: PUSH_NEEDS };
  return { status: 'on' };
}

const MAP_KEYS = ['root', 'name', 'givenName', 'title', 'managerName', 'managerEmail'];
const MAP_PATH = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+){0,7}$/;
function urlTemplate(raw) {
  const s = String(raw || ''), places = s.match(/\{[^}]*\}/g) || [];
  if (places.length !== 1 || !['{email}', '{oid}'].includes(places[0]) || s.includes('#')) return null;
  let a, b;
  try { a = new URL(s.replace(places[0], 'a')); b = new URL(s.replace(places[0], 'b')); } catch { return null; }
  if (a.protocol !== 'https:' || a.username || a.password || a.origin !== b.origin) return null; // the placeholder never picks the host
  for (const k of a.searchParams.keys()) if (/key|token|secret|sig|password|auth/i.test(k)) return null; // no credentials in URLs
  return { template: s, placeholder: places[0].slice(1, -1) };
}
function fieldMap(raw) {
  let m; try { m = JSON.parse(String(raw || '')); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const keys = Object.keys(m);
  if (!keys.length || keys.some(k => !MAP_KEYS.includes(k) || typeof m[k] !== 'string' || !MAP_PATH.test(m[k]))) return null;
  return m.name || m.givenName ? m : null;
}
export function dnaConfig(env = {}) {
  const needs = [...ASSUMED, 'from Mantu IT: DNA_PROFILE_URL, DNA_FIELD_MAP, the secret DNA_API_KEY and, if not Authorization, DNA_AUTH_HEADER'];
  const blocked = reason => ({ status: 'BLOCKED_EXTERNAL', reason, needs });
  if (env.DATA_MODE !== 'production') return blocked(TEST_MODE + ' The DNA connector stays off.');
  if (pushConfig(env).status === 'on') return { status: 'BLOCKED_EXTERNAL', reason: 'DNA push is configured, so the pull connector is never called.', needs: [] };
  const missing = ['DNA_PROFILE_URL', 'DNA_FIELD_MAP', 'DNA_API_KEY'].filter(k => !env[k]);
  if (missing.length) return blocked('Not configured: ' + missing.join(', ') + '.');
  const t = urlTemplate(env.DNA_PROFILE_URL);
  if (!t) return blocked('DNA_PROFILE_URL must be an https address with exactly one {email} or {oid} placeholder, no user name, fragment or credential in the query.');
  const map = fieldMap(env.DNA_FIELD_MAP);
  if (!map) return blocked('DNA_FIELD_MAP must be JSON mapping root, name, givenName, title, managerName and managerEmail to dotted paths, with name or givenName.');
  const header = env.DNA_AUTH_HEADER || 'Authorization';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) return blocked('DNA_AUTH_HEADER must be a header name.');
  return { status: 'on', ...t, header, map };
}

// ---- Stored directory rows (dna, dna_export). Readers never call DNA and never read profiles (§5.8). ----
const pullState = new WeakMap(); // per LibraryStore instance: { lastOkAt, lastError } for the admin view
const rowValues = r => r ? { name: r.name || '', preferredName: r.given_name || '', title: r.title || '', managerName: r.manager_name || '', managerEmail: r.manager_email || '', at: r.fetched_at || '' } : null;
function storedRows(lib, keys, tenant = '') {
  return directoryRows(lib, keys, tenant);
}
// The tenant is one parameter. Keys are chunked so the statement stays at or under 100.
export function directoryRows(lib, keys, tenant = '') {
  const k = keys.filter(Boolean);
  return readChunks(lib, k, {
    fixed: 1,
    sql: chunk => `SELECT * FROM directory WHERE lower(COALESCE(tenant, '')) = ? AND source IN ('dna', 'dna_export') AND key IN (${placeholders(chunk.length)})`,
    params: chunk => [String(tenant || '').toLowerCase(), ...chunk],
  });
}
const firstOf = (rows, test) => ['dna', 'dna_export'].map(s => rows.find(r => r.source === s && test(r))).find(Boolean) || null;

export function lookupPerson(lib, address, tenant = '') {
  ensure(lib);
  const e = validEmail(address), r = e ? firstOf(storedRows(lib, [e], tenant), x => x.name || x.title) : null;
  return r ? { email: e, name: r.name || '', title: r.title || '', from: r.source } : null;
}
// The F3 confirmer's directory source: the owner's N+1 from a stored dna or dna_export row, never the owner's edits.
export function directoryManager(lib, address, tenant = '') {
  ensure(lib);
  const e = validEmail(address), r = e ? firstOf(storedRows(lib, [e], tenant), x => x.manager_email) : null;
  return r ? { email: r.manager_email, name: r.manager_name || '', from: r.source } : null;
}

// ---- The DNA pull (ASSUMED shape): the signed-in subject only, mapped fields only, never the raw response. ----
function walk(o, path) { return path.split('.').reduce((v, k) => v && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined, o); }
async function boundedText(res, max) {
  if (Number(res.headers.get('Content-Length') || 0) > max) return null;
  if (!res.body) return '';
  const reader = res.body.getReader(), parts = []; let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return new TextDecoder().decode(out);
}
const oidOf = subject => { const m = /^[0-9a-f-]{36}:([0-9a-f-]{36})$/.exec(String(subject || '')); return m ? m[1] : ''; };
async function pull(lib, env, cfg, key, { fetcher, now, timeoutMs, tenant = '' }) {
  const t0 = Date.now(), ac = new AbortController(), last = pullState.get(lib) || {};
  let status = 0, timer;
  const scope = String(tenant || '').toLowerCase();
  const store = (row, outcome) => {
    if (ac.signal.aborted) throw new Error('timeout');
    lib.housekeeping('dna-cache', () => lib.exec(`INSERT OR REPLACE INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant)
      VALUES (?, 'dna', ?, ?, ?, ?, ?, 'pull', ?, ?)`, key, row.name, row.given_name, row.title, row.manager_name, row.manager_email, now, scope));
    return outcome;
  };
  try {
    const value = key.startsWith('oid:') ? key.slice(4) : key, url = cfg.template.replace('{' + cfg.placeholder + '}', encodeURIComponent(value));
    const work = (async () => {
      const res = await fetcher(url, { method: 'GET', redirect: 'manual', signal: ac.signal, headers: { Accept: 'application/json', [cfg.header]: env.DNA_API_KEY } });
      status = res.status;
      if (res.status === 404) return store({ name: '', given_name: '', title: '', manager_name: '', manager_email: '' }, 'not_found'); // cached miss
      if (res.status === 401 || res.status === 403) throw new Error(`DNA refused the key (HTTP ${res.status})`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`); // any 3xx is an error, never followed
      if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(res.headers.get('Content-Type') || '')) throw new Error('HTTP 200 without JSON');
      const text = await boundedText(res, DNA_MAX_BYTES);
      if (text === null) throw new Error('HTTP 200 larger than 64 KB');
      const data = JSON.parse(text), root = cfg.map.root ? walk(data, cfg.map.root) : data, at = k => cfg.map[k] ? walk(root, cfg.map[k]) : undefined;
      const managerEmail = validEmail(at('managerEmail'));
      return store({ name: str(at('name'), 100), given_name: str(at('givenName'), 40), title: str(at('title'), 100), manager_name: str(at('managerName'), 100),
        manager_email: managerEmail !== value ? managerEmail : '' }, 'ok');
    })();
    work.catch(() => {}); // a late failure after the timeout is already reported below
    const out = await Promise.race([work, new Promise((_, no) => { timer = setTimeout(() => { ac.abort(); no(new Error('timeout')); }, timeoutMs); })]);
    pullState.set(lib, { ...last, lastOkAt: now });
    return out;
  } catch (e) {
    pullState.set(lib, { ...last, lastError: /^(HTTP \d+|DNA refused the key \(HTTP \d+\))/.exec(e.message)?.[0] || (e.message === 'timeout' ? 'timeout' : 'failed'), lastErrorAt: now });
    return 'error';
  } finally {
    clearTimeout(timer);
    console.log(JSON.stringify({ atlas_metric: 'dna_lookup', ms: Date.now() - t0, status })); // numbers only
  }
}
async function dnaSource(lib, env, user, { fetcher, now, waitUntil, timeoutMs }) {
  const mail = validEmail(user.mail), oid = oidOf(user.email), cfg = dnaConfig(env), tenant = tenantKey(user);
  const read = key => lib.rows("SELECT * FROM directory WHERE source = 'dna' AND key = ? AND lower(COALESCE(tenant, '')) = ?", key, tenant)[0] || null;
  if (cfg.status !== 'on') {
    const r = firstOf([read(oid ? 'oid:' + oid : ''), read(mail)].filter(Boolean), x => x.name || x.title || x.manager_email);
    return { values: rowValues(r), state: r ? 'ok' : pushConfig(env).status === 'on' ? 'not_found' : 'off' };
  }
  const key = cfg.placeholder === 'oid' ? (oid ? 'oid:' + oid : '') : mail;
  if (!key) return { values: null, state: 'off' };
  const cached = read(key), filled = r => r && (r.name || r.title || r.manager_email);
  if (cached && Date.parse(now) - Date.parse(cached.fetched_at) < DAY) return { values: filled(cached) ? rowValues(cached) : null, state: filled(cached) ? 'ok' : 'not_found' };
  if (cached) { // stale: serve it, refresh in the background
    waitUntil(pull(lib, env, cfg, key, { fetcher, now, timeoutMs, tenant }).catch(() => {}));
    return { values: filled(cached) ? rowValues(cached) : null, state: filled(cached) ? 'ok' : 'not_found' };
  }
  const state = await pull(lib, env, cfg, key, { fetcher, now, timeoutMs, tenant }), fresh = read(key);
  return { values: state === 'ok' && filled(fresh) ? rowValues(fresh) : null, state: state === 'ok' && !filled(fresh) ? 'not_found' : state };
}

// ---- The profile row and the merge (§5.2). ----
function touch(lib, user, idp, now) {
  const mail = validEmail(user.mail), claims = nameClaims(idp), signin = claims.name || claims.given_name ? { name: claims.name || '', givenName: str(claims.given_name, 40) } : {};
  demandTenant(user);
  const subject = profileFold(user.email), tenant = tenantKey(user);
  const row = profileSelection(lib, subject, tenant).matched[0];
  const signinJson = JSON.stringify(signin.name || signin.givenName ? { ...signin, at: now } : {});
  if (!row) {
    lib.housekeeping('sign-in', () => lib.exec('INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      subject, tenant, mail, '{}', signinJson, '{}', now, now, now));
    return profileSelection(lib, subject, tenant).matched[0];
  }
  const ident = storedIdentity(lib, row, subject, tenant);
  const old = json(row.signin), same = (old.name || '') === (signin.name || '') && (old.givenName || '') === (signin.givenName || '');
  const seen = String(row.seen_at || '').slice(0, 10) !== now.slice(0, 10);
  if (!same || seen || row.email !== mail || ident.subject !== row.subject || ident.tenant !== row.tenant) {
    lib.housekeeping('sign-in', () => lib.exec('UPDATE profiles SET subject = ?, tenant = ?, email = ?, signin = ?, seen_at = ? WHERE rowid = ?', ident.subject, ident.tenant, mail,
      same ? row.signin : signinJson, seen ? now : row.seen_at, row.id));
    return profileSelection(lib, subject, tenant).matched[0];
  }
  return row;
}
async function gather(lib, env, user, idp, { fetcher = fetch, now = lib.now(), waitUntil = p => p, timeoutMs = DNA_TIMEOUT_MS } = {}) {
  demandTenant(user);
  ensure(lib);
  const row = touch(lib, user, idp, now), mail = validEmail(user.mail), signin = json(row.signin), guess = emailGuess(mail);
  const dna = await dnaSource(lib, env, user, { fetcher, now, waitUntil, timeoutMs });
  const exportRow = firstOf(storedRows(lib, [mail], row.tenant).filter(r => r.source === 'dna_export'), x => x.name || x.title || x.manager_email);
  const anyExport = lib.rows("SELECT COUNT(*) AS n FROM directory WHERE source = 'dna_export' AND lower(COALESCE(tenant, '')) = ?", row.tenant)[0].n > 0;
  const sources = [
    ['dna', dna.values, dna.state],
    ['dna_export', rowValues(exportRow), exportRow ? 'ok' : anyExport ? 'not_found' : 'off'],
    ['signin', signin.name || signin.givenName ? { name: signin.name || '', preferredName: signin.givenName || '', at: signin.at || '' } : null, signin.name || signin.givenName ? 'ok' : 'off'],
    ['guess', guess.name ? { name: guess.name, preferredName: guess.givenName || '', at: row.created_at } : null, guess.name ? 'ok' : 'not_found'],
  ];
  return { row, mail, guess, edits: json(row.edits), consents: json(row.consents), sources, now };
}
// The winning non-edit source for a field: what an edit replaces (its basis) and what `newer` compares with.
const topOf = (g, f) => { for (const [from, v] of g.sources) if (v?.[f]) return { value: v[f], from, at: v.at }; return null; };
function build(g) {
  const fields = {};
  for (const f of Object.keys(FIELDS)) {
    const top = topOf(g, f), e = g.edits[f];
    if (e?.value) {
      fields[f] = { value: e.value, from: 'you', at: e.at || '' };
      // "DNA now says …": a source value that changed since the edit. A guess never argues with an edit.
      if (top && top.from !== 'guess' && top.value !== (e.basis || '') && top.value !== e.value) fields[f].newer = { value: top.value, from: top.from };
    } else fields[f] = top ? { value: top.value, from: top.from, at: top.at || '' } : null;
  }
  // Each consent kind appears only when it is stored (so a profile without any still reads `consents: {}`).
  const consents = Object.fromEntries(CONSENT_KINDS.filter(k => g.consents[k]).map(k => [k, g.consents[k]]));
  const profile = { email: g.mail, fields, firstName: '', guessed: fields.name?.from === 'guess',
    consents, sources: g.sources.map(([id, , state]) => ({ id, state })), updatedAt: g.row.updated_at };
  profile.firstName = firstName(profile);
  return profile;
}
export async function resolveProfile(lib, env, user, idp = {}, opts = {}) { return build(await gather(lib, env, user, idp, opts)); }

function save(lib, g, patch, actor, action, detail) {
  const ident = storedIdentity(lib, g.row, g.row.subject, g.row.tenant);
  return lib.recorded(() => {
    lib.exec('UPDATE profiles SET subject = ?, tenant = ?, edits = ?, consents = ?, updated_at = ? WHERE rowid = ?', ident.subject, ident.tenant, JSON.stringify(patch.edits ?? g.edits), JSON.stringify(patch.consents ?? g.consents), g.now, g.row.id);
    lib.log('profile', actor, action, detail); // field names and counts only, never values
    return { ...g, edits: patch.edits ?? g.edits, consents: patch.consents ?? g.consents, row: { ...g.row, subject: ident.subject, tenant: ident.tenant, updated_at: g.now } };
  });
}
function cleanEdit(env, g, f, raw) {
  if (typeof raw !== 'string') throw fail(400, `The ${LABEL[f]} must be text.`);
  const v = str(raw, 1000);
  if (v.length > FIELDS[f]) throw fail(400, `Keep the ${LABEL[f]} to ${FIELDS[f]} characters.`);
  if (!v) return '';
  if (f === 'name' && v.includes('@')) throw fail(400, 'Type your name, not an email address.');
  if (f === 'preferredName' && !validFirst(v)) throw fail(400, 'Use letters only for the first name shown on screen, in at most two words.');
  if (f === 'managerEmail') {
    const e = validEmail(v);
    if (!e || inList(e, env.EXTERNAL_EMAILS)) throw fail(400, 'Check the N+1 email address.');
    if (e === g.mail) throw fail(400, "Your N+1 can't be you.");
    return e;
  }
  return v;
}
async function editProfile(lib, env, user, body, opts) {
  const b = obj(body), set = obj(b.set), clear = b.clear === undefined ? [] : b.clear;
  if (!Array.isArray(clear) || [...Object.keys(set), ...clear].some(f => typeof f !== 'string' || !Object.hasOwn(FIELDS, f))) throw fail(400, 'Unknown profile field.');
  let g = await gather(lib, env, user, user.idp, opts);
  const edits = { ...g.edits }, changed = new Set();
  for (const f of clear) { delete edits[f]; changed.add(f); }
  for (const [f, raw] of Object.entries(set)) {
    const value = cleanEdit(env, g, f, raw);
    if (value) edits[f] = { value, at: g.now, basis: topOf(g, f)?.value || '' }; else delete edits[f];
    changed.add(f);
  }
  // "Yes, that's me": the guessed name (and its first name) become the person's own values.
  if (b.confirmGuess === true && !edits.name?.value && topOf(g, 'name')?.from === 'guess') {
    edits.name = { value: g.guess.name, at: g.now, basis: g.guess.name }; changed.add('name');
    if (g.guess.givenName && !edits.preferredName?.value) { edits.preferredName = { value: g.guess.givenName, at: g.now, basis: topOf(g, 'preferredName')?.value || '' }; changed.add('preferredName'); }
  }
  if (changed.size) g = save(lib, g, { edits }, user.email, 'profile edited', 'fields: ' + [...changed].join(', '));
  return build(g);
}

// ---- Directory import (§5.6) and push (§5.4): staged batches, final replace, the shrink guard. ----
function cleanRow(raw, production) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'not a row' };
  if (Object.keys(raw).some(k => !ROW_KEYS.includes(k))) return { reason: 'unknown column' };
  if (Object.values(raw).some(v => v !== null && v !== undefined && typeof v !== 'string')) return { reason: 'values must be text' };
  const e = validEmail(raw.email), m = raw.managerEmail ? validEmail(raw.managerEmail) : '';
  if (!e) return { reason: 'no valid email' };
  if (raw.managerEmail && !m) return { reason: 'no valid N+1 email' };
  if (!production && (!testAddress(e) || (m && !testAddress(m)))) return { reason: SYNTHETIC };
  if (m && m === e) return { reason: 'the N+1 is the same person' };
  const given = str(raw.givenName, 40), name = str(raw.name, 100) || str([given, str(raw.familyName, 100)].filter(Boolean).join(' '), 100);
  return { row: { key: e, name, given_name: given, title: str(raw.title, 100), manager_name: str(raw.managerName, 100), manager_email: m } };
}
function importPart(lib, env, user, body, source) {
  demandTenant(user);
  const tenant = tenantKey(user);
  const b = obj(body), batch = String(b.batch ?? ''), part = b.part, rows = b.rows, final = b.final === true, now = lib.now();
  if (!/^[a-f0-9]{32}$/.test(batch)) throw fail(400, 'batch must be 32 lower-case hex characters.');
  if (!Number.isInteger(part) || part < 1 || part > 40) throw fail(400, 'part must be a whole number from 1 to 40.');
  if (!Array.isArray(rows) || rows.length > 500) throw fail(400, 'Send at most 500 rows per part.');
  if (b.final !== undefined && typeof b.final !== 'boolean') throw fail(400, 'final must be true or false.');
  const verdict = lib.chainVerdict();
  if (!verdict.ok) { const err = fail(409, 'The audit chain is tampered.'); err.code = verdict.reason; throw err; }
  let imp = lib.rows('SELECT * FROM directory_imports WHERE batch = ? AND lower(COALESCE(tenant, \'\')) = ?', batch, tenant)[0];
  if (imp && (imp.state !== 'staged' || imp.source !== source)) throw fail(409, 'This import batch is already finished.');
  const stage = 'staged:' + batch, production = env.DATA_MODE === 'production';
  const done = lib.recorded(() => {
    if (!imp) {
      lib.exec("INSERT INTO directory_imports (batch, tenant, source, by, started_at, finished_at, rows, rejected, state) VALUES (?, ?, ?, ?, ?, '', 0, 0, 'staged')", batch, tenant, source, user.email, now);
      imp = { rows: 0, rejected: 0 };
    }
    const offset = imp.rows + imp.rejected, rejected = [];
    let accepted = 0;
    rows.forEach((raw, i) => {
      const r = cleanRow(raw, production);
      if (r.reason) { rejected.push({ row: offset + i + 1, reason: r.reason }); return; }
      const x = r.row; accepted++;
      lib.exec(`INSERT OR REPLACE INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        x.key, stage, x.name, x.given_name, x.title, x.manager_name, x.manager_email, batch, now, tenant);
    });
    lib.exec('UPDATE directory_imports SET rows = rows + ?, rejected = rejected + ? WHERE batch = ? AND lower(COALESCE(tenant, \'\')) = ?', accepted, rejected.length, batch, tenant);
    if (!final) {
      lib.log('directory', user.email, 'directory_import', `${source}: staged part ${part}, ${accepted} rows, ${rejected.length} rejected`);
      return { accepted, rejected };
    }
    const count = s => lib.rows("SELECT COUNT(*) AS n FROM directory WHERE source = ? AND lower(COALESCE(tenant, '')) = ? AND batch != 'pull'", s, tenant)[0].n;
    const from = count(source), to = count(stage);
    const total = lib.rows('SELECT rows, rejected FROM directory_imports WHERE batch = ? AND lower(COALESCE(tenant, \'\')) = ?', batch, tenant)[0];
    // Shrink guard: a partial export must never wipe the directory silently. A push cannot confirm, so it is refused.
    if (to < 0.8 * from && !(b.confirmShrink === true && user.role !== 'system')) {
      lib.exec("DELETE FROM directory WHERE source = ? AND lower(COALESCE(tenant, '')) = ?", stage, tenant);
      lib.exec("UPDATE directory_imports SET state = 'refused', finished_at = ? WHERE batch = ? AND lower(COALESCE(tenant, '')) = ?", now, batch, tenant);
      lib.log('directory', user.email, 'directory_import refused', `${source}: ${to} rows would replace ${from}`);
      return { shrink: true, from, to };
    }
    lib.exec("DELETE FROM directory WHERE source = ? AND lower(COALESCE(tenant, '')) = ?", source, tenant);
    lib.exec("UPDATE directory SET source = ? WHERE source = ? AND lower(COALESCE(tenant, '')) = ?", source, stage, tenant);
    lib.exec("UPDATE directory_imports SET state = 'applied', finished_at = ? WHERE batch = ? AND lower(COALESCE(tenant, '')) = ?", now, batch, tenant);
    lib.log('directory', user.email, 'directory_import', `${source}: ${to} rows, ${total.rejected} rejected, replaced ${from}`);
    return { accepted, rejected, replaced: { from, to } };
  });
  if (done.shrink) throw fail(409, `This replaces ${done.from} rows with ${done.to}. That is far fewer people than before: confirm to replace anyway.`);
  return done;
}
function directoryStatus(lib, env, user = {}) {
  const tenant = tenantKey(user);
  const rows = s => lib.rows("SELECT COUNT(*) AS n FROM directory WHERE source = ? AND lower(COALESCE(tenant, '')) = ? AND (name != '' OR title != '' OR manager_email != '')", s, tenant)[0].n;
  const latest = (where, ...p) => lib.rows(`SELECT * FROM directory_imports WHERE lower(COALESCE(tenant, '')) = ? AND ${where} ORDER BY finished_at DESC, rowid DESC LIMIT 1`, tenant, ...p)[0];
  const last = latest("state = 'applied'");
  const pullCfg = dnaConfig(env), pullRun = pullState.get(lib) || {}, pushCfg = pushConfig(env);
  const pull = pullCfg.status === 'on' ? { status: pullRun.lastErrorAt && pullRun.lastErrorAt >= (pullRun.lastOkAt || '') ? 'error' : 'on',
    ...(pullRun.lastOkAt ? { lastOkAt: pullRun.lastOkAt } : {}), ...(pullRun.lastError ? { lastError: pullRun.lastError } : {}) } : { status: pullCfg.status, reason: pullCfg.reason, needs: pullCfg.needs };
  // A push that failed the shrink guard shows as HTTP 409 until a later push applies.
  const pushOk = latest("source = 'dna' AND state = 'applied'"), pushLast = latest("source = 'dna' AND state IN ('applied', 'refused')");
  const push = { ...pushCfg, ...(pushOk ? { lastOkAt: pushOk.finished_at } : {}), ...(pushLast?.state === 'refused' ? { lastError: 'HTTP 409' } : {}) };
  const production = env.DATA_MODE === 'production';
  return { dataMode: production ? 'production' : 'test', rows: { dna: rows('dna'), dna_export: rows('dna_export') },
    lastImport: last ? { at: last.finished_at, by: last.by, source: last.source, rows: last.rows, rejected: last.rejected } : null,
    sources: { pull, push, dna_export: production ? { status: 'on' } : { status: 'on', reason: 'Test deployment: only synthetic addresses (example.com, .test) are accepted.' },
      signin: env.IDENTITY_SOURCE === 'entra' ? { status: 'on' } : { status: 'BLOCKED_EXTERNAL', reason: 'Sign-in name claims arrive only with Entra sign-in.',
        needs: ['Entra sign-in through Cloudflare Access (entra/README.md)', 'the name, given_name and family_name claims, appended after preferred_username'] } } };
}

// ---- Stored reads for story rating (docs/JEV_RATING.md §3.2, §8.4). The profiles row only: never DNA, never a source.
// They create no table: without a profiles table (profile never used on this library) nothing is stored, so the answer
// is false / []. storedNames is used only to MASK names in model input; it is never sent anywhere.
function storedProfile(lib, subject, tenant) {
  if (!READY || !subject || tenant === undefined || tenant === null) return null;
  try { return profileSelection(lib, subject, tenant).matched[0] || null; }
  catch { return null; } // no profiles table yet
}
export function storedConsent(lib, subject, kind, tenant) {
  if (tenant === undefined || tenant === null) return false;
  const row = storedProfile(lib, subject, tenant);
  return !!row && CONSENT_KINDS.includes(kind) && json(row.consents)[kind]?.version === 1;
}
export function storedNames(lib, subject, tenant) {
  if (tenant === undefined || tenant === null) return [];
  const row = storedProfile(lib, subject, tenant);
  if (!row) return [];
  return [...new Set([json(row.edits).name?.value, json(row.signin).name].map(v => str(v, 100)).filter(Boolean))];
}

// ---- Daily housekeeping (called from the system `scan-stale` block once READY): counts only. ----
export function daily(lib, now = lib.now(), user = {}) {
  ensure(lib);
  const enforced = user?.tenantEnforced === true;
  const tenant = profileFold(user?.tenant);
  if (enforced && !TENANT_ID.test(tenant)) return { maintenanceRefused: 'A verified tenant is required.' };
  const n = (q, ...p) => lib.rows(q, ...p)[0].n;
  const scope = enforced ? tenant : '';
  // An unenforced scan has no verified tenant. It must not purge blank-tenant profiles.
  let profiles = 0;
  if (enforced) {
    const cutoff = isoBefore(now, 395);
    const stale = lib.rows('SELECT rowid AS id, tenant, seen_at FROM profiles')
      .filter(row => profileFold(row.tenant) === tenant && String(row.seen_at || '') !== '' && String(row.seen_at) < cutoff);
    profiles = stale.length;
    // The folded tenant filter already chose these rowids. A SQL tenant compare would miss a
    // padded stored tenant. The chunks bind only rowids and commit together. The directory
    // purge below still runs after that transaction.
    if (profiles) writeChunks(lib, [{
      values: stale.map(row => row.id),
      sql: chunk => `DELETE FROM profiles WHERE rowid IN (${placeholders(chunk.length)})`,
      params: chunk => chunk,
    }]);
  }
  // Residual: an unenforced scan still purges blank-tenant directory pull-cache rows and staged imports.
  // That sweep predates the profile fold and does not delete profiles.
  const cache = n("SELECT COUNT(*) AS n FROM directory WHERE lower(COALESCE(tenant, '')) = ? AND source = 'dna' AND batch = 'pull' AND fetched_at < ?", scope, isoBefore(now, 30));
  const staged = [];
  lib.housekeeping('profile-daily', () => {
    if (cache) lib.exec("DELETE FROM directory WHERE lower(COALESCE(tenant, '')) = ? AND source = 'dna' AND batch = 'pull' AND fetched_at < ?", scope, isoBefore(now, 30));
    staged.push(...lib.rows("SELECT batch FROM directory_imports WHERE lower(COALESCE(tenant, '')) = ? AND state = 'staged' AND started_at < ?", scope, isoBefore(now, 1)).map(r => r.batch));
    for (const batch of staged) {
      lib.exec("DELETE FROM directory WHERE source = ? AND lower(COALESCE(tenant, '')) = ?", 'staged:' + batch, scope);
      lib.exec("UPDATE directory_imports SET state = 'refused', finished_at = ? WHERE batch = ? AND lower(COALESCE(tenant, '')) = ?", now, batch, scope);
    }
  });
  return Object.fromEntries(Object.entries({ profilesPurged: profiles, dnaCachePurged: cache, stagedImportsPurged: staged.length }).filter(([, v]) => v));
}

// ---- Routes: words `profile`, `people`, `directory` (users); `directory` import only for the system push. ----
export async function routes(ctx) {
  const { method, parts, user, lib, env = {} } = ctx, [word, action, extra] = parts;
  if (extra !== undefined) throw fail(404, 'Not found.');
  if (word === 'profile' && method === 'POST' && action === 'delete' && !TENANT_ID.test(tenantKey(user))) throw fail(403, 'A verified tenant is required.');
  demandTenant(user);
  ensure(lib);
  const opts = { fetcher: lib.services?.fetch || fetch, waitUntil: ctx.waitUntil || (p => p) };
  if (user.role === 'system') {
    if (word !== 'directory' || method !== 'POST' || action !== 'import') throw fail(404, 'Not found.');
    const push = pushConfig(env);
    if (push.status !== 'on') return { status: 503, body: { error: 'DNA push is not connected.', ...push } };
    return { body: importPart(lib, env, user, ctx.body, 'dna') };
  }
  if (word === 'profile') {
    if (method === 'GET' && !action) return { body: await resolveProfile(lib, env, user, user.idp, opts) };
    if (method === 'GET' && action === 'consents') { // the profiles row only: no source is read
      demandTenant(user);
      const row = profileSelection(lib, user.email, tenantKey(user)).matched[0];
      return { body: { spokenAsk: json(row?.consents).spokenAsk || null } };
    }
    if (method === 'POST' && !action) return { body: await editProfile(lib, env, user, ctx.body, opts) };
    if (method === 'POST' && action === 'delete') {
      return lib.recorded(() => {
        const had = deleteOwnedProfile(lib, user);
        if (had) lib.log('profile', user.email, 'profile deleted', 'this tenant only; directory rows unchanged');
        return { body: { deleted: !!had, vendorDeletion: 'not-asserted' } };
      });
    }
    if (method === 'POST' && action === 'consent') {
      const b = obj(ctx.body);
      if (!CONSENT_KINDS.includes(b.kind) || b.version !== 1 || typeof b.granted !== 'boolean') throw fail(400, 'Unknown consent.');
      const g = await gather(lib, env, user, user.idp, opts), consents = { ...g.consents };
      if (b.granted) consents[b.kind] = { version: 1, at: g.now }; else delete consents[b.kind];
      return { body: build(save(lib, g, { consents }, user.email, 'consent', b.kind + ' ' + (b.granted ? 'granted' : 'revoked'))) };
    }
  }
  if (word === 'people' && method === 'GET' && !action) {
    // One exact email -> name and job title from stored rows: never the N+1, never DNA, never anyone's profile.
    demandTenant(user);
    if (!rateLimit(lib, 'people:' + tenantKey(user) + ':' + user.email, 30, 3600000)) throw fail(429, 'Too many lookups. Try again in an hour.');
    const e = validEmail(ctx.url?.searchParams.get('email'));
    if (!e) throw fail(400, 'Type one exact email address.');
    const p = lookupPerson(lib, e, tenantKey(user));
    if (!p) throw fail(404, 'Nobody with that email in the directory.');
    return { body: p };
  }
  if (word === 'directory') {
    if (user.role !== 'admin') throw fail(403, 'Only an admin can manage the people directory.');
    if (method === 'GET' && !action) { demandTenant(user); return { body: directoryStatus(lib, env, user) }; }
    if (method === 'POST' && action === 'import') return { body: importPart(lib, env, user, ctx.body, 'dna_export') };
    if (method === 'POST' && action === 'clear') {
      demandTenant(user);
      const tenant = tenantKey(user);
      const cleared = lib.rows("SELECT COUNT(*) AS n FROM directory WHERE lower(COALESCE(tenant, '')) = ?", tenant)[0].n;
      return lib.recorded(() => {
        lib.exec("DELETE FROM directory WHERE lower(COALESCE(tenant, '')) = ?", tenant);
        lib.exec("UPDATE directory_imports SET state = 'refused', finished_at = ? WHERE state = 'staged' AND lower(COALESCE(tenant, '')) = ?", lib.now(), tenant);
        lib.log('directory', user.email, 'directory cleared', `${cleared} rows`);
        return { body: { cleared } };
      });
    }
  }
  throw fail(404, 'Not found.');
}
