// Success-story audience projection: a parity-tested port of project_for_audience in atlas_voice/success_story.py, the
// source of truth. The allowlists, gates and limits come from policy.generated.js (STORY_PROJECTION, derived from
// field_visibility_policy.yaml); test/gen_story_parity.py records the Python function into test/story.vectors.json and
// test/story-projection.test.js replays them here. Field-level allowlist, never a prompt: internal notes exist only in the
// internal projection, and a missing gate, an unknown audience or an unreadable story throws instead of guessing.
import { STORY_PROJECTION as P } from './policy.generated.js';

const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSet = v => typeof v === 'string' && v.trim() !== '';
const clone = v => structuredClone(v);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const QUOTE_PATH = 'amaris_differentiator.client_quote';

export class ProjectionError extends Error {
  constructor(code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra); }
}

// approval_state flags the audience needs that are not exactly true; [] for internal.
export function gateFailures(story, audience) {
  const state = isObj(story) && isObj(story.approval_state) ? story.approval_state : {};
  return (P.gates[audience] || []).filter(g => state[g] !== true);
}

// An external audience sees the client's name only when project.client_permission is exactly named_allowed.
export function anonymizing(story, audience) {
  if (audience === 'internal') return false;
  const project = isObj(story) ? story.project : null;
  return !(isObj(project) && project.client_permission === P.named);
}

function projectKpis(kpis, audience) {
  const out = [];
  for (const k of Array.isArray(kpis) ? kpis : []) {
    if (!isObj(k) || !P.kpi_statuses.includes(k.status) || !isSet(k.label)) continue;
    if (audience === 'public' && k.public_permission !== true) continue;
    out.push(Object.fromEntries(P.kpi_keys.filter(key => own(k, key)).map(key => [key, clone(k[key])])));
    if (out.length === P.kpi_max) break;
  }
  return out;
}

// The quote object, or null. Only an explicitly permitted, sourced, verbatim quote survives.
function projectQuote(quote, anonymize) {
  if (!isObj(quote) || quote.permission !== true || !isSet(quote.exact_text) || !isSet(quote.source_ref)) return null;
  const out = Object.fromEntries(P.quote_keys.filter(k => own(quote, k)).map(k => [k, clone(quote[k])]));
  out.permission = true;
  if (anonymize) { out.speaker = null; out.company = P.anonymized_label; }
  return out;
}

const projectBeforeAfter = items => Array.isArray(items)
  ? items.filter(isObj).map(i => Object.fromEntries(P.before_after_keys.filter(k => own(i, k)).map(k => [k, clone(i[k])]))) : [];

function lookup(obj, path) {
  for (const part of path.split('.')) {
    if (!isObj(obj) || !own(obj, part)) return [false, null];
    obj = obj[part];
  }
  return [true, obj];
}

function store(out, path, value) {
  const parts = path.split('.');
  for (const part of parts.slice(0, -1)) { if (!own(out, part)) out[part] = {}; out = out[part]; }
  out[parts.at(-1)] = value;
}

function scrub(value, pattern, label) {
  if (typeof value === 'string') return value.replace(pattern, () => label);
  if (Array.isArray(value)) return value.map(v => scrub(v, pattern, label));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, pattern, label)]));
  return value;
}

export function projectForAudience(story, audience) {
  if (!P.audiences.includes(audience)) throw new ProjectionError('audience', `unknown audience ${JSON.stringify(audience)}`);
  if (!isObj(story)) throw new ProjectionError('story', 'story must be an object');
  const missing = gateFailures(story, audience);
  if (missing.length) throw new ProjectionError('denied', `${audience} projection needs approval_state: ${missing.join(', ')}`, { audience, missing });
  const anonymize = anonymizing(story, audience);
  const fields = audience === 'internal' ? [...P.public_fields, ...P.internal_fields] : P.public_fields;
  let out = {};
  for (const path of fields) {
    let [found, value] = lookup(story, path);
    if (!found) continue;
    if (path === 'kpis') value = projectKpis(value, audience);
    else if (path === 'results.before_after') value = projectBeforeAfter(value);
    else if (path === QUOTE_PATH) { value = projectQuote(value, anonymize); if (value === null) continue; }
    else value = clone(value);
    store(out, path, value);
  }
  if (anonymize) {
    const name = isObj(story.project) ? story.project.client_display : undefined;
    if (typeof name === 'string' && Array.from(name.trim()).length >= 3) {
      const text = name.trim();
      const quote = isObj(out.amaris_differentiator) ? out.amaris_differentiator.client_quote : undefined;
      if (quote !== undefined) delete out.amaris_differentiator.client_quote;
      out = scrub(out, new RegExp(escapeRe(text), 'gi'), P.anonymized_label);
      if (quote !== undefined && !new RegExp(escapeRe(text), 'i').test(quote.exact_text)) store(out, QUOTE_PATH, quote); // verbatim text is never edited: a quote naming the client is dropped
    }
    store(out, 'project.client_display', P.anonymized_label);
  }
  return out;
}
