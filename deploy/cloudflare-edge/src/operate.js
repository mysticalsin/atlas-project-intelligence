// Admin metrics, journey and privacy routes. Every handler checks the server role again.
import { fail } from './util.js';
import { sameTenant, TENANT_ID } from './authz.js';
import { queryMetrics, recordUsage, purgeTelemetry, ensureTelemetry, personaKeySync } from './telemetry.js';
import { toCsv } from './csvsafe.js';
import { journeyView, saveJourney, mapDraft, ensureJourney } from './journey.js';
import { deleteOwnedProfile } from './profile.js';

function metricQuery(url, bucket = 'day') {
  const q = url?.searchParams || new URLSearchParams();
  return { from: q.get('from') || '', to: q.get('to') || '', bucket: q.get('bucket') || bucket, afterAt: q.get('afterAt') || '', afterId: q.get('afterId') || '' };
}
function dsarStores() {
  return {
    coveredLocal: ['journey for this subject and tenant', 'profile for this subject and tenant', 'telemetry for this persona and tenant', 'manager trust owned by this subject in this tenant is deleted; a row where this subject is only the manager has that address replaced', 'this subject\'s directory row for this tenant is deleted; another person\'s manager address in this tenant is replaced'],
    retained: [
      { store: 'legacy-blank-tenant-rows', action: 'quarantined', note: 'Blank ownership stays blank. It was not assigned a tenant and was not deleted by this request.' },
      { store: 'hindsight-bank', action: 'not-contacted', note: 'The vendor bank was not called. A subject-only bank is not read when a verified tenant is present, and it was not deleted.' },
      { store: 'interview-object', action: 'not-deleted', note: 'The Interview object was not opened and was not erased.' },
      { store: 'vendor-logs', action: 'not-asserted' },
      { store: 'directory-and-audit', action: 'retained', note: 'Directory keys for this subject and tenant are listed in outcomes. Audit rows are not deleted. This response does not report any other row.' },
    ],
    complete: false,
  };
}
const tableReady = (lib, name) => lib.rows("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
const erasureToken = () => 'erased:' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
function tokenOf(ctx) {
  const given = String(ctx?.token || '');
  return /^erased:[0-9a-f]{12}$/.test(given) ? given : erasureToken();
}
function subjectAliases(user) {
  return [...new Set([user?.email, user?.mail].map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
}
// The privacy-delete path and the subject-erasure map both call these. One predicate per store.
export function eraseJourneyFor(lib, user) {
  if (!tableReady(lib, 'journey')) ensureJourney(lib);
  const tenant = String(user.tenant || '').trim().toLowerCase();
  const n = lib.rows('SELECT COUNT(*) AS n FROM journey WHERE subject = ? AND tenant = ?', user.email, tenant)[0].n;
  if (n) lib.sql.exec('DELETE FROM journey WHERE subject = ? AND tenant = ?', user.email, tenant);
  return n;
}
export function eraseTelemetryFor(lib, user) {
  if (!tableReady(lib, 'telemetry')) ensureTelemetry(lib);
  const tenant = String(user.tenant || '').trim().toLowerCase();
  const persona = personaKeySync(user);
  const n = lib.rows("SELECT COUNT(*) AS n FROM telemetry WHERE persona = ? AND lower(COALESCE(tenant, '')) = ?", persona, tenant)[0].n;
  if (n) lib.sql.exec("DELETE FROM telemetry WHERE persona = ? AND lower(COALESCE(tenant, '')) = ?", persona, tenant);
  return n;
}
export function eraseManagerTrustFor(lib, user, ctx = {}) {
  if (!tableReady(lib, 'manager_trust')) return 0;
  const tenant = String(user.tenant || '').trim().toLowerCase();
  const aliases = subjectAliases(user);
  if (!aliases.length) return 0;
  const marks = aliases.map(() => '?').join(', ');
  const token = tokenOf(ctx);
  const managers = lib.rows(`SELECT owner, email FROM manager_trust WHERE lower(COALESCE(tenant, '')) = ? AND lower(email) IN (${marks}) AND lower(owner) NOT IN (${marks})`, tenant, ...aliases, ...aliases);
  let n = 0;
  for (const row of managers) {
    const clash = lib.rows("SELECT 1 AS x FROM manager_trust WHERE owner = ? AND email = ? AND lower(COALESCE(tenant, '')) = ?", row.owner, token, tenant);
    if (clash.length) lib.sql.exec("DELETE FROM manager_trust WHERE owner = ? AND email = ? AND lower(COALESCE(tenant, '')) = ?", row.owner, row.email, tenant);
    else lib.sql.exec("UPDATE manager_trust SET email = ? WHERE owner = ? AND email = ? AND lower(COALESCE(tenant, '')) = ?", token, row.owner, row.email, tenant);
    n++;
  }
  const own = lib.rows(`SELECT COUNT(*) AS n FROM manager_trust WHERE lower(COALESCE(tenant, '')) = ? AND lower(owner) IN (${marks})`, tenant, ...aliases)[0].n;
  if (own) lib.sql.exec(`DELETE FROM manager_trust WHERE lower(COALESCE(tenant, '')) = ? AND lower(owner) IN (${marks})`, tenant, ...aliases);
  return n + own;
}
export function eraseDirectoryFor(lib, user, ctx = {}) {
  if (!tableReady(lib, 'directory')) return 0;
  const tenant = String(user.tenant || '').trim().toLowerCase();
  const aliases = subjectAliases(user);
  const mail = String(user.mail || '').toLowerCase();
  const oid = /^[0-9a-f-]{36}:([0-9a-f-]{36})$/.exec(String(user.email || '').toLowerCase())?.[1] || '';
  const keys = [...new Set([mail, oid ? 'oid:' + oid : ''].filter(Boolean))];
  let n = 0;
  if (aliases.length) {
    const marks = aliases.map(() => '?').join(', ');
    const exclude = keys.length ? ` AND lower(key) NOT IN (${keys.map(() => '?').join(', ')})` : '';
    const refs = lib.rows(`SELECT COUNT(*) AS n FROM directory WHERE lower(COALESCE(tenant, '')) = ? AND lower(COALESCE(manager_email, '')) IN (${marks})${exclude}`, tenant, ...aliases, ...keys)[0].n;
    if (refs) {
      lib.sql.exec(`UPDATE directory SET manager_email = ? WHERE lower(COALESCE(tenant, '')) = ? AND lower(COALESCE(manager_email, '')) IN (${marks})${exclude}`, tokenOf(ctx), tenant, ...aliases, ...keys);
      n += refs;
    }
  }
  if (!keys.length) return n;
  const marks = keys.map(() => '?').join(', ');
  const own = lib.rows(`SELECT COUNT(*) AS n FROM directory WHERE lower(COALESCE(tenant, '')) = ? AND lower(key) IN (${marks})`, tenant, ...keys)[0].n;
  if (own) lib.sql.exec(`DELETE FROM directory WHERE lower(COALESCE(tenant, '')) = ? AND lower(key) IN (${marks})`, tenant, ...keys);
  return n + own;
}
function deny(user) {
  if (user.role !== 'admin') throw fail(403, 'The admin dashboard is only for a verified admin.');
  if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
}

export async function adminRoutes(ctx) {
  const { method, parts, user, lib, env = {}, url } = ctx;
  deny(user);
  const action = parts[1] || '';
  if (method === 'GET' && action === 'metrics') {
    const q = url?.searchParams || new URLSearchParams();
    return { body: queryMetrics(lib, user, env, metricQuery(url, q.get('bucket') || 'day')) };
  }
  if (method === 'GET' && action === 'export') {
    const metrics = queryMetrics(lib, user, env, metricQuery(url, 'day'));
    const rows = metrics.series.map(p => ({ bucket: p.bucket, events: p.events, errors: p.errors, actualTokens: p.actualTokens ?? '', missingTokenEvents: p.missingTokens }));
    lib.log('library', user.email, 'admin metrics export', `${rows.length} buckets`);
    await recordUsage(lib, user, { kind: 'export', feature: 'admin', outcome: 'metrics', tokenStatus: 'missing' });
    return { body: { filename: 'atlas-admin-metrics.csv', csv: toCsv(['bucket', 'events', 'errors', 'actualTokens', 'missingTokenEvents'], rows), metrics } };
  }
  if (method === 'POST' && action === 'publish') {
    const id = String(ctx.body?.id || parts[2] || '');
    return { body: await lib.adminPublish(user, id, ctx.body || {}) };
  }
  throw fail(404, 'Not found.');
}

export async function journeyRoutes(ctx) {
  const { method, user, lib, parts } = ctx;
  if (!user.email || user.role === 'external') throw fail(403, 'Sign in to use the journey.');
  if (method === 'GET' && !parts[1]) return { body: journeyView(lib, user) };
  if (method === 'GET' && parts[1] === 'map-draft') return { body: mapDraft(journeyView(lib, user)) };
  if (method === 'POST' && !parts[1]) return { body: await saveJourney(lib, user, ctx.body) };
  throw fail(404, 'Not found.');
}

export async function privacyRoutes(ctx) {
  const { method, user, lib, env = {}, parts } = ctx;
  if (!user.email) throw fail(401, 'Sign in first.');
  if (method === 'GET' && parts[1] === 'disclosure') {
    return { body: {
      consent: { interview: 'interview-v2', spokenAsk: 'spoken-ask-v1', memory: 'memory-v1' },
      recording: 'The microphone starts only after the purpose consent for this session. Stop ends capture. Revoke deletes the local consent flag for spoken Ask.',
      textOnly: 'Project notes, the journey and the reference can be typed. Voice is optional.',
      retention: {
        appTelemetryDays: Number(env.ATLAS_TELEMETRY_DAYS) || 180,
        profileUnseenDays: 395,
        directoryPullCacheDays: 30,
        vendorDeletion: 'not-asserted',
      },
      processors: [
        { name: 'This ATLAS deployment', processes: 'Account, stories, journey, pseudonymous metrics' },
        { name: 'Voice provider configured on the server', processes: 'Audio and transcript only after interview consent. Which provider is running is an operator setting.', usage: 'unknown-until-runtime' },
        { name: 'Optional memory service', processes: 'Retained only when HINDSIGHT_OPT_IN=1 and a key is set. The public Hindsight host is refused unless HINDSIGHT_ALLOW_CLOUD=1.' },
      ],
      lawfulBasis: 'UNRESOLVED — this screen is not a GDPR certification or a DPO decision.',
      biometrics: 'ATLAS does not build a voiceprint or identify you by voice.',
    } };
  }
  if (method === 'GET' && parts[1] === 'export') {
    if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
    ensureJourney(lib);
    const tenant = String(user.tenant || '').toLowerCase();
    const journey = lib.rows('SELECT payload, updated_at FROM journey WHERE subject = ? AND tenant = ?', user.email, tenant)[0] || null;
    const stories = lib.rows('SELECT id, title, status, updated_at, state FROM refs WHERE owner = ?', user.email).filter(r => {
      let recordTenant = '';
      try { recordTenant = JSON.parse(r.state || '{}').tenant || ''; } catch { return false; }
      return sameTenant(recordTenant, user.tenant, user.tenantEnforced === true);
    }).map(r => ({ id: r.id, title: r.title, status: r.status, updatedAt: r.updated_at }));
    let ownedProfile = null;
    try {
      const row = lib.rows('SELECT edits, consents, updated_at FROM profiles WHERE subject = ? AND tenant = ?', user.email, tenant)[0];
      if (row) ownedProfile = { edits: JSON.parse(row.edits || '{}'), consents: JSON.parse(row.consents || '{}'), updatedAt: row.updated_at };
    } catch { /* profile table may be absent */ }
    lib.log('library', user.email, 'dsar export', `${stories.length} stories`);
    return { body: { subject: user.email, tenant: user.tenant || '', journey: journey ? JSON.parse(journey.payload) : null, profile: ownedProfile, stories,
      stores: dsarStores(), note: 'This export lists the local rows for this subject and tenant. It is not a vendor-log extract and it does not mean every store was erased.' } };
  }
  if (method === 'POST' && parts[1] === 'delete') {
    const tenant = String(user.tenant || '').trim().toLowerCase();
    if (!TENANT_ID.test(tenant)) throw fail(403, 'A verified tenant is required.');
    const outcomes = [];
    const attempt = (store, fn) => {
      try { outcomes.push({ store, removed: fn(), error: null }); }
      catch { outcomes.push({ store, removed: 0, error: 'delete-failed' }); }
    };
    attempt('journey', () => eraseJourneyFor(lib, user));
    attempt('telemetry', () => eraseTelemetryFor(lib, user));
    attempt('profile', () => deleteOwnedProfile(lib, user));
    attempt('manager-trust', () => eraseManagerTrustFor(lib, user));
    attempt('directory', () => eraseDirectoryFor(lib, user));
    lib.log('library', user.email, 'privacy delete', outcomes.map(o => o.store + (o.error ? ' failed' : ' ' + o.removed)).join(', '));
    return { body: { outcomes, ...dsarStores(), complete: false, vendorDeletion: 'not-asserted', note: 'Each store reports only what this request removed for this subject and tenant. An error means that store was not removed. Other tenants, other people, and blank-tenant rows are not counted. Stories, staffing, invitations, and audit history are not deleted. Quarantine is not deletion. Vendor deletion is not-asserted. This is not a GDPR certification.' } };
  }
  if (method === 'POST' && user.role === 'admin' && parts[1] === 'purge-telemetry') {
    if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
    return { body: purgeTelemetry(lib, Number(env.ATLAS_TELEMETRY_DAYS) || 180, user) };
  }
  throw fail(404, 'Not found.');
}
