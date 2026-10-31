// F4.3 / F4.6 pre-Access Teams surfaces on the main host (WOW_SPEC §F4.3, §F4.6): BUILT, NOT CONNECTED.
// app.js routes exactly POST /api/teams/messages and GET /teams/tab here, before Access, and returns this Response
// as-is, so every response carries its own security headers. Until Teams is connected (teamsStatus: TEAMS_APP_ID,
// TEAMS_TENANT_ID and the TEAMS_BOT_SECRET, with TEAMS_BOT_APP_ID defaulting to TEAMS_APP_ID), both paths answer 503
// BLOCKED_EXTERNAL; no other Worker response depends on any TEAMS_* var.
// The bot never sends on its own: events are verified (teams.js), forwarded to the LibraryStore system word
// `teams-event` (which dedupes and applies them), and a card action is answered in the HTTP 200 invoke response.
import { verifyBotActivity, teamsClient, messageCard, teamsStatus, botAppId } from './teams.js';
import { str } from './util.js';
import { baseSecurityHeaders } from './security-headers.js';
import { htmlCsp, htmlCspHeaders, inlineScriptHashes } from './csp.js';
import { TEAMS_JS } from '../teams/vendor/teams-js.mjs';

const MAX_BODY = 262144;
const BASE = baseSecurityHeaders(); // no-store, nosniff, no-referrer, HSTS, COOP/CORP same-origin, Permissions-Policy (security-headers.js)
const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { ...BASE, 'Content-Type': 'application/json', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } });
// Route-specific CSP: only Teams may frame the launcher; the main host keeps frame-ancestors 'none' everywhere else. Its two inline scripts
// (the vendored TeamsJS bundle and the launcher) are static, so the policy allows exactly their hashes (v2.2 F1; blue G14): tabCsp(hashes).
export const TAB_FRAME_ANCESTORS = 'https://teams.microsoft.com https://*.teams.microsoft.com https://*.cloud.microsoft';
export const tabCsp = hashes => htmlCsp({ hashes, page: false, blob: false, formAction: "'none'", frameAncestors: TAB_FRAME_ANCESTORS, report: false });
// The pre-F1 policy, enforced only while ATLAS_CSP=report-only.
const TAB_CSP_LEGACY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors " + TAB_FRAME_ANCESTORS;
const NEEDS = ['TEAMS_APP_ID', 'TEAMS_TENANT_ID', 'TEAMS_BOT_SECRET (Worker secret)', 'TEAMS_BOT_APP_ID only when the bot uses another app registration than TEAMS_APP_ID',
  'Cloudflare Access bypass for /api/teams/messages and /teams/tab', 'Azure Bot resource (F0, single tenant) with the Teams channel on', 'Teams admin approval of the app package'];
const configured = env => teamsStatus(env) === 'connected';

export async function teamsRoutes(request, env = {}, { waitUntil = p => p } = {}, { fetcher = (...a) => fetch(...a), teamsJs = TEAMS_JS } = {}) {
  void waitUntil; // nothing runs after the response: the invoke answer is part of it
  if (!configured(env)) return json({ error: 'Teams is not connected.', status: 'BLOCKED_EXTERNAL',
    reason: 'Teams is not connected: tenant app, bot credentials and TEAMS_* settings are missing.', needs: NEEDS }, 503);
  const url = new URL(request.url);
  if (url.pathname === '/teams/tab' && request.method === 'GET') return tab(env, teamsJs);
  if (url.pathname === '/api/teams/messages' && request.method === 'POST') return messages(request, env, fetcher);
  return json({ error: 'Not found.' }, 404);
}

// Map a verified activity to a TeamsEvent (personal scope only), or null when there is nothing to record.
export function eventOf(a, env) {
  const conv = a.conversation || {}, from = a.from || {}, bot = '28:' + botAppId(env);
  if (conv.conversationType !== 'personal' || !a.id) return null;
  const base = { activityId: str(a.id, 256), aadObjectId: str(from.aadObjectId, 64), tenantId: str(a.channelData?.tenant?.id ?? conv.tenantId, 64),
    teamsUserId: str(from.id, 256), conversationId: str(conv.id, 512), serviceUrl: str(a.serviceUrl, 512) };
  base.subject = `${base.tenantId}:${base.aadObjectId}`.toLowerCase();
  const act = String(a.action || ''), has = list => (Array.isArray(list) ? list : []).some(m => m?.id === bot);
  if (a.type === 'installationUpdate' && act.startsWith('add')) return { ...base, kind: 'install' };
  if (a.type === 'installationUpdate' && act.startsWith('remove')) return { ...base, kind: 'uninstall' };
  if (a.type === 'conversationUpdate' && has(a.membersAdded)) return { ...base, kind: 'install' };
  if (a.type === 'conversationUpdate' && has(a.membersRemoved)) return { ...base, kind: 'uninstall' };
  if (a.type === 'message' && String(a.text || '').replace(/<at>[^<]*<\/at>/gi, '').trim().toLowerCase() === 'stop') return { ...base, kind: 'stop' };
  if (a.type === 'invoke' && a.name === 'adaptiveCard/action') {
    const action = a.value?.action || {};
    return { ...base, kind: 'action', verb: str(action.verb, 20), outreachId: str(action.data?.outreachId, 64) };
  }
  return null;
}

// Reads at most `max` bytes of a request body; null as soon as it is longer (the declared length can be absent or wrong).
async function boundedText(request, max) {
  if (!request.body) return '';
  const reader = request.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return new TextDecoder().decode(out);
}

// Served before Access: no bearer token, nothing is read; otherwise the body is read up to MAX_BODY only, then verified.
async function messages(request, env, fetcher) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return json({ error: 'Request too large.' }, 413);
  if (!/^Bearer\s+\S/.test(request.headers.get('Authorization') || '')) return json({ error: 'A Bot Framework bearer token is required.' }, 401);
  const text = await boundedText(request, MAX_BODY);
  if (text === null) return json({ error: 'Request too large.' }, 413);
  const v = await verifyBotActivity(request, text, env, fetcher);
  if (!v.ok) return json({ error: v.error }, v.status);
  const event = eventOf(v.activity, env);
  if (!event) return json({}, 200);
  if (!env.LIBRARY) return json({ error: 'The reference library is not configured on this deployment.' }, 503);
  if (event.kind === 'install') { // routing email from the member lookup, only when the outbound client exists (connected)
    const client = teamsClient(env, fetcher);
    if (client) { try { event.email = (await client.member(event, event.teamsUserId)).email; } catch { /* stored without an email */ } }
  }
  const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(new Request(new URL('/api/library/teams-event', request.url), { method: 'POST',
    body: JSON.stringify(event), headers: { 'Content-Type': 'application/json', 'x-atlas-user': 'teams-bot', 'x-atlas-role': 'system' } }));
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: 'The Teams event could not be recorded.' }, 502);
  if (event.kind !== 'action') return json({}, 200);
  const value = out.card || messageCard({ title: 'Already recorded.', text: 'Nothing else was changed.' });
  return json({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value }, 200);
}

// GET /teams/tab: a static launcher with no user data and no API call. TeamsJS app.initialize(), then app.openLink to
// /go/start, which opens the consent step (the microphone waits for the Start click; WOW_ZERO_CONFIG §3.1).
async function tab(env, js) {
  if (!js) return json({ error: 'TeamsJS not vendored', status: 'BLOCKED_EXTERNAL',
    reason: 'TeamsJS not vendored: the launcher tab needs the @microsoft/teams-js 2.57.0 UMD bundle in deploy/cloudflare-edge/teams/vendor/.',
    needs: ['@microsoft/teams-js 2.57.0 (MIT) vendored with teams/vendor_teamsjs.py, its SHA-256 recorded in docs/THIRD_PARTY.md and docs/SOURCE_LOCK.json'] }, 503);
  let origin = '';
  try { origin = new URL(String(env.ORIGIN)).origin; } catch { origin = ''; }
  const target = JSON.stringify(origin ? origin + '/go/start' : '/').replace(/</g, '\\u003c'), home = JSON.stringify(origin + '/').replace(/</g, '\\u003c');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATLAS</title>'
    + '<style>body{margin:0;padding:24px;background:#101011;color:#F8F8F8;font:16px/1.5 Arial,system-ui,sans-serif}main{max-width:32rem}'
    + 'h1{font-size:22px;font-weight:600;margin:0 0 8px}p{color:#A9A9BC;margin:0 0 20px}button{font:inherit;border:0;border-radius:8px;padding:12px 18px;background:#3E007A;color:#fff;cursor:pointer}'
    + 'a{color:#F6EB4B}button:focus-visible,a:focus-visible{outline:3px solid #F6EB4B;outline-offset:3px}.row{display:flex;flex-wrap:wrap;gap:16px;align-items:center}</style></head>'
    + '<body><main><h1>ATLAS</h1><p>Interviews and references open in your browser, signed in as you.</p>'
    + '<div class="row"><button id="open" type="button">Open ATLAS</button><a id="pending" href="#">Your pending interviews</a></div><p id="msg" role="status"></p></main>'
    + '<script>' + js + '</script><script>(function(){var target=' + target + ',home=' + home + ',ready=false,msg=document.getElementById("msg");'
    + 'function open(e,to){if(e)e.preventDefault();if(ready&&window.microsoftTeams){microsoftTeams.app.openLink(to).catch(function(){msg.textContent="Teams could not open the link. Open ATLAS in your browser.";});}'
    + 'else{msg.textContent="Open this tab inside Microsoft Teams, or open ATLAS in your browser.";}}'
    + 'document.getElementById("open").addEventListener("click",function(e){open(e,target);});document.getElementById("pending").addEventListener("click",function(e){open(e,home);});'
    + 'try{microsoftTeams.app.initialize().then(function(){ready=true;}).catch(function(){ready=false;});}catch(e){ready=false;}})();</script></body></html>';
  const hashes = await inlineScriptHashes(html);
  return new Response(html, { status: 200, headers: { ...BASE, 'Content-Type': 'text/html; charset=utf-8',
    ...htmlCspHeaders(env, { hashes, page: false, blob: false, formAction: "'none'", frameAncestors: TAB_FRAME_ANCESTORS, report: false }, TAB_CSP_LEGACY) } });
}
