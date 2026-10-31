// Content-aware spoken acknowledgement (plan 3d): a short fixed line, played from cache while the reply is prepared, chosen from
// what the answer was about (the turn pre-pass cues), never from a judgement of the person. Pure and deterministic: the caller
// supplies the state (recent lines, replies since the last earned one, seed) and keeps it. Banks come from persona.py via
// policy.generated.js (every BANK_LANGUAGE has all of them); a language without a bank gets no acknowledgement from cache at all (v2.2 L1: never English).
import { ACKS, BANNED_PRAISE_SRC } from './policy.generated.js';
import { FILLERS, normalize, hasBank } from './languages.js';

export const ACK_MIN_WORDS = 8; // an acknowledgement only after a real answer
export const ACK_NO_REPEAT = 4; // a line is not used again within the last four
export const EARNED_EVERY = 3; // at most one earned_result in three replies
const CATEGORIES = Object.keys(ACKS);
// Categories that do not praise or cheer: fine after a setback. Anything else becomes setback_neutral there.
const SETBACK_SAFE = new Set(['setback_neutral', 'setback_plain', 'correction_thanks', 'correction_thanks_fact', 'confidential_ok', 'no_number_fine']);
// These answer what the consultant just did ("I don't know", "I can't share", a change), so they are said even after a short answer ("I do not know the baseline, honestly.").
const SHORT_OK = new Set(['no_number_fine', 'confidential_ok', 'correction_thanks', 'correction_thanks_fact']);
// A plain uptake ("Okay.", "Thanks, that helps.") is said on alternate replies at most: constant acknowledgement stops sounding like listening.
const ALTERNATING = new Set(['neutral', 'thanks_detail', 'setback_plain']);
// A bare "yes" word is not a fit after a setback ("Yeah." after a failed pilot sounds like agreement with it).
const YES_ONLY = /^(?:yeah|yes|oui|sí|si|sim|ja|sì|ok)\.$/i;
const banned = new RegExp(BANNED_PRAISE_SRC, 'i');

const hasCue = (cues, c) => Array.isArray(cues) ? cues.includes(c) : cues instanceof Set ? cues.has(c) : !!(cues && cues[c]);

function hash(seed) { // FNV-1a over the seed's text: any number or string gives a stable unsigned 32-bit value
  let h = 0x811c9dc5; const s = String(seed ?? 0);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// The variants not used within the last `window` lines; when every variant was (a short bank), the least recently used ones.
function fresh(variants, recent, window) {
  const last = recent.slice(-window), pool = variants.filter(v => !last.includes(v));
  if (pool.length) return pool;
  const idx = v => recent.lastIndexOf(v), oldest = Math.min(...variants.map(idx));
  return variants.filter(v => idx(v) === oldest);
}

// The category after the content rules. null category input means neutral.
function resolve(category, cues, repliesSinceEarned) {
  let c = CATEGORIES.includes(category) ? category : 'neutral';
  if (hasCue(cues, 'describes_setback') && !SETBACK_SAFE.has(c)) return 'setback_neutral';
  if (c === 'earned_result' || c === 'promising_unverified') {
    // A figure said in this turn has no basis yet (before/after, period, source): hedged, never earned.
    if (hasCue(cues, 'metric') || hasCue(cues, 'estimate') || hasCue(cues, 'unverified')) return 'promising_unverified';
    if (c === 'earned_result' && !(repliesSinceEarned === undefined || repliesSinceEarned === null || repliesSinceEarned >= EARNED_EVERY)) return 'thanks_detail';
  }
  return c;
}

// pickAck({category, cues, words, lang, recent, admin, afterQuestion, timeUp, repliesSinceEarned, seed}) -> {text, category} | null
//   category: what the selector asked for; cues: analyze_turn cues of this answer; words: its word count; recent: texts of the last
//   acknowledgements (oldest first); afterQuestion: the consultant asked ATLAS something (she answers it, no preamble);
//   repliesSinceEarned: replies since the last earned_result (omitted: none yet); prevCategory: the category of the acknowledgement before this
//   one (null when that reply had none), which keeps a neutral or "thanks for the detail" line to alternate replies.
export function pickAck({ category = 'neutral', cues = [], words = 0, lang = 'en', recent = [], admin = false, afterQuestion = false, timeUp = false, repliesSinceEarned, prevCategory = null, seed = 0 } = {}) {
  const setback = hasCue(cues, 'describes_setback');
  // A setback is never left unacknowledged: it gets at least a plain uptake even after a short answer or right after another one. Only admin, a question to ATLAS and the time limit silence it.
  if (admin || afterQuestion || timeUp || !(setback || Number(words) >= ACK_MIN_WORDS || SHORT_OK.has(category))) return null;
  const code = lang ? normalize(lang) : 'en', seen = Array.isArray(recent) ? recent : [];
  if (!code) return null; // a language we cannot even name: nothing from cache, never another language's line
  let cat = resolve(category, cues, repliesSinceEarned), bank = ACKS[cat] && ACKS[cat][code];
  // A language with no authored bank (anything but the BANK_LANGUAGES) gets nothing from cache: the talker answers in the language, and an English line is never played to a speaker of another.
  if (!bank && hasBank(code)) { // a bank language missing this category: the neutral filler (always neutral, whatever was asked)
    cat = 'neutral'; bank = FILLERS[code] || null;
    if (bank && setback) bank = bank.filter(f => !YES_ONLY.test(f));
  }
  bank = bank && bank.filter(t => !banned.test(t) && !t.includes('?'));
  if (!bank || !bank.length) return null;
  if (!setback && ALTERNATING.has(cat) && ALTERNATING.has(prevCategory)) return null; // the H2 pacing downgrades sympathy to the plain uptake on a setback, never to silence
  const pool = fresh(bank, seen, Math.min(ACK_NO_REPEAT, bank.length - 1));
  return { text: pool[hash(seed) % pool.length], category: cat };
}

// Every line to synthesise ahead of time for a language (the cache keeps them for all sessions).
export function ackPrewarmList(lang = 'en') {
  const code = lang ? normalize(lang) : 'en', out = new Set();
  for (const c of CATEGORIES) for (const t of (ACKS[c] && ACKS[c][code]) || []) out.add(t);
  if (!out.size && hasBank(code)) for (const t of FILLERS[code] || []) out.add(t);
  return [...out];
}
