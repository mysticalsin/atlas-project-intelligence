// Agent Brain v2.1 T9: pause, resume, repeat, skip, typed turns and the interview state machine, inside a live Session.
// Same fakes as session-humane.test.js: scripted speech recognition, voice, talker and analyst, and a fake clock that the tests move by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, CONTROLS, SKIP_DECLINED, WALL_CAP_S, WALL_CAP_MESSAGE, TYPED_MAX_CHARS, clearPcmCache } from '../src/session.js';
import { PAUSE_LINES, RESUME_LINES } from '../src/policy.generated.js';
import { Machine } from '../src/conversation-state.js';
import { SAMPLE_RATE } from '../src/speech.js';

const PROJECT = { title: 'Project Falcon (synthetic)', consultant: 'Alex', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
const ANSWER = 'We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.';
const QUESTION = 'What was the baseline?';

function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}

// said: what speech recognition hears, utterance by utterance. talk(n, messages): the deltas of talker call n (default: a thank-you and QUESTION).
function harness({ said = [], talk = null, flags = {}, metrics = [], session = {} } = {}) {
  const events = [], bytes = [], calls = { talker: [], analyst: 0, stt: 0, tts: [] }; let t = 1000, closed = false;
  const ai = {
    async transcribe() { calls.stt += 1; return said[calls.stt - 1] || ''; },
    async synthesize(text) { calls.tts.push(text); return new Uint8Array(4800).fill(1); },
    chatStream(messages) {
      const n = calls.talker.length; calls.talker.push(messages);
      const out = talk ? talk(n, messages) : ['Thanks. ', 'What was ', 'the baseline?'];
      return Array.isArray(out) ? (async function* () { yield* out; })() : out;
    },
    async analyst(messages) {
      calls.analyst += 1;
      const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
      return [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'outcome', item_id: seg.item_id, quote: seg.text.slice(0, 31) }] }) }];
    },
  };
  const s = new Session({ flags, ...session, io: { send: e => events.push(e), sendBytes: b => bytes.push(b.length), close: () => { closed = true; } }, ai, csrf: 'tok',
    voice: 'asteria', model: 'test-talker', now: () => t, sleep: () => new Promise(r => setImmediate(r)), metric: (n, v) => metrics.push([n, v]) });
  open.add(s);
  return { s, events, bytes, calls, metrics, tick: () => { t += 0.02; }, advance: sec => { t += sec; }, clock: () => t, closed: () => closed };
}
const open = new Set();
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); clearPcmCache(); });
const settle = async (n = 200) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const until = async (cond, n = 3000) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setImmediate(r)); assert.ok(cond(), 'condition not reached'); };
const say = (h, segs) => { for (const f of frames(segs)) { h.tick(); h.s.onBinary(f); } };
const talked = h => say(h, [[1.2, .2], [1.3, .001]]); // one utterance, then enough silence for the turn to end
async function opened(h, capture = true) {
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture, voice: 'asteria', memory: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 15);
  h.s.playedMs[h.s.protectedItem] = 1e9; // the greeting has played (browser acknowledgement)
}
// A started session in which the consultant has answered once: ATLAS has asked a question and the move is in the asked log.
async function interviewing(opts = {}) {
  const h = harness({ said: [ANSWER, ...(opts.said || [])], talk: n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', 'What was ', 'the baseline?'], ...opts, said: [ANSWER, ...(opts.said || [])] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  return h;
}
const send = (h, obj) => h.s.onText(JSON.stringify(obj));
const screen = h => h.events.reduce((t, e) => e.type === 'agent_text' ? t + e.text : e.type === 'agent_retract' ? t.slice(0, t.length - Math.min(e.chars, t.length)) : t, '');
const named = (metrics, name) => metrics.filter(([n]) => n === name).map(([, v]) => v);
const count = (text, part) => text.split(part).length - 1;
const states = h => h.events.filter(e => e.type === 'state');

test('controls are announced in ready; a client that never saw them is not sent them', async () => {
  const h = harness(); await opened(h);
  assert.deepEqual(h.events.find(e => e.type === 'ready').controls, ['pause', 'resume', 'repeat', 'text', 'correct', 'withhold', 'confirm_summary', 'language']);
  assert.deepEqual([...CONTROLS], ['pause', 'resume', 'repeat', 'text', 'correct', 'withhold', 'confirm_summary', 'language']); // (T11 added the summary card's three, L1 the language selector; U2 removed Skip)
});

test('pause: ATLAS stops, says one stock line, goes quiet; audio is ignored and neither the watchdog nor the clock runs for 60 s of silence', async () => {
  const h = await interviewing();
  const active0 = h.s.activeSeconds();
  await send(h, { type: 'pause' });
  assert.ok(h.s.paused);
  await until(() => !h.s.busy() && h.calls.tts.some(t => PAUSE_LINES.en.includes(t)));
  assert.ok(PAUSE_LINES.en.some(l => screen(h).includes(l)), 'the line is shown as well as spoken');
  const before = { bytesIn: h.s.bytesIn, talker: h.calls.talker.length, sent: h.bytes.length };
  for (let i = 0; i < 6; i++) { h.advance(10); h.s.watch(); } // 60 s with no microphone frames at all
  assert.ok(!h.s.finished && !h.events.some(e => e.type === 'error'), 'no "Microphone frames stopped"');
  // loud frames while paused: not counted, not kept, nobody answers
  say(h, [[1.2, .3], [1.5, .001]]); await settle();
  assert.equal(h.s.bytesIn, before.bytesIn); assert.equal(h.calls.stt, 1, 'nothing was transcribed'); assert.ok(!h.s.turnDetector.active);
  assert.equal(h.calls.talker.length, before.talker); assert.equal(h.bytes.length, before.sent, 'and nothing more was said');
  assert.ok(h.s.activeSeconds() - active0 < 2, 'the 60 s are not interview time: ' + (h.s.activeSeconds() - active0));
  await send(h, { type: 'resume' });
  h.s.watch(); assert.ok(!h.s.finished && !h.events.some(e => e.type === 'error'), 'the watchdog starts afresh at the resume, not at the last frame before the pause');
  h.advance(5); assert.ok(h.s.activeSeconds() - active0 < 10);
  assert.ok(!h.s.paused);
});

test('control: without a pause the same 60 s of silence stops the session (the watchdog is only exempted while paused)', async () => {
  const h = await interviewing();
  h.advance(60); h.s.watch(); await settle();
  assert.ok(h.events.some(e => e.type === 'error' && /Microphone frames stopped/.test(e.message)));
});

test('paused time does not count toward the 15 minutes; the interview limit is measured in active seconds', async () => {
  const h = await interviewing({ session: { maxSeconds: 100 } });
  await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  h.advance(90); h.s.watch(); // 90 s paused, with the limit at 100 s: wall clock would already be at the closing line
  assert.ok(!h.events.some(e => e.type === 'time_up') && !h.s.timeUp);
  await send(h, { type: 'resume' }); await until(() => !h.s.busy());
  h.s.lastInput = h.clock(); h.advance(30); h.s.lastInput = h.clock(); h.s.watch();
  assert.ok(!h.events.some(e => e.type === 'time_up'), 'only 30+ active seconds were used');
  assert.ok(h.s.activeSeconds() < 40 && h.clock() - h.s.startedAt > 120);
  // pace and the selector read the same active clock
  const pace = h.s.paceNotes().join('\n');
  assert.match(pace, /about 0 of 1 minutes used/);
});

test('resume: a stock line then lastQuestion again, with zero talker calls; the asked log stays accurate', async () => {
  const h = await interviewing();
  const talker = h.calls.talker.length, asked = h.s.humane.asked.length, last = h.s.lastQuestion;
  assert.equal(last.text, QUESTION);
  await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  const shown = screen(h).length;
  await send(h, { type: 'resume' }); await until(() => !h.s.busy() && screen(h).length > shown);
  const added = screen(h).slice(shown);
  assert.ok(RESUME_LINES.en.some(l => added.includes(l)), added); assert.ok(added.includes(QUESTION));
  assert.equal(h.calls.talker.length, talker, 'zero talker calls');
  assert.equal(h.s.humane.asked.length, asked, 'one question, one entry in the asked log');
  assert.equal(h.s.lastQuestion.text, QUESTION);
  assert.ok(h.metrics.some(([n, v]) => n === 'tts' && v.cached === 1), 'the line and the question come from the cache or one synthesis');
  assert.equal(named(h.metrics, 'resume').length, 1);
});

test('a question cut off by the pause still counts as asked, and resume says it', async () => {
  let hold;
  const h = harness({ said: [ANSWER], talk: n => n === 1 ? (async function* () { yield 'Thanks. '; await new Promise(r => { hold = r; }); yield 'What did you own?'; })() : ['Thanks. ', QUESTION] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && h.s.busy() && h.s.humane.asked.length === 1);
  // her reply is still being composed: the selector's move is committed but nothing of the question was said
  const move = h.s.humane.asked[0];
  const cleared = h.events.filter(e => e.type === 'clear_audio').length;
  await send(h, { type: 'pause' }); hold?.();
  await until(() => !h.s.busy());
  assert.ok(h.events.filter(e => e.type === 'clear_audio').length > cleared, 'her speech was stopped cleanly (clear_audio)');
  assert.equal(h.s.lastQuestion.move, move, 'the move\'s question is the one she was on');
  await send(h, { type: 'resume' }); await until(() => !h.s.busy() && h.s.humane.asked.includes(move));
  assert.equal(h.s.humane.asked.filter(m => m === move).length, 1);
  assert.ok(screen(h).includes(move.say), 'the move\'s own question was said on resume');
  assert.equal(h.calls.talker.length, 2, 'zero further talker calls');
});

test('repeat (button): the last question again, no model call', async () => {
  const h = await interviewing();
  const talker = h.calls.talker.length, asked = h.s.humane.asked.length, shown = screen(h).length;
  await send(h, { type: 'repeat' }); await until(() => !h.s.busy() && count(screen(h), QUESTION) === 2);
  assert.equal(screen(h).slice(shown).trim(), QUESTION);
  assert.equal(h.calls.talker.length, talker); assert.equal(h.s.humane.asked.length, asked);
  assert.equal(named(h.metrics, 'repeat').length, 1);
});

test('spoken "can you repeat that": the same, with no talker call and no new move', async () => {
  const h = await interviewing({ said: ['Sorry, can you repeat that?'] });
  const talker = h.calls.talker.length, asked = h.s.humane.asked.map(m => m.say), shown = screen(h).length;
  talked(h); await until(() => h.calls.stt === 2 && !h.s.busy() && count(screen(h), QUESTION) === 2);
  assert.equal(screen(h).slice(shown).trim(), QUESTION);
  assert.equal(h.calls.talker.length, talker, 'zero talker calls');
  assert.deepEqual(h.s.humane.asked.map(m => m.say), asked, 'asked log unchanged: a repeat is not an attempt');
  assert.ok(h.s.history.some(m => m.role === 'user' && /repeat that/.test(m.content)) && h.s.history.at(-1).role === 'assistant' && h.s.history.at(-1).content === QUESTION);
  assert.equal(h.s.asrDone?.turn, 1, 'a repeat never reaches the speech-recognition check (it was last run for turn 1)');
});

test('spoken pause: the same handler (line, then quiet, clock stopped); a long answer that merely contains the words is an answer', async () => {
  const long = 'We took a break from the rollout in March because the client needed one minute to review the whole plan and then we went on with it.';
  const h = await interviewing({ said: [long, 'Let us pause for a moment please.'] });
  talked(h); await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.ok(!h.s.paused, 'a long answer with "take a break" in it is not a pause');
  talked(h); await until(() => h.s.paused && !h.s.busy());
  assert.ok(h.calls.tts.some(t => PAUSE_LINES.en.includes(t)));
  assert.equal(h.calls.talker.length, 3, 'the long answer was answered; the pause was not');
  assert.equal(named(h.metrics, 'pause')[0].voice, 1);
});

test('skip (an old client\'s button): a polite refusal note and nothing else: no move, no state change, no ledger entry, never a skip', async () => {
  const h = await interviewing();
  const asked = h.s.humane.asked.length, talker = h.calls.talker.length, audit = h.s.machine.audit.length, history = h.s.history.length;
  await send(h, { type: 'skip' }); await settle(30);
  const warn = h.events.find(e => e.type === 'quality_warning' && e.refused === 'skip');
  assert.equal(warn.message, SKIP_DECLINED); assert.match(warn.message, /rough answer|example|who would know/);
  assert.ok(!/skip|pass|leave it/i.test(warn.message.replace(/ATLAS keeps going/, '')), 'the note never invites a skip');
  assert.deepEqual([h.s.humane.asked.length, h.calls.talker.length, h.s.machine.audit.length, h.s.history.length], [asked, talker, audit, history], 'nothing moved');
  assert.deepEqual(h.s.machine.skipped, []); assert.ok(!h.s.machine.audit.some(a => a.event === 'skip'));
  assert.equal(named(h.metrics, 'skip_declined').length, 1);
  assert.ok(!h.s.busy() && !h.s.finished);
});

test('spoken "skip": an answer to probe: an easier angle on the same point, then (if it is said again) a second one, then the point is left open', async () => {
  const h = await interviewing({ said: ['Skip.', 'Pass.', 'Next question.'] });
  const first = h.s.humane.asked.at(-1), field = first.field, talker = h.calls.talker.length;
  talked(h); await until(() => h.calls.talker.length === talker + 1 && !h.s.busy());
  const a1 = h.s.humane.asked.at(-1);
  assert.equal(a1.kind, 'ask'); assert.equal(a1.field, field); assert.match(a1.why, new RegExp('^reangle:' + field + ':1')); assert.deepEqual(h.s.machine.skipped, [], 'never a skip');
  assert.equal(h.s.asrDone?.turn, 2, 'a skip is still a turn: it resolved nothing');
  talked(h); await until(() => h.calls.talker.length === talker + 2 && !h.s.busy());
  assert.match(h.s.humane.asked.at(-1).why, new RegExp('^reangle:' + field + ':2'));
  talked(h); await until(() => h.calls.talker.length === talker + 3 && !h.s.busy());
  const move = h.s.humane.asked.at(-1);
  assert.equal(move.kind, 'accept_and_move'); assert.match(move.why, new RegExp('^skip:' + field)); assert.notEqual(move.field, field);
  assert.deepEqual(h.s.machine.skipped, [], 'the state machine records no skip: the point is open in the ledger');
  assert.ok(h.s.ledger.deferred[field]);
});

test('typed turn: same path as a spoken turn without speech recognition (item user-typed-N, provenance consultant_typed, reply spoken and shown)', async () => {
  const h = harness(); await opened(h);
  const stt = h.calls.stt;
  await send(h, { type: 'text', text: ANSWER });
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.calls.stt, stt, 'no transcription');
  const ev = h.events.find(e => e.type === 'user_text');
  assert.deepEqual([ev.item_id, ev.text, ev.provenance], ['user-typed-1', ANSWER, 'consultant_typed']);
  assert.equal(h.s.ledger.transcripts.get('user-typed-1'), ANSWER);
  await until(() => h.s.ledger.details.length > 0);
  assert.ok(h.s.ledger.details.every(d => d.item_id === 'user-typed-1' && d.provenance === 'consultant_typed'));
  assert.ok(h.s.history.some(m => m.role === 'user' && m.content === ANSWER));
  assert.ok(screen(h).includes(QUESTION) && h.s.humane.asked.length === 1, 'the reply is shown and was chosen by the selector');
  assert.ok(h.bytes.length > 15, 'and spoken');
  // the next spoken turn is numbered on, as before
  assert.equal(h.s.turns, 1);
});

test('typed turn: bounded and cleaned; empty text is ignored; extra keys are a contract error', async () => {
  const h = harness(); await opened(h);
  await send(h, { type: 'text', text: '   ' }); await settle(20);
  assert.equal(h.s.turns, 0);
  await send(h, { type: 'text', text: 'x'.repeat(TYPED_MAX_CHARS + 500) });
  await until(() => h.s.turns === 1);
  assert.equal([...h.s.ledger.transcripts.get('user-typed-1')].length, TYPED_MAX_CHARS);
  const bad = harness(); await opened(bad);
  await send(bad, { type: 'text', text: 'hi', extra: 1 }); await settle(20);
  assert.ok(bad.events.some(e => e.type === 'error' && e.code === 'voice-contract'));
  const bad2 = harness(); await opened(bad2);
  await send(bad2, { type: 'pause', why: 'x' }); await settle(20);
  assert.ok(bad2.events.some(e => e.type === 'error' && e.code === 'voice-contract') && !bad2.s.paused);
});

test('typing while paused carries on: the clock restarts, nothing is re-asked, the typed answer is answered', async () => {
  const h = await interviewing();
  await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  h.advance(30);
  const shown = screen(h).length, talker = h.calls.talker.length;
  await send(h, { type: 'text', text: 'It took about six months in total and I led it from the start with a small group.' });
  await until(() => h.calls.talker.length === talker + 1 && !h.s.busy());
  assert.ok(!h.s.paused && h.s.machine.state === 'discovery');
  assert.ok(!RESUME_LINES.en.some(l => screen(h).slice(shown).includes(l)), 'no welcome-back line: they are already answering');
  assert.ok(h.s.activeSeconds() < h.clock() - h.s.startedAt - 29);
});

test('45-minute wall cap ends the session, paused or not, with the notes', async () => {
  const h = await interviewing({ session: { maxSeconds: 3 * 3600 } });
  await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  h.advance(WALL_CAP_S - 60); h.s.watch();
  assert.ok(!h.s.ending, 'not yet: 44 minutes');
  h.advance(120); h.s.watch(); await h.s.ending;
  assert.ok(h.s.finished && h.closed());
  assert.equal(h.events.find(e => e.type === 'time_up').message, WALL_CAP_MESSAGE);
  assert.ok(h.events.some(e => e.type === 'notes') && h.events.some(e => e.type === 'ended'));
  assert.equal(named(h.metrics, 'wall_cap').length, 1);
  assert.equal(WALL_CAP_S, 2700);
});

test('state machine: transitions are audited with their actor and sent to the client in `state` events', async () => {
  const h = await interviewing();
  await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  await send(h, { type: 'resume' }); await until(() => !h.s.busy());
  const audit = h.s.machine.audit.map(a => [a.event, a.actor, a.from, a.to]);
  assert.deepEqual(audit.slice(0, 2), [['start', 'atlas', 'welcome', 'purpose_permissions'], ['consent_given', 'user', 'purpose_permissions', 'discovery']]);
  assert.deepEqual(audit.slice(-2), [['pause', 'user', 'discovery', 'paused'], ['resume', 'user', 'paused', 'discovery']]);
  assert.ok(audit.some(([e, a]) => e === 'focus' && a === 'atlas'), 'the first question about a field in another area moved the focus: ' + JSON.stringify(audit));
  const ev = states(h);
  assert.equal(ev.length, h.s.machine.audit.length, 'every transition was announced');
  assert.deepEqual(ev.slice(-2).map(e => [e.event, e.actor, e.from, e.state, e.paused]), [['pause', 'user', 'discovery', 'paused', true], ['resume', 'user', 'paused', 'discovery', false]]);
  assert.match(ev[0].at, /^\d{4}-\d\d-\d\dT/);
  // the audit replays through the table: it is a valid checkpoint for T10
  assert.equal(Machine.fromDict(h.s.stateSnapshot()).state, 'discovery');
});

test('state machine: the summary move asks for the summary; discarding withdraws', async () => {
  const h = await interviewing();
  h.s.commitMove('agent-x', { kind: 'summary', intent: 'summary', field: null, say: 'Here is what I understood.', why: 'summary:test', reaction: 'none', ack_category: null });
  assert.equal(h.s.machine.state, 'summary');
  assert.deepEqual(h.s.machine.audit.at(-1).event, 'request_summary');
  assert.equal(h.s.machine.audit.at(-1).actor, 'atlas');
  const d = harness(); await opened(d);
  await send(d, { type: 'discard' }); await d.s.ending;
  assert.equal(d.s.machine.state, 'withdrawn');
  const w = d.s.machine.audit.at(-1);
  assert.deepEqual([w.event, w.actor], ['withdraw', 'user']); assert.ok(w.reason);
});

test('an illegal transition never crashes the session: state_error is counted and the interview goes on', async () => {
  const h = await interviewing();
  assert.equal(h.s.fireState('confirm_summary', 'user'), false, 'illegal from discovery');
  assert.equal(h.s.fireState('pause', 'atlas'), false, 'actor not allowed');
  assert.equal(h.s.fireState('no_such_event', 'user'), false);
  assert.deepEqual(named(h.metrics, 'state_error').map(v => v.code), ['illegal_transition', 'actor_not_allowed', 'unknown_event']);
  // summary state: an old client's skip is refused politely there too, and nothing breaks
  h.s.machine.fire('request_summary', 'atlas'); const talker = h.calls.talker.length;
  await send(h, { type: 'skip' }); await settle(30);
  assert.equal(h.calls.talker.length, talker); assert.ok(h.events.some(e => e.refused === 'skip'));
  assert.ok(named(h.metrics, 'state_error').length >= 3 && !h.s.finished && !h.events.some(e => e.type === 'error'));
  // and pause / resume still work from there
  await send(h, { type: 'pause' }); await until(() => h.s.paused && !h.s.busy());
  await send(h, { type: 'resume' }); await until(() => !h.s.paused && !h.s.busy());
  assert.equal(h.s.machine.state, 'summary');
});

test('pause is idempotent and resume needs a pause; controls before the interview starts are refused', async () => {
  const early = harness();
  await send(early, { type: 'pause' }); // the first message must be the start
  assert.ok(early.events.some(e => e.type === 'error' && e.code === 'voice-contract'));
  const h = await interviewing();
  await send(h, { type: 'resume' }); await settle(20);
  assert.equal(h.s.machine.audit.filter(a => a.event === 'resume').length, 0);
  await send(h, { type: 'pause' }); await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  assert.equal(h.s.machine.audit.filter(a => a.event === 'pause').length, 1);
  await send(h, { type: 'repeat' }); await send(h, { type: 'skip' }); await settle(20);
  assert.equal(h.calls.talker.length, 2, 'repeat and skip do nothing while paused'); assert.ok(!h.events.some(e => e.refused === 'skip'), 'a skip while paused is dropped without a note');
});

test('with no question yet (paused during the greeting) the first resume asks the talker once to open', async () => {
  let hold;
  const h = harness({ said: [], talk: n => n === 0 ? (async function* () { await new Promise(r => { hold = r; }); yield 'Hello. What was the project?'; })() : ['Welcome. ', QUESTION] });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true, voice: 'asteria', memory: false }));
  await until(() => h.bytes.length >= 3 && h.calls.talker.length === 1);
  await send(h, { type: 'pause' }); hold?.(); await until(() => !h.s.busy());
  assert.equal(h.s.lastQuestion, null);
  await send(h, { type: 'resume' }); await until(() => !h.s.busy() && h.calls.talker.length >= 2);
  assert.ok(h.s.lastQuestion?.text === QUESTION);
});

test('an old client\'s skip in a focused proof interview gets the same polite refusal: no move, the interview goes on', async () => {
  const h = await interviewing(); h.s.mode = 'gap'; const talker = h.calls.talker.length;
  await send(h, { type: 'skip' }); await settle(30);
  assert.ok(h.events.some(e => e.type === 'quality_warning' && e.refused === 'skip'));
  assert.equal(h.calls.talker.length, talker); assert.deepEqual(h.s.machine.skipped, []);
});

test('a spoken skip with no question in front of it (the last move had no field) records nothing and still moves on with a question', async () => {
  const h = harness({ said: ['Skip.'] }); await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.deepEqual(h.s.machine.skipped, []);
  const move = h.s.humane.asked.at(-1);
  assert.ok(move && !/^reangle:/.test(move.why) && (move.say || '').includes('?') && !h.events.some(e => e.type === 'error'));
});
