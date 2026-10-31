// Adaptive interview length: parity-tested port of atlas_voice/extension.py (the source of truth; see there for the policy). Constants come from policy.generated.js.
import { INTERVIEW_LIMIT_S, INTERVIEW_HARD_S, EXTENSION_OFFER, EXTENSION_POINTS, EXTENSION_QUESTION_KINDS, EXTENSION_REFUSING, EXTENSION_YES_MAX_WORDS, TIME_PLAN } from './policy.generated.js';

// Python's round(): half to even.
const pyRound = x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
// The hard cap for a planned end of softS seconds (proportional, so a short test session scales the same way).
export const hardLimit = softS => pyRound(softS * INTERVIEW_HARD_S / INTERVIEW_LIMIT_S);

// The open point a move is about, as ATLAS says it.
export function offerPoint(field, intent) {
  if (intent === 'confirm_asr' || intent === 'asr_repair') return EXTENSION_POINTS._asr;
  if (intent === 'contradiction') return EXTENSION_POINTS._contradiction;
  return (typeof field === 'string' && Object.hasOwn(EXTENSION_POINTS, field) && !field.startsWith('_') ? EXTENSION_POINTS[field] : null) ?? EXTENSION_POINTS._other;
}
export const offerText = (field, intent) => EXTENSION_OFFER.replace('{point}', offerPoint(field, intent));

// Whether the move the selector chose (kind) is replaced by the offer. extension: null (never offered), 'offered', 'accepted' or 'refused'.
export const shouldOffer = (kind, rushed, extension, timeLeft, closingLeftS = TIME_PLAN.closing_left_s) =>
  extension === null && !rushed && EXTENSION_QUESTION_KINDS.includes(kind) && timeLeft <= closingLeftS;

// 'accepted' or 'refused': the consultant's answer to the offer. Only an explicit yes (the `confirm` intent) extends; everything else, a long answer and any language the
// intent rules do not cover included, is no (red M9). The yes must also be short and `words` must be known.
export function extensionReply(intents, words) {
  const list = (Array.isArray(intents) ? intents : []).filter(i => typeof i === 'string');
  if (list.some(i => EXTENSION_REFUSING.includes(i))) return 'refused';
  return list.includes('confirm') && Number.isInteger(words) && words <= EXTENSION_YES_MAX_WORDS ? 'accepted' : 'refused';
}
