// v2.1 X1: the typed interview (start mode 'text') and typing as a barge-in. A text interview takes no microphone and no audio, has no microphone watchdog, shows
// ATLAS's replies as text only (nothing is ever synthesised), and is otherwise the same path as a voice interview: selector, acknowledgements, guard, summary, evidence,
// checkpoint. Same fakes as the other session suites (reconnect-harness.js): scripted recognition, voice, talker and analyst, a clock moved by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERVIEW_MODES, TYPED_MIN_INTERVAL_S, TYPED_RATE_LIMITED, TYPED_WAIT_SPEAKING, PRIVATE_MARK, TEXT_READ_BEAT_MS } from '../src/session.js';
import { GREETING_PIECES } from '../src/languages.js';
import { rig, opened, startMsg, sessionIdOf, talked, until, settle, send, cleanup, screen, named, written, frames, say, PROJECT, ANSWER, QUESTION } from './reconnect-harness.js';

test.afterEach(cleanup);
const errorsOf = h => h.events.filter(e => e.type === 'error');
const readyOf = h => h.events.find(e => e.type === 'ready');
const TALK = n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', 'What part of that work ', 'did you take on yourself, alongside the team?'];
// A typed interview, opened: the greeting and the opening question are on the screen as text.
async function openedText(h, extra = {}) {
  await h.s.onText(startMsg({ mode: 'text', ...extra }));
  await until(() => h.s.finished || (!h.s.busy() && screen(h).includes('What was the project?')));
}
const typedText = h => h.events.filter(e => e.type === 'user_text' && e.provenance === 'consultant_typed');

test('mode: only voice and text are accepted; text is announced back in ready, voice stays the default', async () => {
  assert.deepEqual([...INTERVIEW_MODES], ['voice', 'text']);
  const bad = rig({ talk: TALK }); await bad.s.onText(startMsg({ mode: 'braille' })); await settle(50);
  assert.equal(bad.s.started, false); assert.equal(errorsOf(bad).length, 1); assert.match(errorsOf(bad)[0].message, /Unsupported interview mode/);
  const bad2 = rig({ talk: TALK }); await bad2.s.onText(startMsg({ mode: 'TEXT' })); await settle(50);
  assert.equal(errorsOf(bad2).length, 1, 'exactly the two words, nothing else');
  const voice = rig({ talk: TALK }); await opened(voice); assert.equal(readyOf(voice).input, 'voice'); assert.equal(voice.s.textMode, false);
  const explicit = rig({ talk: TALK }); await opened(explicit, { mode: 'voice' }); assert.equal(readyOf(explicit).input, 'voice');
  const text = rig({ talk: TALK }); await openedText(text);
  assert.equal(readyOf(text).input, 'text'); assert.equal(text.s.textMode, true); assert.match(readyOf(text).message, /Type your answers/);
});

test('start without audio: no microphone frames are needed, nothing is synthesised, no audio is sent, and the greeting arrives as text pieces', async () => {
  const h = rig({ talk: TALK }); await openedText(h);
  assert.equal(h.calls.tts.length, 0, 'no TTS call at all'); assert.equal(h.bytes.length, 0, 'no audio sent');
  assert.equal(h.events.filter(e => e.type === 'audio_turn').length, 0); assert.equal(named(h.metrics, 'tts').length, 0);
  const greeting = GREETING_PIECES.en.join(' ');
  assert.ok(screen(h).startsWith(GREETING_PIECES.en[0]), 'the first greeting piece is the first words on the screen');
  assert.ok(screen(h).includes(GREETING_PIECES.en.at(-1)) && screen(h).includes('What was the project?'));
  assert.deepEqual(readyOf(h).controls.includes('text'), true);
  // The opening wording is the voice interview's, word for word.
  const v = rig({ talk: TALK }); await opened(v);
  assert.equal(screen(h), screen(v), 'the same opening on the screen in both modes'); assert.ok(greeting.length > 40);
  assert.equal(h.s.protectedItem, null, 'nothing protected: there is no audio to protect');
});

test('no microphone watchdog: 60 seconds with no audio frame is fine in text, and still a failure by voice', async () => {
  const h = rig({ talk: TALK }); await openedText(h);
  for (let i = 0; i < 12; i++) { h.advance(5); h.s.watch(); }
  assert.equal(h.s.finished, false); assert.equal(errorsOf(h).length, 0);
  const v = rig({ talk: TALK }); await opened(v);
  v.advance(13); v.s.watch(); await settle(100);
  assert.ok(errorsOf(v).some(e => e.code === 'voice-unavailable'), 'the voice interview keeps its watchdog');
});

test('audio frames sent to a text interview are ignored: nothing is heard, counted or transcribed', async () => {
  const h = rig({ talk: TALK, said: [ANSWER] }); await openedText(h); const before = h.events.length;
  say(h, [[1.2, .2], [1.3, .001]]); await settle(100);
  assert.equal(h.calls.stt, 0); assert.equal(h.s.turns, 0); assert.equal(h.s.bytesIn, 0); assert.equal(h.events.length, before); assert.equal(h.s.finished, false);
});

test('typed turns take the same path as spoken ones: user_text, the analyst, the selector, an acknowledgement and the reply, all as text', async () => {
  const h = rig({ talk: TALK }); await openedText(h);
  await send(h, { type: 'text', text: ANSWER }); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.s.turns, 1); assert.equal(typedText(h).length, 1); assert.equal(typedText(h)[0].item_id, 'user-typed-1'); assert.equal(typedText(h)[0].text, ANSWER);
  assert.ok(screen(h).includes(QUESTION), 'the reply is on the screen');
  assert.equal(h.calls.analyst, 1); assert.ok(h.events.some(e => e.type === 'quality'), 'the story board gets the ledger');
  assert.ok(h.s.humane.asked.length >= 1, 'the selector chose and logged the move'); assert.ok(named(h.metrics, 'ack').length >= 1, 'an acknowledgement was chosen and shown as text');
  assert.equal(h.calls.tts.length, 0); assert.equal(h.bytes.length, 0); assert.equal(h.calls.stt, 0);
  assert.equal(h.s.history.at(-1).role, 'assistant'); assert.ok(h.s.history.at(-1).content.includes(QUESTION));
  assert.equal(h.s.lastQuestion.text, QUESTION);
  assert.ok(named(h.metrics, 'reply_guard').length >= 2, 'the reply guard ran on the typed interview too');
});

test('replies are released in order and at once: the text events add up to the screen, in the order spoken, with no waiting for audio', async () => {
  const h = rig({ talk: n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thanks. ', 'What part of that work ', 'did you take on yourself, alongside the team?'] }); await openedText(h);
  await send(h, { type: 'text', text: ANSWER }); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const texts = h.events.filter(e => e.type === 'agent_text').map(e => e.text), full = texts.join('');
  assert.equal(full, screen(h));
  assert.ok(full.indexOf('What was the project?') < full.indexOf(QUESTION), 'in order');
  assert.ok(texts.length >= 3, 'streamed in pieces, not one block');
  assert.ok(!full.includes('[[END]]'));
});

test('a typed turn while ATLAS is still writing is refused with its reason (the browser keeps the text), and no turn is taken', async () => {
  const h = rig({ talk: TALK }); await openedText(h);
  await send(h, { type: 'text', text: ANSWER });
  await send(h, { type: 'text', text: 'a second one straight after' });
  assert.equal(h.s.turns, 1); assert.equal(typedText(h).length, 1, 'only the accepted turn is echoed as user_text');
  const w = h.events.filter(e => e.type === 'quality_warning' && e.refused === 'text');
  assert.equal(w.length, 1); assert.equal(w[0].reason, 'composing'); assert.equal(w[0].message, TYPED_RATE_LIMITED);
  await until(() => !h.s.busy());
  await send(h, { type: 'text', text: 'too soon after the first' });
  assert.equal(h.events.filter(e => e.refused === 'text').at(-1).reason, 'rate');
  h.advance(TYPED_MIN_INTERVAL_S + 0.1);
  await send(h, { type: 'text', text: 'and now it is fine to answer again' }); assert.equal(h.s.turns, 2); assert.equal(typedText(h).length, 2);
});

test('interview clock and pause work as in voice: paused time is not interview time, typing carries on', async () => {
  const h = rig({ talk: TALK }); await openedText(h);
  await send(h, { type: 'text', text: ANSWER }); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  h.advance(30); const before = h.s.activeSeconds();
  await send(h, { type: 'pause' }); await until(() => !h.s.busy());
  assert.equal(h.s.paused, true); assert.ok(h.events.some(e => e.type === 'state' && e.paused === true));
  h.advance(600); h.s.watch(); assert.equal(h.s.finished, false, 'no limit and no watchdog while paused');
  assert.ok(Math.abs(h.s.activeSeconds() - before) < 0.5, 'the clock stood still');
  assert.equal(h.bytes.length, 0, 'the pause line is text too'); assert.equal(h.calls.tts.length, 0);
  h.advance(TYPED_MIN_INTERVAL_S + 0.1);
  await send(h, { type: 'text', text: 'carrying on now' }); assert.equal(h.s.paused, false); assert.equal(h.s.turns, 2);
  await until(() => !h.s.busy()); await send(h, { type: 'repeat' }); await until(() => !h.s.busy());
  const asked = h.s.lastQuestion.text; assert.ok(screen(h).split(asked).length >= 3, 'Repeat says the question again, as text');
  h.advance(h.s.maxSeconds); h.s.watch(); await settle(100); assert.ok(h.s.ending, 'the interview limit still applies: a clean end');
});

test('checkpoint and resume in text mode: the mode is stored, offered with the saved interview, and restored (voice can still be asked for)', async () => {
  const h = rig({ talk: TALK }); await openedText(h);
  await send(h, { type: 'text', text: ANSWER }); await until(() => h.calls.talker.length === 2 && !h.s.busy()); await written(h);
  const id = sessionIdOf(h); assert.equal((await h.store.info()).input, 'text'); assert.equal((await h.store.load(id)).input, 'text');
  await h.s.suspend();
  const h2 = rig({ storage: h.storage, clk: h.clk, talk: TALK });
  await h2.s.onText(startMsg({ resume: id })); await settle(300); // no `mode`: the stored one carries on
  assert.equal(readyOf(h2).resumed, true); assert.equal(readyOf(h2).input, 'text'); assert.equal(h2.s.textMode, true);
  assert.ok(screen(h2).includes(QUESTION), 'the question in front of them is said again, as text'); assert.equal(h2.calls.tts.length, 0); assert.equal(h2.bytes.length, 0);
  assert.equal(h2.events.find(e => e.type === 'restore').user[0].text, ANSWER);
  h2.advance(60); h2.s.watch(); assert.equal(h2.s.finished, false, 'no microphone watchdog after the resume either');
  await send(h2, { type: 'text', text: 'It dropped from fourteen minutes to nine.' }); await until(() => !h2.s.busy()); assert.equal(h2.s.turns, 2);
  await h2.s.suspend();
  const h3 = rig({ storage: h.storage, clk: h.clk, talk: TALK });
  await h3.s.onText(startMsg({ resume: id, mode: 'voice' })); await settle(300);
  assert.equal(readyOf(h3).input, 'voice', 'the browser may ask to carry on by voice'); assert.equal(h3.s.textMode, false);
});

test('text mode with a gap (proof) interview: the asks are counted and answered through text too', async () => {
  const GAP = 'a'.repeat(32), asks = { asks: [{ id: 'A1', field: 'measurement', ask: QUESTION }], bidAlias: 'Bid X', projectId: 'p-falcon' };
  const h = rig({ talk: n => n === 0 ? ['What was the baseline before the change?'] : ['Thanks. Anything else on it?'], session: { gaps: async id => id === GAP ? asks : null } });
  await h.s.onText(startMsg({ mode: 'text', gap: GAP })); await until(() => !h.s.busy() && screen(h).includes('baseline before'));
  assert.equal(readyOf(h).mode, 'gap'); assert.equal(readyOf(h).input, 'text'); assert.equal(h.calls.tts.length, 0);
  assert.equal(h.s.gapAttempts.A1, 1, 'the ask was put to them: one attempt, counted from the composed text');
  await send(h, { type: 'text', text: 'It was about forty minutes per claim, from the dashboard we had.' }); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(h.s.gapStatuses()[0].status, 'answered_unverified');
});

test('kept private: the browser is told which utterances (user_text_private), so the line on its screen can become the marker; a resumed screen has the marker too', async () => {
  const SECRET = 'We rebuilt the claims intake for Zebracorp and the secret margin was nineteen percent which nobody outside the team knows.';
  const h = rig({ talk: TALK });
  h.s.ai.analyst = async messages => { const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
    return [{ id: 'c1', name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'outcome', item_id: seg.item_id, quote: 'the secret margin was nineteen percent' }] }) }]; };
  await openedText(h);
  await send(h, { type: 'text', text: SECRET }); await until(() => h.calls.talker.length === 2 && !h.s.busy() && h.s.ledger.details.length === 1);
  h.s.startReply(undefined, { move: { kind: 'summary', intent: 'summary', field: null, rung: null, say: 'Is there anything I have misunderstood or missed?', why: 'summary:test', reaction: 'none', ack_category: null }, turn: h.s.turns });
  await until(() => h.s.summary.open && !h.s.busy());
  const d = h.s.ledger.details[0], item = d.item_id;
  await send(h, { type: 'withhold', detail_id: d.id });
  const ev = h.events.filter(e => e.type === 'user_text_private'); assert.equal(ev.length, 1); assert.deepEqual(ev[0].items, [item]);
  assert.ok(!JSON.stringify(ev).includes('Zebracorp'), 'the event carries item ids only, never words');
  await written(h); const id = sessionIdOf(h); await h.s.suspend();
  const h2 = rig({ storage: h.storage, clk: h.clk, talk: TALK }); await h2.s.onText(startMsg({ resume: id })); await settle(300);
  const view = h2.events.find(e => e.type === 'restore');
  assert.equal(view.user.find(u => u.item_id === item).text, PRIVATE_MARK); assert.ok(!JSON.stringify(view.user).includes('Zebracorp'));
});

test('typing while ATLAS is speaking is a barge-in: it stops her and the turn is taken (voice mode); a burst and a reply still being composed are refused', async () => {
  let gate; const held = new Promise(r => { gate = r; });
  const h = rig({ talk: n => n === 0 ? ['Right. ', 'What was the project?'] : (async function* () { yield 'Thanks. '; await held; yield QUESTION; })() });
  await opened(h);
  await send(h, { type: 'text', text: ANSWER });
  await until(() => h.s.busy() && (h.s.sentMs[h.s.replyItem] || 0) > 0); // her acknowledgement is out; the rest of the reply is still being composed
  h.advance(TYPED_MIN_INTERVAL_S + 0.1);
  const clears = h.events.filter(e => e.type === 'clear_audio').length;
  await send(h, { type: 'text', text: 'Actually, let me add one thing about the team size.' });
  assert.equal(h.s.turns, 2, 'taken, not refused'); assert.equal(typedText(h).length, 2);
  assert.ok(h.events.filter(e => e.type === 'clear_audio').length > clears, 'her audio was stopped (the browser flushes what it had not played)');
  assert.equal(named(h.metrics, 'typed_barge_in').length, 1); assert.equal(h.events.filter(e => e.refused === 'text').length, 0);
  assert.ok(h.s.history.some(m => m.role === 'assistant' && /\[interrupted by the consultant\]/.test(m.content)), 'what she had said is recorded as cut short, as for speech');
  gate(); await settle(100);
  // A burst (under 1.5 s) is still refused, with the reason.
  await until(() => !h.s.busy()); await send(h, { type: 'text', text: 'another one straight after' });
  assert.equal(h.events.filter(e => e.refused === 'text').at(-1).reason, 'rate');
});

test('the first greeting piece is protected: typing then is not a barge-in, it is refused with "I\'ll take that as soon as I finish speaking"', async () => {
  const h = rig({ talk: TALK });
  await h.s.onText(startMsg()); await until(() => h.bytes.length >= 1 && h.s.protectedItem);
  h.s.protectedMs = 1e9; h.s.protectedDeadline = h.clk.t + 1e6; h.s.playedMs[h.s.protectedItem] = 0; // (the browser has not played it yet)
  await send(h, { type: 'text', text: 'Hello, I am ready to answer now.' });
  const w = h.events.filter(e => e.refused === 'text'); assert.equal(w.length, 1); assert.equal(w[0].reason, 'speaking'); assert.equal(w[0].message, TYPED_WAIT_SPEAKING);
  assert.equal(h.s.turns, 0);
});

test('the closing line of a typed interview is read before the interview ends (a reading beat), and the interview then ends cleanly', async () => {
  assert.ok(TEXT_READ_BEAT_MS >= 1500);
  const h = rig({ talk: n => n === 0 ? ['Right. ', 'What was the project?'] : ['Thank you, that is everything I needed. [[END]]'], session: { admin: true } }); await openedText(h);
  await send(h, { type: 'text', text: ANSWER }); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  await until(() => h.events.some(e => e.type === 'wrap_up'), 5000);
  assert.ok(screen(h).includes('that is everything I needed')); assert.ok(!screen(h).includes('[[END]]'));
});
