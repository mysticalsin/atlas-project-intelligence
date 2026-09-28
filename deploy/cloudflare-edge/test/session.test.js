import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, projectContext, talkerMessages, TIME_UP, RESUME as RESUME_TEXT } from '../src/session.js';
import { SAMPLE_RATE } from '../src/speech.js';

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
function harness(said = ['We cut triage time by about 40% after the rollout.'], extra = {}) {
  const events = [], bytes = [], calls = { talker: [], analyst: [], stt: 0, tts: [] }; let t = 1000, closed = false;
  const ai = {
    async transcribe(pcm) { calls.stt += 1; assert.ok(pcm.length > 0); return said[calls.stt - 1] || ''; },
    async synthesize(text) { calls.tts.push(text); return new Uint8Array(4800).fill(1); },
    async *chatStream(messages) { calls.talker.push(messages); for (const d of ['Thanks. ', 'What was ', 'the baseline?']) yield d; },
    async analyst(messages) { calls.analyst.push(messages); const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
      return [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details: [{ field: 'outcome', item_id: seg.item_id, quote: 'We cut triage time by about 40%' }] }) }]; },
  };
  const { session: _opts, ...aiExtra } = typeof extra === 'function' ? extra(calls) : extra;
  Object.assign(ai, aiExtra);
  const opts = typeof extra === 'function' ? {} : (extra.session || {});
  const s = new Session({ ...opts, io: { send: e => events.push(e), sendBytes: b => bytes.push(b.length), close: () => { closed = true; } }, ai, csrf: 'tok',
    voice: 'asteria', model: 'test-talker', now: () => t, sleep: () => new Promise(r => setImmediate(r)) });
  open.add(s);
  const tick = () => { t += 0.02; };
  return { s, events, bytes, calls, tick, closed: () => closed };
}
const open = new Set();
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); });
const until = async (cond, n = 2000) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setImmediate(r)); assert.ok(cond(), 'condition not reached'); };

test('full interview: opening, turn, transcript, evidence, guidance, notes', async () => {
  const h = harness();
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'asteria', capture: true, memory: false }));
  assert.equal(h.events[0].type, 'ready');
  await until(() => h.bytes.length >= 10); // opening synthesized: 2 sentences x 4800 bytes
  assert.deepEqual(h.calls.tts, ['Thanks.', 'What was the baseline?']);
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
  const agent = h.events.filter(e => e.type === 'agent_text').map(e => e.text).join('');
  assert.ok(agent.includes('\n\nThanks.'));
  await h.s.onText(JSON.stringify({ type: 'end' }));
  const notes = h.events.find(e => e.type === 'notes');
  assert.equal(notes.status, 'candidate'); assert.equal(notes.sections[3], 'We cut triage time by about 40%');
  assert.ok(!notes.transcript.includes('Thanks') && h.events.at(-1).type === 'ended' && h.closed());
});

test('consultant speaking over ATLAS interrupts playback', async () => {
  const h = harness([]);
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
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

test('live regression: noise while ATLAS composes its opening cannot cancel it', async () => {
  const h = harness([]);
  let release; const gate = new Promise(r => { release = r; });
  const base = h.s.ai.chatStream; h.s.ai.chatStream = async function* (m) { await gate; yield* base(m); };
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  for (const f of frames([[0.2, .001], [0.5, .4]])) { h.tick(); h.s.onBinary(f); } // loud room noise, nothing audible yet
  assert.ok(!h.events.some(e => e.type === 'clear_audio' || e.type === 'user_speaking'));
  release(); await until(() => h.bytes.length >= 10);
  assert.deepEqual(h.calls.tts, ['Thanks.', 'What was the baseline?']);
  await h.s.end(false);
});

test('live regression: an interruption that was only noise makes ATLAS re-ask', async () => {
  const h = harness(['']); // barge-in audio transcribes to nothing
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false }));
  await until(() => !h.s.busy());
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
  const h = harness(['That is everything, I am done.'], calls => ({
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
  assert.ok(JSON.parse(h.calls.report[1].content).interview_transcript.includes('Consultant: That is everything, I am done.'));
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
  assert.ok(last.some(m => m.role === 'system' && m.content.startsWith('INTERVIEW PACE') && m.content.includes('Time is nearly up')));
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
