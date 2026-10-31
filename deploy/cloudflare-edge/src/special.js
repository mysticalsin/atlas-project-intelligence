// Special-category guard (GDPR Art 9), JS port of atlas_voice/privacy_config.py special_categories() (the source of truth; test/special.vectors.json holds the
// port to it). It matches short phrase lists (health, trade union, religion, politics, sexual orientation, ethnic origin; en, fr, es, pt, de, it, nl) on whole
// words after one normal form. A match only offers "keep this private?" at the read-back and keeps that text out of private memory. It is a flag on a
// sentence, never a statement about a person: nothing here is stored against anyone, and no trait is inferred (decision D18).
import { SPECIAL_PHRASES } from './policy.generated.js';

// The same normal form as Python: German transliteration, accents stripped, lower case, every run of other characters one space.
export function normalizeText(text) {
  const s = String(text ?? '').replace(/ä|Ä/g, 'ae').replace(/ö|Ö/g, 'oe').replace(/ü|Ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}
const TABLE = Object.entries(SPECIAL_PHRASES).map(([cat, phrases]) => [cat, phrases.map(p => ' ' + p + ' ')]);

// The categories whose phrases appear in `text`, in the fixed category order.
export function specialCategories(text) {
  const s = ' ' + normalizeText(text) + ' ';
  return TABLE.filter(([, phrases]) => phrases.some(p => s.includes(p))).map(([cat]) => cat);
}
export const isSpecial = text => specialCategories(text).length > 0;
