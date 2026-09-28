// ATLAS edge application logic (Worker routes, Access verification, Workers AI adapters). Platform-free for Node tests.
// Identity comes ONLY from a verified Cloudflare Access JWT (fail closed). Speech and models run on
// Workers AI through the AI binding, so no provider key exists in this code or in the browser.
import { CHAT_TOOLS, SPEAKING_LIMIT_S } from './policy.generated.js';
import { Session, MAX_SECONDS } from './session.js';
import { wav, to16k } from './speech.js';
import { classify } from './classify.js';
import { bankId } from './memory.js';
import { sheetRoutes } from './sheet.js';
import { detectedLanguage, NATIVE_VOICES, normalize } from './languages.js';

const enc = new TextEncoder();
// One voice for everyone: @cf/deepgram/aura-2-en "harmonia" (Deepgram: empathetic, clear, calm, confident).
// Transcription is part of the interview; consent covers it and reuse of reviewed notes for future projects.
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
let certs = { at: 0, keys: [] };

export async function verifyAccess(request, env, fetcher = fetch) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(h))), payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (header.alg !== 'RS256') return null;
  if (Date.now() - certs.at > 600000 || !certs.keys.some(k => k.kid === header.kid)) {
    const r = await fetcher(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    certs = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certs.keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), enc.encode(h + '.' + p))) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud], now = Date.now() / 1000;
  if (!aud.includes(env.ACCESS_AUD) || payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60) || !payload.sub) return null;
  return entraIdentity(payload, env) ?? (env.IDENTITY_SOURCE === 'entra' ? null : { sub: payload.sub, email: payload.email || 'Access service identity' });
}

// Microsoft Entra ID (Windows / Microsoft 365 sign-in) through Cloudflare Access. BUILT, NOT ENABLED:
// active only when IDENTITY_SOURCE='entra'. Access must be configured with the Entra connector and to pass
// the OIDC claims `tid` and `oid` (see entra/README.md). The person's key is `tid:oid`, the same scheme as
// the Python gateway's Entra mode, so private continuity maps 1:1. Only allow-listed tenants are admitted.
export function entraIdentity(payload, env) {
  if (env.IDENTITY_SOURCE !== 'entra') return null;
  const c = payload.custom || {}, tenants = String(env.ENTRA_TENANTS || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(c.tid || '') || !uuid.test(c.oid || '') || !tenants.includes(c.tid.toLowerCase())) return null;
  const roles = Array.isArray(c.roles) ? c.roles.filter(r => typeof r === 'string') : [];
  if (env.ENTRA_REQUIRED_ROLE && !roles.includes(env.ENTRA_REQUIRED_ROLE)) return null;
  return { sub: `${c.tid.toLowerCase()}:${c.oid.toLowerCase()}`, email: payload.email || c.preferred_username || 'Microsoft account', roles };
}

function timingSafe(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}

function headers(env, extra = {}) {
  const ws = env.ORIGIN.replace('https://', 'wss://');
  return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; connect-src 'self' ${ws}; img-src data: blob:; font-src 'self'; worker-src blob:; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    ...extra };
}
const json = (env, body, status = 200) => new Response(JSON.stringify(body), { status, headers: headers(env, { 'Content-Type': 'application/json' }) });

export async function handle(request, env, page) {
  {
    const url = new URL(request.url);
    if (!env.ORIGIN || url.origin !== env.ORIGIN) return new Response('Host is not the configured ATLAS origin.', { status: 403 });
    if (!env.CSRF_SECRET) return new Response('Deployment is not configured (CSRF_SECRET).', { status: 500 });
    // Project-management system trigger: its own bearer secret (Access bypass on this path only; see docs/INTEGRATIONS.md).
    if (url.pathname === '/api/triggers' && request.method === 'POST') {
      const secret = env.TRIGGER_SECRET || '', given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!secret || !env.LIBRARY || given.length !== secret.length || !timingSafe(given, secret)) return json(env, { error: 'Unauthorized.' }, 401);
      if (Number(request.headers.get('Content-Length') || 0) > 16384) return json(env, { error: 'Request too large.' }, 413);
      const fwd = new Request(new URL('/api/library/trigger', request.url), { method: 'POST', body: await request.text(), headers: { 'Content-Type': 'application/json', 'x-atlas-user': 'pm-system', 'x-atlas-role': 'system' } });
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(fwd);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    let who = null;
    try { who = await verifyAccess(request, env); } catch { who = null; }
    if (!who) return new Response('Sign in to use ATLAS.', { status: 401, headers: headers(env) });
    // Access email only: an Entra deployment must grant admin through an app role, never a username fallback.
    const listed = (names, e) => (names || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(String(e || '').toLowerCase());
    const admin = env.IDENTITY_SOURCE !== 'entra' && (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(String(who.email || '').toLowerCase());
    // Library role. Entra: app roles only (never a username fallback); Access: verified email lists.
    const role = env.IDENTITY_SOURCE === 'entra' ? (who.roles?.includes('ATLAS.Admin') ? 'admin' : who.roles?.includes('ATLAS.Reviewer') ? 'reviewer' : 'user')
      : admin ? 'admin' : listed(env.REVIEWER_EMAILS, who.email) ? 'reviewer' : 'user';
    const csrf = await hmac(env.CSRF_SECRET, who.sub), subjectKey = (await hmac('atlas-subject', who.sub)).slice(0, 32);
    if (url.pathname === '/' && request.method === 'GET') {
      const runtime = JSON.stringify({ subjectKey, authMode: 'access', name: who.email }).replace(/</g, '\\u003c');
      let body = page.replace('/* SERVER_RUNTIME */', 'window.ATLAS_RUNTIME=' + runtime + ';')
        .replace("connect-src 'self';", "connect-src 'self' " + env.ORIGIN.replace('https://', 'wss://') + ';');
      const end = body.lastIndexOf('</body>'); // the page embeds an earlier '</body>' inside a script string
      body = body.slice(0, end) + '<div style="position:fixed;left:12px;bottom:10px;z-index:99;font:11px/1.4 Arial;letter-spacing:.06em;color:#A9A9BC;background:#15151cdd;border:1px solid #2a2a36;border-radius:14px;padding:4px 10px">TEST DEPLOYMENT · SYNTHETIC DATA ONLY</div>' + body.slice(end);
      return new Response(body, { headers: headers(env, { 'Content-Type': 'text/html; charset=utf-8' }) });
    }
    if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
      // One voice for everyone, advertised only as 'atlas': the real voice and provider stay server-side.
      return json(env, { provider: 'workers', providerLabel: 'ATLAS voice', protocol: 'atlas-personaplex-pcm-v1', csrf,
        identity: { name: who.email, mode: env.IDENTITY_SOURCE === 'entra' ? 'entra' : 'access', subjectKey }, model: 'ATLAS conversational voice', admin,
        voices: ['atlas'], defaultVoice: 'atlas', captureRequired: true, codecAvailable: true, busy: false, capacity: 1, maxSeconds: MAX_SECONDS, speakingSeconds: SPEAKING_LIMIT_S,
        memory: !!env.HINDSIGHT_API_KEY, wiki: false, jev: !!env.TYPESAFE_API_KEY, jevClassify: !!env.TYPESAFE_API_KEY, library: !!env.LIBRARY, libraryRole: role, sheet: true, transcription: true, structuredNotes: true, liveLedger: true, playbackAck: true,
        readiness: 'edge-deployment-test-data-only' });
    }
    if (url.pathname === '/api/voice') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade.', { status: 426 });
      if (request.headers.get('Origin') !== env.ORIGIN) return new Response('Invalid voice origin', { status: 403 });
      const forward = new Request(request, { headers: new Headers(request.headers) });
      forward.headers.set('x-atlas-admin', admin ? '1' : '0'); // always overwritten: a browser can never claim admin
      forward.headers.delete('x-atlas-role'); forward.headers.delete('x-atlas-user');
      forward.headers.set('x-atlas-bank', await bankId(env, who.sub)); // server-derived; the browser never picks a bank
      forward.headers.set('x-atlas-csrf', csrf); // set by the Worker only; the DO is not reachable otherwise
      return env.INTERVIEW.get(env.INTERVIEW.idFromName(who.sub)).fetch(forward);
    }
    if (url.pathname.startsWith('/api/sheet/') && request.method === 'POST') {
      if (request.headers.get('Origin') !== env.ORIGIN || request.headers.get('X-Atlas-CSRF') !== csrf) return json(env, { error: 'Invalid request origin or session token.' }, 403);
      if (Number(request.headers.get('Content-Length') || 0) > 12 * 1024 * 1024) return json(env, { error: 'The file is larger than 10 MB.' }, 413);
      const ai = workersAI(env), res = await sheetRoutes(request, url.pathname.slice('/api/sheet/'.length), { complete: (m, n) => ai.complete(m, n), toMarkdown: f => env.AI.toMarkdown(f) });
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/memory' || url.pathname.startsWith('/api/memory/')) {
      if (request.method !== 'GET' && (request.headers.get('Origin') !== env.ORIGIN || request.headers.get('X-Atlas-CSRF') !== csrf)) return json(env, { error: 'Invalid request origin or session token.' }, 403);
      if (Number(request.headers.get('Content-Length') || 0) > 131072) return json(env, { error: 'Request too large.' }, 413);
      const forward = new Request(request, { headers: new Headers(request.headers) });
      forward.headers.set('x-atlas-bank', await bankId(env, who.sub)); forward.headers.set('x-atlas-role', role); // always overwritten
      const res = await env.INTERVIEW.get(env.INTERVIEW.idFromName(who.sub)).fetch(forward);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/library' || url.pathname.startsWith('/api/library/')) {
      if (!env.LIBRARY) return json(env, { error: 'The reference library is not configured on this deployment.' }, 404);
      if (request.method !== 'GET' && (request.headers.get('Origin') !== env.ORIGIN || request.headers.get('X-Atlas-CSRF') !== csrf)) return json(env, { error: 'Invalid request origin or session token.' }, 403);
      if (Number(request.headers.get('Content-Length') || 0) > 262144) return json(env, { error: 'Request too large.' }, 413);
      const forward = new Request(request, { headers: new Headers(request.headers) });
      // Entra: the stable tid:oid is the library identity (emails can change); Access: the verified email.
      forward.headers.set('x-atlas-user', String(env.IDENTITY_SOURCE === 'entra' ? who.sub : who.email || who.sub).toLowerCase()); forward.headers.set('x-atlas-role', role); // always overwritten
      const res = await env.LIBRARY.get(env.LIBRARY.idFromName('global')).fetch(forward);
      return new Response(res.body, { status: res.status, headers: headers(env, { 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/jev/classify' && request.method === 'POST') {
      if (request.headers.get('Origin') !== env.ORIGIN || request.headers.get('X-Atlas-CSRF') !== csrf) return json(env, { error: 'Invalid request origin or session token.' }, 403);
      if (Number(request.headers.get('Content-Length') || 0) > 65536) return json(env, { error: 'Project too large to score.' }, 413);
      const raw = await request.text();
      if (raw.length > 65536) return json(env, { error: 'Project too large to score.' }, 413);
      let project;
      try { project = JSON.parse(raw).project; } catch { return json(env, { error: 'Invalid JSON.' }, 400); }
      try { return json(env, await classify(env, project)); }
      catch (e) { return e.status ? json(env, { error: e.message }, e.status) : json(env, { error: 'Scoring is unavailable right now. Try again shortly.' }, 502); }
    }
    if (url.pathname === '/api/test-voice' && env.TEST_VOICE === '1' && request.method === 'GET') {
      // Test-only (off unless TEST_VOICE=1, and still behind Access): synthesizes a scripted consultant line
      // with a different voice so an automated browser can speak into a virtual microphone.
      const text = (url.searchParams.get('text') || '').slice(0, 300), speaker = url.searchParams.get('speaker') || 'orion';
      if (!text || !/^[a-z]+$/.test(speaker)) return json(env, { error: 'text and speaker required' }, 400);
      const pcm = await workersAI(env).synthesize(text, speaker);
      return new Response(pcm, { headers: headers(env, { 'Content-Type': 'audio/L16;rate=24000' }) });
    }
    return json(env, { error: 'This feature is not available in this deployment.' }, 404);
  }
}

// Workers AI adapters. Tolerant of both OpenAI-shaped and native response shapes.
// gpt-oss through the binding may answer in Chat Completions or Responses API shape; accept both (and the legacy shape).
export function responseText(r) {
  if (typeof r?.choices?.[0]?.message?.content === 'string') return r.choices[0].message.content;
  if (Array.isArray(r?.output)) return r.output.filter(o => o?.type === 'message').flatMap(o => Array.isArray(o.content) ? o.content : [])
    .filter(c => c?.type === 'output_text' && typeof c.text === 'string').map(c => c.text).join('');
  return typeof r?.output_text === 'string' ? r.output_text : typeof r?.response === 'string' ? r.response : '';
}
export function responseToolCalls(r) {
  const args = a => typeof a === 'string' ? a : JSON.stringify(a || {});
  const chat = r?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(chat)) return chat.map((c, i) => ({ id: c.id || 'call-' + i, name: c.function?.name, arguments: args(c.function?.arguments) }));
  if (Array.isArray(r?.output)) return r.output.filter(o => o?.type === 'function_call').map((c, i) => ({ id: c.call_id || c.id || 'call-' + i, name: c.name, arguments: args(c.arguments) }));
  return (r?.tool_calls || []).map((c, i) => ({ id: c.id || 'call-' + i, name: c.name, arguments: args(c.arguments) }));
}
// Low reasoning effort keeps the hidden reasoning from eating the output budget; retried without it if the binding rejects the field.
async function runReasoning(env, input) {
  try { return await env.AI.run(env.ANALYST_MODEL, { ...input, reasoning: { effort: 'low' } }); }
  catch { return env.AI.run(env.ANALYST_MODEL, input); }
}

// ElevenLabs Flash v2.5 (32 languages) as raw 24 kHz PCM, the same format as Aura. Optional: ELEVENLABS_API_KEY.
async function elevenLabs(env, text, lang, fetcher = fetch) {
  const voice = encodeURIComponent(env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM');
  const r = await fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_24000`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5', language_code: lang }) });
  if (!r.ok) throw new Error('ElevenLabs HTTP ' + r.status);
  const pcm = new Uint8Array(await r.arrayBuffer());
  return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
}

export function workersAI(env) {
  const bytesOf = async r => r instanceof Uint8Array ? r : r instanceof ArrayBuffer ? new Uint8Array(r)
    : r instanceof ReadableStream || r instanceof Response ? new Uint8Array(await new Response(r.body ?? r).arrayBuffer())
    : r?.audio ? Uint8Array.from(atob(r.audio), c => c.charCodeAt(0)) : new Uint8Array(0);
  return {
    // Automatic language detection (Nova-3 "multi"): returns the text and the utterance's language.
    async transcribe(pcm) {
      const r = await env.AI.run(env.STT_MODEL, { audio: { body: new Blob([wav(pcm)]).stream(), contentType: 'audio/wav' }, smart_format: true, punctuate: true, language: env.STT_LANGUAGE || 'multi' });
      return { text: r?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '', language: detectedLanguage(r) };
    },
    // Semantic end-of-turn (Pipecat smart-turn v2): has the consultant finished, or only paused? Last 8 s at 16 kHz.
    async turnComplete(pcm) {
      const tail = pcm.length > 8 * 48000 ? pcm.subarray(pcm.length - 8 * 48000) : pcm;
      const r = await env.AI.run(env.TURN_MODEL || '@cf/pipecat-ai/smart-turn-v2', { audio: { body: new Blob([wav(to16k(tail), 16000)]).stream(), contentType: 'audio/wav' } });
      return { complete: r?.is_complete === true, probability: Number(r?.probability) || 0 };
    },
    speaks(lang) { return NATIVE_VOICES.includes(lang) || (!!env.ELEVENLABS_API_KEY && !!normalize(lang)); },
    async synthesize(text, speaker = 'atlas', lang = 'en') { // 'atlas' = the configured voice; the browser never sees its real name
      if (lang !== 'en' && lang !== 'es' && env.ELEVENLABS_API_KEY) return elevenLabs(env, text, lang);
      const es = lang === 'es';
      const pcm = await bytesOf(await env.AI.run(es ? (env.TTS_MODEL_ES || '@cf/deepgram/aura-2-es') : env.TTS_MODEL, { text, speaker: es ? (env.TTS_VOICE_ES || 'celeste') : speaker === 'atlas' ? env.TTS_VOICE : speaker, encoding: 'linear16', container: 'none', sample_rate: 24000 }));
      return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
    },
    // Session affinity keeps one interview on the same model instance, so the cached prompt prefix is reused.
    async *chatStream(messages, { affinity } = {}) {
      const stream = await env.AI.run(env.TALKER_MODEL, { messages, stream: true, max_tokens: 300, temperature: 0.7 }, affinity ? { extraHeaders: { 'x-session-affinity': affinity } } : undefined);
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let cut;
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, cut).trim(); buffer = buffer.slice(cut + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try { const j = JSON.parse(payload), d = j.response ?? j.choices?.[0]?.delta?.content; if (d) yield d; } catch { /* keep-alive or partial */ }
        }
      }
    },
    async complete(messages, maxTokens = 2500) {
      return responseText(await runReasoning(env, { messages, temperature: 0.1, max_tokens: maxTokens }));
    },
    async embed(text) {
      const r = await env.AI.run(env.EMBED_MODEL || '@cf/baai/bge-m3', { text: [String(text).slice(0, 8000)] });
      const v = r?.data?.[0];
      return Array.isArray(v) && v.length ? v : null;
    },
    async report(messages) {
      return responseText(await runReasoning(env, { messages, temperature: 0.2, max_tokens: 3000 }));
    },
    async analyst(messages) {
      return responseToolCalls(await runReasoning(env, { messages, tools: CHAT_TOOLS, tool_choice: 'auto', temperature: 0, max_tokens: 1500 }));
    },
  };
}
