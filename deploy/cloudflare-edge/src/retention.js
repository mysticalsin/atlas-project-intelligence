// Retention sweep (v2.2 G2): the LibraryStore's part of the retention schedule, run by the daily scan-stale cron. The periods come from
// atlas_voice/config/retention.json (generated into policy.generated.js as RETENTION); every period there is "PROPOSAL — DPO to confirm", so a change of the JSON changes the
// sweep. It returns COUNTS only (never an id or a word of content). Categories with `sweep: false` (security logs, private memory, the 24-hour checkpoint) are enforced by
// the platform, a per-person prune or a Durable Object alarm (see notSwept).
import { RETENTION } from './policy.generated.js';
import { eraseRefContent } from './subject-rights.js';
import * as privacy from './privacy.js';

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const token = () => 'erased:' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
const SYSTEM_ACTORS = new Set(['atlas', 'atlas-cron', 'library', 'pm-system', 'dna-push', 'system', 'privacy']);
const tableExists = (lib, name) => lib.rows("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
const cat = (retention, id) => retention.categories.find(c => c.id === id);
const before = (now, c) => new Date(Date.parse(now) - (c.hours ? c.hours * 36e5 : c.days * 864e5)).toISOString();

const TENANT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hasTenantColumn = (lib, table) => tableExists(lib, table) && lib.rows("SELECT 1 AS x FROM pragma_table_info('" + table + "') WHERE name = 'tenant'").length > 0;

export function sweep(lib, { now = lib.now(), retention = RETENTION, tenant } = {}) {
  // No tenant argument deletes nothing. A blank tenant is the local sandbox only. A real id never touches blank or other tenants.
  if (tenant === undefined) return {};
  const tid = String(tenant || '').trim().toLowerCase();
  if (tid && !TENANT_RE.test(tid)) return {};
  return lib.housekeeping('retention', () => {
  privacy.ensure(lib);
  const out = {}, add = (k, n) => { if (n) out[k] = (out[k] || 0) + n; };
  const c = id => cat(retention, id), erasedToken = token();
  const scope = "lower(COALESCE(tenant, '')) = ?";
  const refIds = new Set(lib.rows('SELECT id FROM refs WHERE ' + scope, tid).map(r => r.id));
  // Private drafts nobody submitted: the reference (owner-only) and the evidence draft.
  if (c('drafts')) {
    const cut = before(now, c('drafts'));
    for (const r of lib.rows("SELECT id, state FROM refs WHERE updated_at < ? AND " + scope + " AND (merged_into IS NULL OR merged_into != 'erased')", cut, tid)) if (parse(r.state, {}).draft) {
      try { eraseRefContent(lib, r.id, erasedToken, now); add('draftReferences', 1); }
      catch (error) {
        if (error.status !== 409) throw error;
        out.auditRefused = out.auditRefused || { reason: error.code || 'CHAIN_DAMAGED', brokenSeq: error.brokenSeq };
      }
    }
  }
  // Withdrawn references (counted from the withdrawal in the audit trail) that no bid uses and no erasure review still holds.
  if (c('withdrawn_refs')) {
    const cut = before(now, c('withdrawn_refs')), hasBids = tableExists(lib, 'bid_references');
    for (const r of lib.rows("SELECT id, state, updated_at FROM refs WHERE status = 'withdrawn' AND merged_into IS NULL AND " + scope, tid)) {
      const s = parse(r.state, {});
      if (!s.withdrawn || s.erased || s.erasure_pending_review) continue;
      const w = lib.rows("SELECT at FROM audit WHERE id = ? AND action = 'withdrawn' ORDER BY seq DESC LIMIT 1", r.id)[0];
      if ((w?.at || r.updated_at) >= cut || (hasBids && lib.rows('SELECT 1 AS x FROM bid_references WHERE ref_id = ? LIMIT 1', r.id).length)) continue;
      try { eraseRefContent(lib, r.id, erasedToken, now); add('withdrawnReferences', 1); }
      catch (error) {
        if (error.status !== 409) throw error;
        out.auditRefused = out.auditRefused || { reason: error.code || 'CHAIN_DAMAGED', brokenSeq: error.brokenSeq };
      }
    }
  }
  // Expired confirmation and proof requests (90 days after they expired; a proof request expires 30 days after it was made).
  if (c('expired_requests') && hasTenantColumn(lib, 'confirmation_requests')) {
    const cut = before(now, c('expired_requests')), gapCut = new Date(Date.parse(cut) - 30 * 864e5).toISOString();
    const n = lib.rows('SELECT COUNT(*) AS n FROM confirmation_requests WHERE expires_at < ? AND ' + scope, cut, tid)[0].n;
    if (n) { lib.exec('DELETE FROM confirmation_requests WHERE expires_at < ? AND ' + scope, cut, tid); add('confirmationRequests', n); }
    if (hasTenantColumn(lib, 'gap_requests')) {
      const g = lib.rows("SELECT COUNT(*) AS n FROM gap_requests WHERE status != 'open' AND created_at < ? AND " + scope, gapCut, tid)[0].n;
      if (g) { lib.exec("DELETE FROM gap_requests WHERE status != 'open' AND created_at < ? AND " + scope, gapCut, tid); add('proofRequests', g); }
    }
  }
  // Outreach messages and finished interview invitations.
  if (c('outreach')) {
    const cut = before(now, c('outreach'));
    if (hasTenantColumn(lib, 'outreach')) { const n = lib.rows('SELECT COUNT(*) AS n FROM outreach WHERE created_at < ? AND ' + scope, cut, tid)[0].n; if (n) { lib.exec('DELETE FROM outreach WHERE created_at < ? AND ' + scope, cut, tid); add('outreach', n); } }
    if (hasTenantColumn(lib, 'invitations')) {
      const i = lib.rows("SELECT COUNT(*) AS n FROM invitations WHERE status IN ('done', 'dismissed') AND created_at < ? AND " + scope, cut, tid)[0].n;
      if (i) { lib.exec("DELETE FROM invitations WHERE status IN ('done', 'dismissed') AND created_at < ? AND " + scope, cut, tid); add('invitations', i); }
    }
  }
  // Staffing import rows: N days after the project ended (the end date), else after the last import.
  if (c('staffing_imports') && tableExists(lib, 'staffing')) {
    const cut = before(now, c('staffing_imports')), day = cut.slice(0, 10);
    const n = lib.rows("SELECT COUNT(*) AS n FROM staffing WHERE " + scope + " AND ((end_date != '' AND end_date < ?) OR (end_date = '' AND updated_at < ?))", tid, day, cut)[0].n;
    if (n) { lib.exec("DELETE FROM staffing WHERE " + scope + " AND ((end_date != '' AND end_date < ?) OR (end_date = '' AND updated_at < ?))", tid, day, cut); add('staffingRows', n); }
  }
  // Audit rows older than the period become a tombstone. The proof is stored and later hashes stay, so the head does not move.
  if (c('audit')) {
    const cut = before(now, c('audit')), names = new Map();
    const groups = new Map();
    for (const row of lib.rows('SELECT seq, id, actor, detail, at FROM audit')) {
      if (!refIds.has(String(row.id || ''))) continue;
      if (row.at >= cut || (String(row.actor || '').startsWith('erased:') && row.detail === '')) continue;
      const personal = row.actor && !SYSTEM_ACTORS.has(row.actor) && !String(row.actor).startsWith('erased:');
      if (!personal && row.detail === '') continue;
      if (!names.has(row.actor)) names.set(row.actor, token());
      const tombstone = names.get(row.actor);
      if (!groups.has(tombstone)) groups.set(tombstone, []);
      groups.get(tombstone).push(Number(row.seq));
    }
    let changed = 0, refused = null, head = null, previousHead = null;
    for (const [tombstone, seqs] of groups) {
      const r = lib.rewriteAudit(tombstone, seqs);
      changed += r.changed || 0;
      if (r.head) { head = r.head; previousHead = r.previousHead; }
      if (r.refused) refused = r;
    }
    if (refused) out.auditRefused = { reason: refused.reason, brokenSeq: refused.brokenSeq }; // X1 (red M8): a chain that does not verify is left untouched; the cron reports it
    else if (changed) { add('auditRows', changed); out.auditHead = head; out.auditPreviousHead = previousHead; }
  }
  // Consent receipts are keyed by subject hash and have no tenant column. Only the blank local sandbox may sweep them.
  // A verified tenant must not delete another tenant's receipts for the same person.
  if (c('consent_receipts') && tid === '') {
    const cut = before(now, c('consent_receipts'));
    const n = lib.rows('SELECT COUNT(*) AS n FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)', cut)[0].n;
    if (n) { privacy.retentionGate(lib, () => lib.exec('DELETE FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)', cut)); add('consentReceipts', n); }
  }
  return out;
  });
}
// The periods the sweep does NOT enforce (platform, per-person prune, alarm): reported by the privacy notice and the docs, so nobody reads silence as "done".
export const notSwept = (retention = RETENTION) => retention.categories.filter(x => !x.sweep).map(x => x.id);
