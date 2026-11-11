// One live interview, platform-independent (driven by the Durable Object in worker.js, tested in Node).
// Same browser protocol as atlas_voice/cascade.py, so the compiled ATLAS page, worklet and orb work unchanged:
// the orb moves only from PCM this session actually sends for playback.
import { TALKER_POLICY, OPENING, HISTORY, TOPICS, ADMIN_NOTE, SPEAKING_LIMIT_S, INTERVIEW_LIMIT_S, WRAP_S, TIME_UP, AREAS, TIME_PLAN, TIME_UP_MESSAGE, FIELDS,
  GAP_LIMIT_S, GAP_SPEAKING_S, GAP_WRAP_S, GAP_MAX, GAP_OPENING, WIN_HINTS } from './policy.generated.js';
import { gapSystemBlock, gapNotes, gapStatus, gapGuidance, timePlan } from './gap-policy.js';
import { Analyst, InterviewLedger } from './ledger.js';
import { EnergyTurns, isEcho, Phrases, speakable } from './speech.js';
import { EndMarker, parseReport, reportMessages } from './report.js';
import { LANGUAGES, normalize, spokenFor, languageNote, GREETINGS, WELCOME_BACK, FILLERS, unfinished } from './languages.js';
import { budgetRefused } from './meter.js';
import { BUDGET_MESSAGE, budgetOutcome } from './budget-stop.js';

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
export const SYNTH_AHEAD = 2; // pieces of one reply being synthesised (or waiting to be sent) at once
export const UNDERRUN_S = 0.02; // a gap in her audio longer than one chunk counts as an underrun
// Synthesised audio for short fixed phrases (greetings, acknowledgements), shared by every session in this isolate.
const PCM_CACHE = new Map(), PCM_CACHE_BYTES = 12 * 1024 * 1024; let pcmCacheSize = 0;
function cacheGet(key) { const v = PCM_CACHE.get(key); if (v) { PCM_CACHE.delete(key); PCM_CACHE.set(key, v); } return v; }
function cacheSet(key, pcm) {
  if (PCM_CACHE.has(key) || pcm.length > 1024 * 1024) return;
  PCM_CACHE.set(key, pcm); pcmCacheSize += pcm.length;
  for (const [k, v] of PCM_CACHE) { if (pcmCacheSize <= PCM_CACHE_BYTES) break; PCM_CACHE.delete(k); pcmCacheSize -= v.length; }
}
export const pcmCacheStats = () => ({ entries: PCM_CACHE.size, bytes: pcmCacheSize });
export function clearPcmCache() { PCM_CACHE.clear(); pcmCacheSize = 0; }
export { SPEAKING_LIMIT_S, TIME_UP };
export const MAX_SECONDS = INTERVIEW_LIMIT_S; // the whole interview (15 minutes); ATLAS's own speaking time is a second cap inside it
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
const START_KEYS = ['type', 'csrf', 'consent', 'project', 'voice', 'capture', 'memory', 'language', 'gap'];
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
  const untrusted = 'UNTRUSTED PROJECT DATA:\n' + JSON.stringify(project) + (gaps?.length ? gapSystemBlock(gaps) : '') + '\nUNTRUSTED PRIVATE PREFERENCES (not evidence):\n';
  const messages = [{ role: 'system', content: TALKER_POLICY }, { role: 'user', content: untrusted }];
  messages.push(...history.slice(-HISTORY));
  if (guidance) messages.push({ role: 'system', content: 'ANALYST_GUIDANCE (server plan, not a script): ' + JSON.stringify(guidance) });
  for (const note of notes) if (note) messages.push({ role: 'system', content: note });
  if (instruction) messages.push({ role: 'user', content: instruction });
  return messages;
}

const joinPcm = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const same = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export class Session {
  /** io: {send(obj), sendBytes(u8), close()}; ai: {transcribe(pcm), synthesize(text), chatStream(messages), analyst(messages)} */
  // gaps: async id => {asks, bidAlias, referenceId, projectId} | null (the verified assignee's open gap request);
  // winHint: async () => ({hint: 'quantified'|'confirmed'|null}) | null (aggregate win-loop guidance, never awaited).
  constructor({ io, ai, csrf, voice, voices = null, captureRequired = false, model, maxSeconds = MAX_SECONDS, admin = false, memory = null, speakingLimit = SPEAKING_LIMIT_S, now = () => Date.now() / 1000, sleep = ms => new Promise(r => setTimeout(r, ms)), metric = () => {}, sttTimeout = STT_TIMEOUT_MS,
    gaps = null, winHint = null, gapTimeout = GAP_RESOLVE_MS }) {
    // metric(name, numbers): timings and counts only, never transcript or project content.
    Object.assign(this, { io, ai, csrf, voice, voices: voices || [voice], captureRequired, model, maxSeconds, admin, speakingLimit, now, sleep, metric, memory, sttTimeout, gaps, winHint, gapTimeout });
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

  async onText(text) {
    let value;
    try { value = JSON.parse(text); } catch { return this.fail('Unsupported client event', 'voice-contract'); }
    if (this.starting) { // a gap request is being resolved: only leaving is allowed (never a second start)
      const leave = value && typeof value === 'object' && Object.keys(value).length === 1 && (value.type === 'discard' || value.type === 'end');
      return leave ? this.end(false) : this.fail('Unsupported client event', 'voice-contract');
    }
    if (!this.started) return this.start(value);
    if (value?.type === 'end' && Object.keys(value).length === 1) return this.end(true);
    if (value?.type === 'discard' && Object.keys(value).length === 1) return this.end(false);
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
        // The short greeting is not interruptible (room noise must not cut the introduction); everything after it is.
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
    else if (b) this.queueTranscription(b.pcm, { continuing: b.continuing, echoable: b.echoable, endedBy: 'limit', endedAt: b.endedAt });
    if (!d.active) return;
    const endedAt = this.now() - d.quiet, pcm = d.flush();
    this.pause = '';
    if (pcm && this.voiced >= MIN_VOICED) this.queueTranscription(pcm, { ...this.takeUtterance(), endedBy: 'limit', endedAt });
  }

  closeBlip() {
    const d = this.turnDetector, endedAt = this.now() - d.quiet, pcm = d.flush();
    this.pause = '';
    this.blip = pcm ? { pcm, voiced: this.voiced, at: this.now(), endedAt, ...this.takeUtterance() } : null;
    this.metric('blip', {});
  }

  // Nothing followed the short sound. If ATLAS is not talking, it may have been a short answer ("No."): transcribe it;
  // a click transcribes to nothing and changes nothing.
  expireBlip() {
    const b = this.blip;
    if (!b || this.sttBusy > 0) return; // wait for the transcript in flight: it decides whether ATLAS answers
    this.blip = null;
    if (this.busy() || this.ending) return;
    this.queueTranscription(b.pcm, { continuing: b.continuing, echoable: b.echoable, endedBy: 'silence', endedAt: b.endedAt });
  }

  endTurn(endedBy) {
    const endedAt = this.now() - this.turnDetector.quiet; // before flush(), which clears the silence count
    const utterance = this.turnDetector.flush();
    this.pause = '';
    if (utterance) this.queueTranscription(utterance, { ...this.takeUtterance(), endedBy, endedAt, blip: this.voiced < MIN_VOICED });
  }

  queueTranscription(pcm, how = {}) {
    this.sttBusy += 1;
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
      if (!this.voices.includes(init.voice ?? this.voice)) throw new Error('Unsupported voice');
      this.voice = init.voice ?? this.voice;
      this.capture = init.capture === true;
      this.language = normalize(init.language) || 'en'; // the browser's language opens the conversation
      if (this.captureRequired && !this.capture) throw new Error('Transcription consent is required for this interview');
      if (init.gap !== undefined && (typeof init.gap !== 'string' || !GAP_ID.test(init.gap) || !this.gaps)) throw new Error(GAP_UNAVAILABLE);
    } catch (e) { return this.fail(e.message, 'voice-contract'); }
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
    this.started = true; this.startedAt = this.lastInput = this.now();
    const stage = this.project.stage || 'Unknown';
    this.analyst = this.capture ? new Analyst(messages => this.ai.analyst(messages), stage) : null;
    this.ledger = this.analyst ? this.analyst.ledger : new InterviewLedger(stage);
    this.event('ready', { model: 'ATLAS', provider: 'ATLAS voice', sampleRate: 24000, speakingSeconds: this.speakingLimit, capture: this.capture, liveLedger: !!this.analyst,
      maxSeconds: this.maxSeconds, message: 'Voice session ready. Speak naturally. Candidate notes require your review.',
      mode: this.mode, timePlan: timePlan(this.maxSeconds, this.mode), ...(gap ? { gaps: this.gapAsks.map(({ id, label, ask }) => ({ id, label, ask })) } : {}) });
    if (this.memory && !gap) { // private memory from earlier conversations, bounded so the greeting is never held up (none in gap mode)
      let timer;
      try { this.memoryNote = await Promise.race([this.memory(this.project), new Promise(r => { timer = setTimeout(() => r(''), 3500); })]) || ''; }
      catch (e) {
        this.memoryNote = '';
        const stop = budgetOutcome(e);
        if (stop) { this.memoryStop = stop; this.metric('spend_cap', { reason: 'exhausted:usd' }); }
        else this.metric('memory_error', {});
      }
      finally { clearTimeout(timer); }
      if (this.finished || this.ending) return; // closed while recalling: no timer, no opening
      this.event('memory', this.memoryStop
        ? { status: 'budget_exhausted', message: this.memoryStop.message }
        : { status: this.memoryNote ? 'recalled' : 'empty', message: this.memoryNote ? 'ATLAS remembers your earlier conversations (private to you).' : 'No earlier conversations to recall.' });
    }
    this.timer = setInterval(() => this.watch(), 1000);
    this.pace();
    const lang = this.spoken();
    if (gap) { // the first open ask, after the usual greeting (always spoken, admin included: Tony, 2026-10-02)
      this.guidance = gapGuidance(this.gapAsks, this.gapStatuses());
      this.startReply(GAP_OPENING, { prefix: GREETINGS[lang] || '' });
    } else this.startReply(OPENING, { prefix: (this.memoryNote ? WELCOME_BACK[lang] : GREETINGS[lang]) || '' });
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
    const left = this.maxSeconds - (this.now() - this.startedAt);
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

  interrupt() {
    this.recordLive();
    this.stopped();
    this.protectedItem = null; // nothing protected is playing any more
    this.gen += 1; this.queue = [];
    this.event('clear_audio');
  }

  async transcribe(pcm, { continuing = false, echoable = true, endedBy = '', endedAt = this.now(), blip = false } = {}) {
    if (this.finished) return;
    let text = '';
    const t0 = this.now();
    let heardIn = null, timer;
    if (blip) this.metric('blip', {}); // a click or a breath: no words to transcribe
    else try {
      const heard = await Promise.race([this.ai.transcribe(pcm), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'Timeout' })), this.sttTimeout); })]);
      text = (typeof heard === 'string' ? heard : heard?.text || '').trim(); heardIn = typeof heard === 'string' ? null : heard?.language || null;
      this.metric('stt', { ms: Math.round((this.now() - t0) * 1000), audio_ms: Math.round(pcm.length / 48), words: text ? text.split(/\s+/).length : 0 });
    } catch (e) {
      if (budgetRefused(e)) { this.metric('spend_cap', { reason: String(e.reason || 'refused').slice(0, 40) }); clearTimeout(timer); return this.fail(BUDGET_MESSAGE, 'voice-unavailable', { budget: true }); }
      // A failed (or hung) transcription counts as no words: whatever was waiting on it (a held answer, a re-ask) still happens.
      this.metric('stt_error', { name: e?.name || 'Error' }); this.event('quality_warning', { message: 'A speech segment could not be transcribed. Please repeat it or add it to your notes.' }); text = ''; heardIn = null;
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
    const lang = heardIn || this.language, how = { endedBy, endedAt, lang };
    if (text) { this.cutOff = false; await this.finishTurn(text, continuing, how); }
    // No words. Unless the consultant is already speaking again (that utterance will decide): answer what they said
    // before a noise, or re-ask after a noise that cut ATLAS off.
    else if (this.continuing || this.sttBusy > 1 || this.busy()) return;
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
    if (!merge && !closing && this.busy()) this.interrupt();
    this.turns += 1;
    if (this.turns > 300) return this.fail('Turn budget reached; end and start a new focused session', 'voice-contract');
    const ident = 'user-' + this.turns;
    if (merge) { this.history[this.history.length - 1] = { role: 'user', content: this.history.at(-1).content + ' ' + text }; this.metric('turn_merged', {}); }
    else this.history.push({ role: 'user', content: text });
    // Gap mode: the turn joins its ask's answer window, and the plan moves on at once (the reply about to be composed
    // must carry the next ask, not wait for the analyst).
    if (this.mode === 'gap') { this.recordAnswer(text, merge); this.guidance = gapGuidance(this.gapAsks, this.gapStatuses()); }
    if (this.capture) {
      this.event('user_text', { item_id: ident, text, provenance: 'unverified_speech_recognition' });
      const a0 = this.now();
      const job = this.analyst.hear(ident, text).then(async result => {
        this.metric('analyst', { ms: Math.round((this.now() - a0) * 1000), ok: result.analyst_status === 'analysed' ? 1 : 0, details: result.candidate_details.length, rejected: result.rejected_proposals });
        if (this.mode === 'gap') return this.gapQuality(result);
        let chosen = result.guidance, monthStop = result.analyst_status === 'budget_exhausted';
        if (this.ai.rankProbe && result.analyst_status === 'analysed') {
          const j0 = this.now();
          try { const better = await this.ai.rankProbe(result, chosen); this.metric('jev', { ms: Math.round((this.now() - j0) * 1000), override: better ? 1 : 0 }); if (better) chosen = better; }
          catch (e) { this.metric('jev_error', { name: e?.name || 'Error' }); if (budgetOutcome(e)) monthStop = true; } // JEV unavailable: keep the ledger's own choice, and say so when the month stopped it
        }
        this.guidance = chosen;
        const { guidance, ...rest } = result;
        this.event('quality', rest);
        if (monthStop) this.event('quality_warning', { message: BUDGET_MESSAGE });
        else if (result.analyst_status !== 'analysed') this.event('quality_warning', { message: 'The evidence analyst did not respond for this turn. The answer is kept; review it in the notes.' });
      }).catch(() => this.event('quality_warning', { message: 'This turn exceeded the transcript budget and was not added to the evidence ledger.' }));
      this.pending.add(job); job.finally(() => this.pending.delete(job));
    }
    if (closing) return;
    if (this.continuing && this.turnDetector.active && this.voiced >= MIN_VOICED) return; // already speaking again: answer when they have finished
    this.answer(this.history.at(-1).content, how);
  }

  // Gap mode, after the analyst: no JEV rankProbe (it never reorders asks). The plan is recomputed from the windows and the
  // ledger's details, and the quality event names the current ask in every question field, so the story board never shows
  // a full-mode question during a gap interview.
  gapQuality(result) {
    const { guidance, ...rest } = result, statuses = this.gapStatuses(), g = gapGuidance(this.gapAsks, statuses);
    this.guidance = g;
    this.event('quality', { ...rest, next_field: g.field, next_question: g.question, planned_question: g.question, why_this_question: g.why, next_action: g.action, gap_status: statuses });
    if (result.analyst_status !== 'analysed') this.event('quality_warning', { message: result.analyst_status === 'budget_exhausted' ? BUDGET_MESSAGE : 'The evidence analyst did not respond for this turn. The answer is kept; review it in the notes.' });
  }

  // Reply to the consultant's latest turn. A thought left hanging (the turn model heard it unfinished, or the words
  // trail off) gets room, then at most a gentle nudge the talker chooses; never an acknowledgement or a new question.
  // Timed from the consultant's last sound (endedAt), so the wait does not depend on how fast speech recognition was.
  answer(text, { endedBy = '', endedAt = this.now(), lang = this.language } = {}) {
    const trailing = unfinished(text, lang);
    // Admin (Tony) gets the same patience, without the nudge or an acknowledgement.
    if (this.admin) return this.startReply(undefined, { turn: this.turns, endedAt, notBefore: trailing && endedBy !== 'thinking' ? endedAt + THINKING_PAUSE : 0 });
    if (endedBy !== 'thinking' && !trailing) return this.startReply(undefined, { filler: this.pickFiller(text), turn: this.turns, endedAt });
    this.metric('still_thinking', { by: endedBy === 'thinking' ? 1 : 0 });
    this.startReply(STILL_THINKING, { notBefore: endedBy === 'thinking' ? 0 : endedAt + THINKING_PAUSE, turn: this.turns, endedAt, thinking: true });
  }

  spoken() { return spokenFor(this.language, l => (this.ai.speaks ? this.ai.speaks(l) : l === 'en')); }
  // Per-turn server notes. Full: [admin, language, memory, win hint, pace] (identical to before when there is no hint).
  // Gap: [admin, GAP_NOTE, gap pace (open items by label)] then language and the win hint; there is no memory in gap mode.
  paceNotes() {
    const lang = languageNote(this.language, this.spoken()), elapsed = this.now() - this.startedAt;
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
  async synth(text, lang, measure = false) {
    const key = lang + '|' + this.voice + '|' + text, cached = text.length <= 220 ? cacheGet(key) : null, t0 = this.now();
    const pcm = cached || await this.ai.synthesize(text, this.voice, lang);
    if (!cached && text.length <= 220) cacheSet(key, pcm);
    if (measure) this.metric('tts', { ms: cached ? 0 : Math.round((this.now() - t0) * 1000), audio_ms: Math.round(pcm.length / 48), chars: text.length, cached: cached ? 1 : 0 });
    return pcm;
  }

  prewarm() { // fill the cache for this language's acknowledgements without delaying anything
    const lang = this.spoken();
    for (const f of FILLERS[lang] || []) this.synth(f, lang).catch(() => {});
  }

  startReply(instruction, { prefix = '', filler = '', notBefore = 0, turn = -1, endedAt = 0, thinking = false } = {}) {
    if (this.ending || this.finished) return;
    // Re-checked on every reply: an interrupted closing (or a noise re-ask) cannot escape the time limits. With wrapS
    // (WRAP_S, or GAP_WRAP_S in gap mode) left of the interview, or ATLAS's own speaking time used up, the next reply is the closing.
    const late = this.now() - this.startedAt >= this.maxSeconds - this.wrapS;
    if (instruction !== OPENING && instruction !== GAP_OPENING && this.turns >= 1 && (late || this.spokenMs >= this.speakingLimit * 1000)) {
      if (!this.timeUp) { this.timeUp = true; this.metric(late ? 'interview_limit' : 'speaking_limit', { turns: this.turns }); }
      instruction = TIME_UP;
    }
    this.replies += 1;
    const item = 'agent-' + this.replies, gen = ++this.gen;
    this.replyItem = item; this.replyTurn = turn; this.replyGen = gen;
    const run = this.speak(item, gen, instruction, prefix || filler, !!filler, notBefore, endedAt, thinking).catch(e => {
      this.metric('reply_error', { name: e?.name || 'Error' });
      if (budgetRefused(e)) return this.fail(BUDGET_MESSAGE, 'voice-unavailable', { budget: true });
      if (!this.finished && gen === this.gen) this.event('error', { message: 'The voice reply failed. No fallback voice was used.', code: 'voice-unavailable' });
    });
    this.speaking = run;
    run.finally(() => { if (this.speaking === run) this.speaking = null; });
  }

  async speak(item, gen, instruction, prefix = '', isFiller = false, notBefore = 0, endedAt = 0, thinking = false) {
    let said = '', interrupted = true, firstText = 0, firstAudio = 0;
    const lang = this.spoken(); // one voice per reply, even if the consultant switches mid-reply
    const marker = new EndMarker(); // the talker's end-of-interview token is never spoken or shown
    const t0 = this.now();
    // Text travels with its audio and reaches the screen when that audio is actually sent for playback (pace()), so it
    // never shows words ATLAS has not started to say, and a withdrawn piece never appears.
    let pending = '';
    this.live = { item, text: '' };
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
      while ((this.turnDetector.active || this.sttBusy > 0 || this.now() < notBefore) && gen === this.gen && !this.finished) await this.sleep(20);
      if (!firstAudio) {
        firstAudio = this.now(); this.metric('reply', { first_text_ms: Math.round((firstText - t0) * 1000), first_audio_ms: Math.round((firstAudio - t0) * 1000) });
        // The measure of "answers too quick": the consultant's last sound to ATLAS's first sound (numbers only).
        if (endedAt && gen === this.gen) this.metric('reply_gap', { ms: Math.round((this.now() - endedAt) * 1000), filler: isFiller ? 1 : 0, thinking: thinking ? 1 : 0 });
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
      chain = chain.then(() => deliver(piece, synthesis));
      chain.catch(e => { if (budgetRefused(e)) this.fail(BUDGET_MESSAGE, 'voice-unavailable', { budget: true }); });
      inflight.push(chain);
      while (inflight.length >= SYNTH_AHEAD) await inflight.shift();
    };
    try {
      if (prefix) { // cached greeting or acknowledgement: audible within milliseconds, while the model prepares the rest
        if (!firstText) firstText = this.now();
        show((this.replies > 1 ? '\n\n' : '') + prefix + ' '); said = prefix + ' ';
        const before = this.sentMs[item] || 0;
        await deliver(prefix, this.synth(prefix, lang, true), isFiller, true); if (gen !== this.gen || this.finished) return;
        if (!isFiller) { // protect exactly the greeting's audio: until the browser confirms it played (capped)
          this.protectedItem = item; this.protectedMs = (this.sentMs[item] || 0) + this.queue.filter(c => c.item === item).reduce((n, c) => n + c.bytes.length, 0) / 48 - before;
          this.protectedDeadline = this.now() + this.protectedMs / 1000 + 3;
        }
      }
      const notes = [...this.paceNotes(), prefix ? (isFiller ? `ALREADY SAID (server): you have just said "${prefix}" out loud. Continue naturally from there; do not start with another short acknowledgement.`
        : `ALREADY SAID (server): you have just greeted the consultant with: "${prefix}". Do not repeat it or introduce yourself again.`) : ''];
      const guidance = instruction === TIME_UP ? null : this.guidance, gap = this.mode === 'gap';
      // Gap mode: the ask this reply carries, fixed now that it is composed. A normal reply or the opening carries the plan's
      // ask; a reflect-back (the plan has no ask left) and the closing carry none, and once heard they close the answer
      // window, so a confirmation or a goodbye answers no ask. A re-ask after a noise leaves the window as it is; so does a
      // nudge while they are mid-answer, unless that reply goes on to ask a question: from it on, it carries the plan's ask.
      if (gap && (instruction === undefined || instruction === GAP_OPENING || instruction === TIME_UP)) this.askByItem.set(item, guidance?.askId ?? null);
      let asked = false;
      const carry = s => { if (gap && instruction === STILL_THINKING && !asked && /[?？]/.test(s)) { asked = true; this.askByItem.set(item, guidance?.askId ?? null); } };
      // First words fast (the first sentence, or a first clause of 40 characters), then whole phrases (speech.js Phrases).
      const phrases = new Phrases();
      for await (const raw of this.ai.chatStream(talkerMessages(this.project, guidance, this.history, instruction, notes, gap ? this.gapAsks : null), { affinity: this.affinity })) {
        if (gen !== this.gen || this.finished) return;
        const delta = marker.feed(raw);
        if (!delta) continue;
        if (!firstText) firstText = this.now();
        show(!said && this.replies > 1 ? '\n\n' + delta : delta);
        said += delta;
        for (const piece of phrases.feed(delta)) { carry(piece); await say(piece); if (gen !== this.gen) return; }
      }
      const rest = marker.flush();
      if (rest && gen === this.gen) { show(rest); said += rest; }
      if (gen === this.gen) for (const piece of [...phrases.feed(rest), ...phrases.flush()]) { carry(piece); await say(piece); }
      await chain; // every piece sent, or dropped by a withdrawal or an interruption
      release(); // anything left that produced no audio of its own
      interrupted = gen !== this.gen;
      // Backstop: a reply that still asks a question is not a closing, whatever token it carries (admin may end at will).
      const closes = instruction === TIME_UP || (marker.seen && (this.admin || !said.includes('?')));
      if (marker.seen && !closes) this.metric('end_ignored', {});
      if (!interrupted && closes && this.turns >= 1) this.wrapUp(item, gen);
    } finally {
      const text = said.trim();
      if (text && !this.discarded.has(item) && !this.recorded.has(item)) {
        // Stopped by anything other than interrupt()/withdraw()/end() (e.g. a voice failure): only what was voiced counts.
        const content = interrupted ? (this.live?.item === item ? this.live.text.trim() : '') && this.live.text.trim() + ' [cut off]' : text;
        if (content) { const entry = { role: 'assistant', content }; this.history.push(entry); this.committed = { item, entry }; }
      }
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
        const report = parseReport(await Promise.race([this.ai.report(reportMessages(this.history, this.ledger.notes(), this.ledger.stage)), timeout]));
        this.metric('report', { ms: Math.round((this.now() - t0) * 1000), ok: report ? 1 : 0, attempt });
        if (report) return report;
      } catch (e) {
        const stop = budgetOutcome(e);
        this.metric('report_error', { name: stop ? 'BudgetExhausted' : e?.message === 'timeout' ? 'Timeout' : e?.name || 'Error', attempt });
        if (stop) { this.reportStop = stop; return null; }
        if (e?.message === 'timeout') return null;
      }
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

  fail(message, code, extra) {
    if (this.finished || this.ending) return;
    this.event('error', extra ? { message, code, ...extra } : { message, code });
    return this.end(false);
  }

  end(clean) {
    // One end per session: every later call (watch() at the wall cap, a socket close, a second End) shares this one.
    if (this.ending) return this.ending;
    this.ending = (async () => {
      this.recordLive(' [cut off when the interview ended]');
      if (clean) this.finalWords();
      this.gen += 1; clearInterval(this.timer); this.queue = [];
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
      if (clean) {
        await Promise.race([this.sttChain, this.sleep(8000)]); // the consultant's last words are still being transcribed
        if (this.pending.size) await Promise.race([Promise.allSettled([...this.pending]), this.sleep(10000)]);
      }
      this.finished = true;
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
      this.event('audio_stopped');
      if (clean && this.capture && this.ledger) {
        // Gap mode writes no report: its answers go back only through the consultant's explicit clicks (§F2.1 step 6).
        const gap = this.mode === 'gap', report = gap ? null : await this.report();
        this.event('notes', { transcript: [...this.ledger.transcripts.values()].join('\n\n'), sections: this.ledger.notes(), status: 'candidate', report, mode: this.mode,
          ...(gap ? { gap: { requestId: this.gapRequest, results: this.gapResults() } } : {}),
          ...(!report && this.reportStop ? { budgetMessage: this.reportStop.message } : {}),
          message: 'Unverified speech recognition and quote-linked candidate notes. Correct omissions and errors before adding to the project. The final cut-off utterance may be incomplete.' });
      } else if (clean) this.event('notes', { transcript: '', sections: null, status: 'not-enabled', mode: this.mode, message: 'Transcript capture was off. No consultant notes were stored.' });
      this.event('ended', { message: 'Microphone and voice service closed.' });
      this.io.close();
    })();
    return this.ending;
  }
}
