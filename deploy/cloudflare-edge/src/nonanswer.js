// JavaScript port of atlas_voice/nonanswer.py (the source of truth; test/nonanswer.vectors.json holds the port to it): what is NOT an answer.
// kind(text): '' (an answer), 'refusal' (a deferral, a refusal or a skip: "I don't know", "no idea", "pass", "next question", "I can't share") or 'filler'
// (a bare acknowledgement or nothing but punctuation), or 'injection' (an instruction to ATLAS hidden in the answer). The whole utterance has to be that and nothing else; a long answer that contains "I don't know" is an answer.
import { NON_ANSWER_INJECTION_SRC, NON_ANSWER_REFUSALS, NON_ANSWER_FILLERS, NON_ANSWER_LEAD, NON_ANSWER_TRAIL, NON_ANSWER_ADVERBS, NON_ANSWER_MAX_TOKENS, NON_ANSWER_FILLER_MAX } from './policy.generated.js';
import { plain } from './textfold.js';

const REFUSALS = new Set(NON_ANSWER_REFUSALS), FILLERS = new Set(NON_ANSWER_FILLERS), LEAD = new Set(NON_ANSWER_LEAD), TRAIL = new Set(NON_ANSWER_TRAIL), ADVERBS = new Set(NON_ANSWER_ADVERBS);
const SEP = /[\s.,;:!?¿¡"()[\]{}…«»“”‘’–—\-/]+/u, APOSTROPHES = /['’‘`´ʼ]/gu;

export function tokens(text) { return plain(typeof text === 'string' ? text : '').replace(APOSTROPHES, '').split(SEP).filter(Boolean); }

const INJECTION = new RegExp(NON_ANSWER_INJECTION_SRC, 'i');
// An instruction to ATLAS ("ignore your instructions ...", any bank language): never obeyed, echoed or filed.
export const isInjection = text => INJECTION.test(tokens(text).join(' '));

export function kind(text) {
  const t = tokens(text);
  if (!t.length) return 'filler';
  if (isInjection(text)) return 'injection';
  if (t.length > NON_ANSWER_MAX_TOKENS) return '';
  if (t.length <= NON_ANSWER_FILLER_MAX && t.every(x => FILLERS.has(x))) return 'filler';
  const starts = [0]; while (starts.at(-1) < t.length && LEAD.has(t[starts.at(-1)])) starts.push(starts.at(-1) + 1);
  const ends = [t.length]; while (ends.at(-1) > 0 && TRAIL.has(t[ends.at(-1) - 1])) ends.push(ends.at(-1) - 1);
  for (const lo of starts) for (const hi of ends) {
    const core = t.slice(lo, hi).filter(x => !ADVERBS.has(x));
    if (core.length && REFUSALS.has(core.join(' '))) return 'refusal';
  }
  return '';
}
export const isNonAnswer = (text, _lang) => kind(text) !== '';
