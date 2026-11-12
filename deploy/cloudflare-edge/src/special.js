// Special-category guard (GDPR Art 9), JS port of atlas_voice/privacy_config.py special_categories() (the source of truth; test/special.vectors.json holds the port to it). It matches
// short phrase lists (health, trade union, religion, politics, sexual orientation, ethnic origin; the seven bank languages plus ru, pl, ar, ja, zh) after one normal form that folds
// look-alike letters, drops invisible characters and rejoins spaced-out letters (v2.2 X2, red M13). A match only offers "keep this private?" at the read-back and keeps that text out
// of private memory. It is a flag on a sentence, never a statement about a person: nothing here is stored against anyone, and no trait is inferred (decision D18).
import { SPECIAL_PHRASES, SPECIAL_EXCLUDE, SPECIAL_LANGS } from './policy.generated.js';
import { fold } from './textfold.js';
import { detect } from './lang-detect.js';

// The same normal form as Python: folded, German transliteration, marks stripped, every run of other characters one space, a run of 3+ single letters one word.
export function normalizeText(text) {
  const s = fold(text).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/\p{M}/gu, '');
  const tokens = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' '), out = []; let run = [];
  for (const t of [...tokens, '']) {
    if (/^\p{L}$/u.test(t)) { run.push(t); continue; }
    if (run.length) { out.push(...(run.length >= 3 ? [run.join('')] : run)); run = []; }
    if (t) out.push(t);
  }
  return out.join(' ');
}
// Scripts written without spaces between words (and Arabic, whose words carry attached prefixes): their phrases match anywhere, any other only as whole words.
const NOSPACE = /[؀-ۿ぀-ヿ㐀-鿿฀-๿]/;
const TABLE = Object.entries(SPECIAL_PHRASES).map(([cat, phrases]) => [cat, phrases.map(p => NOSPACE.test(p) ? p : ' ' + p + ' ')]);

// The categories whose phrases appear in `text`, in the fixed category order. A listed place name ("Church Street") is removed first (red L14).
export function specialCategories(text) {
  let s = ' ' + normalizeText(text) + ' ';
  for (const x of SPECIAL_EXCLUDE) s = s.split(' ' + x + ' ').join(' | ');
  return TABLE.filter(([, phrases]) => phrases.some(p => s.includes(p))).map(([cat]) => cat);
}
export const isSpecial = text => specialCategories(text).length > 0;
// True when `text` is written in a language that has no phrase list here (the detector names it and it is not in SPECIAL_LANGS): callers keep such model-written text out of
// private memory rather than retain it unchecked. False for short or unnamed text.
export function uncoveredLanguage(text) { const lang = detect(text).lang; return lang != null && !SPECIAL_LANGS.includes(lang); }
