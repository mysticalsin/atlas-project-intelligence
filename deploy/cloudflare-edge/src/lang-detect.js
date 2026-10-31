// JavaScript port of atlas_voice/languages.py detect() (parity-tested, test/lang.vectors.json): which language a short typed or transcribed text is
// written in, from script ranges plus stopword sets. Pure and deterministic; the tables come from policy.generated.js (LANG_DETECT).
import { LANG_DETECT as D } from './policy.generated.js';

const STOP = Object.fromEntries(Object.entries(D.latin_stopwords).map(([l, w]) => [l, new Set(w.split(' '))]));
const CYR = Object.fromEntries(Object.entries(D.cyrillic_stopwords).map(([l, w]) => [l, new Set(w.split(' '))]));
const LISTED = {};
for (const words of Object.values(STOP)) for (const w of words) LISTED[w] = (LISTED[w] || 0) + 1; // a word several languages list scores one point, one only a single language has scores two
const MARKS = Object.entries(D.latin_marks).map(([l, chars]) => [l, new Set([...chars])]);
const isLetter = ch => /^\p{L}$/u.test(ch);
const hasLetter = w => /\p{L}/u.test(w);

function scriptOf(cp) { for (const [name, lo, hi] of D.ranges) if (cp >= lo && cp <= hi) return name; return null; }
function tokens(text) { return text.match(/\p{L}+/gu)?.map(t => t.toLowerCase()) || []; }
const anyOf = (chars, text) => [...text].some(c => chars.includes(c));

export function detect(raw) {
  const text = [...String(raw ?? '').normalize('NFKC')].slice(0, D.chars).join('');
  const counts = {}; let letters = 0;
  for (const ch of text) {
    if (!isLetter(ch)) continue;
    letters += 1;
    const s = scriptOf(ch.codePointAt(0));
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  const spaced = text.split(/\s+/).filter(w => w && hasLetter(w)).length;
  const cjk = (counts.han || 0) + (counts.hiragana || 0) + (counts.katakana || 0) + (counts.hangul || 0) + (counts.thai || 0);
  const units = cjk * 2 >= letters ? Math.max(spaced, Math.floor(cjk / 2)) : spaced;
  const out = { lang: null, units, score: 0, strong: false };
  const scripts = Object.keys(counts).sort();
  if (letters < 2 || !scripts.length) return out;
  const kana = (counts.hiragana || 0) + (counts.katakana || 0), han = counts.han || 0;
  let top = scripts[0];
  for (const k of scripts) if (counts[k] > counts[top]) top = k;
  if (kana && kana + han >= Math.floor(letters * 3 / 5)) {
    return { ...out, lang: 'ja', score: kana + han, strong: units >= 3 && (kana + han) * 10 >= letters * 8 };
  }
  if (counts[top] * 5 < letters * 3) return out;
  let lang;
  if (top === 'han') lang = 'zh';
  else if (top === 'arabic') lang = Object.entries(D.arabic_marks).find(([, marks]) => anyOf(marks, text))?.[0] || 'ar';
  else if (top === 'cyrillic') {
    const toks = tokens(text), lower = text.toLowerCase();
    const mark = Object.entries(D.cyrillic_marks).find(([, marks]) => anyOf(marks, lower))?.[0] || null;
    const score = code => toks.filter(t => CYR[code].has(t)).length;
    lang = mark || (score('uk') > score('ru') ? 'uk' : 'ru');
  } else if (top === 'latin') return latin(text, out);
  else lang = D.script_lang[top] || null;
  return { ...out, lang, score: counts[top], strong: !!lang && units >= 3 && counts[top] * 10 >= letters * 8 };
}

function latin(text, out) {
  const toks = tokens(text), marks = {};
  for (const ch of text.toLowerCase()) for (const [l, set] of MARKS) if (set.has(ch)) marks[l] = (marks[l] || 0) + 1;
  const scores = Object.entries(STOP).map(([l, words]) => [l, toks.reduce((n, t) => n + (words.has(t) ? (LISTED[t] === 1 ? 2 : 1) : 0), 0) + Math.min(D.mark_cap, marks[l] || 0)]);
  scores.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const [bestLang, best] = scores[0], second = scores[1][1];
  const result = { ...out, score: best };
  if (best >= D.min_score && best > second) { result.lang = bestLang; result.strong = best >= D.strong_score && best >= 2 * second; }
  return result;
}
