// JavaScript port of atlas_voice/asr.py (parity-tested): the spans of an utterance the recogniser was unsure of and that matter
// (numbers, the word next to a percent or currency marker, capitalised words inside a sentence). An unclear number or proper noun
// is confirmed with the consultant, never silently converted. All tables come from policy.generated.js.
import { ASR_TAU, ASR_MAX_WORDS, ASR_MAX_SPANS, ASR_MAX_TEXT_WORDS, ASR_MAX_TOKEN_CHARS, ASR_PUNCT, ASR_CLOSERS, ASR_SENTENCE_END, ASR_NUMBER_WORDS,
  ASR_UNIT_AFTER, ASR_UNIT_BEFORE, ASR_SLOT_AFTER, ASR_STOPWORDS, ASR_I_WORDS } from './policy.generated.js';

const PUNCT = new Set(ASR_PUNCT), NUMBER_WORDS = new Set(ASR_NUMBER_WORDS), UNIT_AFTER = new Set(ASR_UNIT_AFTER), UNIT_BEFORE = new Set(ASR_UNIT_BEFORE), SLOT_AFTER = new Set(ASR_SLOT_AFTER);
const STOPWORDS = new Set(ASR_STOPWORDS), I_WORDS = new Set(ASR_I_WORDS), DECIMAL = /^\s*(?:[0-9]+\.?[0-9]*|\.[0-9]+)\s*$/;
const chars = s => [...s]; // by code point, like Python

function core(token) {
  const c = chars(token); let a = 0, b = c.length;
  while (a < b && PUNCT.has(c[a])) a++;
  while (b > a && PUNCT.has(c[b - 1])) b--;
  return c.slice(a, b).join('');
}
const isNumber = c => /[0-9]/.test(c) || c.toLowerCase().split('-').every(p => NUMBER_WORDS.has(p));
const upperFirst = c => { const ch = chars(c)[0] ?? ''; return ch !== '' && ch.toLowerCase() !== ch && ch.toUpperCase() === ch; };
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const cut = (s, n) => chars(s).slice(0, n).join('');
const sentenceEnd = w => { const c = chars(w); let b = c.length; while (b > 0 && ASR_CLOSERS.includes(c[b - 1])) b--; return b > 0 && ASR_SENTENCE_END.includes(c[b - 1]); };

function clean(words, limit) {
  return (Array.isArray(words) ? words.slice(0, limit) : []).map(item => {
    const x = item !== null && typeof item === 'object' && !Array.isArray(item) ? item : {};
    return { w: typeof x.w === 'string' ? cut(x.w, ASR_MAX_TOKEN_CHARS) : '', c: num(x.c), s: num(x.s), e: num(x.e) };
  });
}

function groups(words) {
  const n = words.length, cores = words.map(x => core(x.w)), low = cores.map(c => c.toLowerCase()), role = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!cores[i]) continue;
    if (UNIT_AFTER.has(low[i])) role[i] = 'after';
    else if (UNIT_BEFORE.has(low[i])) role[i] = 'before';
    else if (isNumber(cores[i])) role[i] = 'number';
    else if (upperFirst(cores[i]) && chars(cores[i]).length >= 2 && !I_WORDS.has(low[i]) && i && !sentenceEnd(words[i - 1].w)) role[i] = 'proper_noun';
  }
  for (let i = 0; i < n; i++) {
    if (role[i] === 'after' && SLOT_AFTER.has(low[i]) && i && role[i - 1] === null && cores[i - 1] && !STOPWORDS.has(low[i - 1])) role[i - 1] = 'number';
    else if (role[i] === 'before' && i + 1 < n && role[i + 1] === null && cores[i + 1] && !STOPWORDS.has(low[i + 1])) role[i + 1] = 'number';
  }
  const found = []; let current = null;
  for (let i = 0; i < n; i++) {
    if (role[i] === null) { current = null; continue; }
    const kind = role[i] === 'proper_noun' ? 'proper_noun' : 'number';
    if (current === null || current.kind !== kind || role[i - 1] === 'after' || (role[i] === 'before' && role[i - 1] !== 'before')) { current = { kind, indices: [] }; found.push(current); }
    current.indices.push(i);
  }
  return found.filter(g => g.indices.some(i => role[i] === 'number' || role[i] === 'proper_noun') && !(g.indices.length === 1 && low[g.indices[0]] === 'one'))
    .map(g => ({ kind: g.kind, indices: g.indices, text: g.indices.map(i => cores[i]).join(' ') }));
}

export function tauFrom(value, def = ASR_TAU) {
  const v = typeof value === 'string' ? (DECIMAL.test(value) ? parseFloat(value) : null) : num(value);
  return v !== null && v > 0 && v <= 1 ? v : def;
}

export function uncertainSpans(words, tau = ASR_TAU) {
  words = clean(words, ASR_MAX_WORDS); tau = tauFrom(tau);
  const spans = [];
  for (const g of groups(words)) {
    const confs = g.indices.map(i => words[i].c).filter(c => c !== null);
    if (!confs.length) continue;
    const min = Math.min(...confs);
    if (min >= tau) continue;
    spans.push({ text: g.text, kind: g.kind, min_conf: min, start: words[g.indices[0]].s, end: words[g.indices.at(-1)].e, at: g.indices[0] });
  }
  spans.sort((a, b) => (a.kind !== 'number') - (b.kind !== 'number') || a.min_conf - b.min_conf || a.at - b.at);
  return spans.slice(0, ASR_MAX_SPANS).map(({ at, ...rest }) => rest);
}

export function replacement(text, kind) {
  const tokens = typeof text === 'string' ? text.split(/\s+/).filter(Boolean).slice(0, ASR_MAX_TEXT_WORDS) : [];
  const found = groups(tokens.map(t => ({ w: cut(t, ASR_MAX_TOKEN_CHARS), c: 1.0, s: null, e: null }))).filter(g => g.kind === kind);
  return found.length ? found.at(-1).text : null;
}

// Deepgram Nova-3 (Workers AI) result -> [{w, c, s, e}]: the word as punctuated (capitals matter for proper nouns), confidence 0..1,
// start and end in seconds, at most ASR_MAX_WORDS. A result without words (another model, an empty clip) gives []. JS only: Python
// never sees the raw result. (languages.js reads the same alternatives[0].words for the language.)
export function sttWords(result) {
  const list = result?.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!Array.isArray(list)) return [];
  const out = [], r3 = v => Math.round(v * 1000) / 1000;
  for (const x of list.slice(0, ASR_MAX_WORDS)) {
    const w = typeof x?.punctuated_word === 'string' && x.punctuated_word ? x.punctuated_word : x?.word;
    if (typeof w !== 'string' || !w) continue;
    const c = num(x.confidence), s = num(x.start), e = num(x.end);
    out.push({ w: cut(w, ASR_MAX_TOKEN_CHARS), c: c === null ? null : r3(Math.min(1, Math.max(0, c))), s: s === null ? null : r3(s), e: e === null ? null : r3(e) });
  }
  return out;
}
