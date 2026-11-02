// Retention sweep (v2.2 G2): the LibraryStore's part of the retention schedule, run by the daily scan-stale cron. The periods come from
// atlas_voice/config/retention.json (generated into policy.generated.js as RETENTION); every period there is "PROPOSAL — DPO to confirm", so a change of the JSON changes the
// sweep. It returns COUNTS only (never an id or a word of content). Categories with `sweep: false` (security logs, private memory, the 24-hour checkpoint) are enforced by
// the platform, a per-person prune or a Durable Object alarm (see notSwept).
import { RETENTION } from './policy.generated.js';
import { eraseRefContent, eraseEvidenceContent } from './subject-rights.js';
import { rewriteRows } from './audit-chain.js';
import * as privacy from './privacy.js';

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const token = () => 'erased:' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
const SYSTEM_ACTORS = new Set(['atlas', 'atlas-cron', 'library', 'pm-system', 'dna-push', 'system', 'privacy']);
const tableExists = (lib, name) => lib.rows("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
const cat = (retention, id) => retention.categories.find(c => c.id === id);
const before = (now, c) => new Date(Date.parse(now) - (c.hours ? c.hours * 36e5 : c.days * 864e5)).toISOString();

export function sweep(lib, { now = lib.now(), retention = RETENTION } = {}) {
  privacy.ensure(lib);
  const out = {}, add = (k, n) => { if (n) out[k] = (out[k] || 0) + n; };
  const c = id => cat(retention, id), erasedToken = token();
  // Private drafts nobody submitted: the reference (owner-only) and the evidence draft.
  if (c('drafts')) {
    const cut = before(now, c('drafts'));
    for (const r of lib.rows("SELECT id, state FROM refs WHERE updated_at < ? AND (merged_into IS NULL OR merged_into != 'erased')", cut)) if (parse(r.state, {}).draft) { eraseRefContent(lib, r.id, erasedToken, now); add('draftReferences', 1); }
    for (const r of lib.rows("SELECT id, state_json FROM evidence_records WHERE status = 'evidence_draft' AND updated_at < ?", cut)) {
      const s = parse(r.state_json, {}); if (s.erased || s.ever_submitted || s.erasure_pending_review) continue;
      eraseEvidenceContent(lib, r.id, erasedToken, now); add('draftEvidence', 1);
    }
  }
  // Withdrawn references (counted from the withdrawal in the audit trail) that no bid uses and no erasure review still holds.
  if (c('withdrawn_refs')) {
    const cut = before(now, c('withdrawn_refs')), hasBids = tableExists(lib, 'bid_references');
    for (const r of lib.rows("SELECT id, state, updated_at FROM refs WHERE status = 'withdrawn' AND merged_into IS NULL")) {
      const s = parse(r.state, {});
      if (!s.withdrawn || s.erased || s.erasure_pending_review) continue;
      const w = lib.rows("SELECT at FROM audit WHERE id = ? AND action = 'withdrawn' ORDER BY seq DESC LIMIT 1", r.id)[0];
      if ((w?.at || r.updated_at) >= cut || (hasBids && lib.rows('SELECT 1 AS x FROM bid_references WHERE ref_id = ? LIMIT 1', r.id).length)) continue;
      eraseRefContent(lib, r.id, erasedToken, now); add('withdrawnReferences', 1);
    }
  }
  // Rejected or withdrawn evidence.
  if (c('rejected_evidence')) {
    const cut = before(now, c('rejected_evidence'));
    for (const r of lib.rows("SELECT id, state_json FROM evidence_records WHERE status IN ('rejected', 'closed_rejected', 'withdrawn') AND updated_at < ?", cut)) {
      const s = parse(r.state_json, {}); if (s.erased || s.erasure_pending_review) continue;
      eraseEvidenceContent(lib, r.id, erasedToken, now); add('rejectedEvidence', 1);
    }
  }
  // Expired confirmation and proof requests (90 days after they expired; a proof request expires 30 days after it was made).
  if (c('expired_requests') && tableExists(lib, 'confirmation_requests')) {
    const cut = before(now, c('expired_requests')), gapCut = new Date(Date.parse(cut) - 30 * 864e5).toISOString();
    const n = lib.rows('SELECT COUNT(*) AS n FROM confirmation_requests WHERE expires_at < ?', cut)[0].n;
    if (n) { lib.sql.exec('DELETE FROM confirmation_requests WHERE expires_at < ?', cut); add('confirmationRequests', n); }
    if (tableExists(lib, 'gap_requests')) {
      const g = lib.rows("SELECT COUNT(*) AS n FROM gap_requests WHERE status != 'open' AND created_at < ?", gapCut)[0].n;
      if (g) { lib.sql.exec("DELETE FROM gap_requests WHERE status != 'open' AND created_at < ?", gapCut); add('proofRequests', g); }
    }
  }
  // Outreach messages and finished interview invitations.
  if (c('outreach')) {
    const cut = before(now, c('outreach'));
    if (tableExists(lib, 'outreach')) { const n = lib.rows('SELECT COUNT(*) AS n FROM outreach WHERE created_at < ?', cut)[0].n; if (n) { lib.sql.exec('DELETE FROM outreach WHERE created_at < ?', cut); add('outreach', n); } }
    const i = lib.rows("SELECT COUNT(*) AS n FROM invitations WHERE status IN ('done', 'dismissed') AND created_at < ?", cut)[0].n;
    if (i) { lib.sql.exec("DELETE FROM invitations WHERE status IN ('done', 'dismissed') AND created_at < ?", cut); add('invitations', i); }
  }
  // Staffing import rows: N days after the project ended (the end date), else after the last import.
  if (c('staffing_imports') && tableExists(lib, 'staffing')) {
    const cut = before(now, c('staffing_imports')), day = cut.slice(0, 10);
    const n = lib.rows("SELECT COUNT(*) AS n FROM staffing WHERE (end_date != '' AND end_date < ?) OR (end_date = '' AND updated_at < ?)", day, cut)[0].n;
    if (n) { lib.sql.exec("DELETE FROM staffing WHERE (end_date != '' AND end_date < ?) OR (end_date = '' AND updated_at < ?)", day, cut); add('staffingRows', n); }
  }
  // Audit rows older than the period: the actor becomes a token and the detail is cleared; the hash chain is re-sealed (the new head is returned for the log).
  if (c('audit')) {
    const cut = before(now, c('audit')), names = new Map();
    const r = rewriteRows(lib.sql, row => {
      if (row.at >= cut || (String(row.actor || '').startsWith('erased:') && row.detail === '')) return null;
      const personal = row.actor && !SYSTEM_ACTORS.has(row.actor) && !String(row.actor).startsWith('erased:');
      if (!personal && row.detail === '') return null;
      if (personal && !names.has(row.actor)) names.set(row.actor, token());
      return { actor: personal ? names.get(row.actor) : row.actor, detail: '' };
    });
    if (r.refused) out.auditRefused = { reason: r.reason, brokenSeq: r.brokenSeq }; // X1 (red M8): a chain that does not verify is left untouched; the cron reports it
    else if (r.changed) { add('auditRows', r.changed); out.auditHead = r.head; out.auditPreviousHead = r.previousHead; }
  }
  // Consent receipts of a person whose latest receipt is older than the period.
  if (c('consent_receipts')) {
    const cut = before(now, c('consent_receipts'));
    const n = lib.rows('SELECT COUNT(*) AS n FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)', cut)[0].n;
    if (n) { privacy.retentionGate(lib, () => lib.sql.exec('DELETE FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)', cut)); add('consentReceipts', n); }
  }
  return out;
}
// The periods the sweep does NOT enforce (platform, per-person prune, alarm): reported by the privacy notice and the docs, so nobody reads silence as "done".
export const notSwept = (retention = RETENTION) => retention.categories.filter(x => !x.sweep).map(x => x.id);
