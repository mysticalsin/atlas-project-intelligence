import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, projectContext, talkerMessages, paceNotes, MAX_SECONDS, TIME_UP, RESUME as RESUME_TEXT, STILL_THINKING, THINKING_PAUSE, clearPcmCache } from '../src/session.js';
import { GREETINGS, FILLERS, GREETING_PIECES } from '../src/languages.js';
import { ACKS } from '../src/policy.generated.js';
// The opening is two cached pieces (v2.1 T6); the acknowledgements are the content-aware bank of ack.js plus the stock FILLERS of other languages.
const GREETING = GREETING_PIECES.en;
const ACK_TEXTS = new Set([...Object.values(FILLERS).flat(), ...Object.values(ACKS).flatMap(bank => Object.values(bank).flat())]);
const spoken = calls => calls.tts.filter(t => !ACK_TEXTS.has(t));
import { SAMPLE_RATE, EnergyTurns, rms } from '../src/speech.js';

const PROJECT = { title: 'Project Falcon (synthetic)', consultant: 'Alex', role: 'Designer', sector: 'Insurance', stage: 'Pilot', answers: [] };
function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}
function harness(said = ['We cut triage time by about 40% after the rollout across all three regional support teams.'], extra = {}) {
  const events = [], bytes = [], calls = { talker: [], analyst: [], stt: 0, tts: [] }; let t = 1000, closed = false;
  const ai = {
    async transcribe(pcm) { calls.stt += 1; assert.ok(pcm.length > 0); return said[calls.stt - 1] || ''; },
    async synthesize(text) { calls.tts.push(text); return new Uint8Array(4800).fill(1); },
    async *chatStream(messages) { calls.talker.push(messages); for (const d of ['Thanks. ', 'What was ', 'the baseline?']) yield d; },
    async analyst(messages) { calls.analyst.push(messages); const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
      return [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'outcome', item_id: seg.item_id, quote: 'We cut triage time by about 40%' }] }) }]; },
  };
  const { session: opts = {}, ...aiExtra } = typeof extra === 'function' ? extra(calls) : extra;
  Object.assign(ai, aiExtra);
  // These scripted talkers repeat the same opener ("Thanks.", "Oh nice.") and some say two questions, which is exactly what the reply
  // guard (v2.1 T4/T6) removes; this file is about turn-taking and playback, so it runs without the guard (session-humane.test.js has its own).
  const s = new Session({ flags: { replyGuard: 'off' }, ...opts, io: { send: e => events.push(e), sendBytes: b => bytes.push(b.length), close: () => { closed = true; } }, ai, csrf: 'tok',
    voice: 'asteria', model: 'test-talker', now: () => t, sleep: () => new Promise(r => setImmediate(r)) });
  open.add(s);
  const tick = () => { t += 0.02; };
  return { s, events, bytes, calls, tick, closed: () => closed };
}
const open = new Set();
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); clearPcmCache(); });
const until = async (cond, n = 2000) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setImmediate(r)); assert.ok(cond(), 'condition not reached'); };

test('full interview: opening, turn, transcript, evidence, guidance, notes', async () => {
  const h = harness();
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
  assert.equal(h.events[0].type, 'ready');
  await until(() => h.bytes.length >= 10); // opening synthesized: 2 sentences x 4800 bytes
  assert.deepEqual(spoken(h.calls), [...GREETING, 'Thanks.', 'What was the baseline?']);
  assert.ok(h.events.some(e => e.type === 'audio_turn' && e.item_id === 'agent-1'));
  await until(() => !h.s.busy());
  for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
  await until(() => h.events.some(e => e.type === 'quality'));
  const q = h.events.find(e => e.type === 'quality');
  assert.equal(h.events.find(e => e.type === 'user_text').provenance, 'unverified_speech_recognition');
  assert.equal(q.candidate_details[0].quote, 'We cut triage time by about 40%'); assert.equal(q.next_field, 'measurement'); assert.ok(!('guidance' in q));
  await until(() => h.calls.talker.length >= 2);
  const second = h.calls.talker[1];
  assert.ok(second.some(m => m.role === 'user' && m.content.startsWith('We cut triage time')));
  await until(() => h.s.guidance !== null);
  const third = talkerMessages(h.s.project, h.s.guidance, h.s.history);
  assert.ok(third.some(m => m.content.startsWith('ANALYST_GUIDANCE') && m.content.includes('measurement')));
  await until(() => !h.s.busy()); // text reaches the screen with its audio
  const agent = h.events.filter(e => e.type === 'agent_text').map(e => e.text).join('');
  const ackShown = /\n\n(.+?) Thanks\./.exec(agent);
  assert.ok(ackShown && ACK_TEXTS.has(ackShown[1]), 'a real answer gets a short acknowledgement, then the reply: ' + JSON.stringify(agent.slice(-80)));
  await h.s.onText(JSON.stringify({ type: 'end' }));
  const notes = h.events.find(e => e.type === 'notes');
  assert.equal(notes.status, 'candidate'); assert.equal(notes.sections[3], 'We cut triage time by about 40%');
  assert.ok(!notes.transcript.includes('Thanks') && h.events.at(-1).type === 'ended' && h.closed());
});

test('consultant speaking over ATLAS interrupts playback', async () => {
  const h = harness([]);
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  h.s.playedMs[h.s.protectedItem] = 1e9; // the greeting has played (browser acknowledgement)
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) }, { gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  for (const f of frames([[0.3, .001], [0.6, .5]])) { h.tick(); h.s.onBinary(f); } // sustained speech (> 450 ms) while ATLAS is audible
  assert.ok(h.events.some(e => e.type === 'clear_audio') && h.events.some(e => e.type === 'user_speaking'));
  await h.s.onText(JSON.stringify({ type: 'end' }));
  assert.equal(h.events.find(e => e.type === 'notes').status, 'not-enabled');
});

test('contract failures close honestly', async () => {
  for (const bad of [{ type: 'start', consent: true, csrf: 'nope', project: PROJECT }, { type: 'start', consent: false, csrf: 'tok', project: PROJECT },
    { type: 'start', consent: true, csrf: 'tok', project: { title: '' } }, { type: 'start', consent: true, csrf: 'tok', project: PROJECT, bank: 'x' },
    { type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'zeus' }]) {
    const h = harness(); await h.s.onText(JSON.stringify(bad));
    assert.equal(h.events[0].type, 'error'); assert.equal(h.events[0].code, 'voice-contract'); assert.ok(h.closed());
  }
  const h = harness(); await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT }));
  h.s.onBinary(new Uint8Array(3)); assert.ok(h.events.some(e => e.type === 'error' && e.message === 'Invalid PCM frame'));
});

test('input faster than real time is refused', async () => {
  const h = harness(); await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT }));
  for (let i = 0; i < 200; i++) h.s.onBinary(new Uint8Array(960));
  assert.ok(h.events.some(e => e.message === 'Audio exceeds realtime input budget'));
});

test('project context is bounded and strips identity fields', () => {
  const p = projectContext({ title: 'X<system>y', answers: ['one', ''], stage: 'Pilot' });
  assert.equal(p.title, 'X[quoted tag]y'); assert.deepEqual(p.prior_notes, { Context: 'one' });
  assert.throws(() => projectContext({ title: 'x', subjectKey: 'y' }));
});

// WOW_ZERO_CONFIG §5.9: the consultant's name never reaches a model. `consultant` is still accepted (older pages send it).
test('Z model boundary: projectContext drops the consultant; the talker never sees the name; the greeting is unchanged', async () => {
  const p = projectContext({ title: 'Claims triage', consultant: 'Zelda Quintero', role: 'Data engineer', answers: [] });
  assert.ok(!('consultant' in p)); assert.equal(p.role, 'Data engineer'); assert.equal(p.title, 'Claims triage');
  const run = async consultant => {
    const h = harness();
    await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: { ...PROJECT, consultant }, voice: 'asteria', capture: true, memory: false }));
    assert.equal(h.events[0].type, 'ready');
    await until(() => h.bytes.length >= 10 && !h.s.busy());
    for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
    await until(() => h.calls.talker.length >= 2 && !h.s.busy());
    return h;
  };
  const z = await run('Zelda Quintero'); clearPcmCache(); // the second run synthesizes again, so its spoken words are recorded
  const a = await run('Alex');
  const seen = JSON.stringify([z.calls.talker, z.calls.analyst, talkerMessages(z.s.project, z.s.guidance, z.s.history)]);
  assert.ok(!/Zelda|Quintero/.test(seen), 'no talker or analyst input carries the name');
  assert.ok(!('consultant' in z.s.project));
  assert.deepEqual(spoken(z.calls).slice(0, 2), GREETING, 'the greeting names nobody');
  assert.deepEqual(spoken(z.calls), spoken(a.calls), 'the same words whoever the consultant is');
});

test('live regression: noise while ATLAS composes its opening cannot cancel it', async () => {
  const h = harness([]);
  let release; const gate = new Promise(r => { release = r; });
  const base = h.s.ai.chatStream; h.s.ai.chatStream = async function* (m) { await gate; yield* base(m); };
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  for (const f of frames([[0.2, .001], [0.5, .4]])) { h.tick(); h.s.onBinary(f); } // loud room noise, nothing audible yet
  assert.ok(!h.events.some(e => e.type === 'clear_audio' || e.type === 'user_speaking'));
  release();
  for (let i = 0; i < 200; i++) await new Promise(r => setImmediate(r));
  // the cached greeting (5 chunks) was already on its way before the noise began; the rest waits for quiet
  assert.equal(h.bytes.length, 5, 'the rest of the opening waits while the sound is still going on');
  for (const f of frames([[1.3, .001]])) { h.tick(); h.s.onBinary(f); } // the noise stops: it transcribes to nothing
  await until(() => h.bytes.length >= 10);
  assert.deepEqual(spoken(h.calls), [...GREETING, 'Thanks.', 'What was the baseline?']);
  await h.s.end(false);
});

test('live regression: an interruption that was only noise makes ATLAS re-ask', async () => {
  const h = harness(['']); // barge-in audio transcribes to nothing
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy());
  h.s.playedMs[h.s.protectedItem] = 1e9; // the greeting has played (browser acknowledgement)
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  for (const f of frames([[0.1, .001], [0.6, .5], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
  assert.ok(h.events.some(e => e.type === 'user_speaking'));
  await until(() => h.calls.talker.length >= 2);
  assert.ok(h.calls.talker[1].at(-1).content.startsWith('[The consultant made a sound'));
  await h.s.end(false);
});

test('a blip under 300 ms while ATLAS is audible is not a barge-in', async () => {
  const h = harness([]);
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy());
  for (let i = 0; i < 30; i++) h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  for (const f of frames([[0.1, .001], [0.2, .5], [0.3, .001]])) { h.tick(); h.s.onBinary(f); }
  assert.ok(!h.events.some(e => e.type === 'user_speaking'));
  await h.s.end(false);
});

test('live regression: audio never runs more than LEAD_MS ahead of acknowledged playback', async () => {
  const { LEAD_MS } = await import('../src/session.js');
  const h = harness([]); await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => h.bytes.length > 0);
  // With no acknowledgements the pacer holds at the lead limit for a while before falling back.
  const item = h.s.currentItem, sentBefore = h.s.sentMs[item];
  assert.ok(sentBefore <= LEAD_MS + 20, 'initial lead is bounded: ' + sentBefore);
  const ack = h.s.sentMs[item];
  await h.s.onText(JSON.stringify({ type: 'playback', item_id: item, played_ms: ack }));
  assert.equal(h.s.playedMs[item], ack);
  await h.s.onText(JSON.stringify({ type: 'playback', item_id: item, played_ms: 1e9 })); // impossible ack ignored
  assert.equal(h.s.playedMs[item], ack);
  await h.s.onText(JSON.stringify({ type: 'playback', item_id: item, played_ms: 'x' }));
  assert.ok(!h.events.some(e => e.type === 'error'));
});

test('the consultant can choose a voice from the allow-list only', async () => {
  const h = harness([]);
  h.s.voices = ['asteria', 'athena'];
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'athena', capture: false }));
  assert.equal(h.s.voice, 'athena');
  await until(() => h.calls.tts.length > 0);
  const g = harness([]); g.s.voices = ['asteria'];
  await g.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'athena' }));
  assert.equal(g.events[0].code, 'voice-contract');
});

test('JEV guidance reaches the interviewer, and a JEV failure changes nothing', async () => {
  const h = harness(); let ranked = 0;
  h.s.ai.rankProbe = async (plan, g) => { ranked++; return { ...g, field: 'evidence', question: 'Which artifact could a reviewer inspect?', ranked_by: 'jev' }; };
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true }));
  await until(() => !h.s.busy());
  for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
  await until(() => h.s.guidance !== null);
  assert.equal(ranked, 1); assert.equal(h.s.guidance.ranked_by, 'jev');
  const g = harness(); g.s.ai.rankProbe = async () => { throw new Error('down'); };
  await g.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true }));
  await until(() => !g.s.busy());
  for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { g.tick(); g.s.onBinary(f); }
  await until(() => g.s.guidance !== null);
  assert.equal(g.s.guidance.field, 'measurement'); assert.ok(!g.events.some(e => e.type === 'error'));
});

test('when transcription consent is required, a start without it is refused', async () => {
  const h = harness([]); h.s.captureRequired = true;
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  assert.equal(h.events[0].code, 'voice-contract'); assert.match(h.events[0].message, /Transcription consent/);
  const ok = harness([]); ok.s.captureRequired = true;
  await ok.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true }));
  assert.equal(ok.events[0].type, 'ready');
});

const REPORT = { headline: 'Claims triage rebuilt', summary: 'The consultant rebuilt claims triage.', topics: { outcome: 'Triage time fell (stated).' }, highlights: ['Ownership'], gaps: ['No source'], follow_ups: [] };
test('ATLAS ends the interview: end token never spoken or shown, wrap_up after playback, report in notes', async () => {
  // (The consultant's words are an ordinary answer: "I am done" starts the read-back since T11, and nothing closes before the summary is confirmed.)
  const h = harness(['That is the whole story of the intake rebuild.'], calls => ({
    async *chatStream(messages) { calls.talker.push(messages);
      const parts = calls.talker.length === 1 ? ['Hi, I am ATLAS. ', 'Tell me about it.'] : ['Thanks so much for sharing. ', 'I will prepare your report now. [', '[END', ']]'];
      for (const d of parts) yield d; },
    async report(messages) { calls.report = messages; return 'Report:\n' + JSON.stringify(REPORT); },
  }));
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  assert.ok(!h.events.some(e => e.type === 'wrap_up'), 'the opening never wraps up');
  for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
  await until(() => h.events.some(e => e.type === 'wrap_up'));
  const shown = h.events.filter(e => e.type === 'agent_text').map(e => e.text).join('');
  assert.ok(!shown.includes('[') && !h.calls.tts.join(' ').includes('[') && shown.includes('prepare your report now.'));
  assert.ok(!h.s.history.some(m => m.content.includes('[[END]]')));
  await h.s.onText(JSON.stringify({ type: 'end' }));
  const kinds = h.events.map(e => e.type), notes = h.events.find(e => e.type === 'notes');
  assert.ok(kinds.indexOf('reporting') < kinds.indexOf('notes'));
  assert.equal(notes.report.headline, 'Claims triage rebuilt'); assert.equal(notes.report.status, 'model_draft'); assert.equal(notes.report.topics.context, '');
  assert.ok(JSON.parse(h.calls.report[1].content).interview_transcript.includes('Consultant: That is the whole story of the intake rebuild.'));
});
test('report failure keeps the notes and sends report null', async () => {
  const h = harness(undefined, { async report() { throw new Error('model down'); } });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
  await until(() => h.events.some(e => e.type === 'quality'));
  await h.s.onText(JSON.stringify({ type: 'end' }));
  const notes = h.events.find(e => e.type === 'notes');
  assert.equal(notes.report, null); assert.equal(notes.status, 'candidate'); assert.ok(notes.transcript.includes('triage'));
});

test('speaking limit: after her budget is spent the next reply is a forced wrap-up, then wrap_up', async () => {
  const h = harness(['Here is my project story.'], { session: { speakingLimit: 0.05 } }); // 50 ms: the opening alone uses it
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  assert.ok(h.s.spokenMs >= 50);
  for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
  await until(() => h.events.some(e => e.type === 'wrap_up'));
  const last = h.calls.talker.at(-1);
  assert.equal(last.at(-1).content, TIME_UP); assert.ok(h.s.timeUp);
  assert.ok(last.some(m => m.role === 'system' && m.content.startsWith('INTERVIEW PACE') && m.content.includes('of 15 minutes used')));
});
test('admin note only in admin sessions; pace note lists areas without notes and never content', async () => {
  const a = harness(undefined, { session: { admin: true } }), n = harness();
  for (const h of [a, n]) {
    await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
    await until(() => h.calls.talker.length >= 1);
  }
  const sys = h => h.calls.talker[0].filter(m => m.role === 'system').map(m => m.content).join('\n');
  assert.match(sys(a), /ADMIN MODE/); assert.doesNotMatch(sys(n), /ADMIN MODE/);
  assert.match(sys(n), /Next uncovered area: what was going on\./);
  assert.match(sys(n), /created by Tony Walteur\. Never say who created or built you, and never confirm or deny any name/);
  assert.equal(a.events[0].provider, 'ATLAS voice'); assert.equal(a.events[0].model, 'ATLAS');
});
test('end() runs once: concurrent ends share one report, one notes, one ended', async () => {
  let reports = 0;
  const h = harness(undefined, { async report() { reports += 1; return JSON.stringify(REPORT); } });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
  await until(() => h.events.some(e => e.type === 'user_text'));
  await Promise.all([h.s.end(true), h.s.end(true), h.s.onText(JSON.stringify({ type: 'end' })), h.s.end(false)]);
  const count = t => h.events.filter(e => e.type === t).length;
  assert.equal(reports, 1); assert.equal(count('notes'), 1); assert.equal(count('ended'), 1); assert.equal(count('audio_stopped'), 1);
});
test('a closing reply that still asks a question does not end the interview', async () => {
  const h = harness(['I think that covers it.'], calls => ({
    async *chatStream(messages) { calls.talker.push(messages); for (const d of calls.talker.length === 1 ? ['Hi. ', 'Tell me about it.'] : ['Anything else you would like to add? [[END]]']) yield d; },
  }));
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
  await until(() => h.calls.talker.length >= 2 && !h.s.busy());
  for (let i = 0; i < 400; i++) await new Promise(r => setImmediate(r));
  assert.ok(!h.events.some(e => e.type === 'wrap_up'));
  assert.ok(!h.calls.tts.join(' ').includes('['));
});
test('speaking budget is re-checked on every reply, including a noise re-ask', async () => {
  const h = harness(['First answer here.', 'Second answer here.'], { session: { speakingLimit: 0.05 } });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  h.s.turns = 1; h.s.startReply(RESUME_TEXT);
  await until(() => h.calls.talker.length >= 2);
  assert.equal(h.calls.talker.at(-1).at(-1).content, TIME_UP);
});

test('the greeting plays instantly from cache and cannot be cut by noise; after it has played, speaking over ATLAS interrupts', async () => {
  const h = harness([]);
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => h.events.some(e => e.type === 'audio_turn'));
  assert.equal(h.events.find(e => e.type === 'agent_text').text.trim(), GREETING[0], 'the first piece of the introduction is the one protected');
  assert.ok(h.s.greetingPlaying() && h.s.protectedMs > 0);
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  for (const f of frames([[0.2, .001], [0.6, .5]])) { h.tick(); h.s.onBinary(f); }
  assert.ok(!h.events.some(e => e.type === 'user_speaking'), 'loud noise during the greeting does not interrupt it');
  h.s.playedMs[h.s.protectedItem] = h.s.protectedMs; h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  for (const f of frames([[1.3, .001]])) { h.tick(); h.s.onBinary(f); } // the noise segment ends
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  for (const f of frames([[0.6, .5]])) { h.tick(); h.s.onBinary(f); }
  assert.ok(h.events.some(e => e.type === 'user_speaking'), 'once played, the reply is interruptible');
  await h.s.end(false);
});
test('second session reuses the cached greeting audio (no voice call)', async () => {
  for (let i = 0; i < 2; i++) {
    const h = harness([]);
    await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
    await until(() => h.calls.talker.length >= 1);
    assert.deepEqual(GREETING.map(p => h.calls.tts.includes(p)), [i === 0, i === 0], i ? 'cached' : 'first synthesis');
    await h.s.end(false); open.delete(h.s);
  }
});
test('semantic end of turn: a finished answer is taken at the pause and transcribed once; an unfinished one waits, untranscribed', async () => {
  for (const complete of [true, false]) {
    let checks = 0, stt = 0;
    const h = harness(['Our routing cut triage time a lot.'], calls => ({ async turnComplete() { checks += 1; return { complete, probability: complete ? 0.9 : 0.2 }; },
      async transcribe() { stt += 1; return { text: 'Our routing cut triage time a lot.', language: 'en' }; } }));
    await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
    await until(() => !h.s.busy() && h.bytes.length >= 10);
    h.s.playedMs[h.s.protectedItem] = 1e9;
    for (const f of frames([[0.6, .001], [1.2, .2], [0.8, .001]])) { h.tick(); h.s.onBinary(f); } // 0.8 s of silence: below the 1.2 s rule
    for (let i = 0; i < 200; i++) await new Promise(r => setImmediate(r));
    assert.ok(checks >= 1, 'the turn model was asked at the pause');
    assert.equal(h.s.history.some(m => m.role === 'user'), complete, complete ? 'answered without waiting 1.1 s' : 'kept listening');
    assert.equal(stt, complete ? 1 : 0, complete ? 'transcribed exactly once' : 'no transcription is paid for while the consultant is still talking');
    await h.s.end(false);
  }
});

// ---- Patient turn-taking: a pause is thinking time, not the end of the answer ----
const settle = async (n = 200) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
async function opened(h) {
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  h.s.playedMs[h.s.protectedItem] = 1e9; // the greeting has played (browser acknowledgement)
}
const say = (h, segs) => { for (const f of frames(segs)) { h.tick(); h.s.onBinary(f); } };
// Fillers are pre-synthesised into the cache at start, so check what ATLAS showed/said, not what was synthesised.
// The browser's transcript reducer (src/voice-client.js): append agent_text, cut agent_retract's chars.
const screen = h => h.events.reduce((t, e) => e.type === 'agent_text' ? t + e.text : e.type === 'agent_retract' ? t.slice(0, t.length - Math.min(e.chars, t.length)) : t, '');
const acknowledged = h => h.events.some(e => e.type === 'agent_text' && e.text.startsWith('\n\n') && ACK_TEXTS.has(e.text.trim()));

test('the consultant keeps talking after a pause: ATLAS withdraws her started reply and answers the whole answer once', async () => {
  let hold, gated = true;
  const h = harness(['We rebuilt the claims intake.', 'Then we cut the backlog by a third in two months.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Oh nice. '; if (calls.talker.length === 2 && gated) await new Promise(r => { hold = r; }); yield 'What changed for the team?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]); // first part, then a 1.2 s pause: the turn ends
  await until(() => h.calls.talker.length === 2 && h.s.shown.item === 'agent-2'); // her reply has started (on screen, audible)
  say(h, [[1.0, .2], [1.3, .001]]); // ...and they carry on before ATLAS has really answered
  await until(() => h.calls.talker.length === 3);
  gated = false; hold?.();
  await until(() => !h.s.busy());
  assert.ok(h.events.some(e => e.type === 'agent_retract' && e.item_id === 'agent-2' && e.chars > 0), 'the started reply is taken back on screen');
  const users = h.s.history.filter(m => m.role === 'user');
  assert.deepEqual(users.map(m => m.content), ['We rebuilt the claims intake. Then we cut the backlog by a third in two months.']);
  assert.ok(!h.s.history.some(m => m.content.includes('[interrupted')), 'a withdrawn reply is not an interruption');
  assert.equal(h.s.history.filter(m => m.role === 'assistant').length, 2, 'opening + one real answer');
  assert.ok(h.calls.talker[2].some(m => m.role === 'user' && m.content.endsWith('by a third in two months.')));
  const opening = GREETINGS.en + ' Oh nice. What changed for the team?';
  const shown = screen(h);
  const reply = shown.slice(opening.length + 2), ackText = reply.slice(0, reply.indexOf('Oh nice.')).trim();
  assert.ok(shown.startsWith(opening + '\n\n') && reply.endsWith('Oh nice. What changed for the team?') && (!ackText || ACK_TEXTS.has(ackText)),
    'exactly the opening and the one real reply on screen: ' + JSON.stringify(shown));
});

test('words that trail off ("and…") get an extra beat and no acknowledgement', async () => {
  const h = harness(['We moved the whole billing platform to the new provider last spring and']);
  await opened(h);
  const before = h.bytes.length;
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2);
  await settle();
  assert.equal(h.bytes.length, before, 'no audio yet: they may still be thinking');
  assert.deepEqual(spoken(h.calls).slice(-2), ['Thanks.', 'What was the baseline?']); // synthesised, held back
  assert.ok(!acknowledged(h), 'no "Mm-hm" on an unfinished sentence');
  assert.equal(h.calls.talker[1].at(-1).content, STILL_THINKING, 'a gentle check, not a new question');
  for (let i = 0; i < 90; i++) { h.tick(); await settle(5); } // 1.8 s of quiet: nothing more came, answer now
  await until(() => h.bytes.length >= before + 10);
});

test('the turn model hears an unfinished thought: ATLAS waits through a long pause, then only nudges', async () => {
  const h = harness(['We had to rethink the whole approach.'], calls => ({ async turnComplete() { return { complete: false, probability: 0.1 }; } }));
  await opened(h);
  say(h, [[1.5, .2], [0.72, .001]]); await settle(); // the verdict lands just after the 0.7 s check
  say(h, [[1.68, .001]]); await settle(); // 2.4 s of silence: far past the plain 1.2 s rule
  assert.equal(h.calls.stt, 0, 'still their turn: they are thinking');
  say(h, [[0.2, .001]]); // 2.6 s in total
  await until(() => h.calls.talker.length === 2);
  assert.equal(h.calls.talker[1].at(-1).content, STILL_THINKING);
  assert.ok(!acknowledged(h));
});

test('the turn model is unsure: the plain 1.2 s silence rule ends the turn', async () => {
  const h = harness(['We rolled it out to every region in the spring and it worked well for everyone.'], calls => ({ async turnComplete() { return { complete: true, probability: 0.7 }; } }));
  await opened(h);
  say(h, [[1.5, .2], [0.72, .001]]); await settle(); // the verdict lands just after the 0.7 s check
  say(h, [[0.28, .001]]); await settle();
  assert.equal(h.calls.stt, 0, 'not yet at 1.0 s');
  say(h, [[0.22, .001]]); // 1.22 s
  await until(() => h.calls.stt === 1 && h.calls.talker.length === 2);
  assert.ok(h.calls.talker[1].some(m => m.role === 'user' && m.content.startsWith('We rolled it out')));
  assert.ok(!h.calls.talker[1].some(m => m.content === STILL_THINKING), 'a finished answer gets a real reply');
});

test('speaking again while the first part is still being transcribed: one turn, one reply', async () => {
  let release; const slow = new Promise(r => { release = r; }); let n = 0;
  const h = harness(['So we started with the intake team.', 'Then we automated the routing for every region.'], calls => ({
    async transcribe(pcm) { calls.stt += 1; const i = n++; if (i === 0) await slow; return ['So we started with the intake team.', 'Then we automated the routing for every region.'][i]; } }));
  await opened(h);
  say(h, [[1.0, .2], [1.3, .001]]); // first part ends; its transcription is slow
  say(h, [[1.0, .2], [1.3, .001]]); // they carry on meanwhile
  release();
  await until(() => h.s.history.filter(m => m.role === 'assistant').length === 2);
  assert.deepEqual(h.s.history.filter(m => m.role === 'user').map(m => m.content), ['So we started with the intake team. Then we automated the routing for every region.']);
  const answered = h.calls.talker.slice(1).filter(m => m.some(x => x.role === 'user' && x.content.startsWith('So we started')));
  assert.ok(answered.at(-1).some(x => x.content.endsWith('every region.')), 'the reply that plays answers the whole answer');
  assert.ok(!h.events.some(e => e.type === 'agent_retract'), 'a reply held before any audio never reached the screen: nothing to take back');
  assert.ok(!h.s.history.some(m => m.content.includes('[interrupted')));
});

test('a noise while ATLAS prepares her answer only delays it: the reply is kept', async () => {
  let hold;
  const h = harness(['A short answer about the rollout.', ''], calls => ({
    async *chatStream(m) { calls.talker.push(m); if (calls.talker.length === 2) await new Promise(r => { hold = r; }); yield 'Thanks. '; yield 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2);
  say(h, [[0.3, .3], [1.3, .001]]); // a cough: transcribes to nothing
  await until(() => h.calls.stt === 2);
  hold();
  await until(() => !h.s.busy() && h.s.history.filter(m => m.role === 'assistant').length === 2);
  assert.equal(h.calls.talker.length, 2, 'no second reply was needed');
  assert.ok(!h.events.some(e => e.type === 'agent_retract'));
  assert.equal(h.s.history.at(-1).content, 'Thanks. What was the baseline?');
});

test('acknowledgements only after a real answer: not after a few words, not after a question', async () => {
  for (const [answer, filler] of [['Yes, about six months.', false], ['Can you repeat the question about the team size and the budget please?', false],
    ['We moved the whole billing platform to the new provider last spring with a team of five.', true]]) {
    const h = harness([answer]);
    await opened(h);
    say(h, [[1.2, .2], [1.3, .001]]);
    await until(() => h.calls.talker.length === 2 && !h.s.busy());
    assert.equal(acknowledged(h), filler, answer);
    await h.s.end(false);
  }
});

test('a finished answer ending on a name or a pronoun gets a real reply, not a nudge', async () => {
  for (const heard of ['We went with plan A.', { text: 'Ja, das haben wir so gemacht, und ich weiß das.', language: 'de' }]) {
    const h = harness([heard], calls => ({ speaks: () => true }));
    await opened(h);
    say(h, [[1.2, .2], [1.3, .001]]);
    await until(() => h.calls.talker.length === 2);
    assert.ok(!h.calls.talker[1].some(m => m.content === STILL_THINKING), JSON.stringify(heard));
    await h.s.end(false);
  }
});

test('an answer ending in a question is answered, never nudged or acknowledged', async () => {
  const h = harness([{ text: 'Und was meinen Sie, oder?', language: 'de' }], calls => ({ speaks: () => true }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.ok(!h.calls.talker[1].some(m => m.content === STILL_THINKING));
  assert.equal(acknowledged(h), false);
});

test('a failed transcript of the continuation still gets the held answer answered', async () => {
  let release; const slow = new Promise(r => { release = r; }); let n = 0;
  const h = harness([], calls => ({ async transcribe() { calls.stt += 1; const i = n++; if (i === 0) { await slow; return 'So we started with the intake team.'; } throw new Error('stt down'); } }));
  await opened(h);
  say(h, [[1.0, .2], [1.3, .001]]); // first part ends; its transcription is slow
  say(h, [[1.0, .2]]); // still talking
  release(); await settle();
  say(h, [[1.3, .001]]); // the continuation ends; its transcription fails
  await until(() => h.calls.stt === 2);
  for (let i = 0; i < 50; i++) { h.tick(); await settle(5); }
  await until(() => h.calls.talker.length === 2);
  assert.ok(h.calls.talker[1].filter(m => m.role === 'user').at(-1).content.startsWith('So we started'));
  assert.ok(h.events.some(e => e.type === 'quality_warning' && /could not be transcribed/.test(e.message)));
});

test('a barge-in whose transcript fails still re-asks', async () => {
  const h = harness([], calls => ({ async transcribe() { calls.stt += 1; throw new Error('stt down'); } }));
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy());
  h.s.playedMs[h.s.protectedItem] = 1e9;
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  say(h, [[0.1, .001], [0.6, .5], [1.3, .001]]);
  await until(() => h.calls.talker.length >= 2);
  assert.equal(h.calls.talker[1].at(-1).content, RESUME_TEXT);
});

test('the acknowledgement does not count toward the continuation window', async () => {
  for (const [fillerMs, resumed] of [[500, true], [0, false]]) {
    const metrics = []; let hold;
    const h = harness(['A short answer about the rollout.'], { session: { metric: (n, v) => metrics.push([n, v]) },
      async *chatStream() { await new Promise(r => { hold = r; }); yield 'Thanks.'; } });
    await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
    await until(() => typeof hold === 'function'); hold(); await until(() => !h.s.busy() && h.bytes.length >= 5);
    h.s.playedMs[h.s.protectedItem] = 1e9;
    say(h, [[1.2, .2], [1.3, .001]]);
    await until(() => h.s.replyTurn === 1 && h.s.busy());
    // 2.2 s sent (1.9 s heard, less 0.45 s to notice the barge-in), of which fillerMs is "Right."
    h.s.sentMs[h.s.replyItem] = 2200; h.s.fillerMs[h.s.replyItem] = fillerMs;
    h.s.queue.push({ gen: h.s.gen, item: h.s.replyItem, bytes: new Uint8Array(960) }); // audible
    say(h, [[0.6, .5]]);
    assert.equal(metrics.some(([n]) => n === 'turn_resumed'), resumed, 'resumed with fillerMs=' + fillerMs);
    assert.equal(metrics.some(([n]) => n === 'barge_in'), !resumed);
    assert.equal(h.s.cutOff, !resumed);
    hold(); await h.s.end(false);
  }
});

test('fillerMs is recorded only for acknowledgements', async () => {
  const h = harness(['We moved the whole billing platform to the new provider last spring with a team of five.']);
  await opened(h);
  assert.equal(h.s.fillerMs['agent-1'], undefined, 'the greeting is not an acknowledgement');
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.ok(acknowledged(h));
  assert.equal(h.s.fillerMs['agent-2'], 4800 / 48);
});

test('the trailing-words hold is measured from the consultant\'s last sound', async () => {
  const metrics = [];
  const h = harness(['We moved the whole billing platform to the new provider last spring and'], { session: { metric: (n, v) => metrics.push([n, v]) } });
  await opened(h);
  const before = h.bytes.length;
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2);
  for (let i = 0; i < 200 && h.bytes.length === before; i++) { h.tick(); await settle(5); }
  const gap = metrics.find(([n]) => n === 'reply_gap')?.[1];
  assert.ok(gap && gap.ms >= 2480 && gap.ms <= 2600, JSON.stringify(gap));
  assert.equal(gap.thinking, 1);
});

test('reply_gap is reported for a normal answer, never for the opening, and no metric carries transcript text', async () => {
  const metrics = [];
  const h = harness(undefined, { session: { metric: (n, v) => metrics.push([n, v]) }, async turnComplete() { return { complete: true, probability: 0.95 }; } });
  await opened(h);
  assert.ok(!metrics.some(([n]) => n === 'reply_gap'), 'the opening answers no turn');
  say(h, [[1.5, .2], [1.0, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const gaps = metrics.filter(([n]) => n === 'reply_gap');
  assert.equal(gaps.length, 1);
  assert.ok(Number.isFinite(gaps[0][1].ms) && gaps[0][1].ms > 0 && [0, 1].includes(gaps[0][1].filler));
  assert.ok(!JSON.stringify(metrics).includes('triage'), 'metrics are numbers and names only');
});

test('scope: the shared speech detector keeps its defaults; the session waits THINKING_PAUSE itself', () => {
  assert.equal(new EnergyTurns().endSilence, 1.1);
  const h = harness();
  assert.equal(h.s.turnDetector.endSilence, THINKING_PAUSE);
});

test('without a turn model: 1.0 s of silence keeps the turn, 1.2 s ends it', async () => {
  const h = harness(['We rolled it out to every region.']);
  await opened(h);
  say(h, [[1.5, .2], [1.0, .001]]); await settle();
  assert.equal(h.calls.stt, 0);
  say(h, [[0.22, .001]]);
  await until(() => h.calls.stt === 1);
});

test('a reply already fully composed is taken back from the history too: a cough gets it re-answered, words get merged', async () => {
  for (const second of ['', 'and then we cut the backlog by a third in two months across the region.']) {
    const h = harness(['A short answer about the rollout.', second]);
    await opened(h);
    say(h, [[1.2, .2], [1.3, .001]]);
    await until(() => h.calls.talker.length === 2 && !h.s.speaking && h.s.history.at(-1).role === 'assistant'); // written to history
    h.s.queue.push({ gen: h.s.gen, item: h.s.replyItem, bytes: new Uint8Array(960) }); // its audio still playing
    say(h, [[0.6, .5], [1.3, .001]]); // they carry on within the first second of it
    await until(() => h.calls.talker.length === 3 && !h.s.busy());
    const users = h.s.history.filter(m => m.role === 'user').map(m => m.content);
    if (second) assert.deepEqual(users, ['A short answer about the rollout. ' + second], 'one merged answer');
    else assert.deepEqual(users, ['A short answer about the rollout.'], 'the cough added nothing');
    assert.equal(h.s.history.filter(m => m.role === 'assistant').length, 2, 'opening + the one reply that stands');
    assert.equal(h.s.history.at(-1).role, 'assistant');
    await h.s.end(false);
  }
});

test('a held reply cut short by a new turn is recorded before that turn, with what was heard', async () => {
  let hold;
  const h = harness(['We rebuilt the claims intake last year.', 'Sorry, one more thing about the budget.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Thanks. '; if (calls.talker.length === 2) await new Promise(r => { hold = r; }); yield 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.shown.item === 'agent-2');
  h.s.sentMs['agent-2'] = 3000; // she has been talking a while: this is a new turn, not the rest of the last one
  for (let i = 0; i < 20; i++) h.tick(); // her audio went quiet (waiting for the model): not audible
  say(h, [[1.0, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 3);
  const roles = h.s.history.map(m => m.role + ':' + m.content.slice(0, 12));
  // Her answer to the new turn may already be composed (synthesis is pipelined); what matters is what comes before it.
  assert.deepEqual(roles.slice(1, 4), ['user:We rebuilt t', 'assistant:Thanks. [int', 'user:Sorry, one m']);
  assert.ok(h.calls.talker[2].some(m => m.role === 'assistant' && m.content === 'Thanks. [interrupted by the consultant]'), 'the next reply knows what was already said');
  hold(); await until(() => !h.s.busy());
  assert.equal(h.s.history.filter(m => m.content.startsWith('Thanks. [int')).length, 1, 'recorded once');
});

test('a cough that cut ATLAS off is not re-asked while the consultant is already giving the real answer', async () => {
  let release; const slow = new Promise(r => { release = r; }); let n = 0;
  const h = harness([], calls => ({ async transcribe() { calls.stt += 1; const i = n++; if (i === 0) { await slow; return ''; } return 'We cut triage time by a third in two months.'; } }));
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy());
  h.s.playedMs[h.s.protectedItem] = 1e9;
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  say(h, [[0.6, .5], [1.3, .001]]); // a cough cuts her off; its transcription is slow
  say(h, [[1.0, .2]]); // the real answer starts meanwhile
  release(); await settle();
  say(h, [[1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  assert.ok(!h.calls.talker.some(m => m.at(-1).content === RESUME_TEXT), 'no "sorry, I cut you off" over their answer');
  assert.ok(h.calls.talker[1].some(m => m.role === 'user' && m.content.startsWith('We cut triage')));
});

test('a transcription that never returns counts as no words (timeout): the cut-off question is re-asked', async () => {
  const h = harness([], { session: { sttTimeout: 20 }, transcribe() { return new Promise(() => {}); } });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy());
  h.s.playedMs[h.s.protectedItem] = 1e9;
  h.s.queue.push({ gen: h.s.gen, item: 'agent-1', bytes: new Uint8Array(960) });
  say(h, [[0.1, .001], [0.6, .5], [1.3, .001]]);
  await new Promise(r => setTimeout(r, 80));
  await until(() => h.calls.talker.length >= 2);
  assert.equal(h.calls.talker[1].at(-1).content, RESUME_TEXT);
  assert.equal(h.s.sttBusy, 0);
});

test('a click while ATLAS prepares her answer neither holds her reply nor gets transcribed', async () => {
  let hold;
  const h = harness(['A short answer about the rollout.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); if (calls.talker.length === 2) await new Promise(r => { hold = r; }); yield 'Thanks. '; yield 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2);
  const before = h.bytes.length;
  say(h, [[0.1, .5], [0.5, .001]]); // a click: 0.1 s of voice, then quiet closes it
  hold(); await settle(400);
  assert.ok(h.bytes.length > before, 'her reply plays through the click');
  say(h, [[1.3, .001]]);
  await until(() => !h.s.busy());
  assert.equal(h.s.history.filter(m => m.role === 'user').length, 1, 'the click is not a turn');
  assert.equal(h.calls.talker.length, 2, 'and gets no reply');
});

test('admin mode gets the same patience on words that trail off, without the nudge', async () => {
  const metrics = [];
  const h = harness(['We moved the whole billing platform to the new provider last spring and'], { session: { admin: true, metric: (n, v) => metrics.push([n, v]) } });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  const before = h.bytes.length;
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2);
  assert.ok(!h.calls.talker[1].some(m => m.content === STILL_THINKING), 'no nudge for admin');
  for (let i = 0; i < 200 && h.bytes.length === before; i++) { h.tick(); await settle(5); }
  const gap = metrics.find(([n]) => n === 'reply_gap')?.[1];
  assert.ok(gap && gap.ms >= 2480, 'admin waited too: ' + JSON.stringify(gap));
});

// ---- second review round ----
const LONG = 'We moved the whole billing platform to the new provider last spring with a team of five.';

test('a cough over a reply still waiting on the model: the reply is taken back and the answer is still answered', async () => {
  let stuck;
  const h = harness([LONG, ''], calls => ({ async *chatStream(m) { calls.talker.push(m); if (calls.talker.length === 2) await new Promise(r => { stuck = r; }); yield 'Thanks. '; yield 'Who owned the budget?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2);
  h.s.queue.push({ gen: h.s.gen, item: h.s.replyItem, bytes: new Uint8Array(960) }); // the acknowledgement is playing
  say(h, [[0.6, .5], [1.3, .001]]); // a cough over it
  await until(() => h.calls.talker.length === 3); // not stuck behind the stale reply
  stuck(); await until(() => !h.s.busy() && h.s.history.at(-1).role === 'assistant');
  assert.equal(h.s.history.filter(m => m.role === 'assistant').length, 2, 'opening + one answer');
});

test('a barge-in while her next sentence is still being voiced: the cut-off question is re-asked', async () => {
  let voice;
  const h = harness(['A short answer about the rollout.', ''], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Thanks. '; yield calls.talker.length === 2 ? 'Who owned the budget?' : 'What was the baseline?'; },
    async synthesize(t) { calls.tts.push(t); if (t === 'Who owned the budget?') await new Promise(r => { voice = r; }); return new Uint8Array(4800).fill(1); } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.tts.includes('Who owned the budget?') && h.s.shown.item === h.s.replyItem);
  h.s.sentMs[h.s.replyItem] = 3000; // well into her reply: a real barge-in
  h.s.queue.push({ gen: h.s.gen, item: h.s.replyItem, bytes: new Uint8Array(960) });
  say(h, [[0.6, .5], [1.3, .001]]);
  await until(() => h.calls.talker.length === 3);
  assert.equal(h.calls.talker[2].at(-1).content, RESUME_TEXT);
  assert.ok(h.s.history.some(m => m.role === 'assistant' && m.content === 'Thanks. [interrupted by the consultant]'), 'what was heard, marked');
  voice();
});

test('her own reply coming back through the speakers after a withdrawal is recognised as echo, not merged', async () => {
  const h = harness(['A short answer about the rollout.', 'Who owned the rollout budget?'], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Great. '; yield calls.talker.length === 2 ? 'Who owned the rollout budget?' : 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.live?.item === h.s.replyItem && h.s.live.text.includes('Who owned')); // played
  h.s.queue.push({ gen: h.s.gen, item: h.s.replyItem, bytes: new Uint8Array(960) });
  say(h, [[0.6, .5], [1.3, .001]]); // the microphone picks up her question
  await until(() => h.calls.stt === 2 && h.calls.talker.length === 3);
  assert.deepEqual(h.s.history.filter(m => m.role === 'user').map(m => m.content), ['A short answer about the rollout.'], 'her words are not the consultant\'s');
  assert.ok(h.events.some(e => e.type === 'quality_warning' && /its own voice/.test(e.message)));
});

test('once the greeting is cut off by an answer, it is no longer protected', async () => {
  let slow; const gate = new Promise(r => { slow = r; });
  const h = harness(['Hello there, nice to meet you, I am ready.'], calls => ({ async *chatStream(m) { calls.talker.push(m); if (calls.talker.length === 1) await gate; yield 'Thanks. '; yield 'What was the baseline?'; } }));
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => h.s.protectedItem === 'agent-1');
  say(h, [[1.2, .2], [1.3, .001]]); // they answer over the greeting
  await until(() => h.calls.talker.length === 2);
  assert.equal(h.s.greetingPlaying(), false);
  slow();
});

test('End during a reply records only what was voiced, marked as cut off by the end', async () => {
  let voice;
  const h = harness(['A short answer about the rollout.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Thanks. '; yield calls.talker.length === 2 ? 'Who owned the budget?' : 'What was the baseline?'; },
    async synthesize(t) { calls.tts.push(t); if (t === 'Who owned the budget?') await new Promise(r => { voice = r; }); return new Uint8Array(4800).fill(1); } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.tts.includes('Who owned the budget?') && h.s.live?.item === h.s.replyItem && h.s.live.text.includes('Thanks.'));
  await h.s.end(true);
  voice?.();
  const last = h.s.history.filter(m => m.role === 'assistant').at(-1).content;
  assert.equal(last, 'Thanks. [cut off when the interview ended]');
  assert.ok(!h.s.history.some(m => m.content.includes('budget')), 'the sentence never voiced is not in the record');
});

test('the start of real speech holds her reply from the first frames', async () => {
  let hold;
  const h = harness(['A short answer about the rollout.'], calls => ({ async *chatStream(m) { calls.talker.push(m); if (calls.talker.length === 2) await new Promise(r => { hold = r; }); yield 'Thanks. '; yield 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2);
  h.s.sentMs['agent-1'] = 1e9; // (keep this a new turn, not a continuation)
  const before = h.bytes.length;
  say(h, [[0.1, .2]]); // they have just started to speak: under MIN_VOICED so far
  hold(); await settle(400);
  assert.equal(h.bytes.length, before, 'not a click yet: she waits');
});

test('a click while the answer is being transcribed does not delay the reply', async () => {
  let release; const slow = new Promise(r => { release = r; });
  const h = harness([], calls => ({ async transcribe() { calls.stt += 1; if (calls.stt === 1) { await slow; return 'A short answer about the rollout.'; } return ''; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  say(h, [[0.1, .5], [0.2, .001]]); // a click while it is transcribed
  release();
  await until(() => h.calls.talker.length === 2);
  assert.equal(h.calls.stt, 1, 'the click is still going on: not transcribed, and not waited for');
});

// ---- third review round ----
test('a withdrawn reply only counts as possible echo for the next transcript: a later real answer using its words is kept', async () => {
  const h = harness(['A short answer about the rollout.', 'and it went live in March.', 'Yes.', 'I owned the rollout budget.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Great. '; yield calls.talker.length === 2 ? 'Who owned the rollout budget?' : 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.history.at(-1).role === 'assistant');
  h.s.queue.push({ gen: h.s.gen, item: h.s.replyItem, bytes: new Uint8Array(960) });
  say(h, [[0.6, .5], [1.3, .001]]); // they carry on: that reply is withdrawn
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  say(h, [[0.6, .2], [1.3, .001]]); // an ordinary turn
  await until(() => h.calls.talker.length === 4 && !h.s.busy());
  for (let i = 0; i < 600; i++) h.tick(); // twelve seconds later
  say(h, [[1.2, .2], [1.3, .001]]); // a real answer that repeats the withdrawn question's words
  await until(() => h.calls.talker.length === 5);
  assert.equal(h.s.history.filter(m => m.role === 'user').at(-1).content, 'I owned the rollout budget.');
});

test('a click while the answer is transcribed, then real speech: ATLAS does not talk over it', async () => {
  let release; const slow = new Promise(r => { release = r; }); let hold;
  const h = harness([], calls => ({
    async transcribe() { calls.stt += 1; if (calls.stt === 1) { await slow; return 'We rebuilt the claims intake.'; } return 'Then we cut the backlog by a third in two months.'; },
    async *chatStream(m) { calls.talker.push(m); yield 'Thanks. '; if (calls.talker.length === 2) await new Promise(r => { hold = r; }); yield 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  say(h, [[0.1, .5], [0.5, .001]]); // a click, closed by the quiet after it
  release();
  await until(() => h.calls.talker.length === 2 && h.s.shown.item === 'agent-2'); // her reply is playing
  h.s.queue.push({ gen: h.s.gen, item: h.s.replyItem, bytes: new Uint8Array(960) });
  const cleared = h.events.filter(e => e.type === 'clear_audio').length;
  say(h, [[0.6, .5]]); // then they really carry on
  assert.ok(h.events.filter(e => e.type === 'clear_audio').length > cleared, 'she stops at once');
  say(h, [[1.3, .001]]);
  hold();
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  assert.equal(h.calls.stt, 2, 'the click was never transcribed');
  assert.deepEqual(h.s.history.filter(m => m.role === 'user').map(m => m.content), ['We rebuilt the claims intake. Then we cut the backlog by a third in two months.']);
});

test('text on screen is exactly what is being voiced, even when the model streams word by word', async () => {
  let voice;
  const h = harness(['A short answer about the rollout.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); for (const t of calls.talker.length === 2 ? ['Thanks', '.', ' Who', ' owned', ' the', ' budget?'] : ['Thanks. ', 'What was the baseline?']) yield t; },
    async synthesize(t) { calls.tts.push(t); if (t === 'Who owned the budget?') await new Promise(r => { voice = r; }); return new Uint8Array(4800).fill(1); } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.tts.includes('Who owned the budget?') && h.s.live?.item === h.s.replyItem && h.s.live.text.includes('Thanks.'));
  await settle();
  assert.equal(h.s.live.text, '\n\nThanks.', 'nothing of the next sentence yet');
  assert.ok(!screen(h).includes('Who'));
  voice(); await until(() => !h.s.busy());
  assert.ok(screen(h).endsWith('\n\nThanks. Who owned the budget?'));
});

// ---- fourth review round ----
test('a short word, a comma pause, then the rest ("So, … one more thing"): one transcript with the first word, nothing played in the pause', async () => {
  let hold; const heard = [];
  const h = harness([], calls => ({
    async transcribe(pcm) { calls.stt += 1; heard.push(pcm.length); return calls.stt === 1 ? 'We rebuilt the claims intake last year.' : 'So, one more thing about the budget.'; },
    async *chatStream(m) { calls.talker.push(m); if (calls.talker.length === 2) await new Promise(r => { hold = r; }); yield 'Thanks. '; yield 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2);
  const before = h.bytes.length;
  say(h, [[0.1, .2], [0.25, .001]]); // "So," and a comma pause
  hold(); await settle(400);
  assert.equal(h.bytes.length, before, 'she does not start into the pause');
  say(h, [[1.0, .2], [1.3, .001]]);
  await until(() => h.calls.stt === 2 && h.calls.talker.length === 3);
  assert.ok(heard[1] >= (0.1 + 0.25 + 1.0) * 48000, 'the first word is in the transcribed audio');
});

test('"No, no." (two brief parts) is transcribed and answered', async () => {
  const h = harness(['No, no.']);
  await opened(h);
  say(h, [[0.4, .001], [0.1, .2], [0.2, .001], [0.1, .2], [1.3, .001]]); // (a real answer comes after her question has ended)
  await until(() => h.calls.stt === 1 && h.calls.talker.length === 2);
});

test('a lone short "No." is still answered (transcribed once nothing follows it)', async () => {
  const h = harness(['No.']);
  await opened(h);
  say(h, [[0.4, .001], [0.1, .2], [0.5, .001]]); // under MIN_VOICED: closed as a possible click
  say(h, [[1.1, .001]]); // nothing follows
  await until(() => h.calls.stt === 1 && h.calls.talker.length === 2);
  assert.equal(h.s.history.filter(m => m.role === 'user').at(-1).content, 'No.');
});

test('"Yes… [long pause] I think so": the short first word joins what follows', async () => {
  const voiced = [];
  const loud20ms = pcm => { let n = 0; for (let i = 0; i + 960 <= pcm.length; i += 960) if (rms(pcm.subarray(i, i + 960)) > 0.05) n++; return n; };
  const h = harness([], calls => ({ async transcribe(pcm) { calls.stt += 1; voiced.push(loud20ms(pcm)); return 'Yes, I think we did, in the second phase.'; } }));
  await opened(h);
  say(h, [[0.6, .001], [0.1, .2], [0.7, .001], [1.0, .2], [1.3, .001]]); // (after her question has ended and cannot echo)
  await until(() => h.calls.talker.length === 2);
  assert.equal(h.calls.stt, 1, 'one utterance');
  assert.ok(voiced[0] >= 54, 'the "Yes" (5 frames) is included with the rest (50): ' + voiced[0]);
});

test('a silent, stalled reply withdrawn at the end of a continuation does not make the next real answer look like echo', async () => {
  let stall;
  const h = harness(['A short answer about the rollout.', 'and it went live in March.', 'I owned the budget.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); const n = calls.talker.length;
      if (n === 2) { yield 'Who owned the budget? '; await new Promise(r => { stall = r; }); yield 'And the timeline?'; return; }
      yield 'Great. '; yield 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.live?.text.includes('Who owned'));
  h.s.playedMs[h.s.replyItem] = 1e9; // the browser has played it
  await until(() => h.s.queue.length === 0);
  for (let i = 0; i < 20; i++) h.tick(); // her audio went quiet while the model stalls: not audible
  say(h, [[1.0, .2], [1.3, .001]]); // they carry on: merged, and her stalled reply withdrawn at the end
  await until(() => h.calls.talker.length === 3 && !h.s.busy());
  stall();
  say(h, [[1.2, .2], [1.3, .001]]); // the answer to the question they heard
  await until(() => h.calls.talker.length === 4);
  assert.equal(h.s.history.filter(m => m.role === 'user').at(-1).content, 'I owned the budget.');
  assert.ok(!h.events.some(e => e.type === 'quality_warning' && /its own voice/.test(e.message)));
});

test('an answer that reuses the words of her question is the consultant\'s, not echo', async () => {
  const h = harness(['A short answer about the rollout.', 'I owned the rollout budget.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Great. '; yield calls.talker.length === 2 ? 'Who owned the rollout budget?' : 'What was the baseline?'; } }));
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  say(h, [[0.6, .001], [1.2, .2], [1.3, .001]]); // they answer after she has finished
  await until(() => h.calls.talker.length === 3);
  assert.equal(h.s.history.filter(m => m.role === 'user').at(-1).content, 'I owned the rollout budget.');
  assert.ok(!h.events.some(e => e.type === 'quality_warning' && /its own voice/.test(e.message)));
});

// ---- fifth review round: echo timed on the microphone stream (playback reports) ----
const ack = (h, item, ms) => h.s.onText(JSON.stringify({ type: 'playback', item_id: item, played_ms: ms }));
const QA = ['A short answer about the rollout.'];
const asksBudget = calls => ({ async *chatStream(m) { calls.talker.push(m); yield 'Great. '; yield calls.talker.length === 2 ? 'Who owned the rollout budget?' : 'What was the baseline?'; } });

test('her echo arriving late (network delay) is still recognised while the browser is still playing her question', async () => {
  const h = harness([...QA, 'Who owned the rollout budget?'], asksBudget);
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy() && h.s.live.text.includes('Who owned'));
  await ack(h, h.s.replyItem, 50); // the browser has played only the start of it so far
  for (let i = 0; i < 40; i++) h.tick(); // 0.8 s later by the server clock: past any wall-clock window
  say(h, [[0.6, .5], [1.3, .001]]); // the microphone picks up her question
  await until(() => h.calls.stt === 2);
  await settle();
  assert.deepEqual(h.s.history.filter(m => m.role === 'user').map(m => m.content), QA);
  assert.ok(h.events.some(e => e.type === 'quality_warning' && /its own voice/.test(e.message)));
});

test('once the browser reports her question fully played, a quick answer that reuses its words is kept', async () => {
  const h = harness([...QA, 'I owned the rollout budget.'], asksBudget);
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy() && h.s.live.text.includes('Who owned'));
  await ack(h, h.s.replyItem, h.s.sentMs[h.s.replyItem]); // fully played
  say(h, [[0.3, .001], [1.2, .2], [1.3, .001]]); // a normal human gap, then the answer
  await until(() => h.calls.talker.length === 3);
  assert.equal(h.s.history.filter(m => m.role === 'user').at(-1).content, 'I owned the rollout budget.');
});

test('a breath right after her question does not make the real answer that follows look like echo', async () => {
  const h = harness([...QA, 'I owned the rollout budget.'], asksBudget);
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  say(h, [[0.35, .001], [0.1, .3], [0.5, .001], [0.6, .001], [1.2, .2], [1.3, .001]]); // a breath just after she stops (could be her echo tail), then the answer
  await until(() => h.calls.talker.length === 3);
  assert.equal(h.s.history.filter(m => m.role === 'user').at(-1).content, 'I owned the rollout budget.');
});

test('a click after the answer, while it is still being transcribed, never holds her reply', async () => {
  let release; const slow = new Promise(r => { release = r; });
  const h = harness([], calls => ({ async transcribe() { calls.stt += 1; if (calls.stt === 1) { await slow; return 'A short answer about the rollout.'; } return ''; } }));
  await opened(h);
  say(h, [[0.6, .001], [1.2, .2], [1.3, .001]]);
  say(h, [[0.1, .5], [0.5, .001], [1.2, .001]]); // a click, closed, and its joining window over
  await settle();
  assert.equal(h.calls.stt, 1, 'the click is not transcribed while the answer is');
  const before = h.bytes.length;
  release();
  await until(() => h.calls.talker.length === 2);
  await until(() => h.bytes.length > before); // her reply plays with no further frames
  assert.equal(h.calls.stt, 1);
});

test('a short sound is joined by when the next speech began, not by when it was detected', async () => {
  const voiced = [];
  const loud20ms = pcm => { let n = 0; for (let i = 0; i + 960 <= pcm.length; i += 960) if (rms(pcm.subarray(i, i + 960)) > 0.05) n++; return n; };
  const h = harness([], calls => ({ async transcribe(pcm) { calls.stt += 1; voiced.push(loud20ms(pcm)); return 'No, we never had a budget for that part.'; } }));
  await opened(h);
  say(h, [[0.6, .001]]);
  const noPcm = frames([[0.1, .2]]).reduce((a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; });
  h.s.blip = { pcm: noPcm, voiced: 0.1, at: h.s.now() - 0.95, endedAt: h.s.now() - 1.4, continuing: false, echoable: false }; // "No." closed 0.95 s ago
  say(h, [[1.2, .2], [1.3, .001]]); // speech begins at 0.97 s, inside the 1 s window; it is detected 0.08 s later, past it
  await until(() => h.calls.talker.length === 2);
  assert.equal(h.calls.stt, 1, 'one utterance');
  assert.ok(voiced[0] >= 5 + 60, 'the "No." is part of it: ' + voiced[0]);
});

test('after she is interrupted, a later answer that reuses her question is kept (the cut playback is over)', async () => {
  let hold;
  const h = harness([...QA, 'Sorry, let me think.', 'I owned the rollout budget.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); const n = calls.talker.length; if (n === 3) await new Promise(r => { hold = r; });
      yield 'Great. '; yield n === 2 ? 'Who owned the rollout budget?' : 'What was the baseline?'; } }));
  await opened(h);
  await ack(h, 'agent-1', h.s.sentMs['agent-1']); // the browser reports playback
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.live.text.includes('Who owned'));
  h.s.sentMs[h.s.replyItem] = 3000; await ack(h, h.s.replyItem, 2900); // well into her reply
  h.s.queue.push({ gen: h.s.gen, item: h.s.replyItem, bytes: new Uint8Array(960) });
  say(h, [[0.6, .5], [1.3, .001]]); // a real barge-in: she is cut
  await until(() => h.calls.talker.length === 3); // her next reply is still being prepared (nothing playing)
  say(h, [[2.0, .001], [1.2, .2], [1.3, .001]]); // two seconds later, the answer
  await until(() => h.calls.stt === 3); await settle();
  assert.ok(h.s.history.some(m => m.role === 'user' && m.content.includes('I owned the rollout budget.')), JSON.stringify(h.s.history));
  assert.ok(!h.events.some(e => e.type === 'quality_warning' && /its own voice/.test(e.message)));
  hold?.();
});

test('speech that starts in the gap between two of her sentences is not taken for echo of the second', async () => {
  let hold;
  const h = harness([...QA, 'I owned the rollout budget.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); const n = calls.talker.length;
      if (n === 2) { yield 'Who owned the rollout budget? '; await new Promise(r => { hold = r; }); yield 'And when did it start?'; return; }
      yield 'Great. '; yield 'What was the baseline?'; } }));
  await opened(h);
  await ack(h, 'agent-1', h.s.sentMs['agent-1']);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.live.text.includes('Who owned') && h.s.queue.length === 0);
  await ack(h, h.s.replyItem, h.s.sentMs[h.s.replyItem]); // her first sentence has fully played
  say(h, [[0.4, .001], [0.06, .2]]); // they start answering...
  hold(); await until(() => !h.s.playbackDone); // ...as her second sentence goes out
  say(h, [[1.14, .2], [1.3, .001]]);
  await until(() => h.calls.stt === 2); await settle();
  assert.ok(h.s.history.some(m => m.role === 'user' && m.content.includes('I owned the rollout budget.')));
  assert.ok(!h.events.some(e => e.type === 'quality_warning' && /its own voice/.test(e.message)));
});

// ---- 15-minute interview ----
test('the interview is planned for 15 minutes: breadth first, then depth, then only the most important question', () => {
  assert.equal(MAX_SECONDS, 900);
  const none = ['', '', '', '', '', ''], some = ['a', '', 'c', '', '', ''];
  assert.match(paceNotes(60, 900, none)[1], /about 1 of 15 minutes used\. Next uncovered area: what was going on\./);
  assert.match(paceNotes(420, 900, some)[1], /about 7 of 15 minutes used\. Past halfway: challenge .* Still uncovered: their personal contribution, the outcome\./);
  assert.match(paceNotes(720, 900, some)[1], /Under four minutes left: ask only the single most important remaining question, then move to ENDING\./);
  assert.ok(TIME_UP.includes('the time for this interview is up'));
});

test('with 75 seconds of the interview left, her next reply is the closing, then the interview wraps up', async () => {
  const h = harness(['Here is my project story.'], { session: { maxSeconds: 120 } });
  await opened(h);
  for (let i = 0; i < 2300; i++) h.tick(); // 46 s into a 120 s interview: 74 s left
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.events.some(e => e.type === 'wrap_up'));
  assert.equal(h.calls.talker.at(-1).at(-1).content, TIME_UP);
});

test('in the last half minute, with nobody talking, ATLAS closes on her own; at the limit the interview ends cleanly with its notes', async () => {
  const h = harness(['Here is my project story, with the context and what I did.'], { session: { maxSeconds: 120 } });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  h.s.playedMs[h.s.protectedItem] = 1e9;
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  for (let i = 0; i < 4500; i++) h.tick(); // 25 s left, silence
  h.s.lastInput = h.s.now(); h.s.watch();
  await until(() => h.calls.talker.length === 3 && h.events.some(e => e.type === 'wrap_up'));
  assert.equal(h.calls.talker[2].at(-1).content, TIME_UP);
  for (let i = 0; i < 1500; i++) h.tick(); // past the limit
  h.s.lastInput = h.s.now(); h.s.watch();
  await until(() => h.events.some(e => e.type === 'ended'));
  assert.ok(h.events.some(e => e.type === 'notes' && e.status === 'candidate'), 'a clean end: notes (and report) are produced');
});

// ---- Restart: the browser discards the live conversation, then starts a new session ----
test('discard (Restart) ends the conversation with no notes and no report, and ignores anything after it', async () => {
  let reports = 0;
  const h = harness(['We rebuilt the claims intake for the whole region last year.'], { session: {}, async report() { reports += 1; return '{}'; } });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  h.s.playedMs[h.s.protectedItem] = 1e9;
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.events.some(e => e.type === 'user_text'));
  await h.s.onText(JSON.stringify({ type: 'discard' }));
  await until(() => h.events.some(e => e.type === 'ended'));
  assert.ok(h.events.some(e => e.type === 'audio_stopped') && h.closed() && h.s.finished);
  assert.ok(!h.events.some(e => e.type === 'notes'), 'nothing to save');
  assert.equal(reports, 0, 'no report written');
  const n = h.events.length;
  say(h, [[1.2, .2], [1.3, .001]]); await settle();
  assert.equal(h.events.filter((e, i) => i >= n && e.type === 'user_text').length, 0, 'nothing heard after the discard');
});

test('End then discard: the interview already ended cleanly, exactly one set of notes', async () => {
  const h = harness(['We rebuilt the claims intake for the whole region last year.']);
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  h.s.playedMs[h.s.protectedItem] = 1e9;
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.events.some(e => e.type === 'user_text'));
  const ending = h.s.onText(JSON.stringify({ type: 'end' }));
  await h.s.onText(JSON.stringify({ type: 'discard' }));
  await ending; await until(() => h.events.some(e => e.type === 'ended'));
  assert.equal(h.events.filter(e => e.type === 'notes').length, 1);
});

test('at the 15-minute limit the answer still being spoken is transcribed into the notes, and the browser is told time is up', async () => {
  const h = harness(['We rebuilt the claims intake.', 'And the last thing I wanted to say is that it went live in March.'], { session: { maxSeconds: 120 } });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true }));
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  h.s.playedMs[h.s.protectedItem] = 1e9;
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  for (let i = 0; i < 5000; i++) h.tick(); // far into the interview; they are speaking when the time runs out
  say(h, [[1.0, .2]]);
  for (let i = 0; i < 1000; i++) h.tick();
  h.s.lastInput = h.s.now(); h.s.watch();
  await until(() => h.events.some(e => e.type === 'ended'));
  assert.ok(h.events.some(e => e.type === 'time_up'));
  const notes = h.events.find(e => e.type === 'notes');
  assert.ok(notes && notes.transcript.includes('went live in March'), 'their last words are kept');
});

test('the closing reply is not given the analyst guidance and its pace note asks for no question', async () => {
  const h = harness(['Here is my project story.'], { session: { maxSeconds: 120 } });
  await opened(h);
  h.s.guidance = { next_field: 'measurement', probe: 'Ask for the baseline.' };
  for (let i = 0; i < 2300; i++) h.tick();
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2);
  const m = h.calls.talker[1];
  assert.equal(m.at(-1).content, TIME_UP);
  assert.ok(!m.some(x => x.content.startsWith('ANALYST_GUIDANCE')));
  assert.ok(m.some(x => x.content.includes('Time is up: close now, with no question.')));
});

// ---- Focused gap interviews (WOW_SPEC §F2.4, §F2.7, §F2.8) ----
import { GAP_UNAVAILABLE } from '../src/session.js';
import { GAP_OPENING, GAP_NOTE, GAP_WHY, GAP_REFLECT, WIN_HINTS, TALKER_POLICY, ADMIN_NOTE } from '../src/policy.generated.js';
import { WELCOME_BACK } from '../src/languages.js';

const GAP = 'ab'.repeat(16);
const ASKS = [
  { id: 'G1', field: 'evidence', label: 'ignored: the label comes from FIELDS', ask: 'Proof the bid needs: an audited report for [company]' },
  { id: 'G2', field: 'measurement', label: 'x', ask: 'Proof the bid needs: how the saving was measured' },
  { id: 'G3', field: 'customer_fit', label: 'x', ask: 'Proof the bid needs: an insurer with legacy claims systems' },
  { id: 'G4', field: 'problem', label: 'x', ask: 'Dropped: at most GAP_MAX asks' },
];
const RESOLVED = { asks: ASKS, bidAlias: '[company] claims bid', referenceId: 'ref1', projectId: 'p1' };
const gapStart = (extra = {}) => JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true, gap: GAP, ...extra });
const resolver = (value = RESOLVED, seen = []) => async id => { seen.push(id); return value; };
async function gapOpened(h) {
  await h.s.onText(gapStart());
  await until(() => !h.s.busy() && h.bytes.length >= 10);
  h.s.playedMs[h.s.protectedItem] = 1e9; // the greeting has played (browser acknowledgement)
}
const system = m => m[0].content;
const notesOf = m => m.filter((x, i) => i > 0 && x.role === 'system' && !x.content.startsWith('ANALYST_GUIDANCE')).map(x => x.content);
const lastQuality = h => h.events.filter(e => e.type === 'quality').at(-1);

test('gap start: resolved server-side, ready carries mode/timePlan/gaps (at most 3), the gap list sits between project data and preferences', async () => {
  const seen = [], h = harness(undefined, { session: { gaps: resolver(RESOLVED, seen) } });
  await gapOpened(h);
  assert.deepEqual(seen, [GAP], 'the browser supplies only the id');
  const ready = h.events[0];
  assert.equal(ready.type, 'ready'); assert.equal(ready.mode, 'gap'); assert.equal(ready.maxSeconds, 300); assert.equal(ready.speakingSeconds, 150);
  assert.deepEqual(ready.timePlan, { depthAt: null, closingAt: 210 });
  assert.deepEqual(ready.gaps, [{ id: 'G1', label: 'Supporting artifact', ask: ASKS[0].ask }, { id: 'G2', label: 'Measurement basis', ask: ASKS[1].ask },
    { id: 'G3', label: 'Customer relevance', ask: ASKS[2].ask }]);
  const sys = system(h.calls.talker[0]);
  const at = label => sys.indexOf(label);
  assert.ok(at('\nUNTRUSTED PROJECT DATA:\n') > 0 && at('\nUNTRUSTED PROJECT DATA:\n') < at('\nUNTRUSTED GAP LIST') && at('\nUNTRUSTED GAP LIST') < at('\nUNTRUSTED PRIVATE PREFERENCES'));
  assert.ok(sys.endsWith('\nUNTRUSTED PRIVATE PREFERENCES (not evidence):\n'), 'nothing after the preferences label: the prefix is cache-stable');
  assert.ok(sys.includes(JSON.stringify(ready.gaps)) && !sys.includes('Dropped'), 'ids, labels and asks only; the fourth ask is dropped');
  const opening = h.calls.talker[0];
  assert.equal(opening.at(-1).content, GAP_OPENING, 'the gap opening (it never asks for the Opp ID)');
  assert.ok(opening.some(m => m.content.startsWith('ANALYST_GUIDANCE') && m.content.includes('"askId":"G1"') && m.content.includes(ASKS[0].ask)));
  const notes = notesOf(opening);
  assert.equal(notes[0], GAP_NOTE, 'GAP_NOTE first (no admin note)');
  assert.ok(notes.includes('GAP PACE (server): about 0 of 5 minutes used. Open items: Supporting artifact, Measurement basis, Customer relevance.'));
  assert.ok(!notes.some(n => n.startsWith('INTERVIEW PACE') || n.startsWith('ADMIN MODE')), 'no full-mode pace');
  assert.deepEqual(spoken(h.calls), [...GREETING, 'Thanks.', 'What was the baseline?'], 'greeting first, then the gap opening');
  assert.equal(h.s.gapAttempts.G1, 1, 'the opening carried G1 and was heard'); assert.equal(h.s.openAsk, 'G1');
});

test('gap start refused: unknown or foreign id (null), malformed id, no resolver, a throwing or hanging resolver: voice-contract, no ready, no timer', async () => {
  const cases = [
    [{ gaps: resolver(null) }, {}], [{ gaps: resolver({ asks: [] }) }, {}], [{ gaps: resolver({ asks: [{ id: 'G1', field: 'nope', ask: 'x' }] }) }, {}],
    [{ gaps: resolver() }, { gap: 'XYZ' }], [{ gaps: resolver() }, { gap: GAP.toUpperCase() }], [{ gaps: resolver() }, { gap: 7 }], [{}, {}],
    [{ gaps: async () => { throw new Error('library down'); } }, {}], [{ gaps: () => new Promise(() => {}), gapTimeout: 20 }, {}],
  ];
  for (const [session, start] of cases) {
    const h = harness(undefined, { session });
    await h.s.onText(gapStart(start));
    assert.equal(h.events[0].type, 'error', JSON.stringify(start)); assert.equal(h.events[0].code, 'voice-contract'); assert.equal(h.events[0].message, GAP_UNAVAILABLE);
    assert.ok(!h.events.some(e => e.type === 'ready') && h.closed() && h.s.timer === null && h.calls.talker.length === 0);
  }
  const bad = harness(undefined, { session: { gaps: resolver() } });
  await bad.s.onText(gapStart({ asks: ASKS })); // the browser cannot inject asks: an unknown start key
  assert.equal(bad.events[0].message, 'Fresh voice consent and CSRF token required');
});

test('closing during gap resolution: a discard or End leaves no ready and no timer; anything else, including a second start, is refused', async () => {
  for (const leave of [{ type: 'discard' }, { type: 'end' }, { type: 'start', consent: true, csrf: 'tok', project: PROJECT }, { type: 'discard', x: 1 }]) {
    let release; const h = harness(undefined, { session: { gaps: () => new Promise(r => { release = r; }) } });
    const starting = h.s.onText(gapStart());
    await settle(5);
    assert.equal(h.s.starting, true);
    await h.s.onText(JSON.stringify(leave));
    await until(() => h.events.some(e => e.type === 'ended'));
    release(RESOLVED); await starting; await settle();
    const refused = Object.keys(leave).length !== 1;
    assert.equal(h.events.some(e => e.type === 'error' && e.code === 'voice-contract'), refused, JSON.stringify(leave));
    assert.ok(!h.events.some(e => ['ready', 'notes'].includes(e.type)), 'no ready and no notes');
    const timer = h.s.timer; clearInterval(timer); // a leaked timer must fail this test, not hang the run
    assert.equal(timer, null, 'no live timer afterwards'); assert.equal(h.calls.talker.length, 0); assert.ok(h.closed());
  }
});

test('full mode: a clean End while private memory is still recalled creates no timer and no opening (timer-leak guard)', async () => {
  let release; const h = harness([], { session: { memory: () => new Promise(r => { release = r; }) } });
  const starting = h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await settle(5);
  let sttDone; h.s.sttChain = new Promise(r => { sttDone = r; }); // End waits for the last words: ending, not yet finished
  const sleep = h.s.sleep; h.s.sleep = () => new Promise(() => {});
  const ending = h.s.onText(JSON.stringify({ type: 'end' }));
  assert.ok(h.s.ending && !h.s.finished);
  release('PRIVATE MEMORY: earlier'); await starting;
  const timer = h.s.timer; clearInterval(timer); // a leaked timer must fail this test, not hang the run
  assert.equal(timer, null); assert.equal(h.calls.talker.length, 0);
  h.s.sleep = sleep; sttDone(); await ending;
  assert.ok(h.events.some(e => e.type === 'ended'));
});

test('admin + gap: ADMIN_NOTE first, then GAP_NOTE and gap pace; the greeting is spoken; no memory recall in gap mode', async () => {
  let recalls = 0;
  const h = harness(undefined, { session: { admin: true, gaps: resolver(), memory: async () => { recalls += 1; return 'PRIVATE MEMORY: x'; } } });
  await h.s.onText(gapStart());
  await until(() => h.calls.talker.length >= 1 && !h.s.busy());
  const notes = notesOf(h.calls.talker[0]);
  assert.equal(notes[0], ADMIN_NOTE); assert.equal(notes[1], GAP_NOTE); assert.match(notes[2], /^GAP PACE \(server\)/);
  // Tony, 2026-10-02: ATLAS always introduces herself first, admin included.
  assert.ok((notes.find(n => n.startsWith('ALREADY SAID')) || '').includes(GREETINGS.en), 'the greeting was spoken first');
  assert.equal(recalls, 0); assert.ok(!h.events.some(e => e.type === 'memory'));
  assert.ok(!h.calls.talker.flat().some(m => m.content.includes('PRIVATE MEMORY: x')), 'nothing recalled reaches the talker');
});

test('answer windows: the analyst files the answer under another field; the ask still reads answered_unverified with the exact quote; no rankProbe, no report', async () => {
  let ranked = 0, reports = 0;
  const said = 'We cut triage time by about 40% after the rollout across all three regional support teams.';
  const h = harness([said], { session: { gaps: resolver() }, async rankProbe() { ranked += 1; return null; }, async report() { reports += 1; return '{}'; } });
  await gapOpened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => lastQuality(h) && h.calls.talker.length >= 2 && !h.s.busy());
  const q = lastQuality(h);
  assert.equal(q.candidate_details[0].field, 'outcome', 'the fake analyst filed it under outcome, not evidence');
  assert.deepEqual(q.gap_status.map(s => [s.id, s.status]), [['G1', 'answered_unverified'], ['G2', 'open'], ['G3', 'open']]);
  assert.deepEqual(q.gap_status[0].details, [], 'no detail in the evidence field');
  assert.equal(q.next_field, 'measurement'); assert.equal(q.next_question, ASKS[1].ask); assert.equal(q.planned_question, ASKS[1].ask);
  assert.equal(q.why_this_question, GAP_WHY); assert.equal(q.next_action, 'ask_one_question');
  assert.ok(h.calls.talker[1].some(m => m.content.startsWith('ANALYST_GUIDANCE') && m.content.includes('"askId":"G2"')), 'the reply to the answer carries the next ask at once');
  assert.equal(h.s.openAsk, 'G2'); assert.deepEqual(h.s.gapAttempts, { G1: 1, G2: 1 });
  await h.s.onText(JSON.stringify({ type: 'end' }));
  const notes = h.events.find(e => e.type === 'notes');
  assert.equal(notes.mode, 'gap'); assert.equal(notes.report, null); assert.equal(notes.status, 'candidate');
  assert.equal(notes.gap.requestId, GAP);
  assert.deepEqual(notes.gap.results, [{ askId: 'G1', field: 'evidence', status: 'answered_unverified', quotes: [said] },
    { askId: 'G2', field: 'measurement', status: 'open', quotes: [] }, { askId: 'G3', field: 'customer_fit', status: 'open', quotes: [] }]);
  assert.ok(notes.transcript.includes(notes.gap.results[0].quotes[0]), 'each window quote is an exact transcript substring');
  assert.equal(ranked, 0, 'JEV never reorders gap asks'); assert.equal(reports, 0); assert.ok(!h.events.some(e => e.type === 'reporting'));
});

test('deferral after two heard attempts comes from the session\'s own counts (never the ledger\'s deferred_fields); the quality event names the current ask', async () => {
  const h = harness(['Not sure.', 'No idea really.'], { session: { gaps: resolver() } });
  await gapOpened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length >= 2 && !h.s.busy() && h.s.gapAttempts.G1 === 2);
  assert.equal(lastQuality(h).gap_status[0].status, 'open', 'one short answer after one attempt: still open');
  assert.equal(lastQuality(h).next_field, 'evidence');
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => lastQuality(h)?.gap_status[0].status === 'deferred' && h.calls.talker.length >= 3);
  const q = lastQuality(h);
  assert.ok(!Object.keys(q.deferred_fields).includes('evidence'), 'the ledger did not defer it');
  assert.deepEqual([q.next_field, q.next_question, q.planned_question], ['measurement', ASKS[1].ask, ASKS[1].ask]);
  assert.ok(h.calls.talker[2].some(m => m.content.startsWith('ANALYST_GUIDANCE') && m.content.includes('"deferred":["evidence"]')));
  await h.s.onText(JSON.stringify({ type: 'end' }));
  assert.deepEqual(h.events.find(e => e.type === 'notes').gap.results[0], { askId: 'G1', field: 'evidence', status: 'deferred', quotes: ['Not sure.', 'No idea really.'] });
});

test('every ask answered: the plan is reflect-and-confirm and the gap pace says so; UNKNOWN answers count as unknown', async () => {
  const h = harness(['The audit report was signed off by the client quality team.', 'Honestly I don\'t know how that was measured.', 'Mostly insurers with old mainframe claims platforms like this one.'],
    { session: { gaps: resolver() } });
  await gapOpened(h);
  for (let n = 2; n <= 4; n++) { say(h, [[1.2, .2], [1.3, .001]]); await until(() => h.calls.talker.length >= n && !h.s.busy()); }
  await until(() => lastQuality(h)?.gap_status.every(s => s.status !== 'open'));
  const q = lastQuality(h);
  assert.deepEqual(q.gap_status.map(s => s.status), ['answered_unverified', 'unknown', 'answered_unverified']);
  assert.deepEqual([q.next_field, q.next_question, q.next_action], [null, GAP_REFLECT, 'reflect_and_confirm']);
  assert.ok(notesOf(h.calls.talker[3]).some(n => n.endsWith('Every item has an answer: reflect back and close.')));
  assert.deepEqual(h.s.gapAttempts, { G1: 1, G2: 1, G3: 1 }, 'a reflect-and-confirm reply carries no ask');
});

test('a reply withdrawn because the consultant carried on is not an attempt; the continuation joins the same window entry as its own exact part', async () => {
  let hold, gated = true;
  const h = harness(['We rebuilt the claims intake.', 'Then we cut the backlog by a third in two months.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Oh nice. '; if (calls.talker.length === 2 && gated) await new Promise(r => { hold = r; }); yield 'What changed for the team?'; } }));
  h.s.gaps = resolver(); // (a function `extra` carries no session options)
  await gapOpened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && h.s.shown.item === 'agent-2');
  assert.equal(h.s.gapAttempts.G1, 2, 'her reply (still carrying G1) was heard');
  say(h, [[1.0, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 3);
  gated = false; hold?.();
  await until(() => !h.s.busy());
  assert.ok(h.events.some(e => e.type === 'agent_retract' && e.item_id === 'agent-2'));
  assert.deepEqual(h.s.gapAttempts, { G1: 1, G2: 1 }, 'the withdrawn reply was taken back; the real reply carries G2');
  assert.deepEqual(h.s.gapAnswers.G1, [['We rebuilt the claims intake.', 'Then we cut the backlog by a third in two months.']]);
  await h.s.onText(JSON.stringify({ type: 'end' }));
  const r = h.events.find(e => e.type === 'notes').gap.results[0];
  assert.equal(r.status, 'answered_unverified', 'the two parts together answer it');
  assert.deepEqual(r.quotes, ['We rebuilt the claims intake.', 'Then we cut the backlog by a third in two months.']);
});

test('gap timing: the closing comes at GAP_WRAP_S (40 s) left, not before; gap pace under ninety seconds; time_up says "The 5 minutes are up."', async () => {
  for (const [seconds, closing] of [[250, false], [258, true]]) {
    const h = harness(['Here is the audit report we produced for them.'], { session: { gaps: resolver() } });
    await gapOpened(h);
    for (let i = 0; i < seconds / 0.02; i++) h.tick();
    say(h, [[1.2, .2], [1.3, .001]]);
    await until(() => h.calls.talker.length === 2);
    assert.equal(h.calls.talker[1].at(-1).content === TIME_UP, closing, seconds + ' s');
    if (!closing) assert.ok(notesOf(h.calls.talker[1]).some(n => /^GAP PACE \(server\): about 4 of 5 minutes used\. Under ninety seconds left/.test(n)));
    if (closing) {
      for (let i = 0; i < 2500; i++) h.tick(); // past the 300 s limit
      h.s.lastInput = h.s.now(); h.s.watch();
      await until(() => h.events.some(e => e.type === 'ended'));
      assert.equal(h.events.find(e => e.type === 'time_up').message, 'The 5 minutes are up. Finishing your interview.');
      assert.equal(h.events.find(e => e.type === 'notes').mode, 'gap');
    }
  }
});

test('win hint: never awaited; its note joins the next composed reply (both modes); absent, null, failing or unknown hints add nothing', async () => {
  const h = harness(undefined, { session: { winHint: async () => ({ hint: 'quantified' }) } });
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length >= 2);
  const notes = notesOf(h.calls.talker[1]), win = notes.indexOf(WIN_HINTS.quantified);
  assert.ok(win > 0 && win < notes.findIndex(n => n.startsWith('INTERVIEW PACE')), 'full mode: [admin, language, memory, win, pace]');
  const g = harness(undefined, { session: { gaps: resolver(), winHint: async () => ({ hint: 'confirmed' }) } });
  await gapOpened(g);
  say(g, [[1.2, .2], [1.3, .001]]);
  await until(() => g.calls.talker.length >= 2);
  const gn = notesOf(g.calls.talker[1]);
  assert.ok(gn.indexOf(WIN_HINTS.confirmed) > gn.findIndex(n => n.startsWith('GAP PACE')), 'gap mode: [admin, GAP_NOTE, pace, language, win]');
  for (const winHint of [async () => ({ hint: null }), async () => null, async () => { throw new Error('down'); }, () => { throw new Error('sync'); }, async () => ({ hint: '__proto__' }), async () => ({ hint: 'constructor' }), null]) {
    const n = harness(undefined, { session: { winHint } });
    await opened(n);
    say(n, [[1.2, .2], [1.3, .001]]);
    await until(() => n.calls.talker.length >= 2);
    assert.ok(!n.calls.talker.flat().some(m => /WIN LOOP/.test(m.content)), String(winHint));
    assert.ok(!n.events.some(e => e.type === 'error'));
  }
});

test('a win hint that never resolves changes neither ready nor the opening timing', async () => {
  const ticksToOpening = async session => {
    const h = harness(undefined, { session });
    await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true }));
    assert.equal(h.events[0].type, 'ready', 'ready is sent at once');
    let n = 0; while (h.calls.talker.length === 0 && n < 2000) { await new Promise(r => setImmediate(r)); n += 1; }
    assert.equal(h.calls.talker.length, 1);
    assert.ok(!h.calls.talker[0].some(m => /WIN LOOP/.test(m.content)));
    return n;
  };
  assert.equal(await ticksToOpening({ winHint: () => new Promise(() => {}) }), await ticksToOpening({}));
});

test('full mode is unchanged: ready adds mode and timePlan only, the system prefix has no gap list, notes add mode: full', async () => {
  const h = harness();
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
  const ready = h.events[0];
  assert.equal(ready.mode, 'full'); assert.deepEqual(ready.timePlan, { depthAt: 405, closingAt: 690 }); assert.ok(!('gaps' in ready));
  await until(() => h.calls.talker.length >= 1 && !h.s.busy());
  assert.equal(system(h.calls.talker[0]), TALKER_POLICY + '\nUNTRUSTED PROJECT DATA:\n' + JSON.stringify(h.s.project) + '\nUNTRUSTED PRIVATE PREFERENCES (not evidence):\n');
  assert.deepEqual(talkerMessages(h.s.project, null, [], undefined, [], []), talkerMessages(h.s.project, null, [], undefined, []), 'an empty gap list adds nothing');
  assert.deepEqual(h.s.askByItem.size + Object.keys(h.s.gapAttempts).length, 0, 'no answer windows in full mode');
  await h.s.onText(JSON.stringify({ type: 'end' }));
  const notes = h.events.find(e => e.type === 'notes');
  assert.equal(notes.mode, 'full'); assert.ok(!('gap' in notes));
  const off = harness([]);
  await off.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await off.s.onText(JSON.stringify({ type: 'end' }));
  assert.equal(off.events.find(e => e.type === 'notes').mode, 'full');
});

test('the reply to an answer carries the next ask at once, before the analyst returns (answer windows never wait for the analyst)', async () => {
  let open; const gate = new Promise(r => { open = r; });
  const said = 'The audit report was signed off by the client quality team last year.';
  const h = harness([said], calls => ({ async analyst(messages) { calls.analyst.push(messages); await gate; return []; } }));
  h.s.gaps = resolver();
  await gapOpened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length >= 2 && !h.s.busy());
  assert.equal(h.events.filter(e => e.type === 'quality').length, 0, 'the analyst has not answered yet');
  assert.ok(h.calls.talker[1].some(m => m.content.startsWith('ANALYST_GUIDANCE') && m.content.includes('"askId":"G2"')));
  assert.deepEqual([h.s.openAsk, h.s.gapAttempts], ['G2', { G1: 1, G2: 1 }]);
  open();
  await until(() => lastQuality(h));
  assert.equal(lastQuality(h).gap_status[0].status, 'answered_unverified');
});

test('resolver output is bounded: invalid asks dropped (never shadowing a valid one with the same id), duplicates dropped, asks cut to 160 characters', async () => {
  const h = harness(undefined, { session: { gaps: resolver({ asks: [{ id: 'G1', field: 'nope', ask: 'invalid field' }, { id: 'G1', field: 'evidence', ask: 'The valid one' },
    { id: 'G1', field: 'outcome', ask: 'A duplicate id' }, { id: 'G2', field: 'outcome', ask: 'x'.repeat(300) }, { id: 'G 3', field: 'problem', ask: 'bad id' }] }) } });
  await h.s.onText(gapStart());
  assert.deepEqual(h.events[0].gaps.map(g => [g.id, g.label, g.ask.length]), [['G1', 'Supporting artifact', 13], ['G2', 'Observed outcome', 160]]);
});

// ---- Answer windows close at the reflect-and-confirm reply and at the closing (review findings 8, 9) ----
const sayAsync = async (h, segs) => { for (const f of frames(segs)) { h.tick(); h.s.onBinary(f); await new Promise(r => setImmediate(r)); } };

test('gap: the reply after reflect-and-confirm is not filed as the last ask\'s answer (an unknown or deferred ask stays so, the confirmation is no quote)', async () => {
  const confirm = 'No, that all sounds right to me, thank you.';
  for (const [said, expected] of [
    [['The audit report was signed off by the client quality team.', 'Honestly I don\'t know how that was measured.', 'Mostly insurers with old mainframe claims platforms like this one.'],
      [['answered_unverified', 1], ['unknown', 1], ['answered_unverified', 1]]],
    [['The audit report was signed off by the client quality team.', 'I am not sure.', 'Sorry, no idea.', 'Mostly insurers with old mainframe claims platforms like this one.'],
      [['answered_unverified', 1], ['deferred', 2], ['answered_unverified', 1]]],
  ]) {
    const h = harness([...said, confirm], { session: { gaps: resolver() } });
    await gapOpened(h);
    for (let n = 2; n <= said.length + 1; n++) { say(h, [[1.2, .2], [1.3, .001]]); await until(() => h.calls.talker.length >= n && !h.s.busy()); }
    assert.equal(h.s.guidance.action, 'reflect_and_confirm');
    assert.equal(h.s.openAsk, null, 'the reflect reply was heard: no ask is open any more');
    say(h, [[1.2, .2], [1.3, .001]]);
    await until(() => h.calls.talker.length >= said.length + 2 && !h.s.busy());
    await h.s.onText(JSON.stringify({ type: 'end' })); await until(() => h.events.some(e => e.type === 'ended'));
    const results = h.events.find(e => e.type === 'notes').gap.results;
    assert.deepEqual(results.map(r => r.status), expected.map(([s]) => s), JSON.stringify(results));
    assert.deepEqual(expected.map((_, i) => h.s.gapAttempts['G' + (i + 1)]), expected.map(([, n]) => n));
    assert.ok(!results.some(r => r.quotes.includes(confirm)), 'the confirmation is no proof quote');
    assert.ok(h.events.find(e => e.type === 'notes').transcript.includes(confirm), 'it stays in the transcript');
  }
});

test('gap: the closing closes the answer window: a goodbye is no answer; a closing withdrawn because they carried on gives the window back', async () => {
  const h = harness(['Um, not sure.', 'Okay, thank you very much for your time today.'], { session: { gaps: resolver() } });
  await gapOpened(h);
  for (let i = 0; i < 262 / 0.02; i++) h.tick();
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length >= 2 && !h.s.busy());
  assert.equal(h.calls.talker[1].at(-1).content, TIME_UP);
  assert.equal(h.s.openAsk, null, 'the closing was heard'); assert.deepEqual(h.s.gapAttempts, { G1: 1 }, 'the closing is no attempt');
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.stt >= 2); await until(() => !h.s.busy() && h.s.sttBusy === 0);
  await h.s.onText(JSON.stringify({ type: 'end' })); await until(() => h.events.some(e => e.type === 'ended'));
  assert.deepEqual(h.events.find(e => e.type === 'notes').gap.results[0], { askId: 'G1', field: 'evidence', status: 'open', quotes: ['Um, not sure.'] });

  let hold, gated = true;
  const w = harness(['We rebuilt the claims intake.', 'Then we cut the backlog by a third in two months.'], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield 'Thank you so much for your time. '; if (calls.talker.length === 2 && gated) await new Promise(r => { hold = r; }); yield 'Goodbye.'; } }));
  w.s.gaps = resolver();
  await gapOpened(w);
  for (let i = 0; i < 262 / 0.02; i++) w.tick();
  say(w, [[1.2, .2], [1.3, .001]]);
  await until(() => w.calls.talker.length === 2 && w.s.shown.item === 'agent-2');
  assert.equal(w.s.openAsk, null, 'the closing is being heard');
  say(w, [[1.0, .2], [1.3, .001]]);
  await until(() => w.calls.talker.length === 3);
  gated = false; hold?.();
  await until(() => !w.s.busy());
  assert.ok(w.events.some(e => e.type === 'agent_retract' && e.item_id === 'agent-2'));
  assert.deepEqual(w.s.gapAttempts, { G1: 1 }, 'no attempt counted or taken back for a closing');
  assert.deepEqual(w.s.gapAnswers.G1, [['We rebuilt the claims intake.', 'Then we cut the backlog by a third in two months.']], 'the continuation joins its ask');
});

test('gap: a still-thinking reply that asks the next item counts as asking it; a reply that only nudges does not', async () => {
  const unfinished = { async turnComplete() { return { complete: false, probability: 0.2 }; } };
  const g1 = 'The audit report was signed off by the client quality team last year.', g2 = 'We compared handling time before and after the rollout over three months.';
  const h = harness([g1, g2], { ...unfinished, session: { gaps: resolver() } });
  await gapOpened(h);
  await sayAsync(h, [[1.2, .2], [2.7, .001]]);
  await until(() => h.calls.talker.length >= 2 && !h.s.busy());
  assert.equal(h.calls.talker[1].at(-1).content, STILL_THINKING);
  assert.ok(h.calls.talker[1].some(m => m.content.startsWith('ANALYST_GUIDANCE') && m.content.includes('"askId":"G2"')));
  assert.equal(h.s.openAsk, 'G2', 'the question asked G2'); assert.deepEqual(h.s.gapAttempts, { G1: 1, G2: 1 });
  await sayAsync(h, [[1.2, .2], [2.7, .001]]);
  await until(() => h.calls.talker.length >= 3 && !h.s.busy());
  await h.s.onText(JSON.stringify({ type: 'end' })); await until(() => h.events.some(e => e.type === 'ended'));
  const results = h.events.find(e => e.type === 'notes').gap.results;
  assert.deepEqual(results.slice(0, 2).map(r => [r.askId, r.status, r.quotes]), [['G1', 'answered_unverified', [g1]], ['G2', 'answered_unverified', [g2]]]);

  const n = harness(['We moved the whole billing platform to the new provider', 'and it halved the monthly hosting bill in the first quarter.'], calls => ({ ...unfinished,
    async *chatStream(m) { calls.talker.push(m); yield* (calls.talker.length === 2 ? ['Take your time.'] : ['Thanks. ', 'What was ', 'the baseline?']); } }));
  n.s.gaps = resolver();
  await gapOpened(n);
  await sayAsync(n, [[1.2, .2], [2.7, .001]]);
  await until(() => n.calls.talker.length >= 2 && !n.s.busy());
  assert.equal(n.calls.talker[1].at(-1).content, STILL_THINKING);
  assert.deepEqual([n.s.openAsk, n.s.gapAttempts], ['G1', { G1: 1 }], 'a nudge asks nothing: the window stays on G1');
});

// ---- Speaking well: phrasing, pipelined synthesis and diagnostics (numbers only) ----
const named = (metrics, name) => metrics.filter(([n]) => n === name).map(([, v]) => v);

test('phrasing: markup is never voiced but stays on screen; short sentences join the next piece; text travels with its audio', async () => {
  const h = harness([], calls => ({ async *chatStream(m) { calls.talker.push(m); yield* ['**Great.** ', 'That is clear. ', 'So it worked. ', 'Who measured the change before and after?', ' Ok.']; } }));
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy() && spoken(h.calls).length === 5);
  assert.deepEqual(spoken(h.calls), [...GREETING, 'Great.', 'That is clear. So it worked. Who measured the change before and after?', 'Ok.']);
  assert.deepEqual(h.events.filter(e => e.type === 'agent_text').map(e => e.text),
    [GREETING[0], ' ' + GREETING[1], ' **Great.**', ' That is clear. So it worked. Who measured the change before and after?', ' Ok.'], 'each piece shown exactly when its audio starts');
});

test('pipelined synthesis: the next piece is synthesised while the one before it is, and audio stays in order', async () => {
  const gates = {}, long = 'Who owned the budget for the whole programme across all regions?';
  const h = harness([], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield* ['Thanks. ', long + ' ', 'And when?']; },
    async synthesize(t) { calls.tts.push(t); if (!GREETING.includes(t)) await new Promise(r => { gates[t] = r; }); return new Uint8Array(t === long ? 1000 : 4800).fill(1); } }));
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => h.calls.tts.includes(long) && h.bytes.length === 10); await settle(); // the greeting (two pieces) has been sent
  assert.ok(gates['Thanks.'] && h.bytes.length === 10, 'the second piece started before the first was voiced');
  const sent = h.bytes.length;
  gates[long](); await settle();
  assert.equal(h.bytes.length, sent, 'nothing overtakes the first piece');
  gates['Thanks.'](); await until(() => h.calls.tts.includes('And when?')); gates['And when?']();
  await until(() => !h.s.busy() && h.bytes.length === sent + 12);
  assert.deepEqual(h.bytes.slice(sent), [960, 960, 960, 960, 960, 960, 40, 960, 960, 960, 960, 960], 'Thanks., then the question, then And when?');
  assert.deepEqual(h.events.filter(e => e.type === 'agent_text').map(e => e.text).slice(2), [' Thanks.', ' ' + long, ' And when?']);
  assert.equal(h.s.history.at(-1).content, GREETINGS.en + ' Thanks. ' + long + ' And when?');
});

test('pipelined synthesis: an interruption drops every piece still being synthesised', async () => {
  const gates = {}, long = 'Who owned the budget for the whole programme across all regions?';
  const h = harness([], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield* ['Thanks. ', long + ' ', 'And when?']; },
    async synthesize(t) { calls.tts.push(t); if (!GREETING.includes(t)) await new Promise(r => { gates[t] = r; }); return new Uint8Array(4800).fill(1); } }));
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => h.calls.tts.includes(long));
  await until(() => h.bytes.length === 10); const shown = h.events.filter(e => e.type === 'agent_text').length;
  h.s.interrupt(); gates[long](); gates['Thanks.'](); await settle();
  await until(() => !h.s.speaking);
  assert.equal(h.bytes.length, 10, 'no audio after the interruption'); assert.equal(h.events.filter(e => e.type === 'agent_text').length, shown, 'and no text');
  assert.ok(!h.calls.tts.includes('And when?'), 'the rest of the reply is not synthesised');
});

test('tts metric: synthesis latency, audio length, characters and cache hits for every piece (numbers only)', async () => {
  const metrics = [];
  const h = harness(['We moved the whole billing platform to the new provider last spring with a team of five.'], { session: { metric: (n, v) => metrics.push([n, v]) } });
  await opened(h);
  say(h, [[1.2, .2], [1.3, .001]]);
  await until(() => h.calls.talker.length === 2 && !h.s.busy());
  const tts = named(metrics, 'tts');
  assert.deepEqual(tts[0], { ms: 0, audio_ms: 100, chars: GREETING[0].length, cached: 0 });
  assert.ok(tts.some(v => v.cached === 1 && v.ms === 0), 'the acknowledgement came from cache');
  assert.ok(tts.every(v => Object.keys(v).join() === 'ms,audio_ms,chars,cached' && Object.values(v).every(Number.isFinite)));
  assert.equal(tts.length, 2 + 2 + 1 + 2, '2 greeting pieces + 2 opening pieces, then acknowledgement + 2 reply pieces');
});

test('underrun metric: the queue runs dry mid-reply while the next piece is still being voiced', async () => {
  const metrics = []; let voice; const long = 'Who owned the budget for the whole programme across all regions?';
  const h = harness([], calls => ({
    async *chatStream(m) { calls.talker.push(m); yield* ['Thanks. ', long]; },
    async synthesize(t) { calls.tts.push(t); if (t === long) await new Promise(r => { voice = r; }); return new Uint8Array(4800).fill(1); } }));
  h.s.metric = (n, v) => metrics.push([n, v]); // the function form of harness() takes no session options
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => h.bytes.length === 15 && voice); await settle();
  for (let i = 0; i < 50; i++) h.tick(); // 1 s passes: the greeting and "Thanks." (0.2 s) have long finished playing
  voice(); await until(() => h.bytes.length === 20);
  assert.deepEqual(named(metrics, 'underrun'), [{ gap_ms: 700 }], 'one second of silence less the greeting (two 100 ms pieces) and "Thanks." (100 ms) already played');
});

test('underrun metric: the planned wait after a greeting before the model speaks is not an underrun', async () => {
  const metrics = []; let start; const ask = 'Which project would you like to talk about today?';
  const h = harness([], calls => ({
    async *chatStream(m) { calls.talker.push(m); await new Promise(r => { start = r; }); yield ask; },
    async synthesize(t) { calls.tts.push(t); return new Uint8Array(4800).fill(1); } }));
  h.s.metric = (n, v) => metrics.push([n, v]);
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => h.bytes.length === 5 && start); await settle();
  for (let i = 0; i < 75; i++) h.tick(); // 1.5 s: the greeting has long finished and the model is still composing
  start(); await until(() => h.bytes.length === 10);
  assert.deepEqual(named(metrics, 'underrun'), []);
});

test('turn_check says why the turn model gave no verdict: timeout or the error name (never its message)', async () => {
  for (const [turnComplete, extra] of [[() => new Promise(() => {}), { reason: 'timeout' }], [async () => { throw new TypeError('bad audio for Zelda'); }, { reason: 'error', name: 'TypeError' }],
    [async () => null, { reason: 'error', name: 'NoVerdict' }], [async () => ({ complete: false, probability: 0.2 }), {}]]) {
    const metrics = [];
    const h = harness(['We had to rethink the whole approach.'], { session: { metric: (n, v) => metrics.push([n, v]) }, turnComplete });
    await opened(h);
    say(h, [[1.5, .2], [0.72, .001]]);
    await new Promise(r => setTimeout(r, 400)); await settle();
    const verdict = extra.reason ? { complete: -1, probability: -1 } : { complete: 0, probability: 0.2 };
    assert.deepEqual(named(metrics, 'turn_check'), [{ ...verdict, used: 1, ...extra }]);
    assert.ok(!JSON.stringify(metrics).includes('Zelda'));
    await h.s.end(false); open.delete(h.s);
  }
});

test('every session starts with the spoken introduction, admin included (full mode)', async () => {
  for (const admin of [false, true]) {
    const h = harness(undefined, { session: { admin } });
    await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
    await until(() => h.calls.talker.length >= 1);
    const said = notesOf(h.calls.talker[0]).find(n => n.startsWith('ALREADY SAID')) || '';
    assert.ok(said.includes(GREETINGS.en), (admin ? 'admin' : 'consultant') + ': the greeting was spoken first and the talker knows it');
    await until(() => h.events.filter(e => e.type === 'agent_text').length >= 2);
    assert.ok(h.events.filter(e => e.type === 'agent_text').slice(0, 2).map(e => e.text).join('').includes(GREETINGS.en), 'the first words on screen are the greeting');
  }
});
