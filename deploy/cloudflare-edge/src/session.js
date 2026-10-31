// One live interview, platform-independent (driven by the Durable Object in worker.js, tested in Node).
// Same browser protocol as atlas_voice/cascade.py, so the compiled ATLAS page, worklet and orb work unchanged:
// the orb moves only from PCM this session actually sends for playback.
import { TALKER_POLICY, OPENING, HISTORY, TOPICS, ADMIN_NOTE, SPEAKING_LIMIT_S, INTERVIEW_LIMIT_S, WRAP_S, TIME_UP, AREAS, TIME_PLAN, TIME_UP_MESSAGE, FIELDS,
  GAP_LIMIT_S, GAP_SPEAKING_S, GAP_WRAP_S, GAP_MAX, GAP_OPENING, WIN_HINTS, BANNED_PRAISE_SRC, ASR_TAU, PAUSE_LINES, RESUME_LINES } from './policy.generated.js';
import { gapSystemBlock, gapNotes, gapStatus, gapGuidance, timePlan } from './gap-policy.js';
import { Analyst, InterviewLedger } from './ledger.js';
import { EnergyTurns, isEcho, Phrases, speakable, sentences, ReplyGuard, GUARD_MAX_WORDS } from './speech.js';
import { EndMarker, parseReport, reportMessages } from './report.js';
import { LANGUAGES, normalize, spokenFor, languageNote, GREETING_PIECES, WELCOME_BACK_PIECES, FILLERS, unfinished } from './languages.js';
import { analyzeTurn } from './turns.js';
import { select } from './selector.js';
import { pickAck, ackPrewarmList } from './ack.js';
import { uncertainSpans, replacement, tauFrom } from './asr.js';
import { Machine } from './conversation-state.js';
import { serialize, restore, restoreView, newSessionId, TTL_MS } from './checkpoint.js';
import { buildSummary, buildUnknowns, summaryFacts, summaryNote, redact, withheldQuotes, MAX_FACTS, REFLECT_FACTS, SUMMARY_QUESTION } from './summary.js';

export const RESUME = '[The consultant made a sound but no words were recognised, and your last reply was cut off.] Briefly re-ask your last question in fresh words.';

const CHUNK = 960; // 20 ms of 24 kHz PCM16
// Turn-taking is patient on purpose: an interviewer lets people think. A pause mid-story is not the end of the answer.
export const EARLY_PAUSE = 0.7; // seconds of silence before asking the turn model whether the consultant has finished
export const TURN_PROBABILITY = 0.85; // only a confident "finished" ends the turn early; otherwise END_SILENCE decides
export const END_SILENCE = 1.2; // plain silence that ends a turn when the turn model is unsure (or unavailable)
export const THINKING_PAUSE = 2.5; // silence that ends a turn the turn model judged unfinished: they are thinking
export const STILL_THINKING = '[Server: the consultant went quiet mid-answer and may still be thinking.] If their last words trail off unfinished, '
  + 'reply only with a short, warm nudge in their language (for example "Take your time." or "Go on, I\'m listening."), with no question. '
  + 'Otherwise continue the interview as usual.';
export const CONTINUE_MS = 1200; // ms of her real reply (the acknowledgement does not count): speaking again before that is still answering
export const FILLER_WORDS = 12; // an acknowledgement only after a real answer, not after a few words
export const MIN_VOICED = 0.15; // seconds of actual voice below which a sound may be a click or a breath
export const BLIP_QUIET = 0.45; // such a sound is closed after this much quiet (longer than a comma pause), so ATLAS is not held by it
// Echo of ATLAS can only begin while her audio is still playing in the browser (plus a short room/echo-canceller tail).
// Measured on the microphone stream itself: playback reports arrive on the same ordered socket as the microphone
// audio, so network delays cannot move one relative to the other. Browsers without reports: wall-clock fallback.
export const ECHO_TAIL = 0.2; // seconds of microphone audio after her playback ended
export const ECHO_WINDOW = 0.5; // fallback without playback reports: after her last audio was sent (lead + tail)
export const BLIP_JOIN = 1.0; // ...but kept this long: speech starting again joins it (nothing lost); if none, it is transcribed when idle
export const STT_TIMEOUT_MS = 15000; // a transcription that never returns counts as no words
export const PREWARM_LANES = 3; // acknowledgement lines synthesised at once while the session starts
const OPENER_WORDS = 12; // a leading sentence longer than this is an answer, not a reaction (as in ReplyGuard)
export const SYNTH_AHEAD = 2; // pieces of one reply being synthesised (or waiting to be sent) at once
export const UNDERRUN_S = 0.02; // a gap in her audio longer than one chunk counts as an underrun
// Synthesised audio for short fixed phrases (greetings, acknowledgements), shared by every session in this isolate.
const PCM_CACHE = new Map(), PCM_CACHE_BYTES = 12 * 1024 * 1024; let pcmCacheSize = 0;
function cacheGet(key) { const v = PCM_CACHE.get(key); if (v) { PCM_CACHE.delete(key); PCM_CACHE.set(key, v); } return v; }
function cacheSet(key, pcm) {
  if (PCM_CACHE.has(key) || pcm.length > 2 * 1024 * 1024) return; // the full spoken introduction is about 25 s (1.2 MB)
  PCM_CACHE.set(key, pcm); pcmCacheSize += pcm.length;
  for (const [k, v] of PCM_CACHE) { if (pcmCacheSize <= PCM_CACHE_BYTES) break; PCM_CACHE.delete(k); pcmCacheSize -= v.length; }
}
export const pcmCacheStats = () => ({ entries: PCM_CACHE.size, bytes: pcmCacheSize });
export function clearPcmCache() { PCM_CACHE.clear(); pcmCacheSize = 0; }
export { SPEAKING_LIMIT_S, TIME_UP };

// Agent Brain v2.1 switches, read from the Worker env (app.js hands them to the Session through ai.flags). Each defaults to the
// new behaviour; the legacy values reproduce the earlier one exactly (analyst guidance one turn late, stock fillers, no reply guard).
//   ATLAS_SELECTOR=v2|legacy    v2: the next move is selected synchronously from the answer just heard (full interviews, not admin)
//   ATLAS_REPLY_GUARD=on|off    on: one question, no empty praise, no repeated opener, at most GUARD_MAX_WORDS words, enforced in code
//   ATLAS_ACKS=content|legacy   content: the acknowledgement follows what the answer was about (ack.js); legacy: FILLERS
//   ANALYST_WAIT_MS=0           bounded wait (ms) for the analyst while the acknowledgement plays, then the move is re-selected
//   ASR_CONFIRM_TAU=0.55        a number or proper noun the recogniser heard with less confidence than this is confirmed aloud (asr.js)
//   SPECULATIVE_STT=on          RESERVED: speculative transcription is not implemented, the flag is read and has no effect
export const DEFAULT_FLAGS = Object.freeze({ selector: 'v2', replyGuard: 'on', acks: 'content', analystWaitMs: 0, asrTau: ASR_TAU, speculativeStt: false });
export function sessionFlags(env = {}) {
  const e = env || {}, wait = Number(e.ANALYST_WAIT_MS);
  return { selector: String(e.ATLAS_SELECTOR || '').toLowerCase() === 'legacy' ? 'legacy' : 'v2',
    replyGuard: String(e.ATLAS_REPLY_GUARD || '').toLowerCase() === 'off' ? 'off' : 'on',
    acks: String(e.ATLAS_ACKS || '').toLowerCase() === 'legacy' ? 'legacy' : 'content',
    analystWaitMs: Number.isFinite(wait) && wait > 0 ? Math.min(Math.round(wait), 1500) : 0,
    asrTau: tauFrom(e.ASR_CONFIRM_TAU),
    speculativeStt: ['on', '1', 'true'].includes(String(e.SPECULATIVE_STT || '').toLowerCase()) };
}
export const MAX_SECONDS = INTERVIEW_LIMIT_S; // the whole interview (15 minutes); ATLAS's own speaking time is a second cap inside it
// Pause, repeat, skip and typed turns (Agent Brain v2.1 T9). Paused time does not count toward the interview (maxSeconds is measured in
// active seconds, activeSeconds()), but nothing may stay open for ever: the session ends at WALL_CAP_S of wall-clock time, paused or not.
export const WALL_CAP_S = 45 * 60;
export const WALL_CAP_MESSAGE = 'The 45-minute session limit was reached. Finishing your notes.';
export const CONTROLS = Object.freeze(['pause', 'resume', 'repeat', 'skip', 'text', 'correct', 'withhold', 'confirm_summary']); // client events this session understands (sent in `ready`, so older gateways are never sent them)
export const CONTROL_MAX_WORDS = 12; // a spoken pause / repeat / skip is a short request; the same words inside a long answer are part of the answer
export const TYPED_MAX_CHARS = 2000; // a typed answer; longer text is cut (the browser limits it to the same)
// Cost bounds (S1, review L5): each typed turn costs an analyst call and a talker call, so one is taken at a time and not faster than this; corrections are bounded per minute.
export const TYPED_MIN_INTERVAL_S = 1.5;
export const TYPED_RATE_LIMITED = 'ATLAS is still replying. Wait a moment, then send that again.';
export const CORRECTIONS_PER_MINUTE = 6;
export const CORRECTION_RATE_LIMITED = 'That is a lot of corrections at once. Wait a moment, then try again.';
export const PRIVATE_MARK = '[kept private]'; // what stands for a whole utterance the consultant kept private (summary.js redact() uses the same marker for a quote)
export const SKIP_UNAVAILABLE = 'Skipping is not available in a focused proof interview.';
const SKIP_NOTE = '(I\'d like to skip that question.)'; // history entry for the Skip button, so the talker sees what the consultant did (never the ledger)
const SKIP_INSTRUCTION = '[Server: the consultant chose to skip your last question.] Accept that without pressing, and ask one different question.';
// Summary read-back and correction revisions (T11, plan 3h, D19, Tony Q2). At the close ATLAS reads back a few facts, the browser shows the whole card
// (summary event), and the consultant corrects, keeps private or confirms. Confirming saves an OWNER-ONLY evidence draft; nothing goes to a reviewer
// until the owner presses Submit for review in the library (a separate click, never here).
export const SUMMARY_WAIT_MS = 2500; // the analyst may still be filing the last answer when the read-back is built: wait this long for it, no more
export const SUMMARY_MAX_WORDS = 90; // a read-back is longer than an ordinary reply (GUARD_MAX_WORDS); the question always follows it
export const CORRECTION_MAX_CHARS = 1800; // the ledger's own bound for a quote
export const CONFIRM_WAIT_MS = 3000; // a late analyst entry is part of the draft: wait this long for it when the summary is confirmed
export const SATISFIED_WORDS = 6; // a reply this short to the read-back ("No, that's right.") means they have nothing to add (as the selector's own rule)
const CORRECTION_ITEM_BASE = 1000; // typed corrections are transcript items user-typed-1001, 1002 ...: never a turn number (turns stop at 300)
const DETAIL_ID = /^D-\d{3,6}$/;
export const SUMMARY_UNAVAILABLE = 'There is no open summary to change. Wait for the read-back, then try again.';
export const SUMMARY_LINES = Object.freeze({
  corrected: { en: ['Thank you, I have updated that. Is there anything else I have misunderstood or missed?', 'Thank you, that is updated. Is there anything else I should correct?'] },
  prompt: { en: ['Thank you. When you are ready, press Confirm summary. That saves a private draft that only you can see, and nothing goes to a reviewer until you press Submit for review yourself.'] },
  saved: { en: ['Thank you. Your summary is saved as a private draft that only you can see. Press Submit for review when you are ready; until then it goes nowhere.'] },
  unsaved: { en: ['Thank you. Your summary is confirmed, but it could not be saved to the library, so nothing was filed. You can try again from your notes.'] },
});
// Other languages: the talker closes (or prompts) in the consultant's language from these server instructions (no model-made claim about what was saved).
const SUMMARY_PROMPT_INSTRUCTION = '[Server: the consultant has nothing to add to the read-back.] Thank them in one short sentence and tell them to press Confirm summary when ready: it saves a private draft only they can see, and nothing goes to a reviewer until they press Submit for review themselves. Ask no question.';
const SUMMARY_CLOSE_INSTRUCTION = saved => '[Server: the consultant confirmed the summary.] Thank them warmly in one short sentence and say '
  + (saved ? 'it is saved as a private draft that only they can see, and goes nowhere until they press Submit for review.' : 'it could not be saved to the library, so nothing was filed.') + ' Ask no question.';
const SUMMARY_MOVE = { kind: 'summary', intent: 'summary', field: null, rung: null, say: 'Let me read that back once more.', why: 'summary:before_close', reaction: 'none', ack_category: null };
const FIELD_ID = /^[a-z][a-z0-9_]{0,63}$/; // the state machine's rule for a skipped field: an internal id, never free text
// Discovery focus (conversation-state.js `focus`) is an annotation of where the conversation is, derived from the field of the move just chosen.
const FIELD_FOCUS = { problem: 'context', stakes: 'context', contribution: 'contribution', intervention: 'contribution', decision: 'contribution', adoption: 'contribution',
  evidence: 'evidence', measurement: 'evidence', limitations: 'evidence', outcome: 'outcome', customer_fit: 'skills', poor_fit: 'skills' };
// The last question sentence of a reply (what a repeat or a resume says again), as it is voiced.
const lastQuestionOf = text => { const [done, rest] = sentences(String(text) + ' '); return [...done, rest].map(speakable).filter(t => /[?？]/.test(t)).at(-1) || ''; };
// Parity-tested port of atlas_voice.cascade.pace_notes: speaking time used and areas with no notes (names only, never content).
export function paceNotes(elapsedS, limitS, notes, admin = false) {
  const left = limitS - elapsedS, missing = AREAS.filter((_, i) => !notes[i]);
  let pace = `INTERVIEW PACE (server): about ${Math.floor(elapsedS / 60)} of ${Math.floor(limitS / 60)} minutes used.`;
  if (left <= WRAP_S) pace += ' Time is up: close now, with no question.';
  else if (left <= TIME_PLAN.closing_left_s) pace += ' Under four minutes left: ask only the single most important remaining question, then move to ENDING.';
  else if (elapsedS >= TIME_PLAN.depth_fraction * limitS) {
    pace += ' Past halfway: challenge the one or two claims that matter most (what changed, and how they know).';
    pace += missing.length ? ' Still uncovered: ' + missing.slice(0, 2).join(', ') + '.' : '';
  } else pace += missing.length ? ' Next uncovered area: ' + missing[0] + '.' : ' Every area has an answer: go deeper only on the one or two claims that matter most.';
  return [admin ? ADMIN_NOTE : '', pace];
}
export const LEAD_MS = 300; // max audio sent ahead of what the browser has played
const START_KEYS = ['type', 'csrf', 'consent', 'project', 'voice', 'capture', 'memory', 'language', 'gap', 'resume'];
// Checkpoint and reconnect (T10, checkpoint.js). `resume` in `start` is the id of the interview to continue; anything that cannot be resumed (nothing stored, another
// person's, expired, another version, a gap request, transcript capture off) is this one message, so the socket reveals nothing about what is stored.
export const RESUME_UNAVAILABLE = 'This interview can no longer be resumed. Start a new one.';
export const RESUME_PROJECT = 'That interview was about a different project. Open that project to resume it, or start a new interview.';
const RESUME_ID = /^[a-f0-9]{32}$/;
export const CHECKPOINT_DEBOUNCE_MS = 1000; // writes are coalesced: one at a time, at most one per second
const SUSPENDABLE = ['discovery', 'summary', 'user_correction', 'paused', 'suspended']; // states a dropped connection can come back to
// Focused gap interviews (WOW_SPEC §F2.4). The browser sends only a request id; the asks come from the library, resolved
// server-side for the verified assignee. Any failure (unknown id, not the assignee, no longer open, timeout) is this one
// message, so the socket reveals nothing about other people's requests.
export const GAP_UNAVAILABLE = 'This gap request is not available to you.';
export const GAP_RESOLVE_MS = 3000;
const GAP_ID = /^[a-f0-9]{32}$/;
const QUOTE_CHARS = 400, WINDOW_QUOTES = 3, GAP_QUOTES = 5;
const first = (s, n) => Array.from(s).slice(0, n).join(''); // whole code points: a quote never ends in half a character
const ws = s => s.split(/\s+/).filter(Boolean).join(' '); // the ledger's quote normalisation
// Resolver output is library data, still bounded here: at most GAP_MAX asks, each with an id, a known field, its label and
// the ask text (already in the other view, placeholders replaced by uniform labels).
function gapAsks(found) {
  const asks = Array.isArray(found?.asks) ? found.asks : [], seen = new Set();
  return asks.filter(a => a && typeof a.id === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(a.id) && typeof a.field === 'string' && Object.hasOwn(FIELDS, a.field) && typeof a.ask === 'string' && a.ask.trim()
      && !seen.has(a.id) && seen.add(a.id))
    .slice(0, GAP_MAX).map(a => ({ id: a.id, field: a.field, label: FIELDS[a.field][0], ask: clean(a.ask, 160) }));
}

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  value = value.replace(/<\s*\/?\s*system\s*>/gi, '[quoted tag]');
  return [...value].filter(c => c.codePointAt(0) >= 32 || c === '\n' || c === '\t').join('').trim().slice(0, limit);
}

// Port of atlas_voice/interview.py project_context: untrusted, bounded, no identity fields. `consultant` is still
// accepted (older pages send it) but never kept: the consultant's name never reaches a model (WOW_ZERO_CONFIG §5.9).
export function projectContext(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Project context must be an object.');
  if (Object.keys(raw).some(k => !['id', 'title', 'consultant', 'role', 'sector', 'stage', 'answers', 'oppId'].includes(k))) throw new Error('Unexpected project fields. Identity and memory banks are server-owned.');
  const result = {};
  for (const [k, n] of [['id', 100], ['title', 160], ['role', 120], ['sector', 100], ['stage', 60], ['oppId', 40]]) result[k] = clean(raw[k], n);
  if (!result.oppId) delete result.oppId;
  if (!result.title) throw new Error('Create a project before starting an interview.');
  const answers = raw.answers ?? [];
  if (!Array.isArray(answers) || answers.length > 6 || answers.some(x => typeof x !== 'string')) throw new Error('Expected at most six answer strings.');
  result.prior_notes = {};
  answers.forEach((v, i) => { if (v.trim()) result.prior_notes[TOPICS[i]] = clean(v, 220); });
  return result;
}

// Prompt order is built for prefix caching: the fixed policy and project first, then the conversation (append-only),
// and only then the per-turn server notes (guidance, language, memory, pace), which change every turn. A gap list (gap
// mode) sits between the project data and the preferences label, so the prefix stays stable for the whole session.
export function talkerMessages(project, guidance, history, instruction, notes = [], gaps = null) {
  const messages = [{ role: 'system', content: TALKER_POLICY + '\nUNTRUSTED PROJECT DATA:\n' + JSON.stringify(project) + (gaps?.length ? gapSystemBlock(gaps) : '') + '\nUNTRUSTED PRIVATE PREFERENCES (not evidence):\n' }];
  messages.push(...history.slice(-HISTORY));
  if (guidance) messages.push({ role: 'system', content: 'ANALYST_GUIDANCE (server plan, not a script): ' + JSON.stringify(guidance) });
  for (const note of notes) if (note) messages.push({ role: 'system', content: note });
  if (instruction) messages.push({ role: 'user', content: instruction });
  return messages;
}

// The talker's NEXT MOVE note (plan 3c): the move the server selected from the answer just heard, rebuilt for every reply and
// never kept. The wording is a proposal; the talker says it in its own words. `say` can carry words of the consultant (a figure
// they gave), so it passes through clean() like any untrusted text.
const MOVE_ACTION = {
  ask: 'Ask this one question, in your own natural words.',
  confirm_asr: 'Check that you heard it right: ask only this confirming question, in your own words.',
  reflect: 'Say back in one short sentence what you have understood so far, then ask the one check question.',
  offer_move_on: 'Offer to move on from this point, gently; ask only that.',
  accept_and_move: 'Accept their answer without pressing; then ask the one question.',
  summary: 'No question is left: this is the read-back. Say back only the SUMMARY FACTS (next note), mention the open points briefly, then ask only: ' + SUMMARY_QUESTION,
  close: 'Close now: thank them warmly in one or two short sentences, with no question, then end with the exact token [[END]].',
};
const MOVE_REACTION = {
  none: 'Open with no reaction; go straight to the move.',
  neutral: 'A very short neutral acknowledgement is enough.',
  thanks_detail: 'Thank them briefly for the detail; no praise.',
  no_number_fine: 'Say that it is fine not to have the number; no pressure.',
  confidential_ok: 'Say that keeping it private is fine; no pressure.',
  correction_thanks: 'Thank them for the correction and use their version.',
  setback_neutral: 'Acknowledge the event neutrally and judge no one; no cheer, no praise.',
  earned_result: 'One short, specific reaction to the result is earned; no superlatives.',
  promising_unverified: 'Say only that it sounds promising; the figure is not confirmed yet; no praise.',
};
export function nextMoveNote(move) {
  if (!move || typeof move !== 'object') return '';
  const reaction = move.reaction === 'none' || !move.reaction ? MOVE_REACTION.none : MOVE_REACTION[move.ack_category] || MOVE_REACTION.neutral;
  const parts = ['kind: ' + move.kind, move.field ? 'about: ' + move.field : '', move.intent && move.intent !== move.kind ? 'intent: ' + move.intent : '',
    'proposed wording: ' + JSON.stringify(clean(move.say, 400)), 'why: ' + clean(move.why, 120)].filter(Boolean);
  return 'NEXT MOVE (server, built from their latest answer, for this reply only; say it in your own words, not as a script): ' + parts.join('; ') + '. '
    + (MOVE_ACTION[move.kind] || MOVE_ACTION.ask) + ' Reaction: ' + reaction + ' If an acknowledgement was already said aloud, add none.';
}

const joinPcm = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
// A well-formed playback report (the browser's acknowledgement of audio it played): exactly its three keys.
const isPlayback = v => !!v && typeof v === 'object' && v.type === 'playback' && Object.keys(v).length === 3 && typeof v.item_id === 'string' && typeof v.played_ms === 'number' && Number.isFinite(v.played_ms) && v.played_ms >= 0;
const same = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export class Session {
  /** io: {send(obj), sendBytes(u8), close()}; ai: {transcribe(pcm), synthesize(text), chatStream(messages), analyst(messages)} */
  // gaps: async id => {asks, bidAlias, referenceId, projectId} | null (the verified assignee's open gap request);
  // winHint: async () => ({hint: 'quantified'|'confirmed'|null}) | null (aggregate win-loop guidance, never awaited).
  constructor({ io, ai, csrf, voice, voices = null, captureRequired = false, model, maxSeconds = MAX_SECONDS, admin = false, memory = null, speakingLimit = SPEAKING_LIMIT_S, now = () => Date.now() / 1000, sleep = ms => new Promise(r => setTimeout(r, ms)), metric = () => {}, sttTimeout = STT_TIMEOUT_MS,
    gaps = null, winHint = null, gapTimeout = GAP_RESOLVE_MS, flags = null, checkpoint = null, evidence = null }) {
    // metric(name, numbers): timings and counts only, never transcript or project content.
    Object.assign(this, { io, ai, csrf, voice, voices: voices || [voice], captureRequired, model, maxSeconds, admin, speakingLimit, now, sleep, metric, memory, sttTimeout, gaps, winHint, gapTimeout, checkpoint, evidence });
    this.flags = { ...DEFAULT_FLAGS, ...(flags || ai?.flags || {}) };
    // Conversation state of the humane interviewer (Agent Brain v2.1), one plain object so a checkpoint can keep it whole:
    // asked (the Move dicts committed so far, oldest first), covered (field ids the consultant's answers touched), rushed,
    // acks (texts of the last acknowledgements played, oldest first), sinceEarned (replies since the last earned_result; null: none yet)
    // and openers (the leading reaction of her last replies, for the repeated-opener rule).
    this.humane = { asked: [], covered: new Set(), rushed: false, acks: [], sinceEarned: null, openers: [] };
    // Speech-recognition doubt (asr.js), per consultant turn item: asrMeta[item] = {spans: [{text, kind, min_conf, start, end, audio_offset_ms, status}],
    // minConf, audioOffsetMs}. status: open (not yet settled), confirmed, denied (waiting for the right value) or corrected. asrIdents: the items
    // of the turn being answered (a turn they carried on after counts as one); asrCorrections: corrections waiting for their ledger turn.
    this.asrMeta = {}; this.asrIdents = []; this.asrDone = null; this.asrCorrections = [];
    // Interview state machine (conversation-state.js, plan 3i) and the pause clock. `machine.audit` is the session's audit trail of transitions (T10
    // checkpoints machine.toDict(), T11/T13 attach it to the evidence); `paused` is what the session acts on, the machine only records it.
    // lastQuestion: {text, move, item}, the question ATLAS last asked (kept even if it was cut off), re-spoken by repeat and resume with no model call.
    this.machine = new Machine('interview'); this.paused = false; this.pausedAt = null; this.pausedTotal = 0; this.pauseCount = 0; this.resumeCount = 0;
    this.lastQuestion = null; this.composing = null; this.identNow = null;
    // Checkpoint (T10): `checkpoint` is the person's own CheckpointStore (worker.js), null when there is none (tests, ATLAS_CHECKPOINT=off). sessionId names the
    // interview across reconnects. discarding: the consultant threw it away (end() then purges). afterRestore: restored while paused, so Resume continues it.
    this.sessionId = null; this.discarding = false; this.afterRestore = false; this.resumed = false; this.ckptDirty = false; this.ckptRun = null; this.capturedAt = null; // capturedAt: when the first checkpoint was written (ms): the 24 hours run from it, whatever happens after
    // Summary read-back (T11). open: the card is on the consultant's screen; rounds: read-backs given; corrections: typed corrections so far (their item ids);
    // confirmed / draft: the confirmation and the evidence draft it saved ({id, revision}, null when nothing was saved); posting: a confirmation is in flight;
    // prompts: how often ATLAS pointed to the Confirm button; sig: the last card sent (not kept: a resume sends the card again).
    // `evidence` is the hook that saves the draft: async notes => {status, body} (worker.js: postDraftFromInterview under the verified identity), null when off.
    this.summary = { open: false, rounds: 0, corrections: 0, confirmed: false, draft: null, posting: false, prompts: 0, sig: '' };
    this.typedAt = -1e9; this.correctionTimes = []; // rate limits (typedTurn, correctDetail): when the last typed turn was taken, and the recent corrections
    this.move = null; this.moveByItem = new Map(); this.prefill = {}; this.lastPlan = null; this.lastTurn = null;
    // Interview mode. Gap mode keeps its own answer windows: askByItem (reply item -> the ask it carried, set when the reply
    // is composed), gapAttempts (replies heard per ask), openAsk (the ask the consultant last heard; null once a reflect-back
    // or the closing is heard) and gapAnswers (ask -> the consultant turns heard after it, each turn a list of transcript parts).
    this.mode = 'full'; this.wrapS = WRAP_S; this.winNote = ''; this.starting = false;
    this.gapAsks = []; this.gapRequest = null; this.askByItem = new Map(); this.gapAttempts = {}; this.gapAnswers = {}; this.openAsk = null; this.lastAnswer = null; this.askHeard = null;
    this.memoryNote = ''; this.language = 'en'; this.languageCandidate = null; this.dry = false; this.affinity = 'atlas-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.pause = ''; this.checkId = 0; this.continuing = false; this.replyTurn = -1; this.replyItem = null; this.shown = { item: null, chars: 0 }; this.discarded = new Set(); this.fillerMs = {}; this.committed = null; this.live = null; this.recorded = new Set(); this.voiced = 0; this.blip = null; this.echoable = false; this.acked = false; this.playbackDone = true; this.doneAt = 0; this.resumedAt = 0; this.lastFiller = -1; this.fillerTurn = -2; this.protectedItem = null; this.protectedMs = 0; this.protectedDeadline = 0;
    this.spokenMs = 0; this.timeUp = false; this.ending = null; this.sttBusy = 0;
    this.started = false; this.finished = false; this.capture = false; this.history = []; this.queue = []; this.waiter = null;
    this.gen = 0; this.replies = 0; this.turns = 0; this.guidance = null; this.speaking = null; this.pending = new Set();
    // The detector ends a turn only at THINKING_PAUSE; the session applies END_SILENCE itself unless the turn model heard an unfinished thought.
    this.sttChain = Promise.resolve(); this.turnDetector = new EnergyTurns(THINKING_PAUSE); this.bytesIn = 0; this.startedAt = 0; this.lastInput = 0;
    this.nextTime = 0; this.currentItem = null; this.timer = null; this.lastAudio = -1e9; this.cutOff = false; this.sentMs = {}; this.playedMs = {};
  }

  event(type, values = {}) { if (!this.finished || ['audio_stopped', 'reporting', 'notes', 'ended', 'error', 'quality', 'quality_warning'].includes(type)) this.io.send({ type, ...values }); }

  // One transition of the interview machine. Never throws: an illegal or malformed move is counted (state_error) and the interview goes on.
  fireState(event, actor, { data = null, reason = null } = {}) {
    const m = this.machine, from = m.state;
    try { m.fire(event, actor, { data, reason, at: new Date(this.now() * 1000).toISOString() }); }
    catch (e) { this.metric('state_error', { event, from, code: e?.code || 'error' }); return false; }
    const entry = m.audit.at(-1);
    this.event('state', { state: m.state, from, event, actor, focus: m.focus, paused: m.state === 'paused', at: entry.at, ...(entry.data ? { data: entry.data } : {}) });
    return true;
  }
  stateSnapshot() { return this.machine.toDict(); }

  // Seconds of interview used: wall clock since the start, less every paused stretch (the one in progress included).
  activeSeconds(now = this.now()) { return now - this.startedAt - this.pausedTotal - (this.pausedAt === null ? 0 : now - this.pausedAt); }

  async onText(text) {
    let value;
    try { value = JSON.parse(text); } catch { return this.fail('Unsupported client event', 'voice-contract'); }
    if (this.starting) { // a gap request or a checkpoint is being read: only leaving is allowed (never a second start)
      if (isPlayback(value)) return; // (a reconnect: the worklet still reports the last item it played, ~80 ms after start; that is not a contract error)
      const leave = value && typeof value === 'object' && Object.keys(value).length === 1 && (value.type === 'discard' || value.type === 'end');
      if (leave && value.type === 'discard') { this.discarding = true; this.fireState('withdraw', 'user', { reason: 'consultant discarded the interview' }); }
      return leave ? this.end(false) : this.fail('Unsupported client event', 'voice-contract');
    }
    if (!this.started) return this.start(value);
    if (value?.type === 'end' && Object.keys(value).length === 1) return this.end(true);
    if (value?.type === 'discard' && Object.keys(value).length === 1) { this.discarding = true; this.fireState('withdraw', 'user', { reason: 'consultant discarded the interview' }); return this.end(false); }
    // Interview controls (CONTROLS, announced in `ready`): the same handlers the spoken intents use. Exactly their own keys, nothing else.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const n = Object.keys(value).length;
      if (n === 1 && value.type === 'pause') return this.pauseSession('ui');
      if (n === 1 && value.type === 'resume') return this.resumeSession('ui');
      if (n === 1 && value.type === 'repeat') return this.repeatQuestion('ui');
      if (n === 1 && value.type === 'skip') return this.skipQuestion();
      if (n === 2 && value.type === 'text' && typeof value.text === 'string') return this.typedTurn(value.text);
      // The summary card (T11): exactly their own keys.
      if (n === 1 && value.type === 'confirm_summary') return this.confirmSummary();
      if (n === 2 && value.type === 'withhold' && typeof value.detail_id === 'string') return this.withholdDetail(value.detail_id);
      if (n === 3 && value.type === 'correct' && typeof value.detail_id === 'string' && typeof value.text === 'string') return this.correctDetail(value.detail_id, value.text);
    }
    if (value?.type === 'playback') {
      // Flow control: the browser reports audio actually played; never run more than LEAD_MS ahead of it.
      const { item_id: item, played_ms: ms } = value;
      if (Object.keys(value).length === 3 && typeof item === 'string' && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= (this.sentMs[item] || 0) + 1) {
        this.playedMs[item] = Math.max(this.playedMs[item] || 0, ms); this.acked = true;
        // Everything sent has been played: from this point of the microphone stream on, speech cannot be her echo.
        if (!this.playbackDone && item === this.currentItem && !this.queue.some(c => c.bytes.length) && this.playedMs[item] >= (this.sentMs[item] || 0) - 40) {
          this.playbackDone = true; this.doneAt = this.bytesIn;
        }
      }
      return;
    }
    return this.fail('Unsupported client event', 'voice-contract');
  }

  onBinary(bytes) {
    if (!this.started || this.finished || this.ending) return;
    if (!bytes.length || bytes.length % 2 || bytes.length > 3840) return this.fail('Invalid PCM frame', 'voice-contract');
    if (this.paused) { this.lastInput = this.now(); return; } // paused: nothing is listened to, kept or counted (the browser also closes its microphone)
    this.bytesIn += bytes.length; this.lastInput = this.now();
    if (this.bytesIn > (this.lastInput - this.startedAt + 3) * 48000) return this.fail('Audio exceeds realtime input budget', 'voice-contract');
    const audible = this.audible();
    const [started, utterance] = this.turnDetector.feed(bytes, audible);
    const d = this.turnDetector;
    if (started) this.voiced = d.loud; // actual voice in this utterance, from its onset
    else if (d.active && d.quiet === 0) this.voiced += bytes.length / 48000;
    // A short sound closed a moment ago ("So,", "No,", "Yes…") is the start of what they are saying now: nothing is lost.
    let carried = false;
    if (started) {
      // Could this be her echo? Only if it began while her audio was still playing (see ECHO_TAIL); a later answer that
      // reuses her words is the consultant's.
      const onsetBytes = this.bytesIn - d.loud * 48000;
      this.echoable = this.acked ? onsetBytes - this.doneAt < ECHO_TAIL * 48000 || (!this.playbackDone && onsetBytes >= this.resumedAt)
        : audible || this.now() - this.lastAudio < ECHO_WINDOW;
    }
    if (started && this.blip) {
      const b = this.blip; this.blip = null;
      // Judged from when this speech began. A sound that may have been her echo is never mixed into their words.
      if (this.now() - d.loud - b.at <= BLIP_JOIN && (!b.echoable || this.echoable)) {
        d.buffer = joinPcm(b.pcm, d.buffer); this.voiced += b.voiced; carried = b.continuing; this.metric('blip_joined', {});
      } else if (!b.echoable) { this.blip = b; this.expireBlip(); }
    } else if (this.blip && !d.active && this.now() - d.loud - this.blip.at > BLIP_JOIN) this.expireBlip(); // speech already under way still joins
    if (started) {
      // Speaking again before ATLAS has really answered (still transcribing, composing, or only a second or so into her
      // reply) means the consultant had not finished: what follows is the rest of the same answer. Her reply stops at
      // once if audible; a reply not yet audible is held and withdrawn only if they actually add words.
      const replying = this.turns > 0 && this.replyTurn === this.turns && this.busy(), item = this.replyItem;
      // What they have actually heard of her reply: acknowledged playback (else what was sent, less the lead), without
      // the acknowledgement word and without the time it took to notice them speaking.
      const heard = replying ? (this.playedMs[item] ?? Math.max(0, (this.sentMs[item] || 0) - LEAD_MS)) - (this.fillerMs[item] || 0) - d.loud * 1000 : 0;
      this.continuing = carried || this.sttBusy > 0 || (replying && heard <= CONTINUE_MS);
      if (this.continuing) {
        if (audible && !this.greetingPlaying()) this.withdraw();
        this.metric('turn_resumed', { heard_ms: replying ? Math.round(heard) : -1, filler_ms: replying ? Math.round(this.fillerMs[item] || 0) : -1, transcribing: this.sttBusy > 0 ? 1 : 0 });
        this.event('user_speaking');
      } else if (audible && !this.greetingPlaying()) {
        // Barge-in only stops audio the consultant can actually hear; noise cannot cancel a reply still being composed.
        // The first piece of the greeting is not interruptible (room noise must not cut the introduction); everything after it is, the second piece included.
        this.interrupt(); this.cutOff = true; this.metric('barge_in', {}); this.event('user_speaking');
      }
    }
    if (utterance) {
      // endedAt: the consultant's last sound (feed() leaves the silence count in place when it completes an utterance)
      const endedBy = this.pause === 'unfinished' ? 'thinking' : 'silence', endedAt = this.now() - this.turnDetector.quiet;
      this.pause = ''; this.queueTranscription(utterance, { ...this.takeUtterance(), endedBy, endedAt, blip: this.voiced < MIN_VOICED }); return;
    }
    if (!d.active || d.quiet === 0) { this.pause = ''; return; }
    // A click or a breath is over once quiet longer than a comma pause follows it: close it, so ATLAS is held for half a
    // second at most, and anything said next starts a fresh utterance (which picks the sound up again, see above).
    if (this.voiced < MIN_VOICED && d.quiet >= BLIP_QUIET) { this.closeBlip(); return; }
    // Semantic end of turn: at a pause, ask the turn model once; transcribe only once the turn has ended
    // (a speculative transcript at every mid-answer pause would bill the same audio several times).
    if (this.ai.turnComplete && !this.pause && d.quiet >= EARLY_PAUSE && d.spoken - d.quiet >= 0.6) this.checkTurn();
    // Plain silence ends the turn, unless the turn model is still being asked or heard an unfinished thought
    // (then the detector's own THINKING_PAUSE applies).
    if (d.quiet >= END_SILENCE && d.spoken >= d.minSpeech && this.pause !== 'asking' && this.pause !== 'unfinished') this.endTurn('silence');
  }

  // The consultant's words still in progress when the interview ends (the time limit, or End) are part of it: they are
  // transcribed and recorded (finishTurn records without replying while ending), never silently dropped.
  finalWords() {
    const d = this.turnDetector, b = this.blip; this.blip = null;
    if (b && d.active) { d.buffer = joinPcm(b.pcm, d.buffer); this.voiced += b.voiced; }
    else if (b) this.queueTranscription(b.pcm, { continuing: b.continuing, echoable: b.echoable, endedBy: 'limit', endedAt: b.endedAt, endBytes: b.endBytes });
    if (!d.active) return;
    const endedAt = this.now() - d.quiet, pcm = d.flush();
    this.pause = '';
    if (pcm && this.voiced >= MIN_VOICED) this.queueTranscription(pcm, { ...this.takeUtterance(), endedBy: 'limit', endedAt });
  }

  closeBlip() {
    const d = this.turnDetector, endedAt = this.now() - d.quiet, pcm = d.flush();
    this.pause = '';
    this.blip = pcm ? { pcm, voiced: this.voiced, at: this.now(), endedAt, endBytes: this.bytesIn, ...this.takeUtterance() } : null;
    this.metric('blip', {});
  }

  // Nothing followed the short sound. If ATLAS is not talking, it may have been a short answer ("No."): transcribe it;
  // a click transcribes to nothing and changes nothing.
  expireBlip() {
    const b = this.blip;
    if (!b || this.sttBusy > 0) return; // wait for the transcript in flight: it decides whether ATLAS answers
    this.blip = null;
    if (this.busy() || this.ending) return;
    this.queueTranscription(b.pcm, { continuing: b.continuing, echoable: b.echoable, endedBy: 'silence', endedAt: b.endedAt, endBytes: b.endBytes });
  }

  endTurn(endedBy) {
    const endedAt = this.now() - this.turnDetector.quiet; // before flush(), which clears the silence count
    const utterance = this.turnDetector.flush();
    this.pause = '';
    if (utterance) this.queueTranscription(utterance, { ...this.takeUtterance(), endedBy, endedAt, blip: this.voiced < MIN_VOICED });
  }

  queueTranscription(pcm, how = {}) {
    this.sttBusy += 1;
    how = { ...how, endBytes: how.endBytes ?? this.bytesIn }; // where in the microphone stream this utterance ended (the transcript comes later)
    this.sttChain = this.sttChain.then(() => this.transcribe(pcm, how)).finally(() => { this.sttBusy -= 1; });
  }

  // What is known about the utterance that just ended, taken once (the next utterance starts fresh).
  takeUtterance() { const u = { continuing: this.continuing, echoable: this.echoable }; this.continuing = false; this.echoable = false; return u; }

  // Take back the reply to the consultant's last turn: they had not finished. Not an interruption, not in the history,
  // and its text is removed from the on-screen transcript.
  withdraw() {
    if (this.replyTurn !== this.turns || !this.replyItem || this.discarded.has(this.replyItem) || !this.busy()) return;
    const item = this.replyItem;
    this.discarded.add(item); this.gen += 1; this.queue = [];
    this.uncommit(item); // a withdrawn reply asked nothing: its move leaves the asked log
    this.stopped();
    // A withdrawn reply is not an attempt either: its ask goes back to where it was (gap mode).
    if (this.askHeard?.item === item) { const { id, before } = this.askHeard; if (id) this.gapAttempts[id] -= 1; this.openAsk = before; this.askHeard = null; }
    // A reply already written to the history (fully composed, audio still playing) is taken back from it too.
    if (this.committed?.item === item) { const i = this.history.lastIndexOf(this.committed.entry); if (i >= 0) this.history.splice(i, 1); this.committed = null; }
    if (this.protectedItem === item) this.protectedItem = null;
    this.event('clear_audio');
    if (this.shown.item === item && this.shown.chars) this.event('agent_retract', { item_id: item, chars: this.shown.chars });
    this.shown = { item: null, chars: 0 };
    this.metric('reply_withdrawn', { played_ms: Math.round(this.sentMs[item] || 0) });
  }

  async checkTurn() {
    this.pause = 'asking';
    const id = ++this.checkId, d = this.turnDetector, snapshot = d.buffer.slice(), t0 = this.now();
    let verdict = null, timer, why = null;
    try { verdict = await Promise.race([this.ai.turnComplete(snapshot), new Promise(r => { timer = setTimeout(() => { why = { reason: 'timeout' }; r(null); }, 350); })]); }
    catch (e) { verdict = null; why = { reason: 'error', name: e?.name || 'Error' }; } finally { clearTimeout(timer); }
    // No verdict: say why (a name, never a message), so a turn model that always times out or fails shows in the logs.
    why = verdict ? {} : why || { reason: 'error', name: 'NoVerdict' };
    // Still the same pause? (new speech resets it, and an ended turn clears it)
    if (id !== this.checkId || this.pause !== 'asking' || this.finished || this.ending || !d.active || d.quiet < EARLY_PAUSE) { this.metric('turn_check', { complete: verdict?.complete ? 1 : 0, used: 0, ...why }); return; }
    const p = verdict ? Math.round(verdict.probability * 100) / 100 : -1;
    if (verdict?.complete && verdict.probability >= TURN_PROBABILITY) { this.metric('turn_early', { ms: Math.round((this.now() - t0) * 1000), probability: p }); this.endTurn('sure'); return; }
    // Unsure (or no answer): the plain silence rule decides. Unfinished: give them room to think.
    this.pause = verdict && !verdict.complete ? 'unfinished' : 'unsure';
    this.metric('turn_check', { complete: verdict ? (verdict.complete ? 1 : 0) : -1, probability: p, used: 1, ...why });
  }

  async start(init) {
    try {
      if (!init || typeof init !== 'object' || Object.keys(init).some(k => !START_KEYS.includes(k)) || init.type !== 'start' || init.consent !== true || !same(String(init.csrf ?? ''), this.csrf)) throw new Error('Fresh voice consent and CSRF token required');
      this.project = projectContext(init.project);
      // What is known before the first question (role, sector, stage, opportunity, earlier notes): never the consultant's name.
      const { role, sector, stage, oppId, prior_notes: notes } = this.project;
      this.prefill = Object.fromEntries(Object.entries({ role, sector, stage, oppId, prior_notes: notes && Object.keys(notes).length ? notes : null }).filter(([, v]) => v));
      if (!this.voices.includes(init.voice ?? this.voice)) throw new Error('Unsupported voice');
      this.voice = init.voice ?? this.voice;
      this.capture = init.capture === true;
      this.language = normalize(init.language) || 'en'; // the browser's language opens the conversation
      if (this.captureRequired && !this.capture) throw new Error('Transcription consent is required for this interview');
      // A resume needs a checkpoint store, transcript consent given again now, and a full interview: a proof request (gap) is never resumed.
      if (init.resume !== undefined && (typeof init.resume !== 'string' || !RESUME_ID.test(init.resume) || init.gap !== undefined || !this.checkpoint || !this.capture)) throw Object.assign(new Error(RESUME_UNAVAILABLE), { code: 'resume-unavailable' });
      if (init.gap !== undefined && (typeof init.gap !== 'string' || !GAP_ID.test(init.gap) || !this.gaps)) throw new Error(GAP_UNAVAILABLE);
    } catch (e) { return this.fail(e.message, e.code || 'voice-contract'); }
    // The checkpoint, before anything else happens: a resume reads it, every other start deletes it (a fresh start never leaves an old interview behind).
    let doc = null;
    if (this.checkpoint) {
      this.starting = true; // until it is read or deleted the browser may only leave (onText)
      try { if (init.resume !== undefined) doc = await this.checkpoint.load(init.resume); else await this.purgeCheckpoint(); }
      catch (e) {
        this.metric('resume_refused', { code: e?.code || 'error' });
        if (e?.code === 'corrupt') await this.purgeCheckpoint(); // it can never be resumed: not offered again at every page load
        this.starting = false; return this.fail(RESUME_UNAVAILABLE, 'resume-unavailable');
      }
      this.starting = false;
      if (this.finished || this.ending) return;
      if (doc && doc.project?.id !== this.project.id) { this.metric('resume_refused', { code: 'project' }); return this.fail(RESUME_PROJECT, 'resume-project'); }
    }
    // Aggregate win-loop guidance (both modes): started now, in parallel, and never awaited, so neither 'ready' nor the
    // opening waits for it. It joins the per-turn notes of the first reply composed after it resolves, and never touches
    // the ledger or the order of questions.
    if (this.winHint) Promise.resolve().then(() => this.winHint()).then(h => { this.winNote = Object.hasOwn(WIN_HINTS, h?.hint ?? '') ? WIN_HINTS[h.hint] : ''; }, () => this.metric('win_hint_error', {}));
    if (init.gap !== undefined) {
      this.starting = true; // until resolved, the browser may only leave (onText)
      let timer, found = null;
      try { found = await Promise.race([Promise.resolve().then(() => this.gaps(init.gap)), new Promise(r => { timer = setTimeout(() => r(null), this.gapTimeout); })]); }
      catch { found = null; }
      finally { clearTimeout(timer); this.starting = false; }
      if (this.finished || this.ending) return; // closed while resolving: no 'ready', no timer
      const asks = gapAsks(found);
      if (!asks.length) { this.metric('gap_unavailable', {}); return this.fail(GAP_UNAVAILABLE, 'voice-contract'); }
      Object.assign(this, { mode: 'gap', maxSeconds: GAP_LIMIT_S, speakingLimit: GAP_SPEAKING_S, wrapS: GAP_WRAP_S, gapAsks: asks, gapRequest: init.gap });
    }
    const gap = this.mode === 'gap';
    const stage = this.project.stage || 'Unknown';
    this.analyst = this.capture ? new Analyst(messages => this.ai.analyst(messages), stage) : null;
    this.ledger = this.analyst ? this.analyst.ledger : new InterviewLedger(stage);
    // A resume puts the stored interview back before it starts (nothing is changed if it is refused: the stored one stays for another try).
    if (doc) {
      try { const r = restore(this, doc); this.resumed = true; this.metric('reconnect', { gap_s: Math.max(0, Math.round(this.now() - r.savedAt)), turns: this.turns, paused: this.paused ? 1 : 0 }); }
      catch (e) {
        this.metric('resume_refused', { code: e?.code || 'error' });
        if (e?.code === 'corrupt') { this.starting = true; await this.purgeCheckpoint(); this.starting = false; } // an interview that had already ended, or damaged: never offered again
        return this.fail(RESUME_UNAVAILABLE, 'resume-unavailable');
      }
    } else this.sessionId = newSessionId();
    this.started = true; this.lastInput = this.now(); if (!this.resumed) this.startedAt = this.lastInput;
    this.event('ready', { model: 'ATLAS', provider: 'ATLAS voice', sampleRate: 24000, speakingSeconds: this.speakingLimit, capture: this.capture, liveLedger: !!this.analyst,
      maxSeconds: this.maxSeconds, message: 'Voice session ready. Speak naturally. Candidate notes require your review.',
      mode: this.mode, timePlan: timePlan(this.maxSeconds, this.mode), controls: CONTROLS, ...(this.checkpointable() ? { sessionId: this.sessionId, resumable: true } : {}), ...(this.resumed ? { resumed: true, activeSeconds: Math.max(0, Math.floor(this.activeSeconds())) } : {}), ...(gap ? { gaps: this.gapAsks.map(({ id, label, ask }) => ({ id, label, ask })) } : {}) });
    if (this.memory && !gap) { // private memory from earlier conversations, bounded so the greeting is never held up (none in gap mode)
      let timer;
      try { this.memoryNote = await Promise.race([this.memory(this.project), new Promise(r => { timer = setTimeout(() => r(''), 3500); })]) || ''; }
      catch { this.memoryNote = ''; this.metric('memory_error', {}); }
      finally { clearTimeout(timer); }
      if (this.finished || this.ending) return; // closed while recalling: no timer, no opening
      this.event('memory', { status: this.memoryNote ? 'recalled' : 'empty', message: this.memoryNote ? 'ATLAS remembers your earlier conversations (private to you).' : 'No earlier conversations to recall.' });
    }
    if (this.resumed) this.fireState('reconnect', 'system'); // the stored interview was suspended (see restore): it carries on from where it was
    else { this.fireState('start', 'atlas'); this.fireState('consent_given', 'user'); } // the consent and the start came in the same message
    this.timer = setInterval(() => this.watch(), 1000);
    this.pace();
    const lang = this.spoken();
    if (this.resumed) { // the screens are repopulated, then the question in front of the consultant is said again (no model call), unless they are paused
      this.event('restore', restoreView(this));
      if (this.paused) this.afterRestore = true; else this.continueInterview(this.line(RESUME_LINES, this.resumeCount++));
    } else if (gap) { // the first open ask, after the usual greeting (always spoken, admin included: Tony, 2026-10-02)
      this.guidance = gapGuidance(this.gapAsks, this.gapStatuses());
      this.startReply(GAP_OPENING, { prefix: GREETING_PIECES[lang] || [] });
    } else this.startReply(OPENING, { prefix: (this.memoryNote ? WELCOME_BACK_PIECES[lang] : GREETING_PIECES[lang]) || [] });
    this.prewarm();
  }

  // Gap mode: the status of every ask from the session's own answer windows and attempt counts, plus the ledger's active
  // details (an ask's field may also be answered by a detail the analyst filed there).
  gapStatuses() {
    const answers = Object.fromEntries(Object.entries(this.gapAnswers).map(([id, turns]) => [id, turns.map(parts => parts.join(' '))]));
    return gapStatus(this.gapAsks, this.gapAttempts, answers, this.ledger ? this.ledger.details.filter(d => d.active) : []);
  }

  // A consultant turn joins the answer window of the ask they last heard. The rest of a turn they had paused in
  // (merged for the interviewer) extends the same entry, as a separate part, so every quote stays an exact transcript.
  recordAnswer(text, merged) {
    const last = this.lastAnswer;
    if (merged) { if (last) this.gapAnswers[last.id][last.index].push(text); return; }
    if (!this.openAsk) { this.lastAnswer = null; return; }
    const turns = this.gapAnswers[this.openAsk] ||= [];
    turns.push([text]); this.lastAnswer = { id: this.openAsk, index: turns.length - 1 };
  }

  // notes.gap.results: per ask, its answer-window turns (exact, first 400 characters, at most 3), then the quotes of active
  // details in its field that those turns do not already contain, at most 5 in all. Statuses as the consultant left them.
  gapResults() {
    const details = this.ledger ? this.ledger.details.filter(d => d.active) : [];
    return this.gapStatuses().map(s => {
      const parts = (this.gapAnswers[s.id] || []).flat(), whole = parts.map(ws);
      const quotes = parts.slice(0, WINDOW_QUOTES).map(p => first(p, QUOTE_CHARS));
      for (const d of details) {
        if (quotes.length >= GAP_QUOTES) break;
        const q = first(d.quote, QUOTE_CHARS);
        if (d.field === s.field && !whole.some(t => t.includes(d.quote)) && !quotes.includes(q)) quotes.push(q);
      }
      return { askId: s.id, field: s.field, status: s.status, quotes };
    });
  }

  watch() {
    if (this.finished || this.ending) return;
    // The absolute cap runs on the wall clock, paused or not: a session never stays open for ever.
    if (this.now() - this.startedAt >= WALL_CAP_S) { this.metric('wall_cap', {}); this.event('time_up', { message: WALL_CAP_MESSAGE }); this.end(true); return; }
    // Paused: the interview clock is stopped and nobody is expected to send audio, so neither the time limit nor the microphone watchdog applies.
    if (this.paused) return;
    const left = this.maxSeconds - this.activeSeconds();
    if (left <= 0) { this.event('time_up', { message: TIME_UP_MESSAGE.replace('{minutes}', String(Math.round(this.maxSeconds / 60))) }); this.end(true); } // a clean end: notes (and the full-mode report) are still written
    else if (this.now() - this.lastInput > 12) this.fail('Microphone frames stopped', 'voice-unavailable');
    // The last half minute and nobody is talking: ATLAS closes on her own, so the interview ends with a goodbye.
    else if (left <= 30 && !this.timeUp && this.turns >= 1 && !this.busy() && !this.turnDetector.active && this.sttBusy === 0) this.startReply(TIME_UP);
  }

  // A reply that was withdrawn or interrupted but has not yet noticed (awaiting the model or the voice) is not busy.
  busy() { return (!!this.speaking && this.replyGen === this.gen) || this.queue.length > 0; }

  audible() { return this.queue.length > 0 || this.now() - this.lastAudio < 0.3; }
  greetingPlaying() { return !!this.protectedItem && (this.playedMs[this.protectedItem] || 0) < this.protectedMs - 50 && this.now() < this.protectedDeadline; }

  // What the consultant heard of a reply cut short (the text sent with its audio) is recorded now, before their next
  // turn, not later when the reply's own code notices it was stopped. Words never voiced are not recorded.
  recordLive(marker = ' [interrupted by the consultant]') {
    const live = this.live;
    if (!live || !this.busy() || this.discarded.has(live.item) || this.recorded.has(live.item)) return;
    if (this.committed?.item === live.item) this.committed.entry.content = (live.text.trim() || this.committed.entry.content) + marker;
    else if (live.text.trim()) this.history.push({ role: 'assistant', content: live.text.trim() + marker });
    this.recorded.add(live.item);
  }

  // Her audio was cut (clear_audio): the browser drops what it had not played, so its playback ends within the unplayed
  // lead. Mark that point in the microphone stream (the browser keeps reporting the cut item, which never completes).
  stopped() {
    const item = this.currentItem, lead = Math.max(0, (this.sentMs[item] || 0) - (this.playedMs[item] || 0));
    if (!this.playbackDone) { this.playbackDone = true; this.doneAt = this.bytesIn + lead * 48; }
  }

  // keepState: the card's own correction cuts the reply short and the read-back comes round again at once, so the machine is left where it is.
  interrupt(keepState = false) {
    this.captureQuestion(); // a reply cut off still asked its question: repeat and resume say it again
    this.recordLive();
    this.uncommit(this.replyItem, true, keepState); // cut before she said her own words: the move was not asked
    this.stopped();
    this.protectedItem = null; // nothing protected is playing any more
    this.gen += 1; this.queue = [];
    this.event('clear_audio');
  }

  async transcribe(pcm, { continuing = false, echoable = true, endedBy = '', endedAt = this.now(), blip = false, endBytes = this.bytesIn } = {}) {
    if (this.finished) return;
    let text = '';
    const t0 = this.now();
    let heardIn = null, words = null, timer;
    if (blip) this.metric('blip', {}); // a click or a breath: no words to transcribe
    else try {
      const heard = await Promise.race([this.ai.transcribe(pcm), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'Timeout' })), this.sttTimeout); })]);
      text = (typeof heard === 'string' ? heard : heard?.text || '').trim(); heardIn = typeof heard === 'string' ? null : heard?.language || null; words = Array.isArray(heard?.words) ? heard.words : null;
      this.metric('stt', { ms: Math.round((this.now() - t0) * 1000), audio_ms: Math.round(pcm.length / 48), words: text ? text.split(/\s+/).length : 0 });
    } catch (e) {
      // A failed (or hung) transcription counts as no words: whatever was waiting on it (a held answer, a re-ask) still happens.
      this.metric('stt_error', { name: e?.name || 'Error' }); this.event('quality_warning', { message: 'A speech segment could not be transcribed. Please repeat it or add it to your notes.' }); text = ''; heardIn = null; words = null;
    } finally { clearTimeout(timer); }
    if (this.finished) return;
    // Echo reference: what the consultant could have heard, including a reply still playing or just withdrawn.
    // Echo reference: the reply that was playing (it stays live, even when withdrawn, until the utterance that stopped it
    // has been transcribed). Older replies cannot come back through the microphone.
    const recent = this.live?.text || this.history.filter(m => m.role === 'assistant').at(-1)?.content || '';
    // Follow the consultant's language, on consistent evidence only: two consecutive clear utterances (three words or more,
    // not her echo) heard in the same other supported language. Nova-3 gives no confidence to trust a single one, and one
    // misheard utterance must not change her language, her voice or the talker's note. The session language clears it.
    if (heardIn && text.split(/\s+/).length >= 3 && !isEcho(text, recent)) {
      if (heardIn === this.language) this.languageCandidate = null;
      else if (heardIn !== this.languageCandidate) { this.languageCandidate = heardIn; this.metric('language_candidate', { language: heardIn }); }
      else {
        this.languageCandidate = null; this.language = heardIn; this.metric('language_switch', { language: heardIn, voice: this.spoken() === heardIn ? 1 : 0 });
        this.event('language', { language: heardIn, name: LANGUAGES[heardIn], voice: this.spoken() === heardIn });
      }
    }
    // Speaker echo of ATLAS's own words must never become consultant testimony.
    if (text && echoable && isEcho(text, recent)) { this.metric('echo_ignored', {}); this.event('quality_warning', { message: 'ATLAS heard its own voice through the microphone and ignored it. Headphones prevent this.' }); text = ''; }
    // baseMs: where this utterance starts in the microphone stream (24 kHz PCM16 = 48 bytes per ms), so a word's offset is baseMs + its start.
    const lang = heardIn || this.language, how = { endedBy, endedAt, lang, sttMs: blip ? -1 : Math.round((this.now() - t0) * 1000), words, baseMs: Math.max(0, endBytes - pcm.length) / 48 };
    if (text) { this.cutOff = false; await this.finishTurn(text, continuing, how); }
    // No words. Unless the consultant is already speaking again (that utterance will decide): answer what they said
    // before a noise, or re-ask after a noise that cut ATLAS off.
    else if (this.paused || this.continuing || this.sttBusy > 1 || this.busy()) return;
    else if (continuing && this.history.at(-1)?.role === 'user') this.answer(this.history.at(-1).content, how);
    else if (this.cutOff) { this.cutOff = false; this.startReply(RESUME); }
  }

  async finishTurn(text, continuing = false, how = {}) {
    if (this.finished) return;
    const closing = !!this.ending; // an utterance finishing while the session closes is still recorded, never answered
    // The rest of an answer the consultant had paused in: the reply to its first part is taken back (screen and history,
    // before the turn count moves on) and both parts become one turn for the interviewer.
    if (continuing) this.withdraw();
    const merge = continuing && this.history.at(-1)?.role === 'user';
    // Otherwise a reply still under way is stopped here, and what they heard of it is recorded before their turn.
    if (!merge && !closing && !this.paused && this.busy()) this.interrupt(); // (a paused session's last words are recorded, and nothing she says is cut for them)
    this.turns += 1;
    if (this.turns > 300) return this.fail('Turn budget reached; end and start a new focused session', 'voice-contract');
    // A typed turn (how.typed, from the text box) has no speech recognition: its own item id, and its provenance says the consultant typed it.
    const ident = (how.typed ? 'user-typed-' : 'user-') + this.turns; this.identNow = ident;
    if (merge) { this.history[this.history.length - 1] = { role: 'user', content: this.history.at(-1).content + ' ' + text }; this.metric('turn_merged', {}); }
    else this.history.push({ role: 'user', content: text });
    const asr = this.recordAsr(ident, how, merge);
    // Gap mode: the turn joins its ask's answer window, and the plan moves on at once (the reply about to be composed
    // must carry the next ask, not wait for the analyst).
    if (this.mode === 'gap') { this.recordAnswer(text, merge); this.guidance = gapGuidance(this.gapAsks, this.gapStatuses()); }
    if (this.capture) {
      this.event('user_text', { item_id: ident, text, provenance: how.typed ? 'consultant_typed' : 'unverified_speech_recognition', ...(asr ? { asr } : {}) });
      const a0 = this.now();
      const job = this.analyst.hear(ident, text).then(async result => {
        this.applyAsrCorrections(ident); this.annotateAsr(ident); // before anything reads the ledger: doubt and corrections are on its details
        if (how.typed) for (const d of this.ledger.details) if (d.item_id === ident && d.provenance === 'unverified_speech_recognition') d.provenance = 'consultant_typed';
        this.metric('analyst', { ms: Math.round((this.now() - a0) * 1000), ok: result.analyst_status === 'analysed' ? 1 : 0, details: result.candidate_details.length, rejected: result.rejected_proposals });
        if (this.mode === 'gap') return this.gapQuality(result);
        this.lastPlan = result; // the plan the ledger now holds; the next move is read from the ledger, so it is never one answer behind
        let chosen = result.guidance;
        if (this.ai.rankProbe && result.analyst_status === 'analysed') {
          const j0 = this.now();
          try { const better = await this.ai.rankProbe(result, chosen); this.metric('jev', { ms: Math.round((this.now() - j0) * 1000), override: better ? 1 : 0 }); if (better) chosen = better; }
          catch (e) { this.metric('jev_error', { name: e?.name || 'Error' }); } // JEV unavailable: keep the ledger's own choice
        }
        this.guidance = chosen;
        const { guidance, ...rest } = result;
        this.event('quality', rest);
        if (this.summary.open) this.sendSummary(); // what the analyst filed late (or a spoken correction's supersede) is on the open card
        if (result.analyst_status !== 'analysed') this.event('quality_warning', { message: 'The evidence analyst did not respond for this turn. The answer is kept; review it in the notes.' });
      }).catch(() => this.event('quality_warning', { message: 'This turn exceeded the transcript budget and was not added to the evidence ledger.' }));
      this.turnJob = job; this.pending.add(job); job.finally(() => { this.pending.delete(job); this.checkpointSoon(); });
    }
    if (closing || this.paused) return;
    if (!how.typed && this.continuing && this.turnDetector.active && this.voiced >= MIN_VOICED) return; // already speaking again: answer when they have finished
    this.answer(this.history.at(-1).content, how);
  }

  // Gap mode, after the analyst: no JEV rankProbe (it never reorders asks). The plan is recomputed from the windows and the
  // ledger's details, and the quality event names the current ask in every question field, so the story board never shows
  // a full-mode question during a gap interview.
  gapQuality(result) {
    const { guidance, ...rest } = result, statuses = this.gapStatuses(), g = gapGuidance(this.gapAsks, statuses);
    this.guidance = g;
    this.event('quality', { ...rest, next_field: g.field, next_question: g.question, planned_question: g.question, why_this_question: g.why, next_action: g.action, gap_status: statuses });
    if (result.analyst_status !== 'analysed') this.event('quality_warning', { message: 'The evidence analyst did not respond for this turn. The answer is kept; review it in the notes.' });
  }

  // Reply to the consultant's latest turn. A thought left hanging (the turn model heard it unfinished, or the words
  // trail off) gets room, then at most a gentle nudge the talker chooses; never an acknowledgement or a new question.
  // Timed from the consultant's last sound (endedAt), so the wait does not depend on how fast speech recognition was.
  //
  // Agent Brain v2.1: for a real answer the pre-pass (analyzeTurn) and the next move (select) run HERE, synchronously, from the
  // words just transcribed, so the reply is steered by this answer and not by the analyst's plan of the one before; the
  // acknowledgement is chosen from the same pre-pass and starts playing before the talker has produced a word. The analyst
  // still runs in the background and refines the ledger the next move is read from.
  answer(text, { endedBy = '', endedAt = this.now(), lang = this.language, sttMs = -1 } = {}) {
    const typed = endedBy === 'typed', trailing = !typed && unfinished(text, lang); // typed words are never "trailing off"
    // The pre-pass runs for every answer (it also tells a spoken pause, repeat or skip from an answer). A short spoken pause or repeat is
    // handled here and goes no further: no acknowledgement, no selector, no talker.
    const t0 = this.now(); let turn = null;
    if (endedBy !== 'thinking' && !trailing) {
      try { turn = this.lastTurn = analyzeTurn(text, lang, { asked_field: this.humane.asked.at(-1)?.field ?? null }); } catch (e) { this.metric('turn_error', { name: e?.name || 'Error' }); }
      const short = turn && turn.words <= CONTROL_MAX_WORDS;
      if (short && turn.intents.includes('pause')) return this.pauseSession('voice');
      if (short && turn.intents.includes('repeat')) return this.repeatQuestion('voice');
      if (short && turn.intents.includes('skip')) this.noteSkip(this.humane.asked.at(-1)?.field); // the answer below accepts it and moves on
    }
    // Admin (Tony) gets the same patience, without the nudge or an acknowledgement (and keeps the analyst's guidance).
    if (this.admin) return this.startReply(undefined, { turn: this.turns, endedAt, notBefore: trailing && endedBy !== 'thinking' ? endedAt + THINKING_PAUSE : 0, timeline: { sttMs, selectorMs: -1 } });
    if (endedBy !== 'thinking' && !trailing) {
      // The read-back is open: a short reply means nothing to add (ATLAS points to the Confirm button and waits, no model call); a correction is taken by the
      // normal path (the selector, the analyst's supersede); anything longer is more to say, so the interview goes on.
      if (turn && this.summaryActive() && this.summaryTurn(turn)) return;
      const h = this.humane, v2 = this.flags.selector === 'v2' && this.mode === 'full', content = this.flags.acks === 'content';
      let move = null, selectorMs = -1, sinceEarned;
      if (v2 || content) {
        if (turn) turn = this.resolveAsr(turn, text); // a yes / no / right value for the span asked last turn settles it (once)
        if (turn && v2) { try { move = this.decide(turn); } catch (e) { this.metric('selector_error', { name: e?.name || 'Error' }); } }
        selectorMs = Math.round((this.now() - t0) * 1000);
      }
      if (h.sinceEarned !== null) sinceEarned = h.sinceEarned += 1;
      const ack = content ? this.ackFor(turn, move, text, sinceEarned) : null;
      // The analyst's plan may still land while the acknowledgement plays: with ANALYST_WAIT_MS the move is chosen again from it.
      const job = this.turnJob, wait = this.flags.analystWaitMs;
      const refine = move && job && wait > 0 ? async old => { await Promise.race([job.catch(() => {}), this.sleep(wait)]); return this.decide(turn, old); } : null;
      return this.startReply(undefined, { filler: ack ? ack.text : content ? '' : this.pickFiller(text), ack, move, refine, turn: this.turns, endedAt, timeline: { sttMs, selectorMs } });
    }
    this.metric('still_thinking', { by: endedBy === 'thinking' ? 1 : 0 });
    this.startReply(STILL_THINKING, { notBefore: endedBy === 'thinking' ? 0 : endedAt + THINKING_PAUSE, turn: this.turns, endedAt, thinking: true });
  }

  // The plan the selector reads: the ledger as it stands now (whatever the analyst has filed so far), else its last result.
  currentPlan() { try { return this.ledger ? this.ledger.inspect() : this.lastPlan || {}; } catch { return this.lastPlan || {}; } }
  // Uncertain speech spans of the turn being answered that are still open, for the selector's confirm_asr (it asks once per span).
  asrFor() {
    const out = [];
    for (const id of this.asrIdents) for (const s of this.asrMeta[id]?.spans || []) if (s.status === 'open') out.push({ text: s.text, kind: s.kind, min_conf: s.min_conf });
    return out.length ? out : null;
  }

  // Speech-recognition doubt for one consultant turn (words come from the transcriber, none from other models): its minimum word
  // confidence, where it starts in the microphone stream, and the spans worth a spoken check. A turn that answers a confirm_asr or
  // asr_repair question gets no new spans: the consultant has just said the value on purpose, so there is no loop. Returns the
  // browser-facing summary (or null when the transcriber sent no words, which changes nothing).
  recordAsr(ident, { words = null, baseMs = 0 } = {}, merge = false) {
    this.asrIdents = merge ? [...this.asrIdents, ident] : [ident];
    if (!Array.isArray(words) || !words.length) return null;
    const answering = ['confirm_asr', 'asr_repair'].includes(this.humane.asked.at(-1)?.intent), at = ms => Number.isFinite(ms) ? Math.round(baseMs + ms * 1000) : null;
    const confs = words.map(x => x.c).filter(c => typeof c === 'number'), start = words.find(x => typeof x.s === 'number')?.s;
    const spans = (answering ? [] : uncertainSpans(words, this.flags.asrTau)).map(sp => ({ ...sp, audio_offset_ms: at(sp.start), status: 'open' }));
    const meta = this.asrMeta[ident] = { spans, minConf: confs.length ? Math.min(...confs) : null, audioOffsetMs: at(start ?? 0) };
    this.metric('asr', { words: words.length, spans: spans.length, min_conf: meta.minConf === null ? -1 : Math.round(meta.minConf * 100) });
    return { min_conf: meta.minConf, audio_offset_ms: meta.audioOffsetMs, spans: spans.map(({ text, kind, min_conf, audio_offset_ms }) => ({ text, kind, min_conf, audio_offset_ms })) };
  }
  asrUnresolved(ident) { return (this.asrMeta[ident]?.spans || []).some(s => s.status === 'open' || s.status === 'denied'); }

  // The answer to the span asked last (the selector's confirm_asr, or the asr_repair after a no). Yes: confirmed. No with the right value
  // in the same breath ("no, thirty five"): corrected at once, and the turn no longer reads as a bare "no" (no second question). A bare
  // no: denied, the selector asks for the right one, and the next answer is it. Anything else leaves the span open (never asked twice).
  resolveAsr(turn, text) {
    const strip = t => ({ ...t, intents: t.intents.filter(i => i !== 'deny' && i !== 'correction') }); // a settled correction is not a bare "no", nor a correction to narrow
    if (this.asrDone?.turn === this.turns) return this.asrDone.strip ? strip(turn) : turn; // answer() can run twice for one turn
    this.asrDone = { turn: this.turns, strip: false };
    const last = this.humane.asked.at(-1), intents = turn.intents;
    if (!last || (last.intent !== 'confirm_asr' && last.intent !== 'asr_repair')) return turn;
    // The span that was asked about: of the turns before this one, the most recent open span whose exact words (whole words) are in the question
    // ("was that 15 percent?" never settles an older open "5"); a bare no is waited on for the most recent denied span.
    const all = Object.entries(this.asrMeta).filter(([ident]) => ident !== (this.identNow || 'user-' + this.turns)).flatMap(([ident, m]) => m.spans.map(span => ({ ident, span }))).reverse(), say = String(last.say || '').toLowerCase();
    const named = span => new RegExp('(?<![\\p{L}\\p{N}])' + span.text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'u').test(say);
    const found = last.intent === 'confirm_asr' ? all.filter(x => x.span.status === 'open' && named(x.span)).sort((a, b) => b.span.text.length - a.span.text.length)[0] : all.find(x => x.span.status === 'denied');
    if (!found) return turn;
    const { ident, span } = found, current = this.identNow || 'user-' + this.turns;
    const correct = value => {
      span.status = 'corrected'; span.corrected_to = value; this.asrDone.strip = true; this.metric('asr_resolved', { how: 1 });
      if (this.capture) this.asrCorrections.push({ ident: current, spanIdent: ident, from: span.text, to: value });
      this.syncAsr(ident);
    };
    if (last.intent === 'confirm_asr') {
      if (intents.includes('confirm') && !intents.includes('deny')) { span.status = 'confirmed'; this.metric('asr_resolved', { how: 0 }); this.syncAsr(ident); }
      else if (intents.includes('deny')) {
        const value = replacement(text, span.kind);
        if (value) correct(value); else { span.status = 'denied'; this.metric('asr_resolved', { how: 2 }); }
      }
    } else if (!intents.some(i => ['dont_know', 'cannot_disclose', 'skip', 'pause', 'resume', 'repeat', 'question_to_atlas', 'stop', 'rushed'].includes(i)) && turn.words >= 1) {
      correct(replacement(text, span.kind) || first(text.trim(), 120));
    }
    return this.asrDone.strip ? strip(turn) : turn;
  }

  // The ledger's details of an item carry the turn's recognition doubt: asr_min_conf and audio_offset_ms (for the evidence record), and
  // asr_unconfirmed: true while a flagged span of that turn is still open (false once settled). Only turns that had spans get the flag.
  annotateAsr(ident) {
    const meta = this.asrMeta[ident];
    if (!meta || !this.ledger) return;
    for (const d of this.ledger.details) if (d.item_id === ident && d.asr_min_conf === undefined) {
      Object.assign(d, { asr_min_conf: meta.minConf, audio_offset_ms: meta.audioOffsetMs });
      if (meta.spans.length) d.asr_unconfirmed = this.asrUnresolved(ident);
    }
  }
  syncAsr(ident) {
    if (!this.ledger) return;
    for (const d of this.ledger.details) if (d.item_id === ident && 'asr_unconfirmed' in d) d.asr_unconfirmed = this.asrUnresolved(ident) || 'asr_correction' in d;
  }

  // A correction settled in the turn just analysed: the details that quote the misheard span are superseded by the consultant's own
  // correcting words (provenance consultant_corrected), through the ledger's own supersede rule. If the analyst already filed the
  // corrected value as a detail of this turn, that detail takes the supersede link instead of a second one. If the ledger refuses (a
  // quote under five characters), the old detail stays active, marked asr_correction and still unconfirmed: never silently rewritten.
  applyAsrCorrections(ident) {
    const mine = this.asrCorrections.filter(c => c.ident === ident);
    this.asrCorrections = this.asrCorrections.filter(c => c.ident !== ident);
    if (!this.ledger) return;
    const quote = first(ws(this.ledger.transcripts.get(ident) || ''), 1800), meta = this.asrMeta[ident];
    for (const c of mine) {
      for (const old of this.ledger.details.filter(d => d.active && d.item_id === c.spanIdent && d.quote.toLowerCase().includes(c.from.toLowerCase()))) {
        const link = d => Object.assign(d, { provenance: 'consultant_corrected', asr_corrected_from: c.from, asr_corrected_to: c.to, ...(meta ? { asr_min_conf: meta.minConf, audio_offset_ms: meta.audioOffsetMs } : {}) });
        const twin = this.ledger.details.find(d => d.active && !d.supersedes && d.item_id === ident && d.field === old.field && d.quote.toLowerCase().includes(c.to.toLowerCase()));
        try {
          if (twin) { old.active = false; twin.supersedes = old.id; link(twin); continue; }
          this.ledger.record({ details: [{ field: old.field, item_id: ident, quote, supersedes: old.id }] });
          const added = this.ledger.details.at(-1);
          if (added?.supersedes !== old.id) throw new Error('not recorded');
          link(added);
        } catch { old.asr_correction = c.to; this.metric('asr_correction_unlinked', {}); }
      }
      this.syncAsr(c.spanIdent);
    }
  }
  // notes.asr: item id -> recognition doubt of that consultant turn (T13's evidence store reads min_conf and audio_offset_ms).
  asrNotes() {
    const out = {}, priv = this.ledger ? this.privateItems() : new Set();
    for (const [item, m] of Object.entries(this.asrMeta)) out[item] = { min_conf: m.minConf, audio_offset_ms: m.audioOffsetMs,
      spans: (priv.has(item) ? [] : m.spans).map(({ text, kind, min_conf, audio_offset_ms, status, corrected_to }) => ({ text, kind, min_conf, audio_offset_ms, status, ...(corrected_to ? { corrected_to } : {}) })) };
    return out;
  }

  // The next move for this answer (plan 3c). `replacing`: a move already committed for this reply, left out of the log when the
  // analyst's newer plan makes the server choose again. Deferrals ("I don't know") stay open: their hints do not count as covered.
  decide(turn, replacing = null) {
    const h = this.humane, elapsed = this.activeSeconds();
    if (turn.intents.includes('rushed')) h.rushed = true;
    const plan = { ...this.currentPlan(), covered_fields: [...h.covered] };
    const move = select(plan, turn, h.asked.filter(m => m !== replacing), this.prefill, elapsed >= TIME_PLAN.depth_fraction * this.maxSeconds ? 'depth' : 'breadth',
      this.maxSeconds - elapsed, this.asrFor(turn), h.rushed, this.language);
    if (!turn.intents.some(i => ['dont_know', 'cannot_disclose', 'skip'].includes(i))) for (const f of turn.field_hints) h.covered.add(f);
    // The selector had to avoid saying a question it already said (a variant, or a whole candidate): counted, never logged.
    if (!replacing && /\+r[vi]/.test(move.why || '')) this.metric('question_repeat', { variant: move.why.includes('+rv') ? 1 : 0, skipped: move.why.includes('+ri') ? 1 : 0 });
    // The selector closes once a read-back was asked and nothing is left. Nothing is filed without the consultant's confirmation, so a close that is not
    // the time limit or their own wish to stop becomes another read-back (the card is on their screen; they confirm there).
    if (move.kind === 'close' && !/^close:(wrap|stop)/.test(move.why || '') && !this.summary.confirmed && this.capture && !this.admin) { this.metric('summary_before_close', {}); return { ...SUMMARY_MOVE }; }
    return move;
  }

  // The move committed for a reply goes into the asked log; one taken back (withdrawn, or cut before she said it) comes out.
  commitMove(item, move) { this.humane.asked.push(move); this.moveByItem.set(item, move); this.moveState(move); }
  swapMove(item, old, move) { const i = this.humane.asked.indexOf(old); if (i >= 0) this.humane.asked[i] = move; else this.humane.asked.push(move); this.moveByItem.set(item, move); this.moveState(move); }
  // A move that opens the read-back asks for the summary; any other move about a field in a new focus area moves the discovery focus (both audited).
  moveState(move) {
    const state = this.machine.state;
    if (move.kind === 'summary') { if (state === 'discovery' || state === 'user_correction') this.fireState('request_summary', 'atlas'); return; } // (already in the summary: a repeat)
    // A read-back was begun (or is open) and the interview goes on with something else: back to discovery. A close (time is up) ends it as it is.
    if (state === 'summary' && this.summary.open && move.kind !== 'close') { this.closeSummary('continue'); this.fireState('continue_discovery', 'atlas'); }
    if (this.machine.state !== 'discovery') return;
    const focus = FIELD_FOCUS[move.field];
    if (focus && focus !== this.machine.focus) this.fireState('focus', 'atlas', { data: { focus } });
  }


  // ----- summary read-back and corrections (T11) -----
  // The card is open on the consultant's screen and the machine is in summary / user_correction (not paused, not suspended).
  summaryActive() { return this.summary.open && (this.machine.state === 'summary' || this.machine.state === 'user_correction'); }
  closeSummary(reason) {
    if (!this.summary.open) return;
    this.summary.open = false; this.summary.sig = '';
    this.event('summary_closed', { reason });
  }
  // The card, from the ledger: items (active, not kept private), open points (unsure speech, "I don't know", skipped, left open).
  summaryView() {
    return { items: buildSummary(this.ledger), unknowns: buildUnknowns(this.ledger, { skipped: this.machine.skipped, deferred: Object.keys(this.ledger.deferred) }), round: this.summary.rounds };
  }
  // Send the card to the browser (only when it changed, unless forced). Sent to the same person on the same authenticated socket.
  sendSummary(force = false) {
    const v = this.summaryView(), sig = JSON.stringify([v.items, v.unknowns]);
    if (force || sig !== this.summary.sig) { this.summary.sig = sig; this.event('summary', { ...v, state: this.machine.state }); }
    return v;
  }
  // The facts of a read-back, from the same ledger as the card. A summary opens the card (after a bounded wait for the analyst's last entry, which may
  // still be landing: the read-back must include what they just said); a reflection only reads a few facts and shows no card. The talker is told these
  // facts and no others, and the ReplyGuard blocks any figure that is not in them.
  async readBack(move, gen = this.gen) {
    const reflect = move.kind === 'reflect';
    if (!reflect && this.turnJob) await Promise.race([this.turnJob.catch(() => {}), this.sleep(SUMMARY_WAIT_MS)]);
    if (this.finished || this.ending || gen !== this.gen) return null; // interrupted or withdrawn while waiting: no card for a read-back nobody heard
    let v;
    if (reflect) v = this.summaryView();
    else { this.summary.open = true; this.summary.rounds += 1; v = this.sendSummary(true); this.metric('summary', { items: v.items.length, unknowns: v.unknowns.length, round: this.summary.rounds }); this.checkpointSoon(); }
    const { facts, numbers } = summaryFacts(v.items, { max: reflect ? REFLECT_FACTS : MAX_FACTS });
    return { reflect, facts: facts.map(f => clean(f, 240)), numbers, unknowns: v.unknowns.map(u => ({ ...u, label: clean(u.label, 80) })) };
  }
  // A spoken turn while the card is open. true: answered here, nothing else is said. false: the normal path goes on.
  summaryTurn(turn) {
    const intents = turn.intents;
    // A correction: the normal path takes it (the selector accepts and narrows, the analyst supersedes the earlier detail); the read-back comes round again.
    if (intents.includes('correction')) { this.fireState('correct', 'user'); this.checkpointSoon(); return false; }
    if (turn.words <= SATISFIED_WORDS || intents.includes('confirm')) { this.promptConfirm(); return true; }
    this.closeSummary('continue'); this.fireState('continue_discovery', 'atlas'); this.checkpointSoon(); // more to say: back to the conversation
    return false;
  }
  // They have nothing to add: ATLAS says where the next click is (no model call), and the interview waits. Nothing is filed by speech alone.
  promptConfirm() {
    this.summary.prompts += 1; this.metric('summary_prompt', {});
    const line = this.line(SUMMARY_LINES.prompt, this.summary.prompts - 1);
    if (line) this.startReply(null, { prefix: [line], only: true, turn: this.turns }); else this.startReply(SUMMARY_PROMPT_INSTRUCTION, { turn: this.turns });
  }
  summaryWarning(message) { this.event('quality_warning', { message }); }
  // The card's buttons (client events correct / withhold) act on one item of the open card. Anything else is refused with one message.
  summaryEditable(id) {
    if (!this.started || this.finished || this.ending || this.starting) return false;
    if (!this.summaryActive() || this.summary.posting || typeof id !== 'string' || !DETAIL_ID.test(id)) { this.summaryWarning(SUMMARY_UNAVAILABLE); return false; }
    return true;
  }
  // After a change the story board gets the ledger as it now stands, like after any analysed turn.
  boardUpdate() { this.event('quality', { ...this.ledger.inspect(), analyst_status: 'analysed', rejected_proposals: 0, ignored_tool_calls: 0 }); }
  // A typed correction of one item: the consultant's own words become a new transcript item (user-typed-N) and a new detail that SUPERSEDES the old one
  // (provenance consultant_typed). The old detail stays in the ledger, inactive, and in the history. No model is involved. Then the read-back comes round again.
  correctDetail(id, raw) {
    if (!this.summaryEditable(id)) return;
    const old = this.ledger.details.find(d => d.id === id && d.active && d.withheld !== true), text = clean(raw, CORRECTION_MAX_CHARS);
    if (!old) return this.summaryWarning('That item is no longer in the summary.');
    if (Array.from(text).length < 5) return this.summaryWarning('Please type a little more, so the correction can be kept as your own words.');
    const t = this.now(); this.correctionTimes = this.correctionTimes.filter(x => t - x < 60);
    if (this.correctionTimes.length >= CORRECTIONS_PER_MINUTE) { this.metric('correction_rate_limited', {}); return this.summaryWarning(CORRECTION_RATE_LIMITED); }
    this.correctionTimes.push(t); // attempts count, failed or not
    // The next free item id (a failed attempt must never leave its id taken: every later correction would then be refused as "Transcript item changed").
    let n = CORRECTION_ITEM_BASE + this.summary.corrections + 1; while (this.ledger.transcripts.has('user-typed-' + n)) n += 1;
    const ident = 'user-typed-' + n; let added = false;
    try {
      this.ledger.addTranscript(ident, text); added = true;
      this.ledger.record({ details: [{ field: old.field, item_id: ident, quote: ws(text), supersedes: old.id }] }, 'consultant_typed');
    } catch { if (added) this.ledger.transcripts.delete(ident); return this.summaryWarning('That correction could not be added to the interview notes.'); }
    this.summary.corrections += 1;
    this.metric('summary_correct', { chars: text.length });
    this.event('user_text', { item_id: ident, text, provenance: 'consultant_typed' });
    this.boardUpdate();
    this.fireState('correct', 'user'); this.fireState('request_summary', 'atlas'); // user_correction, then the read-back again (the loop)
    this.sendSummary(true);
    this.checkpointSoon();
    const line = this.line(SUMMARY_LINES.corrected, this.summary.corrections - 1);
    if (line) { if (this.busy()) this.interrupt(true); this.cutOff = false; this.startReply(null, { prefix: [line], only: true, turn: -1 }); }
  }
  // "Keep private": the item leaves the notes, the report and the evidence draft; it stays in the ledger history. ATLAS does not ask about that point again.
  withholdDetail(id) {
    if (!this.summaryEditable(id)) return;
    if (!this.ledger.details.some(d => d.id === id && d.active && d.withheld !== true)) return this.summaryWarning('That item is no longer in the summary.');
    try { this.ledger.withhold(id); } catch { return this.summaryWarning('That item could not be kept private.'); }
    this.metric('summary_withhold', {});
    this.scrubPrivate();
    this.boardUpdate(); this.sendSummary(true); this.checkpointSoon();
  }
  // "Keep private" covers the WHOLE utterance the detail came from, not only the extracted quote (review L7): its text leaves the notes transcript, the report's
  // input, what goes on to private memory (the notes transcript is what the browser retains) and the talker's history, where it is replaced by a neutral marker.
  // The ledger keeps its own record (the withheld detail, its transcript item) for the audit and the owner-only checkpoint: that is T11's contract.
  privateItems() { return new Set(this.ledger.details.filter(d => d.active && d.withheld === true).map(d => d.item_id)); }
  privateTexts() { return [...this.privateItems()].map(i => this.ledger.transcripts.get(i)).filter(t => typeof t === 'string' && t.trim()); }
  scrubPrivate() {
    const texts = this.privateTexts();
    if (texts.length) for (const m of this.history) if (m.role === 'user') m.content = redact(m.content, texts);
    const priv = this.privateItems();
    for (const item of priv) if (this.asrMeta[item]) this.asrMeta[item].spans = []; // its doubtful words are words of the utterance too
    this.asrCorrections = this.asrCorrections.filter(c => !priv.has(c.ident) && !priv.has(c.spanIdent));
  }
  // The notes a draft is made of (T13 cleanNotes): the active details that are not kept private, nothing else. A withheld or replaced detail never leaves here.
  evidenceNotes() {
    const details = this.ledger.details.filter(d => d.active && d.withheld !== true).map(d => ({ id: d.id, field: d.field, item_id: d.item_id, quote: d.quote, status: d.status, active: true,
      supersedes: d.supersedes || '', withheld: false, provenance: d.provenance || 'unverified_speech_recognition', asr_min_conf: typeof d.asr_min_conf === 'number' ? d.asr_min_conf : null,
      audio_offset_ms: Number.isInteger(d.audio_offset_ms) ? d.audio_offset_ms : null }));
    const asr = this.asrNotes();
    // A project that does not exist yet reaches the server as the placeholder id 'new' (the browser creates it from the report): that is no project, never a shared fake one.
    return { session_id: this.sessionId, project_ref: this.project?.id && this.project.id !== 'new' ? this.project.id : null, details, ...(Object.keys(asr).length ? { asr } : {}) };
  }
  // Confirm: the machine moves to summary_confirmed, the notes become ONE owner-only evidence draft (the hook; idempotent on the session id), and ATLAS closes.
  // It never submits: that is the owner's own click in the library.
  async confirmSummary() {
    if (!this.started || this.finished || this.ending || this.starting) return;
    if (this.summary.confirmed || this.summary.posting) { this.metric('summary_confirm_repeat', {}); return; } // a second click saves nothing more
    if (!this.summaryActive()) return this.summaryWarning(SUMMARY_UNAVAILABLE);
    this.summary.posting = true;
    try {
      if (this.pending.size) await Promise.race([Promise.allSettled([...this.pending]), this.sleep(CONFIRM_WAIT_MS)]); // a late analyst entry belongs in the draft
      if (this.finished || this.ending || !this.summaryActive() || !this.fireState('confirm_summary', 'user')) return;
      this.summary.confirmed = true; this.summary.open = false;
      if (this.busy()) this.interrupt();
      this.cutOff = false;
      this.metric('summary_confirmed', { rounds: this.summary.rounds, corrections: this.summary.corrections });
      this.event('summary_confirmed', {});
      const saved = await this.saveDraft();
      if (this.finished || this.ending) return;
      this.checkpointSoon();
      const line = this.line(SUMMARY_LINES[saved ? 'saved' : 'unsaved'], 0);
      if (line) this.startReply(null, { prefix: [line], only: true, turn: -1, closeAfter: true }); else this.startReply(SUMMARY_CLOSE_INSTRUCTION(saved), { turn: -1, closeAfter: true });
    } finally { this.summary.posting = false; }
  }
  // true: a draft exists (created now, or the same notes were saved before). false: nothing was saved, and the browser is told why (a stable code, no content).
  async saveDraft() {
    const notes = this.evidenceNotes(), no = (reason, message) => { this.metric('evidence_draft_unavailable', { reason }); this.event('evidence_draft_unavailable', { reason, message }); return false; };
    if (!notes.details.length) return no('nothing_to_save', 'Every item was kept private or replaced, so there is nothing to save as a draft.');
    if (!this.evidence) return no('workflow_off', 'The evidence workflow is switched off here, so the summary was not saved to the library.');
    let r = null;
    try { r = await this.evidence(notes); } catch { r = null; }
    if (r && (r.status === 200 || r.status === 201) && typeof r.body?.id === 'string') {
      const revision = Number.isInteger(r.body.revision) ? r.body.revision : 1;
      this.summary.draft = { id: r.body.id, revision };
      this.metric('evidence_draft', { status: r.status, details: notes.details.length });
      this.event('evidence_draft', { id: r.body.id, revision, state: typeof r.body.state === 'string' ? r.body.state : 'evidence_draft', visibility: 'owner_only', unchanged: r.status === 200 });
      return true;
    }
    const status = r?.status || 0;
    return no(status === 409 ? 'already_captured' : status === 400 ? 'nothing_to_save' : status === 0 ? 'library_unavailable' : 'refused',
      status === 409 ? 'This interview was already saved as a draft with different notes. Amend that draft in the library.' : status === 0 ? 'The library could not be reached, so the summary was not saved.' : 'The library did not accept the summary, so it was not saved.');
  }

  // ----- pause, resume, repeat, skip, typed turns (T9) -----
  // lastQuestion: the last question sentence ATLAS composed (so a reply cut off still counts), else, for a reply cut before it got that far,
  // the question its move proposed. A withdrawn reply asked nothing. Repeat and resume say it again with no model call.
  noteQuestion(item, said, move, interrupted) {
    if (this.discarded.has(item)) return;
    const q = lastQuestionOf(said), keep = this.lastQuestion;
    if (q) this.lastQuestion = { text: q, move: move || (keep?.text === q ? keep.move : null), item, turn: this.turns };
    else if (interrupted && move && /[?？]/.test(move.say || '')) { const text = speakable(clean(move.say, 400)); if (text) this.lastQuestion = { text, move, item, turn: this.turns }; }
  }
  captureQuestion() { const c = this.composing; if (c && this.busy()) this.noteQuestion(c.item, c.text(), c.move(), true); }
  // A stock line in the spoken language (persona.py PAUSE_LINES / RESUME_LINES, English only for now: other languages are silent), rotating.
  line(bank, n) { const list = bank[this.spoken()]; return list?.length ? list[n % list.length] : ''; }
  // The consultant chose to skip the question just asked: its field (an internal id) is recorded as skipped_by_user (the field itself stays open).
  noteSkip(field) {
    if (this.mode !== 'full') return;
    if (typeof field === 'string' && FIELD_ID.test(field)) this.fireState('skip', 'user', { data: { field } });
    else this.metric('skip_no_field', {});
  }
  // Drop what the consultant was in the middle of saying: a held click, a half-heard answer, a pending end-of-turn check.
  dropMic() {
    const d = this.turnDetector;
    if (d.active) d.flush();
    this.blip = null; this.pause = ''; this.checkId += 1; this.voiced = 0; this.continuing = false; this.echoable = false;
  }

  // Pause: ATLAS stops (as for an interruption), says one stock line, then goes quiet. Audio is ignored, the interview clock and the
  // microphone watchdog stand still (activeSeconds, watch). Nothing is lost: the question she was on is kept for the resume.
  pauseSession(via = 'ui') {
    if (!this.started || this.finished || this.ending || this.paused || this.starting) return;
    this.paused = true; this.pausedAt = this.now();
    this.dropMic();
    if (this.busy()) this.interrupt();
    this.cutOff = false;
    this.metric('pause', { voice: via === 'voice' ? 1 : 0 });
    this.fireState('pause', 'user');
    const line = this.line(PAUSE_LINES, this.pauseCount++);
    if (line) this.startReply(null, { prefix: [line], only: true });
  }
  // The paused stretch ends: the clock runs again, the microphone watchdog starts afresh.
  unpause(via = 'ui') {
    const t = this.now(), ms = Math.round((t - this.pausedAt) * 1000);
    this.pausedTotal += t - this.pausedAt; this.pausedAt = null; this.paused = false; this.lastInput = t; this.afterRestore = false;
    this.dropMic();
    this.metric('resume', { voice: via === 'voice' ? 1 : 0, paused_ms: ms });
    this.fireState('resume', 'user');
  }
  // Resume: a stock welcome-back line, then the question again (stored text, spoken from cache or synthesised once: no model call).
  resumeSession(via = 'ui') {
    if (!this.paused || this.finished || this.ending) return;
    const restored = this.afterRestore; // an interview resumed from a checkpoint while it was paused carries on the same way as after a reconnect
    this.unpause(via);
    const lead = this.line(RESUME_LINES, this.resumeCount++);
    if (restored) this.continueInterview(lead); else if (this.pendingAnswer()) this.answerPending(); else this.speakQuestion(lead);
  }
  // The consultant's last turn when it still waits for its reply: the question in front of them is older than it (the reply was never composed: the
  // connection dropped, or they paused while the answer was still being transcribed). A short spoken pause / repeat is a control, not an answer
  // (answering it would pause again), and the Skip button's own history note has its reply composed elsewhere.
  pendingAnswer() {
    const q = this.lastQuestion, last = this.history.findLast(m => m.role === 'user');
    if (!last || last.content === SKIP_NOTE || (q && (q.turn ?? this.turns) === this.turns)) return null;
    try { const t = analyzeTurn(last.content, this.language, { asked_field: this.humane.asked.at(-1)?.field ?? null }); if (t.words <= CONTROL_MAX_WORDS && (t.intents.includes('pause') || t.intents.includes('repeat'))) return null; } catch { /* an answer */ }
    return last;
  }
  answerPending() { this.answer(this.history.findLast(m => m.role === 'user').content, { endedBy: 'resume', endedAt: this.now(), lang: this.language, sttMs: -1 }); }
  // After a reconnect: the question in front of the consultant is said again from the stored text, with no model call. When they had already
  // answered it (the reply to that answer was never composed) it is never asked again: the answer gets its reply now, as it would have. Before
  // anything was asked the opening is spoken.
  continueInterview(lead = '') {
    if (this.pendingAnswer()) return this.answerPending();
    if (this.lastQuestion || this.history.some(m => m.role === 'user')) return this.speakQuestion(lead);
    this.startReply(OPENING, { prefix: (this.memoryNote ? WELCOME_BACK_PIECES : GREETING_PIECES)[this.spoken()] || [] });
  }
  // Say lastQuestion again after `lead` (a stock line, or nothing). A question asked but cut off before she said it goes back into the asked
  // log. With no question yet (paused or asked to repeat before the first one) the talker is asked, once, to open or to re-ask.
  speakQuestion(lead = '') {
    const q = this.lastQuestion;
    if (!q) return this.startReply(this.turns === 0 ? OPENING : RESUME, { prefix: lead ? [lead] : '', turn: -1 });
    const move = q.move && !this.humane.asked.includes(q.move) ? q.move : null;
    this.startReply(null, { prefix: [lead, q.text].filter(Boolean), only: true, move, turn: -1 });
  }
  repeatQuestion(via = 'ui') {
    if (!this.started || this.finished || this.ending || this.paused || this.starting) return;
    this.metric('repeat', { voice: via === 'voice' ? 1 : 0 });
    if (this.busy()) this.interrupt();
    this.cutOff = false;
    this.speakQuestion();
  }
  // The Skip button: the question she was on is skipped (field recorded, left open, never asked again) and the selector's accept_and_move follows.
  // The spoken "skip" takes the normal answer path; this one has no words of the consultant, so nothing goes to the ledger.
  skipQuestion() {
    if (!this.started || this.finished || this.ending || this.paused || this.starting) return;
    if (this.mode !== 'full') { this.event('quality_warning', { message: SKIP_UNAVAILABLE }); return; }
    this.metric('skip', {});
    if (this.busy()) this.interrupt();
    this.cutOff = false;
    const h = this.humane, q = this.lastQuestion;
    if (q?.move && !h.asked.includes(q.move)) h.asked.push(q.move); // cut off before she said it: it was still the question in front of them
    const field = h.asked.at(-1)?.field ?? null;
    this.noteSkip(field);
    if (this.flags.selector !== 'v2' || this.admin) return this.startReply(SKIP_INSTRUCTION, { turn: -1 });
    let move = null;
    try { move = this.decide(analyzeTurn('skip it', 'en', { asked_field: field })); } catch (e) { this.metric('selector_error', { name: e?.name || 'Error' }); }
    this.history.push({ role: 'user', content: SKIP_NOTE });
    this.startReply(undefined, { move, turn: -1 });
  }
  // A typed answer from the text box: the same path as a spoken turn without the recogniser (works with the microphone muted). Typing while
  // paused carries on the interview (they are answering): the clock restarts and nothing is re-asked.
  async typedTurn(raw) {
    if (!this.started || this.finished || this.ending || this.starting) return;
    const text = clean(raw, TYPED_MAX_CHARS);
    if (!text) return;
    const t = this.now();
    if (this.busy() || t - this.typedAt < TYPED_MIN_INTERVAL_S) { this.metric('typed_rate_limited', { busy: this.busy() ? 1 : 0 }); this.event('quality_warning', { message: TYPED_RATE_LIMITED }); return; }
    this.typedAt = t;
    if (this.paused) this.unpause('ui');
    this.cutOff = false;
    this.metric('typed_turn', { chars: text.length });
    await this.finishTurn(text, false, { endedBy: 'typed', endedAt: this.now(), lang: this.language, sttMs: -1, words: null, baseMs: 0, typed: true });
  }

  uncommit(item, onlyIfUnheard = false, keepState = false) {
    const move = this.moveByItem.get(item);
    if (!move || (onlyIfUnheard && this.composedItem === item)) return;
    const i = this.humane.asked.indexOf(move); if (i >= 0) this.humane.asked.splice(i, 1);
    this.moveByItem.delete(item);
    // A read-back that was never heard leaves the read-back too: otherwise the machine stays in `summary`, where skip and focus are illegal.
    if (!keepState && move.kind === 'summary' && this.machine.state === 'summary') { this.closeSummary('continue'); this.fireState('continue_discovery', 'atlas'); this.checkpointSoon(); }
  }

  // The acknowledgement for this answer (ack.js): from the selector's category and the cues of the words, never from a judgement
  // of the person. Null in admin, after a question, at the time limit or when the answer is short.
  ackFor(turn, move, text, sinceEarned) {
    if (move?.reaction === 'none') return null; // the selector goes straight to the move (a repeat, an offer to move on, a read-back, a close)
    const h = this.humane, words = turn ? turn.words : String(text).split(/\s+/).filter(Boolean).length;
    return pickAck({ category: move?.ack_category ?? 'neutral', cues: turn?.cues ?? [], words, lang: this.spoken(), recent: h.acks.slice(-4), admin: this.admin, timeUp: this.timeUp,
      afterQuestion: !!turn?.intents.includes('question_to_atlas') || /[?？]\s*$/.test(text), repliesSinceEarned: sinceEarned, seed: this.turns });
  }
  ackPlayed(ack) {
    const h = this.humane; h.acks.push(ack.text); if (h.acks.length > 8) h.acks.shift();
    if (ack.category === 'earned_result') h.sinceEarned = 0;
    this.metric('ack', { category: ack.category });
  }

  spoken() { return spokenFor(this.language, l => (this.ai.speaks ? this.ai.speaks(l) : l === 'en')); }
  // Per-turn server notes. Full: [admin, language, memory, win hint, pace] (identical to before when there is no hint).
  // Gap: [admin, GAP_NOTE, gap pace (open items by label)] then language and the win hint; there is no memory in gap mode.
  paceNotes() {
    const lang = languageNote(this.language, this.spoken()), elapsed = this.activeSeconds();
    if (this.mode === 'gap') {
      const open = this.gapStatuses().filter(s => s.status === 'open').map(s => s.label);
      return [...gapNotes(elapsed, this.maxSeconds, open, this.admin ? ADMIN_NOTE : ''), lang, this.winNote];
    }
    const [admin, pace] = paceNotes(elapsed, this.maxSeconds, this.ledger ? this.ledger.notes() : [], this.admin);
    return [admin, lang, this.memoryNote, this.winNote, pace];
  }

  // A short spoken acknowledgement from cache, only after a real answer, never twice in a row, never in admin mode.
  pickFiller(text) {
    const list = FILLERS[this.spoken()];
    if (!list || this.admin || this.timeUp || this.turns - this.fillerTurn < 2 || String(text).split(/\s+/).length < FILLER_WORDS || /\?\s*$/.test(text)) return '';
    this.fillerTurn = this.turns; this.lastFiller = (this.lastFiller + 1 + (this.turns % 2)) % list.length;
    return list[this.lastFiller];
  }

  // measure: a piece of a reply (not a prewarm), reported as numbers only: synthesis time, audio length, characters, cache hit.
  async synth(text, lang, measure = false, fixed = false) { // fixed: a stock phrase (greeting, acknowledgement), cached whatever its length
    const key = lang + '|' + this.voice + '|' + text, keep = fixed || text.length <= 220, cached = keep ? cacheGet(key) : null, t0 = this.now();
    const pcm = cached || await this.ai.synthesize(text, this.voice, lang);
    if (!cached && keep) cacheSet(key, pcm);
    if (measure) this.metric('tts', { ms: cached ? 0 : Math.round((this.now() - t0) * 1000), audio_ms: Math.round(pcm.length / 48), chars: text.length, cached: cached ? 1 : 0 });
    return pcm;
  }

  // Fill the cache with this language's acknowledgements without delaying anything: the legacy fillers at once (four lines), the
  // content-aware bank (about forty English lines, a few MB of PCM against the 12 MB cache) a few at a time, and none in admin.
  prewarm() {
    const lang = this.spoken();
    if (this.flags.acks === 'legacy') { for (const f of FILLERS[lang] || []) this.synth(f, lang).catch(() => {}); return; }
    if (this.admin) return;
    const todo = ackPrewarmList(lang);
    const lane = async () => { for (let t = todo.shift(); t !== undefined; t = todo.shift()) { if (this.finished) return; await this.synth(t, lang, false, true).catch(() => {}); } };
    for (let i = 0; i < PREWARM_LANES; i++) lane();
  }

  // prefix: a greeting (a list of cached pieces) or an acknowledgement (`filler`, one cached piece). move / ack / refine / timeline:
  // the humane interviewer's inputs for a normal reply (see answer()); a reply with another instruction (opening, nudge, closing,
  // re-ask) carries none.
  // closeAfter: the interview ends once this reply has been heard (the confirmed summary's goodbye), as after a closing the talker ends with [[END]].
  startReply(instruction, { prefix = '', filler = '', notBefore = 0, turn = -1, endedAt = 0, thinking = false, move = null, ack = null, refine = null, timeline = null, only = false, closeAfter = false } = {}) {
    if (this.ending || this.finished) return;
    // only: the reply is exactly its `prefix` pieces (a pause or resume line, a question said again): no model call. Nothing else is spoken while paused.
    if (this.paused && !only) return;
    // Re-checked on every reply: an interrupted closing (or a noise re-ask) cannot escape the time limits. With wrapS
    // (WRAP_S, or GAP_WRAP_S in gap mode) left of the interview, or ATLAS's own speaking time used up, the next reply is the closing.
    const late = this.activeSeconds() >= this.maxSeconds - this.wrapS;
    if (!only && instruction !== OPENING && instruction !== GAP_OPENING && this.turns >= 1 && (late || this.spokenMs >= this.speakingLimit * 1000)) {
      if (!this.timeUp) { this.timeUp = true; this.metric(late ? 'interview_limit' : 'speaking_limit', { turns: this.turns }); }
      instruction = TIME_UP;
    }
    if (only) refine = null; // a question said again keeps its move (it is asked again); it is never chosen again
    else if (instruction !== undefined) { move = null; refine = null; } // only a normal reply carries the selected move
    this.replies += 1;
    const item = 'agent-' + this.replies, gen = ++this.gen;
    this.replyItem = item; this.replyTurn = turn; this.replyGen = gen;
    if (move) this.commitMove(item, move);
    const pieces = Array.isArray(prefix) ? prefix : prefix ? [prefix] : filler ? [filler] : [];
    const run = this.speak(item, gen, instruction, pieces, !!filler, notBefore, endedAt, thinking, { move, ack: filler ? ack : null, refine, timeline, only, closeAfter }).catch(e => { this.metric('reply_error', { name: e?.name || 'Error' }); if (!this.finished && gen === this.gen) this.event('error', { message: 'The voice reply failed. No fallback voice was used.', code: 'voice-unavailable' }); });
    this.speaking = run;
    run.finally(() => { if (this.speaking === run) this.speaking = null; });
  }

  async speak(item, gen, instruction, pieces = [], isFiller = false, notBefore = 0, endedAt = 0, thinking = false, { move = null, ack = null, refine = null, timeline = null, only = false, closeAfter = false } = {}) {
    let said = '', interrupted = true, firstText = 0, firstToken = 0, firstAudio = 0, gapMs = -1, talker = '', voiced = 0;
    const lang = this.spoken(); // one voice per reply, even if the consultant switches mid-reply
    const marker = new EndMarker(); // the talker's end-of-interview token is never spoken or shown
    const t0 = this.now(), prefix = pieces.join(' ');
    // The reply guard (speech.js ReplyGuard) enforces the shape of what the talker says in code: one question, no empty praise,
    // no repeated opener, a short reply. A closing is not capped (its end token comes last). Its drops are counted, never logged.
    const guardOptions = { bannedPraise: BANNED_PRAISE_SRC, recentOpeners: [...this.humane.openers, ...(isFiller ? pieces : [])], maxWords: instruction === TIME_UP ? null : GUARD_MAX_WORDS };
    let guard = !only && this.flags.replyGuard === 'on' ? new ReplyGuard(guardOptions) : null; // (a read-back replaces it with one that knows the facts)
    // Text travels with its audio and reaches the screen when that audio is actually sent for playback (pace()), so it
    // never shows words ATLAS has not started to say, and a withdrawn piece never appears.
    let pending = '';
    this.live = { item, text: '' };
    this.composing = { item, text: () => said, move: () => move }; // what this reply has composed so far: interrupt() keeps its question (captureQuestion)
    const show = text => { pending += text; };
    const release = () => { // text with no audio of its own
      if (!pending || gen !== this.gen || this.finished) return;
      this.push({ gen, item, bytes: new Uint8Array(0), text: pending }); pending = '';
    };
    // One piece of speech: its audio (being synthesised, or ready), sent for playback once the floor is hers.
    const deliver = async (sentence, synthesis, filler = false, lead = false) => {
      const pcm = await synthesis;
      // Never start talking over the consultant (or while their last words are still being transcribed), and leave
      // the extra beat after words that trail off. Any of these can end in a withdrawal (gen changes).
      while (!(only && this.paused) && (this.turnDetector.active || this.sttBusy > 0 || this.now() < notBefore) && gen === this.gen && !this.finished) await this.sleep(20); // (the pause line has nobody to wait for: the microphone is closed)
      if (!firstAudio) {
        firstAudio = this.now(); this.metric('reply', { first_text_ms: Math.round((firstText - t0) * 1000), first_audio_ms: Math.round((firstAudio - t0) * 1000) });
        // The measure of "answers too quick": the consultant's last sound to ATLAS's first sound (numbers only).
        if (endedAt && gen === this.gen) { gapMs = Math.round((this.now() - endedAt) * 1000); this.metric('reply_gap', { ms: gapMs, filler: isFiller ? 1 : 0, thinking: thinking ? 1 : 0 }); }
      }
      if (gen !== this.gen || this.finished) return;
      // The text of exactly this piece (and any separator before it), not the next sentence's first words already streamed.
      const at = pending.indexOf(sentence), cut = at >= 0 ? at + sentence.length : pending.length, piece = pending.slice(0, cut);
      pending = pending.slice(cut);
      for (let i = 0; i < pcm.length; i += CHUNK) this.push({ gen, item, bytes: pcm.subarray(i, Math.min(pcm.length, i + CHUNK)), text: i ? '' : piece, lead });
      if (filler) this.fillerMs[item] = (this.fillerMs[item] || 0) + pcm.length / 48; // the acknowledgement's own audio, not counted as her reply
    };
    // Pipelined: a piece is synthesised as soon as its text is complete, while the piece before it is still being
    // synthesised or waiting for the floor (at most SYNTH_AHEAD at once). Deliveries run strictly one after another, so
    // audio and text keep their order and every wait above applies to each piece exactly as before.
    let chain = Promise.resolve(); const inflight = [];
    const say = async piece => {
      const text = speakable(piece); // markup is never voiced; the screen keeps it
      if (!text) return; // nothing to say: its text goes out with the next piece (or release())
      const synthesis = this.synth(text, lang, true); synthesis.catch(() => {}); // a failure surfaces where it is delivered
      chain = chain.then(() => deliver(piece, synthesis)); chain.catch(() => {});
      inflight.push(chain);
      while (inflight.length >= SYNTH_AHEAD) await inflight.shift();
    };
    try {
      if (pieces.length) { // cached greeting or acknowledgement: audible within milliseconds, while the model prepares the rest
        if (!firstText) firstText = this.now();
        const before = this.sentMs[item] || 0, syntheses = pieces.map(p => this.synth(p, lang, true, true)); // every piece is synthesised (or cached) at once
        syntheses.forEach(x => x.catch(() => {}));
        for (let i = 0; i < pieces.length; i++) {
          show((i === 0 && this.replies > 1 ? '\n\n' : '') + pieces[i] + ' '); said += pieces[i] + ' ';
          await deliver(pieces[i], syntheses[i], isFiller, true); if (gen !== this.gen || this.finished) return;
          if (isFiller && ack) this.ackPlayed(ack);
          if (!isFiller && !only && i === 0) { // protect exactly the greeting's first piece: until the browser confirms it played (capped); the rest can be interrupted
            this.protectedItem = item; this.protectedMs = (this.sentMs[item] || 0) + this.queue.filter(c => c.item === item).reduce((n, c) => n + c.bytes.length, 0) / 48 - before;
            this.protectedDeadline = this.now() + this.protectedMs / 1000 + 3;
          }
        }
      }
      if (only) { // a pause line, a resume line, a question said again: the pieces are the whole reply
        await chain; release(); interrupted = gen !== this.gen;
        if (!interrupted && closeAfter && this.turns >= 1) this.wrapUp(item, gen);
        return;
      }
      // Optionally wait (ANALYST_WAIT_MS) for the analyst while the acknowledgement plays, then choose the move again from its plan.
      if (refine && move) {
        let better = null;
        try { better = await refine(move); } catch (e) { this.metric('selector_error', { name: e?.name || 'Error' }); }
        if (gen !== this.gen || this.finished) return;
        if (better) { this.swapMove(item, move, better); if (better.kind !== move.kind || better.intent !== move.intent) this.metric('move_refined', {}); move = better; }
      }
      const moveNote = move ? nextMoveNote(move) : '';
      // A read-back (the closing summary, or a mid-interview reflection): the talker gets a few facts from the ledger, nothing else to say, and the guard
      // blocks any figure that is not in them. The fixed question follows if the talker's own words never got to it.
      let readNote = '', readBack = null;
      if ((move?.kind === 'summary' || move?.kind === 'reflect') && this.ledger && this.capture) {
        readBack = await this.readBack(move, gen);
        if (gen !== this.gen || this.finished || !readBack) return;
        readNote = summaryNote(readBack.facts, readBack.unknowns, { reflect: readBack.reflect, question: clean(move.say, 400) });
        if (guard) guard = new ReplyGuard({ ...guardOptions, maxWords: readBack.reflect ? GUARD_MAX_WORDS : SUMMARY_MAX_WORDS, summaryFacts: [...readBack.facts, ...readBack.numbers] });
      }
      const notes = [...this.paceNotes(), moveNote, readNote, prefix ? (isFiller ? `ALREADY SAID (server): you have just said "${prefix}" out loud. Continue naturally from there; do not start with another short acknowledgement.`
        : `ALREADY SAID (server): you have just greeted the consultant with: "${prefix}". Do not repeat it or introduce yourself again.`) : ''];
      const guidance = instruction === TIME_UP || moveNote ? null : this.guidance, gap = this.mode === 'gap';
      // Gap mode: the ask this reply carries, fixed now that it is composed. A normal reply or the opening carries the plan's
      // ask; a reflect-back (the plan has no ask left) and the closing carry none, and once heard they close the answer
      // window, so a confirmation or a goodbye answers no ask. A re-ask after a noise leaves the window as it is; so does a
      // nudge while they are mid-answer, unless that reply goes on to ask a question: from it on, it carries the plan's ask.
      if (gap && (instruction === undefined || instruction === GAP_OPENING || instruction === TIME_UP)) this.askByItem.set(item, guidance?.askId ?? null);
      let asked = false;
      const carry = s => { if (gap && instruction === STILL_THINKING && !asked && /[?？]/.test(s)) { asked = true; this.askByItem.set(item, guidance?.askId ?? null); } };
      // First words fast (the first sentence, or a first clause of 40 characters), then whole phrases (speech.js Phrases).
      const phrases = new Phrases();
      // With the guard, only what it lets through is shown, voiced and remembered; without it, the talker's words as they come.
      const voice = async piece => {
        for (const run of guard.push(piece)) {
          const lead = !said ? (this.replies > 1 ? '\n\n' : '') : /\s$/.test(said) ? '' : ' ';
          show(lead + run); said += (said ? lead : '') + run; talker += (talker ? ' ' : '') + run; voiced += 1;
          carry(run); await say(run); if (gen !== this.gen) return;
        }
      };
      const stopped = () => !!guard?.done && (guard.stop === 'question' || marker.seen); // a cap still reads on, to find the end token
      for await (const raw of this.ai.chatStream(talkerMessages(this.project, guidance, this.history, instruction, notes, gap ? this.gapAsks : null), { affinity: this.affinity })) {
        if (gen !== this.gen || this.finished) return;
        if (raw && !firstToken) firstToken = this.now();
        const delta = marker.feed(raw);
        if (guard?.done) { if (stopped()) break; continue; } // the reply is complete: leaving the loop returns the stream, which stops the model
        if (!delta) continue;
        if (!firstText) firstText = this.now();
        if (guard) {
          for (const piece of phrases.feed(delta)) { await voice(piece); if (gen !== this.gen) return; if (guard.done) break; }
          if (stopped()) break;
        } else {
          show(!said && this.replies > 1 ? '\n\n' + delta : delta);
          said += delta;
          for (const piece of phrases.feed(delta)) { carry(piece); await say(piece); if (gen !== this.gen) return; }
        }
      }
      const rest = marker.flush(); // also where a closing token that ended the stream is recognised (even after a cap)
      if (!guard?.done) {
        if (guard) { if (gen === this.gen) for (const piece of [...(rest ? phrases.feed(rest) : []), ...phrases.flush()]) { await voice(piece); if (gen !== this.gen || guard.done) break; } }
        else {
          if (rest && gen === this.gen) { show(rest); said += rest; }
          if (gen === this.gen) for (const piece of [...phrases.feed(rest), ...phrases.flush()]) { carry(piece); await say(piece); }
        }
      }
      // The guard took everything (a lone repeated reaction, praise): ATLAS still asks the move's own question, never silence.
      if (guard && gen === this.gen && !voiced && move?.say && /[?？]/.test(move.say) && Object.values(guard.stats).some(n => n > 0)) {
        this.metric('reply_fallback', {});
        const lead = !said ? (this.replies > 1 ? '\n\n' : '') : /\s$/.test(said) ? '' : ' ';
        show(lead + move.say); said += (said ? lead : '') + move.say; talker = move.say; voiced += 1;
        carry(move.say); await say(move.say);
      }
      if (readBack && !readBack.reflect && gen === this.gen && !/[?？]/.test(said)) { // the read-back always ends in its question
        const lead = !said ? (this.replies > 1 ? '\n\n' : '') : /\s$/.test(said) ? '' : ' ';
        this.metric('summary_question_added', {});
        show(lead + SUMMARY_QUESTION); said += (said ? lead : '') + SUMMARY_QUESTION; talker += (talker ? ' ' : '') + SUMMARY_QUESTION; voiced += 1;
        await say(SUMMARY_QUESTION);
      }
      await chain; // every piece sent, or dropped by a withdrawal or an interruption
      release(); // anything left that produced no audio of its own
      interrupted = gen !== this.gen;
      // Backstop: a reply that still asks a question is not a closing, whatever token it carries (admin may end at will).
      const closes = instruction === TIME_UP || (marker.seen && (this.admin || !said.includes('?')));
      if (marker.seen && !closes) this.metric('end_ignored', {});
      if (!interrupted && (closes || closeAfter) && this.turns >= 1) this.wrapUp(item, gen);
    } finally {
      const text = said.trim();
      if (text && !this.discarded.has(item) && !this.recorded.has(item)) {
        // Stopped by anything other than interrupt()/withdraw()/end() (e.g. a voice failure): only what was voiced counts.
        const content = interrupted ? (this.live?.item === item ? this.live.text.trim() : '') && this.live.text.trim() + ' [cut off]' : text;
        if (content) { const entry = { role: 'assistant', content }; this.history.push(entry); this.committed = { item, entry }; }
      }
      if (guard) this.metric('reply_guard', { ...guard.stats, stopped: guard.done ? 1 : 0 });
      this.noteQuestion(item, said, move, interrupted);
      // Her leading reaction, for the repeated-opener rule of the next replies (a question is not a reaction).
      const [done, rest] = sentences(talker + ' '), lead = (done[0] || rest || '').trim();
      if (!only && lead && !/[?？]$/.test(lead) && lead.split(/\s+/).length <= OPENER_WORDS && !this.discarded.has(item)) { this.humane.openers.push(lead); if (this.humane.openers.length > 3) this.humane.openers.shift(); }
      this.checkpointSoon(); // the reply is part of the interview now (its question, the history)
      // One line per turn: where the time went between the consultant's last word and hers (numbers only; -1: not reached).
      if (timeline && !this.discarded.has(item)) this.metric('turn_timeline', { stt_ms: timeline.sttMs, selector_ms: timeline.selectorMs,
        first_token_ms: firstToken ? Math.round((firstToken - t0) * 1000) : -1, first_audio_ms: firstAudio ? Math.round((firstAudio - t0) * 1000) : -1, reply_gap_ms: gapMs });
    }
  }

  async wrapUp(item, gen) {
    // ATLAS closed the interview. Wait until the closing line has played (acknowledged playback, or wall-clock when the
    // browser sends no acknowledgements), then until the consultant is not mid-sentence. If they add something, the
    // conversation simply continues. Only then ask the browser to end through its normal End path.
    const turns = this.turns;
    for (let i = 0; i < 300 && gen === this.gen && !this.finished; i++) {
      const queued = this.queue.some(c => c.item === item), ahead = (this.sentMs[item] || 0) - (this.playedMs[item] || 0);
      if (!queued && (ahead <= 40 || this.now() >= this.nextTime + 0.3)) break;
      await this.sleep(100);
    }
    await this.sleep(400);
    for (let i = 0; i < 100 && (this.turnDetector.active || this.sttBusy > 0) && !this.finished; i++) await this.sleep(200);
    if (gen !== this.gen || this.finished || this.ending || this.turns !== turns) return;
    this.metric('wrap_up', { turns: this.turns });
    this.event('wrap_up', { message: 'ATLAS closed the interview. Preparing your report.' });
  }

  async report() {
    if (!this.ai.report || !this.ledger?.transcripts.size) return null;
    this.event('reporting', { message: 'Writing your interview report.' });
    const t0 = this.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), attempt === 1 ? 25000 : 15000); });
        // What the consultant asked to keep private never reaches the report: it is taken out of the conversation the report is written from.
        const kept = [...withheldQuotes(this.ledger), ...this.privateTexts()], history = kept.length ? this.history.map(m => ({ ...m, content: redact(m.content, kept) })) : this.history;
        const report = parseReport(await Promise.race([this.ai.report(reportMessages(history, this.ledger.notes(), this.ledger.stage)), timeout]));
        this.metric('report', { ms: Math.round((this.now() - t0) * 1000), ok: report ? 1 : 0, attempt });
        if (report) return report;
      } catch (e) { this.metric('report_error', { name: e?.message === 'timeout' ? 'Timeout' : e?.name || 'Error', attempt }); if (e?.message === 'timeout') return null; }
      finally { clearTimeout(timer); }
    }
    return null;
  }

  showText(item, text) {
    this.event('agent_text', { text });
    if (this.shown.item !== item) this.shown = { item, chars: 0 };
    this.shown.chars += text.length;
    if (this.live?.item === item) this.live.text += text;
  }

  push(chunk) { this.queue.push(chunk); if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }

  async pace() {
    // Real-time paced playback, identical to the Python route: 20 ms chunks, stale generations dropped.
    while (!this.finished) {
      if (!this.queue.length) { this.dry = true; await new Promise(r => { this.waiter = r; }); continue; }
      const { gen, item, bytes, text, lead } = this.queue.shift();
      if (gen !== this.gen) continue;
      if (bytes.length) { // underrun: the queue ran dry mid-reply, and more of the same reply came after her audio had run out
        // Only once the reply's own composed speech has started: the wait after a greeting or acknowledgement is planned.
        const gap = this.now() - this.nextTime;
        if (this.dry && item === this.composedItem && gap > UNDERRUN_S) this.metric('underrun', { gap_ms: Math.round(gap * 1000) });
        this.dry = false;
        if (!lead) this.composedItem = item;
      }
      // Bounded lead over acknowledged playback (browser ring buffer holds 350 ms). Without acknowledgements
      // (older clients, background tabs) fall back to wall-clock pacing after ~1 s of waiting.
      for (let wait = 0; wait < 50 && (this.sentMs[item] || 0) - (this.playedMs[item] || 0) > LEAD_MS && gen === this.gen && !this.finished; wait++) await this.sleep(20);
      if (gen !== this.gen || this.finished) continue;
      if (this.currentItem !== item) { this.currentItem = item; this.event('audio_turn', { item_id: item }); }
      if (text) this.showText(item, text);
      if (!bytes.length) continue;
      // Gap mode: the consultant starts hearing a reply that carries an ask (its first composed audio; a greeting or an
      // acknowledgement before it does not count). That is one attempt, and their next turns answer that ask. A reply that
      // carries none (a reflect-back, the closing) is no attempt and closes the window: their next turns answer no ask.
      if (this.askByItem.has(item)) {
        const id = this.askByItem.get(item); this.askByItem.delete(item);
        this.askHeard = { item, id, before: this.openAsk }; if (id) this.gapAttempts[id] = (this.gapAttempts[id] || 0) + 1; this.openAsk = id;
      }
      if (this.playbackDone) this.resumedAt = this.bytesIn; // where in the microphone stream her audio starts again
      this.io.sendBytes(bytes); this.playbackDone = false; this.spokenMs += bytes.length / 48; this.lastAudio = this.now(); this.sentMs[item] = (this.sentMs[item] || 0) + bytes.length / 48;
      this.nextTime = Math.max(this.nextTime, this.now()) + bytes.length / 48000;
      await this.sleep(Math.max(0, this.nextTime - this.now()) * 1000);
    }
  }

  // An error ends the interview, but one that can be resumed (a stored checkpoint) is suspended rather than lost: the same Durable Object's newer window,
  // a dropped connection and a failed microphone all come back through `resume`.
  fail(message, code) {
    if (this.finished || this.ending) return;
    this.event('error', { message, code });
    return this.end(false, { suspend: true });
  }

  // The connection dropped (worker.js calls this when the socket closes): the interview is kept for 24 hours and can be resumed. Without a checkpoint
  // store, without transcript consent, in gap mode or before the interview was under way it simply ends, as it always did.
  suspend() { return this.end(false, { suspend: true }); }

  // Resumable now: a live full interview of a person who consented to transcript capture, past the consent step, with a store to keep it in.
  checkpointable() { return !!this.checkpoint && this.capture === true && this.mode === 'full' && !!this.ledger && !!this.sessionId; }
  canSuspend() { return this.started && !this.finished && this.checkpointable() && SUSPENDABLE.includes(this.machine.state); }

  // Write the state to the store, one write at a time, at most one a second, and only for an interview that is checkpointable. Called after every
  // committed turn (the analyst's ledger entry, her reply).
  checkpointSoon() {
    if (!this.checkpointable() || !this.started || this.finished || this.ending || this.machine.terminal) return; // a finished interview (confirmed, withdrawn) is never stored
    this.ckptDirty = true;
    if (this.ckptRun) return;
    this.ckptRun = (async () => {
      await this.sleep(CHECKPOINT_DEBOUNCE_MS);
      while (this.ckptDirty && !this.finished && !this.ending && !this.machine.terminal) { this.ckptDirty = false; await this.saveCheckpoint(); }
    })().finally(() => { this.ckptRun = null; });
  }
  async saveCheckpoint() {
    if (this.machine.terminal) return;
    // Absolute expiry (L6): 24 hours from the first write, however many reconnects came between. Past it nothing is written, and what is stored is deleted.
    if (this.capturedAt !== null && this.now() * 1000 >= this.capturedAt + TTL_MS) { this.metric('checkpoint_expired', {}); await this.checkpoint.purge().catch(() => {}); return; }
    const t0 = this.now();
    try { const r = await this.checkpoint.save(serialize(this)); this.capturedAt = r.capturedAt ?? this.capturedAt; this.metric('checkpoint', { ms: Math.round((this.now() - t0) * 1000), bytes: r.bytes, chunks: r.chunks }); }
    catch (e) { this.metric('checkpoint_error', { name: e?.code || e?.name || 'Error' }); } // a failed write never stops the interview
  }
  async purgeCheckpoint() {
    if (!this.checkpoint) return false;
    if (this.ckptRun) await this.ckptRun.catch(() => {}); // never while a write is in flight
    try { await this.checkpoint.purge(); return true; } catch { this.metric('checkpoint_error', { name: 'purge' }); return false; }
  }

  // end(clean): the interview is over (notes, report), a discard, or an error. end(false, {suspend: true}): leave it resumable.
  end(clean, { suspend = false } = {}) {
    // One end per session: every later call (watch() at the wall cap, a socket close, a second End) shares this one.
    if (this.ending) return this.ending;
    const keep = suspend && this.canSuspend();
    this.ending = (async () => {
      // A reply cut off by the drop still asked its question: what she had said of it is kept, and a move she never got to say is not in the asked log.
      if (keep) { this.captureQuestion(); this.recordLive(' [cut off when the connection dropped]'); this.uncommit(this.replyItem, true); }
      else this.recordLive(' [cut off when the interview ended]');
      if (clean || keep) this.finalWords();
      this.gen += 1; clearInterval(this.timer); this.queue = [];
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
      if (clean || keep) {
        await Promise.race([this.sttChain, this.sleep(keep ? 3000 : 8000)]); // the consultant's last words are still being transcribed
        if (this.pending.size) await Promise.race([Promise.allSettled([...this.pending]), this.sleep(keep ? 5000 : 10000)]);
      }
      if (keep) { // the state machine records the loss, then the whole state is written once more (after any write in flight)
        if (this.ckptRun) await this.ckptRun.catch(() => {});
        if (this.machine.state !== 'suspended') this.fireState('disconnect', 'system');
        await this.saveCheckpoint();
      }
      this.finished = true;
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
      if (keep) { this.metric('suspend', { turns: this.turns, paused: this.paused ? 1 : 0 }); this.io.close(); return; }
      this.event('audio_stopped');
      if (clean && this.capture && this.ledger) {
        // Gap mode writes no report: its answers go back only through the consultant's explicit clicks (§F2.1 step 6).
        const gap = this.mode === 'gap', report = gap ? null : await this.report();
        const asr = this.asrNotes();
        const priv = this.privateItems(), whole = [...this.ledger.transcripts].map(([item, text]) => priv.has(item) ? PRIVATE_MARK : text);
        this.event('notes', { transcript: redact(whole.join('\n\n'), withheldQuotes(this.ledger)), sections: this.ledger.notes(), status: 'candidate', report, mode: this.mode,
          ...(Object.keys(asr).length ? { asr } : {}),
          ...(gap ? { gap: { requestId: this.gapRequest, results: this.gapResults() } } : {}),
          message: 'Unverified speech recognition and quote-linked candidate notes. Correct omissions and errors before adding to the project. The final cut-off utterance may be incomplete.' });
      } else if (clean) this.event('notes', { transcript: '', sections: null, status: 'not-enabled', mode: this.mode, message: 'Transcript capture was off. No consultant notes were stored.' });
      // Finished, thrown away, or ended without being suspendable (a confirmed summary whose goodbye was cut by the drop, a failure in a terminal state):
      // nothing of it is kept. Only a suspend leaves a checkpoint (and a session that never started leaves what is stored alone: it may be the resumable one).
      if (clean || this.discarding || this.started) await this.purgeCheckpoint();
      this.event('ended', { message: 'Microphone and voice service closed.' });
      this.io.close();
    })();
    return this.ending;
  }
}
