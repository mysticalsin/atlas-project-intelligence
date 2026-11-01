// F2 gap-interview policy (WOW_SPEC §F2.3): parity-tested ports of atlas_voice/gaps.py, the source of truth.
// Constants come from policy.generated.js; test/gen_gap_parity.py records the Python functions into
// test/gap.vectors.json and test/gap-policy.test.js replays them here.
import { GAP_WRAP_S, GAP_ATTEMPTS, GAP_ANSWER_WORDS, TIME_PLAN, GAP_LIST_LABEL, GAP_NOTE, GAP_WHY, GAP_DONE_WHY, GAP_REFLECT, GAP_REANGLES, GAP_REANGLE, GAP_REANGLE_KIND, GAP_REANGLE_WHY, UNKNOWN_SRC } from './policy.generated.js';
import { analyzeTurn } from './turns.js';

const UNKNOWN = new RegExp(UNKNOWN_SRC, 'i'); // the ledger's own UNKNOWN (ledger.js builds it the same way)
// Python str.split() whitespace: JS \s without U+FEFF, plus the separators U+001C..U+001F and U+0085.
const WORD_GAP = /(?:[\x1c-\x1f\x85]|[^\S﻿])+/;
const words = text => text.split(WORD_GAP).filter(Boolean).length;
const own = (o, k) => o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined;
// Python's round(): half to even (round(4.5) == 4), so time plans agree for every limit.
const pyRound = x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };

// The gap list for the talker's cached system prefix (ids, labels and ask texts in the other view only).
export function gapSystemBlock(asks) {
  return '\n' + GAP_LIST_LABEL + '\n' + JSON.stringify(asks.map(a => ({ id: a.id ?? null, label: a.label ?? null, ask: a.ask ?? null })));
}

// Per-turn server notes in gap mode: [adminNote, GAP_NOTE, pace]. Pace names open items by label, never content.
export function gapNotes(elapsedS, limitS, openLabels, adminNote = '') {
  const left = limitS - elapsedS;
  let pace = `GAP PACE (server): about ${Math.floor(elapsedS / 60)} of ${Math.floor(limitS / 60)} minutes used.`;
  if (left <= GAP_WRAP_S) pace += ' Time is up: close now, with no question.';
  else if (left <= TIME_PLAN.gap_closing_left_s) pace += ' Under ninety seconds left: ask only the single most important open item, then move to ENDING.';
  else if (openLabels.length) pace += ' Open items: ' + openLabels.join(', ') + '.';
  else pace += ' Every item has an answer: reflect back and close.';
  return [adminNote, GAP_NOTE, pace];
}

// 'confidential' | 'refusal' | null for one consultant turn: a confidentiality answer is accepted at once; "I don't know", "no idea", "pass", "skip" and "next question"
// (the seven bank languages) are refusals to be re-angled, never accepted at once.
function kindOf(text, lang) {
  const intents = analyzeTurn(text, lang).intents;
  if (intents.includes('cannot_disclose')) return 'confidential';
  return intents.includes('dont_know') || intents.includes('skip') || UNKNOWN.test(text) ? 'refusal' : null;
}

// Status of each ask, in order. answers: {askId: [consultant turns in its answer window]}; attempts: {askId: replies
// that carried it}; details: the ledger's active candidate details. Deferral comes only from these attempt counts,
// never from the ledger's deferred_fields; an answer the analyst filed under another field still counts through the
// ask's own answer window. A confidentiality answer makes the ask `unknown` at once. A refusal leaves it `open` with `refusals` counted (the guidance then asks a
// narrower angle); only GAP_REANGLES + 1 refusals record it `unknown`, and while it is being re-angled the attempts allowed grow by GAP_REANGLES.
export function gapStatus(asks, attempts, answers, details, lang = 'en') {
  return asks.map(a => {
    const id = a.id ?? null, field = a.field ?? null;
    const turns = (own(answers, id) || []).filter(t => typeof t === 'string');
    const kinds = turns.map(t => kindOf(t, lang)), refusals = kinds.filter(k => k === 'refusal').length;
    const mine = details.filter(d => (d.field ?? null) === field && d.active !== false);
    let status;
    if (turns.some((t, i) => words(t) >= GAP_ANSWER_WORDS && !UNKNOWN.test(t) && kinds[i] === null) || mine.some(d => ['reported', 'uncertain'].includes(d.status))) status = 'answered_unverified';
    else if (kinds.includes('confidential') || refusals > GAP_REANGLES) status = 'unknown';
    else if ((own(attempts, id) || 0) >= GAP_ATTEMPTS + (refusals ? GAP_REANGLES : 0)) status = 'deferred';
    else status = 'open';
    return { id, field, label: a.label ?? null, status, refusals, details: mine.map(d => d.id ?? null) };
  });
}

// The talker's plan in gap mode: the first open ask, or reflect back and confirm when none is open.
export function gapGuidance(asks, statuses) {
  const byId = new Map(statuses.map(s => [s.id ?? null, s.status ?? null])), byRefusals = new Map(statuses.map(s => [s.id ?? null, Number.isInteger(s.refusals) ? s.refusals : 0]));
  const deferred = asks.filter(a => byId.get(a.id ?? null) === 'deferred').map(a => a.field ?? null);
  const next = asks.find(a => byId.get(a.id ?? null) === 'open');
  const refused = next ? Math.min(byRefusals.get(next.id ?? null) || 0, GAP_REANGLES) : 0;
  if (next && refused) return { askId: next.id ?? null, field: next.field ?? null, label: next.label ?? null, question: next.ask ?? null, reangle: GAP_REANGLE[own(GAP_REANGLE_KIND, next.field) ?? 'default'][refused - 1], why: GAP_REANGLE_WHY, action: 'ask_one_question', deferred };
  return next
    ? { askId: next.id ?? null, field: next.field ?? null, label: next.label ?? null, question: next.ask ?? null, why: GAP_WHY, action: 'ask_one_question', deferred }
    : { askId: null, field: null, label: null, question: GAP_REFLECT, why: GAP_DONE_WHY, action: 'reflect_and_confirm', deferred };
}

// When the interview moves to depth and to closing, in seconds from the start (ready.timePlan, F5 phases).
export function timePlan(limitS, mode) {
  if (mode === 'gap') return { depthAt: null, closingAt: limitS - TIME_PLAN.gap_closing_left_s };
  return { depthAt: pyRound(TIME_PLAN.depth_fraction * limitS), closingAt: limitS - TIME_PLAN.closing_left_s };
}
