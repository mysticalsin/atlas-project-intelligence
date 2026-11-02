// Agent Brain v2.1 T6: the humane interviewer inside a live Session (reactivity and latency). Uses the same fakes as
// session.test.js: scripted speech recognition, voice, talker and analyst, and a fake clock. Every behaviour is behind a flag
// with the new behaviour as the default; the legacy values must reproduce the earlier one exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, sessionFlags, DEFAULT_FLAGS, nextMoveNote, clearPcmCache } from '../src/session.js';
import { GREETING_PIECES, GREETINGS, WELCOME_BACK, WELCOME_BACK_PIECES, FILLERS } from '../src/languages.js';
import { ACKS, QUESTION_BANK } from '../src/policy.generated.js';
import { SAMPLE_RATE } from '../src/speech.js';
import { workersAI, TALKER_MAX_TOKENS } from '../src/app.js';

const PROJECT = { title: 'Project Falcon (synthetic)', consultant: 'Alex', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
const GREETING = GREETING_PIECES.en;
const ACK_TEXTS = new Set([...Object.values(FILLERS).flat(), ...Object.values(ACKS).flatMap(bank => Object.values(bank).flat())]);
const ACK_OF = category => new Set(ACKS[category].en);
const spoken = calls => calls.tts.filter(t => !ACK_TEXTS.has(t) && !GREETING.includes(t));

function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}

// talk(callIndex, messages) -> an array of deltas, or an async iterable (to watch return()). said: what speech recognition hears, turn by turn.
// analyst: 'gated' holds the evidence analyst until release() (it lands after the reply), else it answers at once.
function harness({ said = [], talk = null, flags = {}, analyst = 'now', metrics = [], session = {} } = {}) {
  const events = [], bytes = [], calls = { talker: [], analyst: 0, stt: 0, tts: [], order: [], probeText: '' }; let t = 1000, closed = false, release = () => {};
  const gate = new Promise(r => { release = r; });
  const ai = {
    async transcribe(pcm, o) { if (o?.probe) return calls.probeText; calls.stt += 1; return said[calls.stt - 1] || ''; }, // (a probe: the check of a sound over her voice, v2.2 V1)
    async synthesize(text) { calls.tts.push(text); return new Uint8Array(4800).fill(1); },
    chatStream(messages) {
      const n = calls.talker.length; calls.talker.push(messages); calls.order.push(['talker', n]);
      const out = talk ? talk(n, messages) : ['Thanks. ', 'What was ', 'the baseline?'];
      if (Array.isArray(out)) return (async function* () { calls.order.push(['token', n]); yield* out; })();
      return out;
    },
    async analyst(messages) {
      calls.analyst += 1; if (analyst === 'gated') await gate;
      const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
      return [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'outcome', item_id: seg.item_id, quote: seg.text.slice(0, 31) }] }) }];
    },
  };
  const s = new Session({ flags, ...session, io: { send: e => events.push(e), sendBytes: b => bytes.push(b.length), close: () => { closed = true; } }, ai, csrf: 'tok',
    voice: 'asteria', model: 'test-talker', now: () => t, sleep: () => new Promise(r => setImmediate(r)), metric: (n, v) => metrics.push([n, v]) });
  open.add(s);
  const orig = s.push.bind(s); s.push = c => { calls.order.push(['push', c.item, !!c.lead, c.bytes.length]); orig(c); };
  return { s, events, bytes, calls, metrics, release, tick: () => { t += 0.02; }, closed: () => closed };
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
const screen = h => h.events.reduce((t, e) => e.type === 'agent_text' ? t + e.text : e.type === 'agent_retract' ? t.slice(0, t.length - Math.min(e.chars, t.length)) : t, '');
const noteOf = (messages, start) => messages.filter(m => m.role === 'system' && m.content.startsWith(start)).map(m => m.content);
const named = (metrics, name) => metrics.filter(([n]) => n === name).map(([, v]) => v);
// The wording of the NEXT MOVE note: what a talker that says the move's own question says (the question spoken is the move's, v2.2 Q1).
const proposal = messages => { const n = messages.find(m => m.role === 'system' && m.content.startsWith('NEXT MOVE')), m = n && /proposed wording: ("(?:[^"\\]|\\.)*")/.exec(n.content); return m ? JSON.parse(m[1]) : null; };
const questions = text => (text.match(/\?/g) || []).length;

test('flags: new behaviour by default, legacy values read from the env', () => {
  assert.deepEqual({ ...DEFAULT_FLAGS }, { selector: 'v2', replyGuard: 'on', acks: 'content', analystWaitMs: 0, asrTau: 0.55, speculativeStt: false });
  assert.deepEqual(sessionFlags({}), { ...DEFAULT_FLAGS });
  assert.deepEqual(sessionFlags(undefined), { ...DEFAULT_FLAGS });
  assert.deepEqual(sessionFlags({ ATLAS_SELECTOR: 'legacy', ATLAS_REPLY_GUARD: 'off', ATLAS_ACKS: 'legacy', ANALYST_WAIT_MS: '250', SPECULATIVE_STT: 'on' }),
    { selector: 'legacy', replyGuard: 'off', acks: 'legacy', analystWaitMs: 250, asrTau: 0.55, speculativeStt: true });
  assert.equal(sessionFlags({ ASR_CONFIRM_TAU: '0.7' }).asrTau, 0.7); assert.equal(sessionFlags({ ASR_CONFIRM_TAU: 'x' }).asrTau, 0.55, 'a bad threshold keeps the default');
  assert.equal(sessionFlags({ ATLAS_SELECTOR: 'nonsense', ATLAS_REPLY_GUARD: 'maybe', ATLAS_ACKS: '' }).selector, 'v2', 'anything but "legacy"/"off" keeps the default');
  assert.equal(sessionFlags({ ANALYST_WAIT_MS: '-5' }).analystWaitMs, 0); assert.equal(sessionFlags({ ANALYST_WAIT_MS: '999999' }).analystWaitMs, 1500, 'bounded');
  assert.deepEqual(workersAI({}).flags, { ...DEFAULT_FLAGS }, 'the Worker adapter hands the env flags to the Session');
  assert.equal(new Session({ io: {}, ai: { flags: { acks: 'legacy' } }, csrf: 'x', voice: 'v' }).flags.acks, 'legacy', 'a Session without its own flags takes the adapter\'s');
});

// (a) The one-turn-stale guidance bug: the analyst answers after the reply, yet the move reflects the answer just heard.
test('a: the move comes from the answer just heard, even when the analyst lands after the reply', async () => {
  const h = harness({ said: ['We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.', 'We cut onboarding by 40% in Q3.'], analyst: 'gated' });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const first = h.s.humane.asked.at(-1);
  assert.equal(first.field, 'contribution', 'the answer was a team claim: who did what');
  talked(h); await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.ok(h.calls.analyst >= 1 && !h.events.some(e => e.type === 'quality'), 'the analyst has not answered: nothing it said could have steered the reply');
  const note = noteOf(h.calls.talker[2], 'NEXT MOVE');
  assert.equal(note.length, 1, 'exactly one NEXT MOVE note');
  assert.match(note[0], /intent: metric_kind/); assert.match(note[0], /about: measurement/);
  assert.ok(!/about: outcome/.test(note[0]) && !/intent: impact/.test(note[0]), 'not an outcome re-ask: the figure itself was just given');
  assert.ok(!h.calls.talker[2].some(m => m.content.startsWith('ANALYST_GUIDANCE')), 'the stale plan is not sent');
  assert.deepEqual(h.s.humane.asked.map(m => m.intent), [first.intent, 'metric_kind'], 'full Move dicts are kept in the asked log');
  assert.equal(h.s.humane.asked.at(-1).why, 'metric:kind');
  h.release(); await until(() => h.events.some(e => e.type === 'quality')); // ...and the analyst still refines the plan for later turns
  assert.ok(h.s.lastPlan && Array.isArray(h.s.lastPlan.candidate_details));
});

test('a2: notes are rebuilt every turn, never accumulated; covered fields are the union of the hints; prefill never carries the name', async () => {
  const h = harness({ said: ['We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.', 'It took about six months in total and I led it from the start with a small group.'] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  talked(h); await until(() => h.calls.talker.length === 3 && !h.s.busy());
  for (const call of h.calls.talker.slice(1)) assert.equal(noteOf(call, 'NEXT MOVE').length, 1, 'one note per reply, none carried from before');
  assert.ok(h.s.humane.covered.has('intervention') && h.s.humane.covered.size >= 1);
  assert.deepEqual(h.s.prefill, { role: 'Designer', sector: 'Insurance', stage: 'Pilot' });
  assert.ok(!/Alex/.test(JSON.stringify([h.s.prefill, h.calls.talker, [...h.s.humane.asked]])), 'the consultant\'s name never reaches the selector or the talker');
  assert.ok(!h.s.history.some(m => m.content.startsWith('NEXT MOVE')), 'the note is not part of the conversation history');
});

test('a3: "I don\'t know" is met with two easier angles, then the point is left open (accepted) and not asked again', async () => {
  const h = harness({ said: ['We cut triage time by a large margin after the rollout across the regions.', 'Honestly I do not know the baseline, I never saw those figures.', 'Still no idea, I never saw them.', 'No, I really do not know.'] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  talked(h); await until(() => h.calls.talker.length === 3 && !h.s.busy());
  const first = h.s.humane.asked.at(-1);
  assert.equal(first.kind, 'ask'); assert.match(first.why, /^reangle:[a-z_]+:1/); assert.equal(first.ack_category, 'reangle');
  assert.match(noteOf(h.calls.talker[2], 'NEXT MOVE')[0], /come at it from another side/);
  talked(h); await until(() => h.calls.talker.length === 4 && !h.s.busy());
  const second = h.s.humane.asked.at(-1); assert.match(second.why, /^reangle:[a-z_]+:2/); assert.equal(second.field, first.field);
  talked(h); await until(() => h.calls.talker.length === 5 && !h.s.busy());
  const move = h.s.humane.asked.at(-1);
  assert.equal(move.kind, 'accept_and_move'); assert.match(move.why, new RegExp('^dont_know:' + first.field)); assert.notEqual(move.field, first.field);
  assert.match(noteOf(h.calls.talker[4], 'NEXT MOVE')[0], /note the point as open/);
  assert.ok(h.s.ledger.deferred[first.field], 'the point is recorded open in the ledger (the card and the next-question panel show it as still open)');
});

// (b) An adversarial talker: two questions, "Amazing!", the same opener every time.
test('b: one question voiced, no banned praise, no repeated opener, and the model stream is stopped', async () => {
  let returned = 0; const qs = [];
  const stream = q => ({ [Symbol.asyncIterator]() {
    const parts = ['Amazing! ', 'Thanks so much for that. ', q + ' ', 'And who measured it? ', 'Also tell me the period?'];
    let i = 0;
    return { async next() { return i < parts.length ? { value: parts[i++], done: false } : { value: undefined, done: true }; }, async return() { returned += 1; return { value: undefined, done: true }; } };
  } });
  // (the question the model says is the selector's own: a question that is not on the move is replaced by it, v2.2 Q1)
  const h = harness({ said: ['We moved the whole billing platform to the new provider last spring with a team of five.', 'It took about six months in total and I led it from the start with a small group.'], talk: (n, messages) => { const q = proposal(messages) || 'What was the baseline?'; qs[n] = q; return stream(q); } });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  talked(h); await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.equal(returned, 3, 'every reply stopped reading the model once its question was out (opening included)');
  assert.deepEqual(spoken(h.calls), ['Thanks so much for that. What was the baseline?', qs[1], qs[2]], 'the second and third questions were never synthesised');
  const replies = h.s.history.filter(m => m.role === 'assistant').map(m => m.content);
  assert.equal(replies.length, 3);
  assert.ok(replies[0].endsWith('Thanks so much for that. What was the baseline?'), 'the first reply keeps its reaction');
  for (const [i, reply] of replies.slice(1).entries()) { assert.ok(!/Thanks so much/.test(reply) && reply.endsWith(qs[i + 1]), 'the repeated opener is dropped: ' + reply); assert.equal(questions(reply), 1); }
  const text = screen(h);
  assert.ok(!/Amazing/i.test(text) && !/who measured/i.test(text) && !/period/.test(text), 'nor shown: ' + JSON.stringify(text.slice(-200)));
  assert.ok(!h.s.history.some(m => /Amazing/.test(m.content)), 'what the guard dropped is not remembered either');
  const stats = named(h.metrics, 'reply_guard');
  assert.equal(stats.length, 3); assert.ok(stats.every(s => s.dropped_praise >= 1 && s.stopped === 1)); assert.ok(stats[1].dropped_repeat_opener >= 1 && stats[2].dropped_repeat_opener >= 1);
  assert.ok(Object.values(stats[0]).every(Number.isFinite), 'numbers only');
});

test('b2: the word cap ends a long reply but the end token is still found, so a closing is never lost', async () => {
  const long = 'Thank you for walking me through all of this today, it has been a really clear picture of the project and what it changed for the claims team and the clients involved. ';
  const h = harness({ flags: { selector: 'legacy' }, said: ['That is everything I wanted to say about it, thank you very much.'], talk: n => n === 0 ? ['Hello there. ', 'What happened?'] : [long, long, 'I will prepare your report for you to review. ', '[[END]]'] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2);
  await until(() => h.events.some(e => e.type === 'wrap_up'));
  assert.ok(named(h.metrics, 'reply_guard').some(s => s.capped_words >= 1), 'the 45-word cap applied');
});

test('b3: a closing for the time limit is not capped', async () => {
  const closing = 'We are out of time now so let me close here, and thank you for giving me such a thorough and honest account of the whole project from the very beginning to the end.';
  const h = harness({ said: ['Here is my project story and it took quite a while to put together.'], session: { maxSeconds: 120 }, talk: n => n === 0 ? ['Hello. ', 'What happened?'] : [closing] });
  await opened(h);
  for (let i = 0; i < 2300; i++) h.tick();
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.ok(h.s.history.at(-1).content.endsWith('to the end.'), 'the whole closing was said');
  assert.equal(noteOf(h.calls.talker[1], 'NEXT MOVE').length, 0, 'no move for a closing');
});

// (c) The acknowledgement goes out before the talker's first token.
test('c: the acknowledgement is pushed before the first talker token (the model is called in parallel with it, v2.2 V1); a setback never gets an upbeat or earned one', async () => {
  const h = harness({ said: ['We moved the whole billing platform to the new provider last spring with a team of five.'] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  // The model is asked at once, in parallel with the acknowledgement (the scripted model answers in the same tick, so only the audio order is pinned): her own
  // acknowledgement audio (a lead piece of the reply) is queued ahead of every piece of the model's reply.
  const reply = h.calls.order.findIndex(e => e[0] === 'talker' && e[1] === 1), pushes = h.calls.order.filter(e => e[0] === 'push' && e[1] === 'agent-2' && e[3] > 0);
  assert.ok(reply >= 0 && pushes.length > 1 && pushes[0][2] === true, 'the first audio of the reply is her acknowledgement');
  assert.ok(pushes.findIndex(e => e[2] === false) > pushes.findLastIndex(e => e[2] === true), 'all of it before the model\'s own words');
  const ack = h.calls.tts.find(t => ACK_TEXTS.has(t) && screen(h).includes(t));
  assert.ok(ack, 'an acknowledgement was shown: ' + screen(h).slice(-90));
  assert.ok(h.calls.talker[1].some(m => m.content.startsWith('ALREADY SAID (server): you have just said "' + ack + '"')), 'the talker is told not to acknowledge again');
  assert.deepEqual(named(h.metrics, 'ack').map(a => a.category).length, 1);
});

test('c2: a setback utterance gets a neutral acknowledgement: never earned, promising, thanks-for-the-detail or a bare yes', async () => {
  const setbacks = ['The pilot failed completely and the client was disappointed, we had to roll the whole thing back after two months.',
    'We could not get the budget approved and the project was cancelled before it reached production at all.',
    'It did not work out, the pilot was shut down after a few weeks because nobody used it.',
    'It was a difficult project, the first release failed in production and the customer cancelled the rest of the contract.'];
  for (const said of setbacks) {
    const h = harness({ said: [said] });
    await opened(h);
    talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
    const [ack] = named(h.metrics, 'ack');
    assert.ok(ack, said);
    assert.ok(['setback_neutral', 'correction_thanks', 'confidential_ok', 'no_number_fine'].includes(ack.category), ack.category);
    const shown = screen(h), played = [...ACK_TEXTS].find(t => shown.endsWith('\n\n' + t + ' Thanks.') || shown.includes('\n\n' + t + ' '));
    assert.ok(!played || !ACK_OF('earned_result').has(played) && !ACK_OF('promising_unverified').has(played) && !ACK_OF('thanks_detail').has(played) && !/^(Yeah|Yes)\.$/.test(played), played);
    assert.match(noteOf(h.calls.talker[1], 'NEXT MOVE')[0], /Acknowledge the event neutrally and judge no one/);
    await h.s.end(false); clearPcmCache();
  }
});

test('c3: a neutral acknowledgement only in admin sessions (v2.2 V1), none after a question to ATLAS or after a short answer; the bank is prewarmed once', async () => {
  for (const [admin, said, expected] of [[true, 'We moved the whole billing platform to the new provider last spring with a team of five.', true],
    [false, 'Can you say that again, what exactly do you need to know about the team size and the budget?', false], [false, 'Yes, about six months.', false],
    [false, 'We moved the whole billing platform to the new provider last spring with a team of five.', true]]) {
    const h = harness({ said: [said], session: { admin } });
    await opened(h);
    talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
    assert.equal(named(h.metrics, 'ack').length === 1, expected, (admin ? 'admin: ' : '') + said);
    await h.s.end(false); clearPcmCache();
  }
  const h = harness({ said: [], session: { admin: true } });
  await opened(h, false); await settle();
  assert.ok(ACKS.neutral.en.every(t => h.calls.tts.includes(t)) && !ACKS.earned_result.en.some(t => h.calls.tts.includes(t)), 'admin prewarms the neutral lines only (never an earned or upbeat one)');
  clearPcmCache(); // (the cache is shared by every session of the isolate)
  const g = harness({ said: [] });
  await opened(g, false); await settle(1000);
  assert.ok(ACKS.neutral.en.every(t => g.calls.tts.includes(t)), 'the content-aware bank is synthesised ahead of time (neutral lines at least)');
});

test('c4: acknowledgements do not repeat within four and a plain uptake is said on alternate replies; an earned result needs its basis and a gap of three', async () => {
  const said = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].map(n => `We worked through the ${n} stage of the migration with the team and it went to plan overall.`);
  const h = harness({ said });
  await opened(h);
  for (let i = 1; i <= 6; i++) { talked(h); await until(() => h.calls.talker.length === i + 1 && !h.s.busy()); }
  const acks = h.events.filter(e => e.type === 'agent_text' && e.text.startsWith('\n\n') && ACK_TEXTS.has(e.text.trim())).map(e => e.text.trim());
  assert.ok(acks.length >= 3 && acks.length < 6, 'a plain uptake is said on alternate replies at most (H1): ' + acks.length);
  for (let i = 0; i < acks.length; i++) assert.ok(!acks.slice(Math.max(0, i - 4), i).includes(acks[i]), 'no repeat within four: ' + acks.join(' | '));
});

// (d) The legacy flags reproduce the earlier behaviour.
test('d: legacy flags: analyst guidance one turn late, stock fillers, no guard, every word voiced', async () => {
  const stream = () => ['Amazing! ', 'Thanks so much for that. ', 'What was the baseline? ', 'And who measured it?'];
  const h = harness({ said: ['We cut triage time by about 40% after the rollout across all three regional support teams.', 'We moved the whole billing platform to the new provider last spring with a team of five.'],
    flags: { selector: 'legacy', acks: 'legacy', replyGuard: 'off' }, talk: () => stream() });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  await until(() => h.s.guidance !== null);
  talked(h); await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.ok(h.calls.talker[2].some(m => m.content.startsWith('ANALYST_GUIDANCE') && m.content.includes('measurement')), 'the plan of the turn before');
  assert.ok(!h.calls.talker.flat().some(m => m.content.startsWith('NEXT MOVE')), 'no server move');
  assert.equal(h.s.humane.asked.length, 0); assert.equal(named(h.metrics, 'ack').length, 0);
  assert.ok(spoken(h.calls).includes('Amazing!') && spoken(h.calls).includes('And who measured it?'), 'nothing is filtered');
  assert.equal(named(h.metrics, 'reply_guard').length, 0);
  const shown = screen(h);
  assert.ok(/Amazing! Thanks so much/.test(shown) && /And who measured it\?/.test(shown));
  assert.ok(h.calls.tts.filter(t => ACK_TEXTS.has(t)).every(t => FILLERS.en.includes(t)), 'only the four stock fillers are synthesised');
  assert.ok(h.calls.tts.some(t => FILLERS.en.includes(t)), 'prewarmed');
  assert.ok(['Okay.', 'Right.', 'I see.', 'Yeah.'].some(f => shown.includes('\n\n' + f + ' ')), 'a stock filler was played after the real answer');
});

test('d2: legacy selector alone keeps the analyst guidance and the content acks; v2 selector with legacy acks keeps the move and the fillers', async () => {
  const a = harness({ said: ['We moved the whole billing platform to the new provider last spring with a team of five.'], flags: { selector: 'legacy' } });
  await opened(a); talked(a); await until(() => a.calls.talker.length === 2 && !a.s.busy());
  assert.equal(noteOf(a.calls.talker[1], 'NEXT MOVE').length, 0); assert.equal(named(a.metrics, 'ack').length, 1);
  const b = harness({ said: ['We moved the whole billing platform to the new provider last spring with a team of five.'], flags: { acks: 'legacy' } });
  await opened(b); talked(b); await until(() => b.calls.talker.length === 2 && !b.s.busy());
  assert.equal(noteOf(b.calls.talker[1], 'NEXT MOVE').length, 1); assert.equal(named(b.metrics, 'ack').length, 0);
});

// (e) The opening is two cached pieces; only the first is protected.
test('e: the introduction is two cached pieces; barge-in during the first is ignored, during the second it interrupts', async () => {
  assert.equal(GREETING_PIECES.en.join(' '), GREETINGS.en); assert.equal(WELCOME_BACK_PIECES.en.join(' '), WELCOME_BACK.en);
  const h = harness({ said: [] });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => h.events.filter(e => e.type === 'agent_text').length >= 2);
  assert.deepEqual(h.calls.tts.slice(0, 2), GREETING, 'two pieces, synthesised at once');
  assert.equal(h.s.protectedMs, 100, 'only the first piece (100 ms of fake audio) is protected, not both');
  assert.ok(h.s.greetingPlaying());
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  say(h, [[0.2, .001], [0.6, .5]]); // sustained speech while the first piece is still playing
  assert.ok(!h.events.some(e => e.type === 'user_speaking' || e.type === 'clear_audio'), 'the first piece cannot be cut');
  say(h, [[1.3, .001]]); await settle(5);
  h.s.playedMs['agent-1'] = 100; // the browser reports the first piece played: the second is playing
  assert.ok(!h.s.greetingPlaying(), 'protection ends with the first piece');
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  h.calls.probeText = 'sorry, one moment'; say(h, [[1.0, .5]]); await settle();
  assert.ok(h.events.some(e => e.type === 'clear_audio') && h.events.some(e => e.type === 'user_speaking'), 'during the second piece the consultant may interrupt, with words');
  const heard = h.s.history.filter(m => m.role === 'assistant').at(-1)?.content || '';
  assert.ok(heard.startsWith(GREETING[0]) && heard.includes('[interrupted'), 'what was heard of the introduction is recorded');
});

test('e2: the second session reuses both cached pieces, and every cached language has two pieces that rejoin its greeting', async () => {
  for (let i = 0; i < 2; i++) {
    const h = harness({ said: [] });
    await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
    await until(() => h.calls.talker.length >= 1);
    assert.deepEqual(GREETING.map(p => h.calls.tts.includes(p)), [i === 0, i === 0], i ? 'both cached' : 'both synthesised');
    await h.s.end(false); open.delete(h.s);
  }
  for (const [lang, joined] of Object.entries(GREETINGS)) {
    const [a, b] = GREETING_PIECES[lang];
    assert.ok(a && b && `${a} ${b}` === joined, lang); assert.ok(/[.!?]$/.test(a) && /[.!?]$/.test(b), lang + ': each piece ends at a sentence boundary');
    assert.equal(WELCOME_BACK_PIECES[lang].join(' '), WELCOME_BACK[lang]); assert.equal(WELCOME_BACK_PIECES[lang][1], b, lang + ': the disclosure is the same piece');
  }
  assert.deepEqual(Object.keys(GREETING_PIECES), Object.keys(WELCOME_BACK_PIECES));
});

// (f) Talker settings.
test('f: the talker is asked for at most 160 tokens (TALKER_MAX_TOKENS), and returning the stream cancels the model', async () => {
  assert.equal(TALKER_MAX_TOKENS, 160);
  const seen = []; let cancelled = 0;
  const env = { TALKER_MODEL: 'm', AI: { async run(model, input) {
    seen.push(input);
    return new ReadableStream({ start(c) { const enc = new TextEncoder(); c.enqueue(enc.encode('data: {"response":"One. "}\n')); c.enqueue(enc.encode('data: {"response":"Two. "}\n')); }, cancel() { cancelled += 1; } });
  } } };
  for (const [vars, want] of [[{}, 160], [{ TALKER_MAX_TOKENS: '90' }, 90], [{ TALKER_MAX_TOKENS: 'x' }, 160], [{ TALKER_MAX_TOKENS: '-3' }, 160]]) {
    const ai = workersAI({ ...env, ...vars });
    const it = ai.chatStream([{ role: 'user', content: 'hi' }]);
    assert.equal((await it.next()).value, 'One. ');
    assert.equal(seen.at(-1).max_tokens, want, JSON.stringify(vars)); assert.equal(seen.at(-1).stream, true); assert.equal(seen.at(-1).temperature, 0.7);
    const before = cancelled; await it.return(); await settle(5);
    assert.equal(cancelled, before + 1, 'stopping early cancels the upstream stream');
  }
});

// (g) Latency.
test('g: one turn_timeline metric per turn, numbers only; SPECULATIVE_STT is a documented no-op', async () => {
  const h = harness({ said: ['We moved the whole billing platform to the new provider last spring with a team of five.'], flags: { speculativeStt: true } });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const lines = named(h.metrics, 'turn_timeline');
  assert.equal(lines.length, 1, 'the opening is not a turn');
  assert.deepEqual(Object.keys(lines[0]), ['stt_ms', 'selector_ms', 'first_token_ms', 'first_audio_ms', 'reply_gap_ms']);
  assert.ok(Object.values(lines[0]).every(v => Number.isFinite(v) && v >= 0), JSON.stringify(lines[0]));
  assert.equal(named(h.metrics, 'stt').length, 1, 'transcription happens exactly as before: nothing speculative');
});

test('g2: the metrics never carry transcript or project content', async () => {
  const h = harness({ said: ['We cut onboarding by 40% in Q3 for Project Falcon with Alex and the whole claims team.'] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const all = JSON.stringify(h.metrics);
  assert.ok(!/Falcon|Alex|onboarding|40%/.test(all), all.slice(0, 300));
});

// (h) The guard can empty a reply: ATLAS still asks its move's question.
test('h: a reply the guard empties is replaced by the move\'s own question, never silence', async () => {
  const h = harness({ said: ['We moved the whole billing platform to the new provider last spring with a team of five.'], talk: n => n === 0 ? ['Hello there. ', 'What happened?'] : ['Amazing! ', 'Incredible! '] });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const move = h.s.humane.asked.at(-1);
  assert.ok(move.say.includes('?') && questions(move.say) === 1);
  assert.ok(spoken(h.calls).includes(move.say), 'the move\'s own wording was voiced: ' + JSON.stringify(spoken(h.calls)));
  assert.ok(screen(h).endsWith(move.say) && !/Amazing/.test(screen(h)), 'and shown with its audio');
  assert.ok(h.s.history.at(-1).content.endsWith(move.say) && !/Amazing/.test(h.s.history.at(-1).content), 'the history holds what was voiced');
  assert.equal(named(h.metrics, 'reply_fallback').length, 1);
  assert.ok(named(h.metrics, 'reply_guard').at(-1).dropped_praise >= 1);
});

// Move bookkeeping.
test('i: a reply the consultant carried on over after her own words were heard keeps its move in the asked log (v2.2 V1: it is never taken back); the next turn is selected once', async () => {
  let hold, gated = true;
  const h = harness({ said: ['We rebuilt the claims intake process for the insurance client during the pilot.', 'Then we cut the onboarding backlog by a third in two months.'],
    talk: (n, m) => n === 0 ? ['Hello. ', 'What happened?'] : (async function* () { yield 'Oh nice. '; if (n === 1 && gated) await new Promise(r => { hold = r; }); yield 'What changed for the team?'; })() });
  await opened(h);
  talked(h);
  await until(() => h.calls.talker.length === 2 && h.s.shown.item === 'agent-2');
  assert.equal(h.s.humane.asked.length, 1, 'the first part was answered with one move');
  h.calls.probeText = 'then we cut the backlog'; say(h, [[1.2, .2]]); await settle(); say(h, [[1.3, .001]]); // (words stop her: v2.2 V1)
  await until(() => h.calls.talker.length === 3);
  gated = false; hold?.();
  await until(() => !h.s.busy());
  assert.equal(h.s.humane.asked.length, 2, 'the interrupted reply\'s move stays (she had begun it), and the new answer has its own');
  assert.ok(noteOf(h.calls.talker[2], 'NEXT MOVE').length === 1);
});

test('i2: a move she never said (reply cut before her own words) is not counted as asked', async () => {
  let hold;
  const h = harness({ said: ['We moved the whole billing platform to the new provider last spring with a team of five.', 'No wait, it was actually for the claims team, not billing at all.'],
    talk: n => n === 0 ? ['Hello. ', 'What happened?'] : (async function* () { await new Promise(r => { hold = r; }); yield 'What changed?'; })() });
  await opened(h);
  talked(h); await until(() => h.calls.talker.length === 2 && h.s.humane.asked.length === 1);
  h.s.interrupt(); // cut while the model is still composing: only her acknowledgement was heard
  assert.equal(h.s.humane.asked.length, 0, 'the question was never put');
  hold?.();
});

test('j: question_repeat is counted when the selector had to avoid saying a question again', async () => {
  const h = harness({ said: ['Sure, let me explain what we did on that project last year in some detail for you.'] });
  await opened(h);
  h.s.humane.asked.push({ kind: 'ask', intent: 'stakes', field: 'stakes', rung: 2, say: QUESTION_BANK.ownership.en[1], why: 'ladder:stakes', reaction: 'none', ack_category: null });
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const move = h.s.humane.asked.at(-1);
  assert.ok(move.why.includes('+rv'), move.why);
  assert.deepEqual(named(h.metrics, 'question_repeat'), [{ variant: 1, skipped: 0 }]);
});

test('k: ANALYST_WAIT_MS: while the acknowledgement plays the move is chosen again from the analyst\'s plan', async () => {
  const said = ['Sure, let me explain what we did on that project last year in some detail for you.'];
  const off = harness({ said, analyst: 'now' });
  await opened(off); talked(off); await until(() => off.calls.talker.length === 2 && !off.s.busy());
  const quick = off.s.humane.asked.at(-1);
  const h = harness({ said, flags: { analystWaitMs: 300 }, analyst: 'now' });
  // the fake analyst files a "contribution" detail for this turn, which is what the first selection (without it) would have asked about
  const base = h.s.ai.analyst; h.s.ai.analyst = async m => { const seg = JSON.parse(m[1].content.split('\n').slice(1).join('\n')).new_segment;
    return [{ id: 'z', name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'contribution', item_id: seg.item_id, quote: seg.text.slice(0, 18) }] }) }]; };
  await opened(h); talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.equal(quick.field, 'contribution', 'without the wait the move is the ladder\'s first choice');
  const refined = h.s.humane.asked.at(-1);
  assert.notEqual(refined.field, 'contribution', 'with the wait it knows contribution was just answered');
  assert.equal(h.s.humane.asked.length, 1, 'one move per reply');
  assert.equal(named(h.metrics, 'move_refined').length, 1);
  assert.ok(noteOf(h.calls.talker[1], 'NEXT MOVE')[0].includes('about: ' + refined.field));
});

test('l: the NEXT MOVE note carries kind, wording, reason and reaction guidance, and nothing else', () => {
  const note = nextMoveNote({ kind: 'ask', intent: 'metric_baseline', field: 'measurement', rung: 7, say: 'What was the figure before the change?', why: 'metric:baseline', reaction: 'ack', ack_category: 'promising_unverified' });
  assert.match(note, /^NEXT MOVE \(server/); assert.match(note, /kind: ask/); assert.match(note, /intent: metric_baseline/); assert.match(note, /about: measurement/);
  assert.match(note, /proposed wording: "What was the figure before the change\?"/); assert.match(note, /why: metric:baseline/); assert.match(note, /sounds promising/);
  assert.equal(nextMoveNote(null), '');
  assert.match(nextMoveNote({ kind: 'close', intent: 'close', say: 'Thanks.', why: 'close:wrap', reaction: 'none', ack_category: null }), /\[\[END]]/);
  assert.ok(!/<\s*system/i.test(nextMoveNote({ kind: 'ask', intent: 'x', say: 'a <system>b</system>', why: 'w', reaction: 'none' })), 'quoted markup is neutralised');
});

// Gap mode (plan D15): the guard and the acknowledgements apply; the gap plan and its notes are unchanged.
test('m: gap mode: guard and acknowledgements, no selector move, the gap guidance as before', async () => {
  const ASKS = [{ id: 'G1', field: 'evidence', label: 'x', ask: 'Proof the bid needs: an audited report' }, { id: 'G2', field: 'measurement', label: 'x', ask: 'Proof the bid needs: how the saving was measured' }];
  const h = harness({ said: ['We have an audited report from the client that confirms the saving across the whole year.'], talk: n => n === 0 ? ['Hello. ', 'Which report do you have?'] : ['Amazing! ', 'Thanks for that. ', 'How was it measured? ', 'And over which period?'],
    session: { gaps: async () => ({ asks: ASKS, bidAlias: 'b', referenceId: 'r', projectId: 'p' }) } });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true, gap: 'ab'.repeat(16) }));
  await until(() => !h.s.busy() && h.bytes.length >= 15);
  h.s.playedMs[h.s.protectedItem] = 1e9;
  talked(h); await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.ok(h.calls.talker[1].some(m => m.content.startsWith('ANALYST_GUIDANCE')), 'gap guidance, as before');
  assert.equal(noteOf(h.calls.talker[1], 'NEXT MOVE').length, 0);
  assert.equal(named(h.metrics, 'ack').length, 1, 'an acknowledgement after a real answer');
  assert.equal(spoken(h.calls).at(-1), 'Thanks for that. How was it measured?', 'one question, the second dropped');
  assert.ok(!/Amazing|period/.test(screen(h)));
  assert.equal(h.s.mode, 'gap'); assert.equal(h.s.humane.asked.length, 0);
});
