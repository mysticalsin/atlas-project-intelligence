// F2 gap-interview policy (WOW_SPEC §F2.3): parity-tested ports of atlas_voice/gaps.py, the source of truth.
// Constants come from policy.generated.js; test/gen_gap_parity.py records the Python functions into
// test/gap.vectors.json and test/gap-policy.test.js replays them here.
import { GAP_WRAP_S, GAP_ATTEMPTS, GAP_ANSWER_WORDS, TIME_PLAN, GAP_LIST_LABEL, GAP_NOTE, GAP_WHY, GAP_DONE_WHY, GAP_REFLECT, UNKNOWN_SRC } from './policy.generated.js';

const UNKNOWN = new RegExp(UNKNOWN_SRC, 'i'); // the ledger's own UNKNOWN (ledger.js builds it the same way)
// Python str.split() whitespace: JS \s without U+FEFF, plus the separators U+001C..U+001F and U+0085.
const WORD_GAP = /(?:[\x1c-\x1f\x85]|[^\S﻿])+/;
// Chinese, Japanese and Thai do not put spaces between words. Hangul does.
// Same ranges as atlas_voice/gaps.py _UNSPACED.
const UNSPACED = [
  [0x0E00, 0x0E7F],
  [0x3040, 0x309F],
  [0x30A0, 0x30FF], [0x31F0, 0x31FF], [0xFF66, 0xFF9F],
  [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0x20000, 0x2A6DF],
];
const LETTER = /\p{L}/u;
function unspacedLetter(ch) {
  const cp = ch.codePointAt(0);
  if (!LETTER.test(ch)) return false;
  for (let i = 0; i < UNSPACED.length; i++) if (cp >= UNSPACED[i][0] && cp <= UNSPACED[i][1]) return true;
  return false;
}
function words(text) {
  let total = 0;
  for (const token of String(text).split(WORD_GAP).filter(Boolean)) {
    let letters = 0, other = false;
    for (const ch of token) {
      if (!LETTER.test(ch)) continue;
      if (unspacedLetter(ch)) letters++;
      else other = true;
    }
    total += letters && !other ? letters : 1;
  }
  return total;
}
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

// Status of each ask, in order. answers: {askId: [consultant turns in its answer window]}; attempts: {askId: replies
// that carried it}; details: the ledger's active candidate details. Deferral comes only from these attempt counts,
// never from the ledger's deferred_fields; an answer the analyst filed under another field still counts through the
// ask's own answer window.
export function gapStatus(asks, attempts, answers, details) {
  return asks.map(a => {
    const id = a.id ?? null, field = a.field ?? null;
    const turns = (own(answers, id) || []).filter(t => typeof t === 'string');
    const mine = details.filter(d => (d.field ?? null) === field && d.active !== false);
    let status;
    if (turns.some(t => words(t) >= GAP_ANSWER_WORDS && !UNKNOWN.test(t)) || mine.some(d => ['reported', 'uncertain'].includes(d.status))) status = 'answered_unverified';
    else if (turns.some(t => UNKNOWN.test(t)) || mine.some(d => d.status === 'unknown')) status = 'unknown';
    else if ((own(attempts, id) || 0) >= GAP_ATTEMPTS) status = 'deferred';
    else status = 'open';
    return { id, field, label: a.label ?? null, status, details: mine.map(d => d.id ?? null) };
  });
}

// The talker's plan in gap mode: the first open ask, or reflect back and confirm when none is open.
export function gapGuidance(asks, statuses) {
  const byId = new Map(statuses.map(s => [s.id ?? null, s.status ?? null]));
  const deferred = asks.filter(a => byId.get(a.id ?? null) === 'deferred').map(a => a.field ?? null);
  const next = asks.find(a => byId.get(a.id ?? null) === 'open');
  return next
    ? { askId: next.id ?? null, field: next.field ?? null, label: next.label ?? null, question: next.ask ?? null, why: GAP_WHY, action: 'ask_one_question', deferred }
    : { askId: null, field: null, label: null, question: GAP_REFLECT, why: GAP_DONE_WHY, action: 'reflect_and_confirm', deferred };
}

// When the interview moves to depth and to closing, in seconds from the start (ready.timePlan, F5 phases).
export function timePlan(limitS, mode) {
  if (mode === 'gap') return { depthAt: null, closingAt: limitS - TIME_PLAN.gap_closing_left_s };
  return { depthAt: pyRound(TIME_PLAN.depth_fraction * limitS), closingAt: limitS - TIME_PLAN.closing_left_s };
}
