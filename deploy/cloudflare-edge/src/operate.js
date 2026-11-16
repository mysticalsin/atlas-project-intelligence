// Admin metrics, journey and privacy routes. Every handler checks the server role again.
import { fail } from './util.js';
import { sameTenant, TENANT_ID } from './authz.js';
import { queryMetrics, recordUsage, purgeTelemetry, personaKey, ensureTelemetry } from './telemetry.js';
import { toCsv } from './csvsafe.js';
import { journeyView, saveJourney, mapDraft, ensureJourney, journeyMatches, journeyTenant, journeyExport, omittedRow, JOURNEY_COUNT_SQL, JOURNEY_DELETE_SQL } from './journey.js';
import { deleteOwnedProfile, ensure as ensureProfile, profileSelection } from './profile.js';
import { placeholders, readChunks, writeChunks, withTransaction } from './sql-bound.js';
import { readPublication } from './publication.js';

function metricQuery(url, bucket = 'day') {
  const q = url?.searchParams || new URLSearchParams();
  return { from: q.get('from') || '', to: q.get('to') || '', bucket: q.get('bucket') || bucket, afterAt: q.get('afterAt') || '', afterId: q.get('afterId') || '' };
}
function dsarStores() {
  return {
    coveredLocal: ['journey for this subject and tenant', 'profile for this subject and tenant', 'telemetry for this persona and tenant', 'manager trust for this subject and tenant', 'this subject\'s directory row for this tenant'],
    retained: [
      { store: 'legacy-blank-tenant-rows', action: 'quarantined', note: 'Blank ownership stays blank. It was not assigned a tenant and was not deleted by this request. A privacy export names it legacy_unscoped and does not include its content. An operator resolves it by a reviewed migration that assigns the tenant.' },
      { store: 'hindsight-bank', action: 'not-contacted', note: 'The vendor bank was not called. A subject-only bank is not read when a verified tenant is present, and it was not deleted.' },
      { store: 'interview-object', action: 'not-deleted', note: 'The Interview object was not opened and was not erased.' },
      { store: 'vendor-logs', action: 'not-asserted' },
      { store: 'directory-and-audit', action: 'retained', note: 'Directory keys for this subject and tenant are listed in outcomes. Audit rows are not deleted. This response does not report any other row.' },
    ],
    complete: false,
  };
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

// Empty text is an empty object. Anything that is not an object is unreadable.
function jsonObject(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch { return null; }
}

// A readable story keeps the tenant stored in its state. An unreadable one can only be scoped by the row's tenant column.
function exportStories(rows, user) {
  const stories = [];
  const omitted = [];
  const enforced = user.tenantEnforced === true;
  for (const row of rows) {
    const stored = jsonObject(row.state);
    if (!stored) {
      if (sameTenant(row.tenant, user.tenant, enforced)) omitted.push(omittedRow(row.id, 'story'));
      continue;
    }
    if (!sameTenant(stored.tenant || '', user.tenant, enforced)) continue;
    const viewed = readPublication(stored);
    stories.push({ id: row.id, title: row.title, status: viewed.status == null ? row.status : viewed.status, updatedAt: row.updated_at });
  }
  omitted.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { stories, omitted };
}

// The same profile migration and the same profileSelection the read, write and erasure use. A missing table or
// no folded match is absence. A blank-tenant row for this subject is named and not returned. An unreadable edits
// or consents value is an omission; the other part is returned. Further folded matches are named and not merged.
function exportProfile(lib, email, tenant) {
  ensureProfile(lib);
  let selected;
  try { selected = profileSelection(lib, email, tenant); }
  catch (error) {
    if (String(error && error.message).includes('no such table')) return { profile: null, omitted: [] };
    throw error;
  }
  const omitted = [];
  for (const row of selected.unscoped) omitted.push(omittedRow(row.id, 'profile', 'legacy_unscoped'));
  for (const row of selected.collapsed) omitted.push(omittedRow(row.id, 'profile', row.reason || 'duplicate'));
  if (!selected.matched.length) return { profile: null, omitted };
  const row = selected.matched[0];
  const profile = {};
  const edits = jsonObject(row.edits);
  const consents = jsonObject(row.consents);
  if (edits) profile.edits = edits;
  else omitted.push(omittedRow('edits', 'profile'));
  if (consents) profile.consents = consents;
  else omitted.push(omittedRow('consents', 'profile'));
  profile.updatedAt = row.updated_at;
  for (const extra of selected.matched.slice(1)) omitted.push(omittedRow(extra.id, 'profile', 'duplicate'));
  return { profile, omitted };
}

// The tenant is one parameter and the alias list is bound twice. Chunks of aliases stay
// at or under 100. The row deletes share one transaction, and they join a transaction
// the caller already opened.
export function eraseManagerTrust(lib, tenant, aliases) {
  if (!aliases.length) return 0;
  const ids = [...new Set(readChunks(lib, aliases, {
    fixed: 1,
    copies: 2,
    sql: chunk => `SELECT rowid AS id FROM manager_trust WHERE lower(COALESCE(tenant, '')) = ? AND (lower(owner) IN (${placeholders(chunk.length)}) OR lower(email) IN (${placeholders(chunk.length)}))`,
    params: chunk => [tenant, ...chunk, ...chunk],
  }).map(row => row.id))];
  writeChunks(lib, [{
    values: ids,
    sql: chunk => `DELETE FROM manager_trust WHERE rowid IN (${placeholders(chunk.length)})`,
    params: chunk => chunk,
  }]);
  return ids.length;
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
    const tenant = String(user.tenant || '').toLowerCase();
    const { journey, omitted: journeyOmitted } = journeyExport(journeyMatches(lib, user.email, journeyTenant(user)));
    const { stories, omitted: storyOmitted } = exportStories(lib.rows('SELECT id, title, status, updated_at, state, tenant FROM refs WHERE owner = ? ORDER BY id', user.email), user);
    const { profile, omitted: profileOmitted } = exportProfile(lib, user.email, tenant);
    const omittedRows = [...journeyOmitted.rows, ...storyOmitted, ...profileOmitted];
    const omitted = { count: omittedRows.length, rows: omittedRows };
    lib.log('library', user.email, 'dsar export', `${stories.length} stories`);
    return { body: { subject: user.email, tenant: user.tenant || '', journey, omitted, profile, stories,
      stores: dsarStores(), note: 'This export lists the local rows for this subject and tenant. It is not a vendor-log extract and it does not mean every store was erased.' } };
  }
  if (method === 'POST' && parts[1] === 'delete') {
    const tenant = journeyTenant(user);
    if (!TENANT_ID.test(tenant)) throw fail(403, 'A verified tenant is required.');
    const persona = await personaKey(user);
    ensureJourney(lib);
    ensureTelemetry(lib);
    ensureProfile(lib);
    const aliases = [...new Set([user.email, user.mail].map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
    const count = (sql, ...params) => lib.rows(sql, ...params)[0].n;
    let outcomes;
    try {
      outcomes = withTransaction(lib, () => {
        const journey = count(JOURNEY_COUNT_SQL, user.email, tenant);
        if (journey) lib.sql.exec(JOURNEY_DELETE_SQL, user.email, tenant);
        const telemetry = count("SELECT COUNT(*) AS n FROM telemetry WHERE persona = ? AND lower(COALESCE(tenant, '')) = ?", persona, tenant);
        if (telemetry) lib.sql.exec("DELETE FROM telemetry WHERE persona = ? AND lower(COALESCE(tenant, '')) = ?", persona, tenant);
        const profile = deleteOwnedProfile(lib, user);
        const trust = eraseManagerTrust(lib, tenant, aliases);
        const mail = String(user.mail || '').toLowerCase();
        const oid = /^[0-9a-f-]{36}:([0-9a-f-]{36})$/.exec(String(user.email || '').toLowerCase())?.[1] || '';
        const keys = [...new Set([mail, oid ? 'oid:' + oid : ''].filter(Boolean))];
        let directory = 0;
        if (keys.length) {
          // sql-bound-fixed: 3
          const marks = keys.map(() => '?').join(', ');
          directory = count(`SELECT COUNT(*) AS n FROM directory WHERE lower(COALESCE(tenant, '')) = ? AND lower(key) IN (${marks})`, tenant, ...keys);
          if (directory) lib.sql.exec(`DELETE FROM directory WHERE lower(COALESCE(tenant, '')) = ? AND lower(key) IN (${marks})`, tenant, ...keys);
        }
        return [
          { store: 'journey', removed: journey, error: null },
          { store: 'telemetry', removed: telemetry, error: null },
          { store: 'profile', removed: profile, error: null },
          { store: 'manager-trust', removed: trust, error: null },
          { store: 'directory', removed: directory, error: null },
        ];
      });
    } catch (error) {
      if (error.status) throw error;
      throw fail(500, 'The deletion did not finish. Nothing was removed.');
    }
    lib.log('library', user.email, 'privacy delete', outcomes.map(o => o.store + ' ' + o.removed).join(', '));
    return { body: { outcomes, ...dsarStores(), complete: false, vendorDeletion: 'not-asserted', note: 'Each store reports only what this request removed for this subject and tenant. An error means that store was not removed. Other tenants, other people, and blank-tenant rows are not counted. Stories, staffing, invitations, and audit history are not deleted. Quarantine is not deletion. Vendor deletion is not-asserted. This is not a GDPR certification.' } };
  }
  if (method === 'POST' && user.role === 'admin' && parts[1] === 'purge-telemetry') {
    if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
    return { body: purgeTelemetry(lib, Number(env.ATLAS_TELEMETRY_DAYS) || 180, user) };
  }
  throw fail(404, 'Not found.');
}
