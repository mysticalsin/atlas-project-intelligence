// MiChat CV, ready to connect (X2, Tony 2026-11-02: "build this as if it is ready to connect"). The MiChat owners have not sent an endpoint or a contract.
// This module adds what is MiChat-specific on top of the generic connector (connectors.js), and nothing runs against MiChat until the Worker is told to:
//
//   MICHAT_CV_CONTRACT=assumed  overlay the ASSUMED contract (atlas_voice/config/contracts/michat_cv/assumed/contract.json, emitted as MICHAT_ASSUMED_CONTRACT)
//                               on the michat_cv connection: endpoint, field mapping, ack rule, owner, status configured_untested. Unset: connections.json as is.
//   MICHAT_CV_BASE_URL          the MiChat base URL (https)                     MICHAT_CV_TOKEN   secret (wrangler secret put), sent as a bearer token
//   ATLAS_ADAPTERS=live         the global live switch (every other destination without a ready connection then shows blocked_external, never mock)
//   MICHAT_CV_SANDBOX=false     treat MiChat's acknowledgements as production records (default: sandbox, a record is never "synced")
//   MICHAT_CV_LANGUAGE          the CV's language, any language tag (en, fr, pt-BR, ja, ...): approved wording is machine-translated into it (translate.js)
//   MICHAT_CV_TEMPLATE          the CV template name MiChat expects (free text, up to 80 characters)
//   TRANSLATE_GLOSSARY          terms kept as they are, or "term=rendering"
//
// When any of these is missing the CV branch behaves exactly as before: mock (ATLAS_ADAPTERS=mock, the outbox the reviewer sees), off, or blocked_external
// under live. No outbound call is made. Retries, backoff and the idempotency key are the job pump's (jobs.js) and the connector's (Idempotency-Key header).
// Client names stay out of CVs (Tony 2026-11-02, D-G14): outcome and metric text is never sent (adapters.js cvClaim), and every other approved statement
// passes cvTextMask, which replaces any library client or contact name with "a client" / "a contact" and emails, phones and links with tags.
import { CONNECTIONS_CONFIG, MICHAT_ASSUMED_CONTRACT } from './policy.generated.js';
import { createHttpConnector, healthCheck, readiness, connectionById } from './connectors.js';
import { translateText, glossaryTerms, variantOf } from './translate.js';
import { normalize } from './languages.js';
import { clientMatcher, piiText, nameMatcher, libraryNames } from './scrub.js';
import { detect } from './lang-detect.js';

const on = v => String(v ?? '').trim().toLowerCase();
export const assumedContractOn = env => on(env?.MICHAT_CV_CONTRACT) === 'assumed';
const sandboxOf = env => !['false', '0', 'no', 'off'].includes(on(env?.MICHAT_CV_SANDBOX));

// The registry the connectors see for this env: connections.json, with michat_cv overlaid by the assumed contract when it is switched on.
const cache = new Map();
export function effectiveConfig(env, config = CONNECTIONS_CONFIG, overlay = MICHAT_ASSUMED_CONTRACT) {
  if (!assumedContractOn(env)) return config;
  const sandbox = sandboxOf(env), key = sandbox ? 'sandbox' : 'production';
  if (config === CONNECTIONS_CONFIG && overlay === MICHAT_ASSUMED_CONTRACT && cache.has(key)) return cache.get(key);
  const out = { ...config, connections: config.connections.map(c => c.id === 'michat_cv' ? { ...c, ...overlay, sandbox, schema_status: c.schema_status } : c) };
  if (config === CONNECTIONS_CONFIG && overlay === MICHAT_ASSUMED_CONTRACT) cache.set(key, out);
  return out;
}
export const michatConnection = env => connectionById('michat_cv', effectiveConfig(env));
export const michatReadiness = env => readiness(michatConnection(env), env);

// The CV options that travel in the payload. language: any valid language tag (its base code), else null (MiChat's default).
export function cvOptions(env) {
  const template = String(env?.MICHAT_CV_TEMPLATE ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  const raw = String(env?.MICHAT_CV_LANGUAGE ?? '').trim(), base = normalize(raw);
  return { language: base ? (variantOf(raw) || base) : null, template: template || null }; // a regional tag (pt-PT) is kept as given
}

// Client names out of CV text: every library client -> "a client", every contact -> "a contact"; emails, phones, links -> [email] [phone] [link].
export function cvTextMask(lib) {
  let clients = null, contacts = null;
  try { clients = clientMatcher(lib); contacts = nameMatcher(libraryNames(lib).contacts, { contacts: true }); } catch { clients = null; contacts = null; }
  return s => {
    if (typeof s !== 'string') return s;
    let t = piiText(s);
    if (clients) t = clients(t, () => 'a client');
    if (contacts) t = contacts(t, () => 'a contact');
    return t;
  };
}

// Approved statements -> the CV's language. Each claim keeps the language it was written in (statement_language) and a confidence, never a gate.
export async function translateClaims(env, payload, { translate = translateText } = {}) {
  const target = normalize(payload?.language) ? String(payload.language) : null; // the tag as configured (translate.js keeps a regional variety)
  if (!target || !Array.isArray(payload?.claims)) return payload;
  const glossary = glossaryTerms(env);
  const claims = [];
  for (const c of payload.claims) {
    if (typeof c?.statement !== 'string' || !c.statement.trim()) { claims.push(c); continue; }
    const r = await translate(env, c.statement, { target, glossary });
    claims.push({ ...c, statement: r.text, statement_language: r.translated ? r.target : (r.source || detect(c.statement).lang || null), translation_confidence: r.confidence, translation_flags: r.flags });
  }
  return { ...payload, claims };
}

// The live MiChat adapter: the generic HTTP connector on the effective config, after translation. Same send(envelope, payload) interface as the mock.
export function createMichatAdapter(env, { fetcher, now, translate } = {}) {
  const inner = createHttpConnector('MICHAT_CV', { env, config: effectiveConfig(env), ...(fetcher ? { fetcher } : {}), ...(now ? { now } : {}) });
  return { ...inner, async send(envelope, payload) {
    const r = inner.readiness();
    if (!r.eligible) return inner.send(envelope, payload); // refuses with CONNECTION_NOT_READY before any request (and before any model call)
    return inner.send(envelope, await translateClaims(env, payload, translate ? { translate } : {}));
  } };
}

// One health call (admin route and scripts/connection_check.mjs): status code and time only, never a body.
export const michatHealth = (env, { fetcher, now } = {}) => healthCheck('michat_cv', { env, config: effectiveConfig(env), ...(fetcher ? { fetcher } : {}), ...(now ? { now } : {}) });
