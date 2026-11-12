// Gate 8. A Cloudflare Preview uses the existing ledger. It does not copy production
// origin, Access, or secrets. Live AI stays on under the $5 default (no second cap).

export const PRODUCTION_ORIGIN = 'https://atlas.tony-walteur.workers.dev';
export const PRODUCTION_ACCESS_AUD = 'fc05e3d966db92b03ed3bf38b31e5c5254e1508bb0e090825a56ce12a933f386';
export const PRODUCTION_ACCESS_TEAM = 'tony-walteur.cloudflareaccess.com';

export const PREVIEW_BANNER = '<div id="atlas-preview-banner" role="status" style="position:fixed;left:12px;bottom:10px;z-index:99;font:11px/1.4 Arial,sans-serif;letter-spacing:.06em;color:#A9A9BC;background:#15151cdd;border:1px solid #2a2a36;border-radius:14px;padding:4px 10px">Preview. Fake data only.</div>';

// The same wrangler file the preview upload sends. The live Worker has neither the binding nor v3.
// Unset LEDGER_MODE is enforce. Anything else is not this preview.
export function previewLedgerReady(cfg) {
  const preview = cfg?.previews;
  if (!preview?.vars) return { ok: false, reason: 'previews' };
  const bindings = preview.durable_objects?.bindings;
  const hit = Array.isArray(bindings) && bindings.find(b => b && b.name === 'SPEND_LEDGER' && b.class_name === 'ProductionSpendLedger' && !b.script_name);
  if (!hit) return { ok: false, reason: 'SPEND_LEDGER' };
  const tags = [].concat(cfg.migrations || [], preview.migrations || []);
  const v3 = tags.find(m => m && m.tag === 'v3' && Array.isArray(m.new_sqlite_classes) && m.new_sqlite_classes.includes('ProductionSpendLedger'));
  if (!v3) return { ok: false, reason: 'v3' };
  if (Object.prototype.hasOwnProperty.call(preview.vars, 'LEDGER_MODE') && preview.vars.LEDGER_MODE !== 'enforce') return { ok: false, reason: 'LEDGER_MODE' };
  return { ok: true };
}

export function previewMisconfigured(env) {
  if (env?.ATLAS_PREVIEW !== '1') return null;
  const mode = env.LEDGER_MODE;
  if (!(mode === undefined || mode === null || mode === '' || mode === 'enforce')) return 'Preview ledger mode must be enforce.';
  if (env.DATA_MODE === 'production') return 'Preview cannot use production data.';
  if (env.ORIGIN === PRODUCTION_ORIGIN) return 'Preview cannot use the production origin.';
  if (env.ACCESS_AUD === PRODUCTION_ACCESS_AUD) return 'Preview cannot use the production Access audience.';
  if (env.ACCESS_TEAM_DOMAIN === PRODUCTION_ACCESS_TEAM) return 'Preview cannot use the production Access team.';
  return null;
}

// Preview hosts are https://<label>-atlas.tony-walteur.workers.dev. The production host is not one of them.
export function allowedOrigin(env, url) {
  if (env?.ATLAS_PREVIEW === '1') {
    const suffix = String(env.ATLAS_PREVIEW_HOST_SUFFIX || '').toLowerCase();
    if (!suffix.startsWith('-') || suffix.length < 8) return null;
    if (url.protocol !== 'https:' || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (!host.endsWith(suffix)) return null;
    const label = host.slice(0, -suffix.length);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
    return url.origin;
  }
  if (!env?.ORIGIN || url.origin !== env.ORIGIN) return null;
  return env.ORIGIN;
}

export function withPreviewBanner(env, html) {
  if (env?.ATLAS_PREVIEW !== '1') return html;
  const end = String(html).lastIndexOf('</body>');
  if (end < 0) return String(html) + PREVIEW_BANNER;
  return String(html).slice(0, end) + PREVIEW_BANNER + String(html).slice(end);
}

export async function stampPreview(env, response) {
  if (env?.ATLAS_PREVIEW !== '1') return response;
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  const html = await response.text();
  return new Response(withPreviewBanner(env, html), { status: response.status, headers: response.headers });
}
