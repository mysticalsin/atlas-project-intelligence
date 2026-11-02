// JavaScript port of atlas_voice/turns.py analyzeTurn (parity-tested): a deterministic pre-pass over ONE consultant utterance.
// It reports what the WORDS do (intents, cues, field hints, numbers), never the person. All tables come from policy.generated.js.
import {
  NUMERIC_SRC, UNCERTAIN_SRC, FIELDS, TURN_MAX_CHARS, TURN_MAX_NUMBERS, TURN_INTENT_ORDER, TURN_INTENT_MAX_WORDS, TURN_CUE_ORDER, TURN_LANGS_WITH_CUES, TURN_LANGS_WITH_INTENTS,
  TURN_INTENT_RULES, TURN_CUE_SRC, TURN_TECH_SRC, TURN_HINT_SRC, TURN_HINT_FROM_TO, TURN_CUE_GATES, TURN_HINT_GATES, TURN_NUMBER_GATE, TURN_NOT_AN_ANSWER, TURN_ASKED_MIN_WORDS, TURN_NUMBER_SRC,
  TURN_UNIT_CANON, TURN_SCALE, TURN_THOUSANDS_SRC, TURN_DOT_THOUSANDS_SRC, TURN_AMBIGUOUS_DOT_SRC, TURN_PLAIN_NUMBER_SRC, TURN_WHITESPACE_SRC,
} from './policy.generated.js';

const cache = new Map();
const re = (src, flags = 'i') => { const k = flags + src; let r = cache.get(k); if (!r) cache.set(k, r = new RegExp(src, flags)); return r; };
const WS = new RegExp(TURN_WHITESPACE_SRC, 'g');
const QUOTES = [['‘', "'"], ['’', "'"], ['ʼ', "'"], ['“', '"'], ['”', '"']];
const FIELD_KEYS = Object.keys(FIELDS);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function normalize(text) {
  let t = text.slice(0, TURN_MAX_CHARS).normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [k, v] of QUOTES) t = t.split(k).join(v);
  return t.toLowerCase().replace(WS, ' ').trim();
}

const lang = l => String(l || 'en').toLowerCase().replace(/_/g, '-').split('-')[0];

function numberValue(digits) {
  let s = digits;
  if (re(TURN_AMBIGUOUS_DOT_SRC, '').test(s)) return null;
  if (re(TURN_THOUSANDS_SRC, '').test(s)) s = s.split(',').join('');
  else if (re(TURN_DOT_THOUSANDS_SRC, '').test(s)) s = s.split('.').join('');
  else if (s.includes(',') && !s.includes('.') && s.split(',').length === 2) s = s.replace(',', '.');
  if (!re(TURN_PLAIN_NUMBER_SRC, '').test(s) || s.length > 15) return null;
  return parseFloat(s);
}

export function numbers(norm, probe = new Probe(norm)) {
  const out = [];
  if (!probe.passes(TURN_NUMBER_GATE)) return out; // no digit, no number
  for (const m of norm.matchAll(new RegExp(TURN_NUMBER_SRC, 'gi'))) {
    const [text, cur, digits, sym, letters, word] = m;
    const item = { text };
    let value = numberValue(digits), unit = has(TURN_UNIT_CANON, sym || letters || word || '') ? TURN_UNIT_CANON[sym || letters || word] : undefined;
    const key = letters || word || '', scale = has(TURN_SCALE, key) ? TURN_SCALE[key] : 0;
    if (value !== null && scale) { value *= scale; unit = undefined; }
    if (cur) unit = cur;
    if (value !== null) item.value = value;
    if (unit) item.unit = unit;
    out.push(item);
    if (out.length >= TURN_MAX_NUMBERS) break; // stop scanning at the cap, not one match later
  }
  return out;
}

export function intents(norm, lg, words, probe = new Probe(norm)) {
  const rules = has(TURN_INTENT_RULES, lg) ? TURN_INTENT_RULES[lg] : null;
  if (!rules) return [];
  const found = new Set();
  for (const r of rules) {
    if (found.has(r.intent)) continue;
    const limit = r.max_words !== null ? r.max_words : TURN_INTENT_MAX_WORDS[r.intent];
    if (limit !== undefined && words > limit) continue;
    if (r.unless_intents.some(i => found.has(i))) continue;
    if (!probe.test(r.src, r.gate)) continue;
    if (r.unless_src && re(r.unless_src).test(norm)) continue;
    found.add(r.intent);
  }
  return TURN_INTENT_ORDER.filter(i => found.has(i));
}

// A cheap pre-test in front of EVERY costlier pattern (turns.py regex_gate): the tables list, per pattern, requirements (each a list of literals) a match cannot do without,
// and the pattern is only run when the text holds one literal of every requirement. Each requirement is one small alternation of escaped literals (a single scan; V8 runs that
// faster than a substring search per literal), built once and cached.
const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const gateRe = new WeakMap();
const gateTest = (req, norm) => { let r = gateRe.get(req); if (!r) gateRe.set(req, r = new RegExp(req.map(esc).join('|'))); return r.test(norm); };
class Probe {
  constructor(norm) { this.norm = norm; }
  passes(gates) { return gates.every(req => gateTest(req, this.norm)); }
  test(src, gates) { return this.passes(gates) && re(src).test(this.norm); }
}
// True when the words describe a setback: the setback words left once "zero data loss" and the CLIENT's own problem ("the business was frustrated") are taken out.
// problem: whether the text holds the client's problem, when the caller has already looked (else it is looked for here).
export function setbackWords(norm, problem = null, probe = new Probe(norm)) {
  let stripped = probe.passes(TURN_CUE_GATES.setback_strip) ? norm.replace(re(TURN_CUE_SRC.setback_strip, 'gi'), ' ') : norm;
  if (problem === null ? probe.test(TURN_CUE_SRC.client_problem, TURN_CUE_GATES.client_problem) : problem) stripped = stripped.replace(re(TURN_CUE_SRC.client_problem, 'gi'), ' ');
  return (stripped === norm ? probe : new Probe(stripped)).test(TURN_CUE_SRC.describes_setback, TURN_CUE_GATES.describes_setback);
}

export function cues(norm, probe = new Probe(norm)) {
  const S = TURN_CUE_SRC, G = TURN_CUE_GATES, find = (name, src = S[name]) => probe.test(src, G[name]), out = new Set();
  const metric = find('numeric', NUMERIC_SRC) || find('metric_extra');
  if (metric) {
    out.add('metric');
    if (find('uncertain', UNCERTAIN_SRC) || find('estimate_extra')) out.add('estimate');
  }
  if (find('vague_strong') || (!metric && find('vague_weak'))) out.add('vague_verb');
  if (find('team_verb') && !find('i')) out.add('team_claim');
  if (probe.passes(G.tech) && new Set([...norm.matchAll(new RegExp(TURN_TECH_SRC, 'gi'))].map(m => m[0])).size >= S.tech_min) out.add('tech_list');
  if (find('certification')) out.add('certification');
  if (find('client_praise_said') || find('client_praise_direct')) out.add('client_praise');
  const problem = find('client_problem');
  if (problem) out.add('describes_problem');
  if (setbackWords(norm, problem, probe)) out.add('describes_setback');
  if (find('describes_achievement')) out.add('describes_achievement');
  if (find('names_party')) out.add('names_party');
  if (find('period_words')) out.add('period_stated');
  if (find('action')) out.add('describes_action');
  return TURN_CUE_ORDER.filter(c => out.has(c));
}

export function fieldHints(norm, words, found, context, probe = new Probe(norm)) {
  const hits = new Set();
  for (const [f, src] of Object.entries(TURN_HINT_SRC)) if (probe.test(src, TURN_HINT_GATES[f])) hits.add(f);
  if (!hits.has('measurement') && probe.test(TURN_HINT_FROM_TO, TURN_HINT_GATES.from_to)) hits.add('measurement');
  const asked = context !== null && typeof context === 'object' && !Array.isArray(context) ? context.asked_field : null;
  if (words >= TURN_ASKED_MIN_WORDS && typeof asked === 'string' && FIELD_KEYS.includes(asked) && !TURN_NOT_AN_ANSWER.some(i => found.includes(i))) hits.add(asked);
  return FIELD_KEYS.filter(f => hits.has(f));
}

export function analyzeTurn(text, lg = 'en', context = null) {
  text = typeof text === 'string' ? text : '';
  const norm = normalize(text), probe = new Probe(norm), words = text.split(WS).filter(Boolean).length, l = lang(lg);
  const found = TURN_LANGS_WITH_INTENTS.includes(l) ? intents(norm, l, words, probe) : [], full = TURN_LANGS_WITH_CUES.includes(l);
  return { intents: found, cues: full ? cues(norm, probe) : [], field_hints: full ? fieldHints(norm, words, found, context, probe) : [], numbers: full ? numbers(norm, probe) : [], words };
}
