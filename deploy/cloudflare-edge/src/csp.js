// Content-Security-Policy for every HTML response (v2.2 F1; blue review P1, G1, G14). One builder, used by the page, the re-sign-in
// page, the confirm page, the privacy notice and the Teams tab, so no HTML route can ship its own looser policy.
//   script-src   exactly the SHA-256 of each executable inline script (+ blob: for the AudioWorklet module the page builds from its own
//                text/plain script, on the voice page only: /privacy, the confirm and re-sign-in pages and the Teams tab pass blob: false).
//                No 'unsafe-inline', no 'strict-dynamic' (CSP3 browsers would then ignore blob:).
//   script-src-attr 'none'   no inline event handler attribute anywhere; handlers are attached with addEventListener.
//   require-trusted-types-for 'script' + trusted-types atlas-html (v2.2): the one HTML sink (safe-html.js setHTML/insertHTML) goes
//                through a private policy; any other innerHTML, script text or script URL is refused by the browser.
//   style-src 'unsafe-inline'   STILL ALLOWED, a recorded residual: the page carries ~1.5 MB of <style> and style="" attributes. It lets an
//                injected tag restyle the page but not run code or reach the network. Removing it is a design-system change (F2 or later).
//   trusted-types atlas-html   the policy names the one sink. safe-html.js createHTML is a passthrough of a value html`` already built.
//                That is the same class of residual as style-src: recorded here, not a sanitiser this slice invents.
// The server's per-person facts go into a JSON data block (runtimeBlock), never into script. The same policy is built in Python by
// atlas_voice/csp.py for the gateway; tests/test_csp.py holds the two byte-identical. ATLAS_CSP=report-only is the rollout switch.
import { PAGE_SCRIPT_HASHES, RUNTIME_BLOCK } from './csp.generated.js';

export { PAGE_SCRIPT_HASHES, RUNTIME_BLOCK };
export const REPORT_PATH = '/api/csp-report';
export const TT_POLICY = 'atlas-html';
export const REPORT_GROUP = 'atlas-csp';
export const REPORTING_ENDPOINTS = `${REPORT_GROUP}="${REPORT_PATH}"`;

// 'enforce' (default) or 'report-only': the strict policy is only REPORTED while the previous policy stays enforced.
export const cspMode = env => (String(env?.ATLAS_CSP || '').toLowerCase() === 'report-only' ? 'report-only' : 'enforce');

const quoted = hashes => hashes.map(h => `'${h}'`).join(' ');

// Each page names the capabilities it uses. Defaults are the quiet page: no blob, no worker, no media. The voice page opts into
// scriptBlob, workerBlob and mediaBlob. connectSelf is the page's own origin; `connect` is an extra origin (the websocket).
// imgSrc false omits img-src. trustedTypes 'none' is a page that only uses textContent.
export function htmlCsp({
  hashes = [], connect = '', connectSelf = true, frameAncestors = "'none'", formAction = "'self'", report = true,
  scriptBlob = false, workerBlob = false, mediaBlob = false, fontSelf = true, imgSrc, trustedTypes = TT_POLICY,
} = {}) {
  const script = [hashes.length ? quoted(hashes) : '', scriptBlob ? 'blob:' : ''].filter(Boolean).join(' ') || "'none'";
  const d = ["default-src 'none'", 'script-src ' + script, "script-src-attr 'none'", "style-src 'unsafe-inline'"];
  const connectSrc = [connectSelf ? "'self'" : '', connect].filter(Boolean).join(' ');
  if (connectSrc) d.push('connect-src ' + connectSrc);
  const img = imgSrc === undefined ? (scriptBlob ? 'data: blob:' : (fontSelf || connectSelf ? 'data:' : '')) : (imgSrc || '');
  if (img) d.push('img-src ' + img);
  if (fontSelf) d.push("font-src 'self'");
  if (workerBlob) d.push('worker-src blob:');
  if (mediaBlob) d.push('media-src blob:');
  d.push("object-src 'none'", "base-uri 'none'", `form-action ${formAction}`, `frame-ancestors ${frameAncestors}`);
  d.push("require-trusted-types-for 'script'", 'trusted-types ' + (trustedTypes === 'none' ? "'none'" : trustedTypes));
  if (report) d.push(`report-uri ${REPORT_PATH}`, `report-to ${REPORT_GROUP}`);
  return d.join('; ');
}

// The policy before F1. Used only while ATLAS_CSP=report-only, when it is the enforced one.
export const legacyCsp = (connect = '', extra = {}) => `default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; connect-src 'self'${connect ? ' ' + connect : ''}; img-src data: blob:; font-src 'self'; worker-src blob:; media-src blob:; object-src 'none'; base-uri 'none'; form-action ${extra.formAction || "'self'"}; frame-ancestors ${extra.frameAncestors || "'none'"}`;

// The CSP headers of an HTML response. `opts` is htmlCsp's; `legacy` (a string) replaces the previous policy of a page that never had the default one.
// enforceStrict: the page keeps its own strict policy as the enforced header even while ATLAS_CSP=report-only.
// The voice page leaves this off, so only that page reverts to the legacy policy during the rollout.
export function htmlCspHeaders(env, opts = {}, legacy = undefined) {
  const strict = htmlCsp(opts);
  const h = opts.report === false ? {} : { 'Reporting-Endpoints': REPORTING_ENDPOINTS };
  if (cspMode(env) === 'report-only' && opts.enforceStrict !== true) return { ...h, 'Content-Security-Policy': legacy ?? legacyCsp(opts.connect, opts), 'Content-Security-Policy-Report-Only': strict };
  return { ...h, 'Content-Security-Policy': strict };
}

// The JSON data block (see RUNTIME_BLOCK): "<" escaped so no value can close the element or open a comment, and U+2028/2029 escaped for old parsers.
export const runtimeBlock = data => '<script id="atlas-runtime" type="application/json">'
  + JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '</script>';

// The page's own <meta> policy duplicates the header (for an offline copy). While reporting only, it must not enforce, so it is dropped from the response.
export const withoutMetaCsp = html => html.replace(/<meta\b[^>]*\bhttp-equiv=["']?Content-Security-Policy["']?[^>]*>/i, '');

// ---- hashes of inline scripts computed at run time, for the small pages defined in code (sign-in landing, confirm, Teams tab) ----
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script/gi;
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript']);
const executes = attrs => {
  if (/\bsrc\s*=/i.test(attrs)) return false;
  const m = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  return JS_TYPES.has(m ? String(m[1] ?? m[2] ?? m[3]).trim().toLowerCase() : '');
};
const cache = new Map(); // body -> 'sha256-...' : the pages are constants, so each body is hashed once per isolate
async function hashOf(body) {
  let h = cache.get(body);
  if (!h) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    let bin = ''; for (const b of digest) bin += String.fromCharCode(b);
    h = 'sha256-' + btoa(bin); cache.set(body, h);
  }
  return h;
}
// Sorted unique hash tokens (no quotes) of every executable inline script in `html`.
export async function inlineScriptHashes(html) {
  const out = new Set();
  for (const m of String(html).matchAll(SCRIPT)) if (executes(m[1])) out.add(await hashOf(m[2]));
  return [...out].sort();
}
