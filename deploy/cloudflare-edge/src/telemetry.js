// Pseudonymous operational metrics. No transcript, audio, secret, or client name is stored.
// Token counts are actual only when a provider returned them. Missing stays missing, never zero.
// A cost figure is emitted only when the operator configured a unit rate and a currency.

import { fail, str } from './util.js';
import { sameTenant, TENANT_ID } from './authz.js';
import { sha256Hex } from './audit-chain.js';
import { readPublication } from './publication.js';

const DAY = 864e5;
const KINDS = new Set(['interview', 'approval', 'export', 'admin_publish', 'journey', 'error', 'usage']);
const TOKEN = new Set(['actual', 'missing', 'unknown', 'estimated']);

export function personaKeySync(user = {}) {
  const raw = `${String(user.tenant || '').toLowerCase()}|${String(user.email || user.sub || '').toLowerCase()}`;
  return sha256Hex('atlas-persona:' + raw).slice(0, 16);
}
export async function personaKey(user = {}) {
  return personaKeySync(user);
}

export function ensureTelemetry(lib) {
  lib.schema(() => {
  lib.exec(`CREATE TABLE IF NOT EXISTS telemetry (
    id TEXT PRIMARY KEY, at TEXT, tenant TEXT, persona TEXT, kind TEXT, feature TEXT, outcome TEXT,
    latency_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, token_status TEXT, model TEXT, error_class TEXT)`);
  lib.exec('CREATE INDEX IF NOT EXISTS telemetry_at ON telemetry(at)');
  });
}

function num(v) {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

export async function recordUsage(lib, user, event = {}) {
  ensureTelemetry(lib);
  const tokenStatus = TOKEN.has(event.tokenStatus) ? event.tokenStatus : (event.tokensIn == null && event.tokensOut == null ? 'missing' : 'unknown');
  const tokensIn = tokenStatus === 'actual' || tokenStatus === 'estimated' ? num(event.tokensIn) : null;
  const tokensOut = tokenStatus === 'actual' || tokenStatus === 'estimated' ? num(event.tokensOut) : null;
  const persona = await personaKey(user);
  lib.housekeeping('telemetry', () => {
    lib.exec(`INSERT INTO telemetry (id, at, tenant, persona, kind, feature, outcome, latency_ms, tokens_in, tokens_out, token_status, model, error_class)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      lib.newId(), event.at || lib.now(), str(user.tenant, 80), persona,
      KINDS.has(event.kind) ? event.kind : 'usage', str(event.feature, 40) || 'app', str(event.outcome, 40) || 'ok',
      num(event.latencyMs), tokensIn, tokensOut, tokenStatus, str(event.model, 80), str(event.errorClass, 60));
  });
}

function rates(env = {}) {
  const inn = Number(env.ATLAS_TOKEN_RATE_IN);
  const out = Number(env.ATLAS_TOKEN_RATE_OUT);
  const currency = str(env.ATLAS_COST_CURRENCY, 8);
  if (!currency || !Number.isFinite(inn) || !Number.isFinite(out) || inn < 0 || out < 0) return null;
  return { in: inn, out, currency, basis: 'configured-unit-rate' };
}

function bucketOf(iso, bucket) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (bucket === 'week') {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const shift = (day.getUTCDay() + 6) % 7;
    day.setUTCDate(day.getUTCDate() - shift);
    return day.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

export function queryMetrics(lib, user, env = {}, query = {}) {
  ensureTelemetry(lib);
  const now = Date.parse(lib.now()) || Date.now();
  const to = query.to || new Date(now).toISOString();
  const from = query.from || new Date(now - 30 * DAY).toISOString();
  const bucket = query.bucket === 'week' ? 'week' : 'day';
  const tenant = String(user.tenant || '');
  const enforced = user.tenantEnforced === true;
  if (enforced && !TENANT_ID.test(tenant)) {
    return { from, to, bucket, events: 0, errors: 0, denied: 'A verified tenant is required.', tokens: { actualIn: 0, actualOut: 0, estimatedIn: 0, estimatedOut: 0, missing: 0, unknown: 0, actualEvents: 0, estimatedEvents: 0 }, estimatedCost: null, costStatus: 'not-configured', series: [], features: {}, outcomes: {}, workflow: {}, note: 'Refused. Missing tenant is not zero usage.' };
  }
  const limit = 5000;
  const scoped = String(tenant || '').toLowerCase();
  const afterAt = String(query.afterAt || '');
  const afterId = String(query.afterId || '');
  if ((afterAt && !afterId) || (!afterAt && afterId) || afterAt.length > 40 || afterId.length > 80 || (afterAt && Number.isNaN(Date.parse(afterAt)))) {
    return { from, to, bucket, events: 0, errors: 0, denied: 'The page cursor is not valid.', tokens: { actualIn: 0, actualOut: 0, estimatedIn: 0, estimatedOut: 0, missing: 0, unknown: 0, actualEvents: 0, estimatedEvents: 0 }, estimatedCost: null, costStatus: 'not-configured', series: [], features: {}, outcomes: {}, workflow: {}, note: 'Refused. An invalid cursor is not an empty page of real usage.' };
  }
  const rows = lib.rows(`SELECT * FROM telemetry WHERE lower(COALESCE(tenant, '')) = ? AND at >= ? AND at <= ? ${afterAt ? 'AND (at > ? OR (at = ? AND id > ?))' : ''} ORDER BY at ASC, id ASC LIMIT ?`,
    ...(afterAt ? [scoped, from, to, afterAt, afterAt, afterId, limit + 1] : [scoped, from, to, limit + 1]));
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  const cost = rates(env);
  const series = new Map();
  const features = {};
  const outcomes = {};
  const tokens = { actualIn: 0, actualOut: 0, estimatedIn: 0, estimatedOut: 0, missing: 0, unknown: 0, actualEvents: 0, estimatedEvents: 0 };
  let latencySum = 0, latencyN = 0, errors = 0;
  let estimatedCost = null;
  for (const r of page) {
    const key = bucketOf(r.at, bucket) || 'unknown';
    if (!series.has(key)) series.set(key, { bucket: key, events: 0, errors: 0, actualTokens: null, missingTokens: 0 });
    const point = series.get(key);
    point.events += 1;
    features[r.feature || 'app'] = (features[r.feature || 'app'] || 0) + 1;
    outcomes[r.outcome || 'ok'] = (outcomes[r.outcome || 'ok'] || 0) + 1;
    if (r.outcome === 'error' || r.kind === 'error') { errors += 1; point.errors += 1; }
    if (Number.isFinite(r.latency_ms)) { latencySum += r.latency_ms; latencyN += 1; }
    if (r.token_status === 'actual') {
      tokens.actualEvents += 1;
      tokens.actualIn += r.tokens_in || 0;
      tokens.actualOut += r.tokens_out || 0;
      point.actualTokens = (point.actualTokens || 0) + (r.tokens_in || 0) + (r.tokens_out || 0);
    } else if (r.token_status === 'estimated') {
      tokens.estimatedEvents += 1;
      tokens.estimatedIn += r.tokens_in || 0;
      tokens.estimatedOut += r.tokens_out || 0;
    } else if (r.token_status === 'unknown') tokens.unknown += 1;
    else { tokens.missing += 1; point.missingTokens += 1; }
  }
  if (cost && (tokens.actualEvents || tokens.estimatedEvents)) {
    const inn = (tokens.actualIn + tokens.estimatedIn) * cost.in;
    const out = (tokens.actualOut + tokens.estimatedOut) * cost.out;
    estimatedCost = { amount: Math.round((inn + out) * 1e6) / 1e6, currency: cost.currency, basis: cost.basis, includesEstimatedTokens: tokens.estimatedEvents > 0 };
  }
  const workflow = workflowCounts(lib, tenant, enforced);
  return {
    from, to, bucket, truncated, limit,
    next: truncated ? { afterAt: page.at(-1).at, afterId: page.at(-1).id } : null,
    events: page.length,
    errors,
    latencyMs: latencyN ? { average: Math.round(latencySum / latencyN), samples: latencyN } : { average: null, samples: 0, status: 'missing' },
    tokens,
    estimatedCost,
    costStatus: estimatedCost ? 'estimated-from-configured-rates' : 'not-configured',
    series: [...series.values()],
    features, outcomes, workflow,
    note: 'Counts are pseudonymous events in this deployment. Absent token fields are missing, not zero. Cost is omitted until ATLAS_TOKEN_RATE_IN, ATLAS_TOKEN_RATE_OUT and ATLAS_COST_CURRENCY are set. Rates are operator unit prices, not a vendor invoice.',
  };
}

function workflowCounts(lib, tenant, enforced) {
  let rows = [];
  try { rows = lib.rows('SELECT status, state, owner FROM refs WHERE merged_into IS NULL'); } catch { return { status: 'missing' }; }
  const out = { draft: 0, awaiting_manager: 0, awaiting_presales: 0, published: 0, admin_test: 0, withdrawn: 0 };
  for (const r of rows) {
    let stored = {};
    try { stored = JSON.parse(r.state || '{}'); } catch { stored = {}; }
    const viewed = readPublication(stored);
    const state = viewed.state;
    const status = viewed.status == null ? r.status : viewed.status;
    if (!sameTenant(stored.tenant, tenant, enforced)) continue;
    if (status === 'withdrawn') out.withdrawn += 1;
    else if (status === 'published') out.published += 1;
    else if (status === 'admin_test') out.admin_test += 1;
    else if (state.validation?.managerDecision === 'approved') out.awaiting_presales += 1;
    else out.awaiting_manager += 1;
    if (!state.quality) out.draft += 1;
  }
  return out;
}

export function purgeTelemetry(lib, days = 180, user = {}) {
  ensureTelemetry(lib);
  if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
  const tenant = String(user.tenant || '').toLowerCase();
  const n = Math.min(3650, Math.max(7, Number(days) || 180));
  const cut = new Date(Date.parse(lib.now()) - n * DAY).toISOString();
  const before = lib.rows("SELECT COUNT(*) AS n FROM telemetry WHERE at < ? AND lower(COALESCE(tenant, '')) = ?", cut, tenant)[0]?.n || 0;
  if (before) lib.housekeeping('telemetry-purge', () => lib.exec("DELETE FROM telemetry WHERE at < ? AND lower(COALESCE(tenant, '')) = ?", cut, tenant));
  return { purged: before, retainDays: n, tenant };
}
