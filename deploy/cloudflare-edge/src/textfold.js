// JavaScript port of atlas_voice/textfold.py (the source of truth; test/fold.vectors.json holds the port to it): the one normal form for matching text against
// word lists. NFKC, invisible format characters removed, lower case, and letters of other scripts that look like a Latin letter read as that letter. Used to MATCH
// only; the text that is voiced, shown or stored is never replaced by it.
import { FOLD_CONFUSABLES, FOLD_FLAT } from './policy.generated.js';

const LOOK = new RegExp('[' + Object.keys(FOLD_CONFUSABLES).join('') + ']', 'gu');
export function fold(text) {
  return String(text ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase().replace(LOOK, c => FOLD_CONFUSABLES[c]);
}
export const foldList = words => words.map(fold);
// fold() with accents removed as well (NFKD, every mark dropped, ß æ œ ø ł as plain letters): "Vérifié" and "verifie" are one word.
export const plain = text => fold(text).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[ßæœøłđðþ]/g, c => FOLD_FLAT[c]);
