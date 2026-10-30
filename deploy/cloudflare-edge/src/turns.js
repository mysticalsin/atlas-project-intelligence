// JavaScript port of atlas_voice/turns.py analyzeTurn (parity-tested): a deterministic pre-pass over ONE consultant utterance.
// It reports what the WORDS do (intents, cues, field hints, numbers), never the person. All tables come from policy.generated.js.
import {
  NUMERIC_SRC, UNCERTAIN_SRC, FIELDS, TURN_MAX_CHARS, TURN_MAX_NUMBERS, TURN_INTENT_ORDER, TURN_CUE_ORDER, TURN_LANGS_WITH_CUES, TURN_LANGS_WITH_INTENTS,
  TURN_INTENT_RULES, TURN_CUE_SRC, TURN_TECH_SRC, TURN_HINT_SRC, TURN_HINT_FROM_TO, TURN_NOT_AN_ANSWER, TURN_ASKED_MIN_WORDS, TURN_NUMBER_SRC,
  TURN_UNIT_CANON, TURN_SCALE, TURN_THOUSANDS_SRC, TURN_DOT_THOUSANDS_SRC, TURN_AMBIGUOUS_DOT_SRC, TURN_PLAIN_NUMBER_SRC, TURN_WHITESPACE_SRC,
} from './policy.generated.js';

const cache = new Map();
const re = (src, flags = 'i') => { const k = flags + src; let r = cache.get(k); if (!r) cache.set(k, r = new RegExp(src, flags)); return r; };
const test = src => s => re(src).test(s);
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

export function numbers(norm) {
  const out = [];
  for (const m of norm.matchAll(new RegExp(TURN_NUMBER_SRC, 'gi'))) {
    if (out.length >= TURN_MAX_NUMBERS) break;
    const [text, cur, digits, sym, letters, word] = m;
    const item = { text };
    let value = numberValue(digits), unit = has(TURN_UNIT_CANON, sym || letters || word || '') ? TURN_UNIT_CANON[sym || letters || word] : undefined;
    const key = letters || word || '', scale = has(TURN_SCALE, key) ? TURN_SCALE[key] : 0;
    if (value !== null && scale) { value *= scale; unit = undefined; }
    if (cur) unit = cur;
    if (value !== null) item.value = value;
    if (unit) item.unit = unit;
    out.push(item);
  }
  return out;
}

export function intents(norm, lg, words) {
  const rules = has(TURN_INTENT_RULES, lg) ? TURN_INTENT_RULES[lg] : null;
  if (!rules) return [];
  const found = new Set();
  for (const r of rules) {
    if (found.has(r.intent)) continue;
    if (r.max_words !== null && words > r.max_words) continue;
    if (r.unless_intents.some(i => found.has(i))) continue;
    if (!re(r.src).test(norm)) continue;
    if (r.unless_src && re(r.unless_src).test(norm)) continue;
    found.add(r.intent);
  }
  return TURN_INTENT_ORDER.filter(i => found.has(i));
}

export function cues(norm) {
  const S = TURN_CUE_SRC, out = new Set();
  const metric = test(NUMERIC_SRC)(norm) || test(S.metric_extra)(norm);
  if (metric) {
    out.add('metric');
    if (test(UNCERTAIN_SRC)(norm) || test(S.estimate_extra)(norm)) out.add('estimate');
  }
  if (test(S.vague_strong)(norm) || (!metric && test(S.vague_weak)(norm))) out.add('vague_verb');
  if (test(S.team_verb)(norm) && !test(S.i)(norm)) out.add('team_claim');
  if (new Set([...norm.matchAll(new RegExp(TURN_TECH_SRC, 'gi'))].map(m => m[0])).size >= S.tech_min) out.add('tech_list');
  if (test(S.certification)(norm)) out.add('certification');
  if (test(S.client_praise_said)(norm) || test(S.client_praise_direct)(norm)) out.add('client_praise');
  if (test(S.describes_setback)(norm)) out.add('describes_setback');
  if (test(S.describes_achievement)(norm)) out.add('describes_achievement');
  return TURN_CUE_ORDER.filter(c => out.has(c));
}

export function fieldHints(norm, words, found, context) {
  const hits = new Set();
  for (const [f, src] of Object.entries(TURN_HINT_SRC)) if (test(src)(norm)) hits.add(f);
  if (!hits.has('measurement') && test(TURN_HINT_FROM_TO)(norm)) hits.add('measurement');
  const asked = context !== null && typeof context === 'object' && !Array.isArray(context) ? context.asked_field : null;
  if (words >= TURN_ASKED_MIN_WORDS && typeof asked === 'string' && FIELD_KEYS.includes(asked) && !TURN_NOT_AN_ANSWER.some(i => found.includes(i))) hits.add(asked);
  return FIELD_KEYS.filter(f => hits.has(f));
}

export function analyzeTurn(text, lg = 'en', context = null) {
  text = typeof text === 'string' ? text : '';
  const norm = normalize(text), words = text.split(WS).filter(Boolean).length, l = lang(lg);
  const found = TURN_LANGS_WITH_INTENTS.includes(l) ? intents(norm, l, words) : [], full = TURN_LANGS_WITH_CUES.includes(l);
  return { intents: found, cues: full ? cues(norm) : [], field_hints: full ? fieldHints(norm, words, found, context) : [], numbers: full ? numbers(norm) : [], words };
}
