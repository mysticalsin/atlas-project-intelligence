// One live interview, platform-independent (driven by the Durable Object in worker.js, tested in Node).
// Same browser protocol as atlas_voice/cascade.py, so the compiled ATLAS page, worklet and orb work unchanged:
// the orb moves only from PCM this session actually sends for playback.
import { TALKER_POLICY, OPENING, HISTORY, TOPICS, ADMIN_NOTE, SPEAKING_LIMIT_S, TIME_UP, AREAS } from './policy.generated.js';
import { Analyst, InterviewLedger } from './ledger.js';
import { EnergyTurns, isEcho, sentences } from './speech.js';
import { EndMarker, parseReport, reportMessages } from './report.js';
import { LANGUAGES, normalize, spokenFor, languageNote } from './languages.js';

export const RESUME = '[The consultant made a sound but no words were recognised, and your last reply was cut off.] Briefly re-ask your last question in fresh words.';

const CHUNK = 960; // 20 ms of 24 kHz PCM16
export { SPEAKING_LIMIT_S, TIME_UP };
export const MAX_SECONDS = 2700; // whole-call safety cap; the real limit is ATLAS's own speaking time
// Parity-tested port of atlas_voice.cascade.pace_notes: speaking time used and areas with no notes (names only, never content).
export function paceNotes(spokenMs, limitS, notes, admin = false) {
  const used = spokenMs / 1000, missing = AREAS.filter((_, i) => !notes[i]);
  let pace = `INTERVIEW PACE (server): about ${Math.floor(used / 60)} of ${Math.floor(limitS / 60)} minutes of your speaking time used.`;
  pace += missing.length ? ' Next uncovered area: ' + missing[0] + '.' : ' Every area has an answer: go deeper only on the one or two claims that matter most.';
  if (limitS - used <= 90) pace += ' Time is nearly up: ask only the single most important remaining question, or begin to wrap up.';
  return [admin ? ADMIN_NOTE : '', pace];
}
export const LEAD_MS = 300; // max audio sent ahead of what the browser has played
const START_KEYS = ['type', 'csrf', 'consent', 'project', 'voice', 'capture', 'memory', 'language'];

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  value = value.replace(/<\s*\/?\s*system\s*>/gi, '[quoted tag]');
  return [...value].filter(c => c.codePointAt(0) >= 32 || c === '\n' || c === '\t').join('').trim().slice(0, limit);
}

// Port of atlas_voice/interview.py project_context: untrusted, bounded, no identity fields.
export function projectContext(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Project context must be an object.');
  if (Object.keys(raw).some(k => !['id', 'title', 'consultant', 'role', 'sector', 'stage', 'answers'].includes(k))) throw new Error('Unexpected project fields. Identity and memory banks are server-owned.');
  const result = {};
  for (const [k, n] of [['id', 100], ['title', 160], ['consultant', 100], ['role', 120], ['sector', 100], ['stage', 60]]) result[k] = clean(raw[k], n);
  if (!result.title) throw new Error('Create a project before starting an interview.');
  const answers = raw.answers ?? [];
  if (!Array.isArray(answers) || answers.length > 6 || answers.some(x => typeof x !== 'string')) throw new Error('Expected at most six answer strings.');
  result.prior_notes = {};
  answers.forEach((v, i) => { if (v.trim()) result.prior_notes[TOPICS[i]] = clean(v, 220); });
  return result;
}

export function talkerMessages(project, guidance, history, instruction, notes = []) {
  const messages = [{ role: 'system', content: TALKER_POLICY + '\nUNTRUSTED PROJECT DATA:\n' + JSON.stringify(project) + '\nUNTRUSTED PRIVATE PREFERENCES (not evidence):\n' }];
  if (guidance) messages.push({ role: 'system', content: 'ANALYST_GUIDANCE (server plan, not a script): ' + JSON.stringify(guidance) });
  for (const note of notes) if (note) messages.push({ role: 'system', content: note });
  messages.push(...history.slice(-HISTORY));
  if (instruction) messages.push({ role: 'user', content: instruction });
  return messages;
}

const same = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export class Session {
  /** io: {send(obj), sendBytes(u8), close()}; ai: {transcribe(pcm), synthesize(text), chatStream(messages), analyst(messages)} */
  constructor({ io, ai, csrf, voice, voices = null, captureRequired = false, model, maxSeconds = MAX_SECONDS, admin = false, memory = null, speakingLimit = SPEAKING_LIMIT_S, now = () => Date.now() / 1000, sleep = ms => new Promise(r => setTimeout(r, ms)), metric = () => {} }) {
    // metric(name, numbers): timings and counts only, never transcript or project content.
    Object.assign(this, { io, ai, csrf, voice, voices: voices || [voice], captureRequired, model, maxSeconds, admin, speakingLimit, now, sleep, metric, memory });
    this.memoryNote = ''; this.language = 'en';
    this.spokenMs = 0; this.timeUp = false; this.ending = null; this.sttBusy = 0;
    this.started = false; this.finished = false; this.capture = false; this.history = []; this.queue = []; this.waiter = null;
    this.gen = 0; this.replies = 0; this.turns = 0; this.guidance = null; this.speaking = null; this.pending = new Set();
    this.sttChain = Promise.resolve(); this.turnDetector = new EnergyTurns(); this.bytesIn = 0; this.startedAt = 0; this.lastInput = 0;
    this.nextTime = 0; this.currentItem = null; this.timer = null; this.lastAudio = -1e9; this.cutOff = false; this.sentMs = {}; this.playedMs = {};
  }

  event(type, values = {}) { if (!this.finished || ['audio_stopped', 'reporting', 'notes', 'ended', 'error', 'quality', 'quality_warning'].includes(type)) this.io.send({ type, ...values }); }

  async onText(text) {
    let value;
    try { value = JSON.parse(text); } catch { return this.fail('Unsupported client event', 'voice-contract'); }
    if (!this.started) return this.start(value);
    if (value?.type === 'end' && Object.keys(value).length === 1) return this.end(true);
    if (value?.type === 'discard' && Object.keys(value).length === 1) return this.end(false);
    if (value?.type === 'playback') {
      // Flow control: the browser reports audio actually played; never run more than LEAD_MS ahead of it.
      const { item_id: item, played_ms: ms } = value;
      if (Object.keys(value).length === 3 && typeof item === 'string' && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= (this.sentMs[item] || 0) + 1)
        this.playedMs[item] = Math.max(this.playedMs[item] || 0, ms);
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
    // Barge-in only stops audio the consultant can actually hear; noise cannot cancel a reply still being composed.
    if (started && audible) { this.interrupt(); this.cutOff = true; this.metric('barge_in', {}); this.event('user_speaking'); }
    if (utterance) { this.sttBusy += 1; this.sttChain = this.sttChain.then(() => this.transcribe(utterance)).finally(() => { this.sttBusy -= 1; }); }
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
    } catch (e) { return this.fail(e.message, 'voice-contract'); }
    this.started = true; this.startedAt = this.lastInput = this.now();
    const stage = this.project.stage || 'Unknown';
    this.analyst = this.capture ? new Analyst(messages => this.ai.analyst(messages), stage) : null;
    this.ledger = this.analyst ? this.analyst.ledger : new InterviewLedger(stage);
    this.event('ready', { model: 'ATLAS', provider: 'ATLAS voice', sampleRate: 24000, speakingSeconds: this.speakingLimit, capture: this.capture, liveLedger: !!this.analyst,
      maxSeconds: this.maxSeconds, message: 'Voice session ready. Speak naturally. Candidate notes require your review.' });
    if (this.memory) { // private memory from earlier conversations, bounded so the greeting is never held up
      let timer;
      try { this.memoryNote = await Promise.race([this.memory(this.project), new Promise(r => { timer = setTimeout(() => r(''), 3500); })]) || ''; }
      catch { this.memoryNote = ''; this.metric('memory_error', {}); }
      finally { clearTimeout(timer); }
      if (this.finished) return;
      this.event('memory', { status: this.memoryNote ? 'recalled' : 'empty', message: this.memoryNote ? 'ATLAS remembers your earlier conversations (private to you).' : 'No earlier conversations to recall.' });
    }
    this.timer = setInterval(() => this.watch(), 1000);
    this.pace();
    this.startReply(OPENING);
  }

  watch() {
    if (this.finished || this.ending) return;
    if (this.now() - this.startedAt >= this.maxSeconds) this.end(true);
    else if (this.now() - this.lastInput > 12) this.fail('Microphone frames stopped', 'voice-unavailable');
  }

  busy() { return !!this.speaking || this.queue.length > 0; }

  audible() { return this.queue.length > 0 || this.now() - this.lastAudio < 0.3; }

  interrupt() {
    this.gen += 1; this.queue = [];
    this.event('clear_audio');
  }

  async transcribe(pcm) {
    if (this.finished) return;
    let text = '';
    const t0 = this.now();
    let heardIn = null;
    try { const heard = await this.ai.transcribe(pcm); text = (typeof heard === 'string' ? heard : heard?.text || '').trim(); heardIn = typeof heard === 'string' ? null : heard?.language || null; this.metric('stt', { ms: Math.round((this.now() - t0) * 1000), audio_ms: Math.round(pcm.length / 48), words: text ? text.split(/\s+/).length : 0 }); }
    catch (e) { this.metric('stt_error', { name: e?.name || 'Error' }); this.event('quality_warning', { message: 'A speech segment could not be transcribed. Please repeat it or add it to your notes.' }); return; }
    const recent = this.history.filter(m => m.role === 'assistant').slice(-2).map(m => m.content).join(' ');
    // Follow the consultant's language: switch on a clear utterance (three words or more) in another supported language.
    if (heardIn && heardIn !== this.language && text.split(/\s+/).length >= 3 && !isEcho(text, recent)) {
      this.language = heardIn; this.metric('language_switch', { language: heardIn, voice: this.spoken() === heardIn ? 1 : 0 });
      this.event('language', { language: heardIn, name: LANGUAGES[heardIn], voice: this.spoken() === heardIn });
    }
    // Speaker echo of ATLAS's own words must never become consultant testimony.
    if (text && isEcho(text, recent)) { this.metric('echo_ignored', {}); this.event('quality_warning', { message: 'ATLAS heard its own voice through the microphone and ignored it. Headphones prevent this.' }); text = ''; }
    if (text) { this.cutOff = false; await this.finishTurn(text); }
    else if (this.cutOff && !this.busy()) { this.cutOff = false; this.startReply(RESUME); }
  }

  async finishTurn(text) {
    if (this.finished) return;
    const closing = !!this.ending; // an utterance finishing while the session closes is still recorded, never answered
    this.turns += 1;
    if (this.turns > 300) return this.fail('Turn budget reached; end and start a new focused session', 'voice-contract');
    const ident = 'user-' + this.turns;
    this.history.push({ role: 'user', content: text });
    if (this.capture) {
      this.event('user_text', { item_id: ident, text, provenance: 'unverified_speech_recognition' });
      const a0 = this.now();
      const job = this.analyst.hear(ident, text).then(async result => {
        this.metric('analyst', { ms: Math.round((this.now() - a0) * 1000), ok: result.analyst_status === 'analysed' ? 1 : 0, details: result.candidate_details.length, rejected: result.rejected_proposals });
        let chosen = result.guidance;
        if (this.ai.rankProbe && result.analyst_status === 'analysed') {
          const j0 = this.now();
          try { const better = await this.ai.rankProbe(result, chosen); this.metric('jev', { ms: Math.round((this.now() - j0) * 1000), override: better ? 1 : 0 }); if (better) chosen = better; }
          catch (e) { this.metric('jev_error', { name: e?.name || 'Error' }); } // JEV unavailable: keep the ledger's own choice
        }
        this.guidance = chosen;
        const { guidance, ...rest } = result;
        this.event('quality', rest);
        if (result.analyst_status !== 'analysed') this.event('quality_warning', { message: 'The evidence analyst did not respond for this turn. The answer is kept; review it in the notes.' });
      }).catch(() => this.event('quality_warning', { message: 'This turn exceeded the transcript budget and was not added to the evidence ledger.' }));
      this.pending.add(job); job.finally(() => this.pending.delete(job));
    }
    if (closing) return;
    if (this.busy()) this.interrupt();
    this.startReply();
  }

  spoken() { return spokenFor(this.language, l => (this.ai.speaks ? this.ai.speaks(l) : l === 'en')); }
  paceNotes() { const [admin, pace] = paceNotes(this.spokenMs, this.speakingLimit, this.ledger ? this.ledger.notes() : [], this.admin); return [admin, languageNote(this.language, this.spoken()), this.memoryNote, pace]; }

  startReply(instruction) {
    if (this.ending || this.finished) return;
    // Re-checked on every reply: an interrupted closing (or a noise re-ask) cannot escape the speaking budget.
    if (instruction !== OPENING && this.turns >= 1 && this.spokenMs >= this.speakingLimit * 1000) {
      if (!this.timeUp) { this.timeUp = true; this.metric('speaking_limit', { turns: this.turns }); }
      instruction = TIME_UP;
    }
    this.replies += 1;
    const item = 'agent-' + this.replies, gen = ++this.gen;
    const run = this.speak(item, gen, instruction).catch(e => { this.metric('reply_error', { name: e?.name || 'Error' }); if (!this.finished && gen === this.gen) this.event('error', { message: 'The voice reply failed. No fallback voice was used.', code: 'voice-unavailable' }); });
    this.speaking = run;
    run.finally(() => { if (this.speaking === run) this.speaking = null; });
  }

  async speak(item, gen, instruction) {
    let said = '', buffer = '', interrupted = true, firstText = 0, firstAudio = 0;
    const lang = this.spoken(); // one voice per reply, even if the consultant switches mid-reply
    const marker = new EndMarker(); // the talker's end-of-interview token is never spoken or shown
    const t0 = this.now();
    const say = async sentence => {
      const pcm = await this.ai.synthesize(sentence, this.voice, lang);
      if (!firstAudio) { firstAudio = this.now(); this.metric('reply', { first_text_ms: Math.round((firstText - t0) * 1000), first_audio_ms: Math.round((firstAudio - t0) * 1000) }); }
      if (gen !== this.gen || this.finished) return;
      for (let i = 0; i < pcm.length; i += CHUNK) this.push({ gen, item, bytes: pcm.subarray(i, Math.min(pcm.length, i + CHUNK)) });
    };
    try {
      for await (const raw of this.ai.chatStream(talkerMessages(this.project, this.guidance, this.history, instruction, this.paceNotes()))) {
        if (gen !== this.gen || this.finished) return;
        const delta = marker.feed(raw);
        if (!delta) continue;
        if (!firstText) firstText = this.now();
        this.event('agent_text', { text: !said && this.replies > 1 ? '\n\n' + delta : delta });
        said += delta; buffer += delta;
        const [done, rest] = sentences(buffer); buffer = rest;
        for (const s of done) { await say(s); if (gen !== this.gen) return; }
      }
      const rest = marker.flush();
      if (rest && gen === this.gen) { this.event('agent_text', { text: rest }); said += rest; buffer += rest; }
      if (buffer.trim() && gen === this.gen) await say(buffer.trim());
      interrupted = gen !== this.gen;
      // Backstop: a reply that still asks a question is not a closing, whatever token it carries (admin may end at will).
      const closes = instruction === TIME_UP || (marker.seen && (this.admin || !said.includes('?')));
      if (marker.seen && !closes) this.metric('end_ignored', {});
      if (!interrupted && closes && this.turns >= 1) this.wrapUp(item, gen);
    } finally {
      const text = said.trim();
      if (text) this.history.push({ role: 'assistant', content: text + (interrupted ? ' [interrupted by the consultant]' : '') });
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
      } catch (e) { this.metric('report_error', { name: e?.message === 'timeout' ? 'Timeout' : e?.name || 'Error', attempt }); if (e?.message === 'timeout') return null; }
      finally { clearTimeout(timer); }
    }
    return null;
  }

  push(chunk) { this.queue.push(chunk); if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }

  async pace() {
    // Real-time paced playback, identical to the Python route: 20 ms chunks, stale generations dropped.
    while (!this.finished) {
      if (!this.queue.length) { await new Promise(r => { this.waiter = r; }); continue; }
      const { gen, item, bytes } = this.queue.shift();
      if (gen !== this.gen) continue;
      // Bounded lead over acknowledged playback (browser ring buffer holds 350 ms). Without acknowledgements
      // (older clients, background tabs) fall back to wall-clock pacing after ~1 s of waiting.
      for (let wait = 0; wait < 50 && (this.sentMs[item] || 0) - (this.playedMs[item] || 0) > LEAD_MS && gen === this.gen && !this.finished; wait++) await this.sleep(20);
      if (gen !== this.gen || this.finished) continue;
      if (this.currentItem !== item) { this.currentItem = item; this.event('audio_turn', { item_id: item }); }
      this.io.sendBytes(bytes); this.spokenMs += bytes.length / 48; this.lastAudio = this.now(); this.sentMs[item] = (this.sentMs[item] || 0) + bytes.length / 48;
      this.nextTime = Math.max(this.nextTime, this.now()) + bytes.length / 48000;
      await this.sleep(Math.max(0, this.nextTime - this.now()) * 1000);
    }
  }

  fail(message, code) {
    if (this.finished || this.ending) return;
    this.event('error', { message, code });
    return this.end(false);
  }

  end(clean) {
    // One end per session: every later call (watch() at the wall cap, a socket close, a second End) shares this one.
    if (this.ending) return this.ending;
    this.ending = (async () => {
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
        const report = await this.report();
        this.event('notes', { transcript: [...this.ledger.transcripts.values()].join('\n\n'), sections: this.ledger.notes(), status: 'candidate', report,
          message: 'Unverified speech recognition and quote-linked candidate notes. Correct omissions and errors before adding to the project. The final cut-off utterance may be incomplete.' });
      } else if (clean) this.event('notes', { transcript: '', sections: null, status: 'not-enabled', message: 'Transcript capture was off. No consultant notes were stored.' });
      this.event('ended', { message: 'Microphone and voice service closed.' });
      this.io.close();
    })();
    return this.ending;
  }
}
