// POST /api/csp-report (v2.2 F1): where the browser delivers Content-Security-Policy violation reports (both the legacy `report-uri`
// body, application/csp-report, and the Reporting API `report-to` body, application/reports+json). A report is untrusted input from
// any page script, so it is bounded (8 KiB, streamed), rate-limited per person by the caller, and reduced to two short facts that
// are logged as a `csp_violation` security event: the violated DIRECTIVE name and the ORIGIN (never a path, query, sample or the
// document URL) of what was blocked. Nothing is stored and nothing is echoed. The answer is always 204.
import { boundedBytes } from './bounded.js';

export const MAX_REPORT_BYTES = 8192;
const MAX_REPORTS = 5; // one request can carry a batch; more than this is ignored

const directiveOf = v => { const w = String(v ?? '').trim().split(/\s+/)[0].toLowerCase(); return /^[a-z-]{3,40}$/.test(w) ? w : 'unknown'; };
// 'https://evil.example/x?y' -> 'https://evil.example'; 'inline', 'eval', 'data', 'blob' (a keyword or scheme only) pass as they are; anything else is 'unknown'.
export function blockedOrigin(v) {
  const s = String(v ?? '').trim();
  if (/^(inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink|data|blob|about|self)$/i.test(s)) return s.toLowerCase();
  try { const u = new URL(s); if (/^(data|blob|about|javascript):$/.test(u.protocol)) return u.protocol.slice(0, -1); return /^https?:|^wss?:/.test(u.protocol) ? u.origin.slice(0, 80) : 'unknown'; } catch { return 'unknown'; }
}
// Both wire formats to [{ directive, blocked }].
export function parseReports(data) {
  const list = Array.isArray(data) ? data.filter(r => r && r.type === 'csp-violation').map(r => r.body) : [data?.['csp-report']];
  return list.slice(0, MAX_REPORTS).filter(b => b && typeof b === 'object')
    .map(b => ({ directive: directiveOf(b.effectiveDirective ?? b['effective-directive'] ?? b.violatedDirective ?? b['violated-directive']), blocked: blockedOrigin(b.blockedURL ?? b['blocked-uri']) }));
}

// `limited` is app.js's per-person limiter (a Response when over the limit, else null). Returns the 204.
export async function cspReport(request, sec, limited) {
  const refused = await limited('csp-report', 120, 36e5);
  if (refused) return refused;
  const bytes = await boundedBytes(request, MAX_REPORT_BYTES);
  if (bytes === null) return new Response(null, { status: 413 });
  let data = null;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { data = null; }
  for (const r of parseReports(data)) sec.log('csp_violation', 'CSP_VIOLATION', 204, { directive: r.directive, blocked: r.blocked });
  return new Response(null, { status: 204 });
}
