// Agent Brain v2.1 T7: speech-recognition doubt inside a live Session. A number or proper noun the recogniser was unsure of is
// confirmed aloud (once), never silently converted; a yes / "no, it was 35" settles it without a loop; the doubt and the audio offset
// travel with the user_text event, the ledger details and the notes. Same fakes as session-humane.test.js: scripted STT with word
// confidences, synthetic voice, talker and analyst, fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, clearPcmCache } from '../src/session.js';
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
// 'twenty:0.4 five:0.4 minutes' -> word list; a word may carry ':confidence'. Start and end follow the position.
const words = (spec, conf = 0.95) => spec.split(' ').map((t, i) => { const [w, c] = t.split(':'); return { w, c: c ? Number(c) : conf, s: Math.round(i * 400) / 1000, e: Math.round(i * 400 + 350) / 1000 }; });
const heard = (spec, text = spec.replace(/:[0-9.]+/g, '')) => ({ text, language: 'en', words: words(spec) });

function harness({ said = [], flags = {}, metrics = [], session = {}, file = seg => ({ field: 'outcome', quote: seg.text.slice(0, 31) }) } = {}) {
  const events = [], bytes = [], calls = { talker: [], stt: 0 }; let t = 1000;
  const ai = {
    async transcribe() { calls.stt += 1; return said[calls.stt - 1] ?? ''; },
    async synthesize() { return new Uint8Array(4800).fill(1); },
    chatStream(messages) { calls.talker.push(messages); return (async function* () { yield* ['Thanks. ', 'What was ', 'the baseline?']; })(); },
    async analyst(messages) { // files the first words of every turn as an outcome detail (file(seg) -> {field, quote} | null to change that)
      const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment, f = file(seg);
      return f ? [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details: [{ field: f.field, item_id: seg.item_id, quote: f.quote }] }) }] : [];
    },
  };
  const s = new Session({ flags: { replyGuard: 'off', ...flags }, ...session, io: { send: e => events.push(e), sendBytes: b => bytes.push(b.length), close: () => {} }, ai, csrf: 'tok',
    voice: 'asteria', model: 'test-talker', now: () => t, sleep: () => new Promise(r => setImmediate(r)), metric: (n, v) => metrics.push([n, v]) });
  open.add(s);
  return { s, events, bytes, calls, metrics, tick: () => { t += 0.02; } };
}
const open = new Set();
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); clearPcmCache(); });
const settle = async (n = 200) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const until = async (cond, n = 3000) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setImmediate(r)); assert.ok(cond(), 'condition not reached'); };
const say = (h, segs) => { for (const f of frames(segs)) { h.tick(); h.s.onBinary(f); } };
const talked = h => say(h, [[1.2, .2], [1.3, .001]]);
async function opened(h) {
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true, voice: 'asteria', memory: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 15);
  h.s.playedMs[h.s.protectedItem] = 1e9;
}
// One consultant turn, then wait for ATLAS's reply to be composed and spoken; returns the NEXT MOVE note the talker was given.
async function turn(h) {
  const before = h.calls.talker.length;
  talked(h);
  await until(() => h.calls.talker.length > before && !h.s.busy());
  await h.s.pending.size && Promise.allSettled([...h.s.pending]); await settle(20);
  return h.calls.talker[before].filter(m => m.role === 'system' && m.content.startsWith('NEXT MOVE')).map(m => m.content)[0] || '';
}
const named = (metrics, name) => metrics.filter(([n]) => n === name).map(([, v]) => v);
const confirms = h => h.s.humane.asked.filter(m => m.intent === 'confirm_asr');

test('uncertain number: the next move is a confirm_asr that names it; the doubt rides on the user_text event', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run')] });
  await opened(h);
  const note = await turn(h);
  assert.match(note, /kind: confirm_asr/); assert.match(note, /twenty five/);
  assert.equal(confirms(h).length, 1); assert.match(confirms(h)[0].say, /twenty five/);
  const ev = h.events.find(e => e.type === 'user_text');
  assert.equal(ev.asr.min_conf, 0.4); assert.equal(ev.asr.spans.length, 1);
  assert.deepEqual({ text: ev.asr.spans[0].text, kind: ev.asr.spans[0].kind, min_conf: ev.asr.spans[0].min_conf }, { text: 'twenty five', kind: 'number', min_conf: 0.4 });
  assert.ok(Number.isInteger(ev.asr.audio_offset_ms) && ev.asr.audio_offset_ms >= 0 && ev.asr.spans[0].audio_offset_ms >= 800);
  assert.deepEqual(named(h.metrics, 'asr'), [{ words: 10, spans: 1, min_conf: 40 }]);
});

test('details from the doubtful turn are marked asr_unconfirmed with the turn\'s confidence and offset', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run')] });
  await opened(h); await turn(h); await h.s.turnJob;
  const d = h.s.ledger.details.find(x => x.item_id === 'user-1');
  assert.equal(d.asr_unconfirmed, true); assert.equal(d.asr_min_conf, 0.4); assert.equal(d.audio_offset_ms, h.s.asrMeta['user-1'].audioOffsetMs);
});

test('"yes" confirms the span: no re-ask, flag cleared, nothing superseded', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run'), heard('yes that is right')] });
  await opened(h); await turn(h);
  const note = await turn(h); await h.s.turnJob;
  assert.doesNotMatch(note, /kind: confirm_asr/); assert.equal(confirms(h).length, 1);
  assert.equal(h.s.asrMeta['user-1'].spans[0].status, 'confirmed');
  const d = h.s.ledger.details.find(x => x.item_id === 'user-1');
  assert.equal(d.asr_unconfirmed, false); assert.equal(d.active, true);
  assert.equal(h.s.asrFor(), null);
});

test('"no, thirty five": the correction is recorded, the span resolved, and ATLAS does not loop', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run'), heard('no, it was thirty:0.4 five:0.4')] });
  await opened(h); await turn(h);
  const note = await turn(h); await h.s.turnJob;
  assert.doesNotMatch(note, /kind: confirm_asr/); assert.doesNotMatch(note, /asr_repair|misheard/); assert.equal(confirms(h).length, 1);
  const span = h.s.asrMeta['user-1'].spans[0];
  assert.equal(span.status, 'corrected'); assert.equal(span.corrected_to, 'thirty five');
  assert.deepEqual(h.s.asrMeta['user-2'].spans, [], 'the corrected value is not itself put in doubt');
  const old = h.s.ledger.details.find(x => x.item_id === 'user-1'), fresh = h.s.ledger.details.find(x => x.supersedes === old.id);
  assert.equal(old.active, false); assert.ok(fresh && fresh.active && fresh.provenance === 'consultant_corrected' && fresh.item_id === 'user-2');
  assert.match(fresh.quote, /thirty five/); assert.equal(fresh.asr_corrected_from, 'twenty five'); assert.equal(old.asr_unconfirmed, false);
  assert.equal(h.s.asrFor(), null);
});

test('"no, thirty five" when the analyst filed nothing for that field: the ledger supersede rule records the correction', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run'), heard('no, it was thirty:0.4 five:0.4')],
    file: seg => seg.item_id === 'user-1' ? { field: 'outcome', quote: seg.text.slice(0, 31) } : null });
  await opened(h); await turn(h); await turn(h); await h.s.turnJob;
  const old = h.s.ledger.details.find(x => x.item_id === 'user-1'), fresh = h.s.ledger.details.find(x => x.supersedes === old.id);
  assert.equal(old.active, false); assert.equal(fresh.provenance, 'consultant_corrected'); assert.equal(fresh.field, 'outcome'); assert.equal(fresh.quote, 'no, it was thirty five');
  assert.equal(fresh.asr_min_conf, 0.4); assert.ok(Number.isInteger(fresh.audio_offset_ms));
  assert.equal(h.s.ledger.inspect().candidate_details.filter(d => d.field === 'outcome').length, 1, 'one active outcome account, not two');
});

test('a correction the ledger cannot link (quote under five characters) leaves the old detail active, marked, still unconfirmed', async () => {
  const h = harness({ said: [heard('we cut the time by 25:0.3 percent across the board'), heard('no that is wrong'), heard('35')],
    file: seg => seg.item_id === 'user-1' ? { field: 'outcome', quote: seg.text.slice(0, 31) } : null });
  await opened(h); await turn(h); await turn(h); await turn(h); await h.s.turnJob;
  const old = h.s.ledger.details.find(x => x.item_id === 'user-1');
  assert.equal(h.s.asrMeta['user-1'].spans[0].corrected_to, '35');
  assert.equal(old.active, true); assert.equal(old.asr_correction, '35'); assert.equal(old.asr_unconfirmed, true);
  assert.equal(h.metrics.filter(([n]) => n === 'asr_correction_unlinked').length, 1);
});

test('a bare "no" asks for the right one once; the next answer is the correction', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run'), heard('no that is not right'), heard('thirty five minutes')] });
  await opened(h); await turn(h);
  const repair = await turn(h);
  assert.match(repair, /asr_repair/); assert.equal(h.s.asrMeta['user-1'].spans[0].status, 'denied');
  const next = await turn(h); await h.s.turnJob;
  assert.doesNotMatch(next, /confirm_asr|asr_repair/);
  assert.equal(h.s.asrMeta['user-1'].spans[0].status, 'corrected'); assert.equal(h.s.asrMeta['user-1'].spans[0].corrected_to, 'thirty five');
  assert.equal(confirms(h).length, 1); assert.equal(h.s.humane.asked.filter(m => m.intent === 'asr_repair').length, 1);
});

test('a bare "no" then "I do not know" leaves the span unresolved (never guessed)', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run'), heard('no that is not right'), heard('I do not know what it was')] });
  await opened(h); await turn(h); await turn(h); await turn(h); await h.s.turnJob;
  assert.equal(h.s.asrMeta['user-1'].spans[0].status, 'denied');
  assert.equal(h.s.ledger.details.find(x => x.item_id === 'user-1').asr_unconfirmed, true);
});

test('a span is confirmed at most once: an unrelated answer leaves it open and it is not asked again', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run'), heard('we also used Kafka for the whole pipeline last year'), heard('and the team adopted it quickly')] });
  await opened(h); await turn(h);
  const second = await turn(h), third = await turn(h);
  assert.doesNotMatch(second, /confirm_asr/); assert.doesNotMatch(third, /confirm_asr/); assert.equal(confirms(h).length, 1);
  assert.equal(h.s.asrMeta['user-1'].spans[0].status, 'open');
});

test('a proper noun below the threshold is confirmed by name', async () => {
  const h = harness({ said: [heard('we built it for Contoso:0.35 last spring and it went well')] });
  await opened(h);
  const note = await turn(h);
  assert.match(note, /kind: confirm_asr/); assert.match(note, /Contoso/);
  assert.equal(h.events.find(e => e.type === 'user_text').asr.spans[0].kind, 'proper_noun');
});

test('high confidence: no span, no confirmation, but the minimum confidence and offset are still kept', async () => {
  const h = harness({ said: [heard('it took twenty five minutes to finish the batch run')] });
  await opened(h);
  const note = await turn(h);
  assert.doesNotMatch(note, /confirm_asr/); assert.equal(confirms(h).length, 0);
  const ev = h.events.find(e => e.type === 'user_text');
  assert.deepEqual(ev.asr.spans, []); assert.equal(ev.asr.min_conf, 0.95);
});

test('missing words: behaviour is unchanged (no asr key, no spans, no metric)', async () => {
  const h = harness({ said: [{ text: 'it took twenty five minutes to finish the batch run', language: 'en' }, 'we also used Kafka for the pipeline'] });
  await opened(h);
  const note = await turn(h); await turn(h);
  assert.doesNotMatch(note, /confirm_asr/); assert.equal(h.s.asrFor(), null);
  assert.ok(h.events.filter(e => e.type === 'user_text').every(e => !('asr' in e)));
  assert.deepEqual(named(h.metrics, 'asr'), []);
  assert.deepEqual(h.s.asrMeta, {});
});

test('ASR_CONFIRM_TAU lowers the bar: 0.4 is not doubtful at tau 0.3', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run')], flags: { asrTau: 0.3 } });
  await opened(h);
  assert.doesNotMatch(await turn(h), /confirm_asr/);
});

test('notes carry the recognition doubt and audio offsets per turn (T13 shape: asr[item] = {min_conf, audio_offset_ms})', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run'), heard('no, it was thirty:0.4 five:0.4')] });
  await opened(h); await turn(h); await turn(h);
  await h.s.end(true);
  const notes = h.events.find(e => e.type === 'notes');
  assert.deepEqual(Object.keys(notes.asr), ['user-1', 'user-2']);
  for (const m of Object.values(notes.asr)) { assert.equal(m.min_conf, 0.4); assert.ok(Number.isInteger(m.audio_offset_ms) && m.audio_offset_ms >= 0); }
  assert.ok(notes.asr['user-2'].audio_offset_ms > notes.asr['user-1'].audio_offset_ms, 'the second utterance starts later in the microphone stream');
  assert.deepEqual(notes.asr['user-1'].spans.map(s => [s.text, s.status, s.corrected_to]), [['twenty five', 'corrected', 'thirty five']]);
});

test('no capture: no ledger, no analyst, yet the confirmation and the yes still work', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run'), heard('yes')] });
  await h.s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: false, voice: 'asteria', memory: false }));
  await until(() => !h.s.busy() && h.bytes.length >= 15); h.s.playedMs[h.s.protectedItem] = 1e9;
  assert.match(await turn(h), /confirm_asr/); await turn(h);
  assert.equal(h.s.asrMeta['user-1'].spans[0].status, 'confirmed');
});

test('legacy selector never confirms (the flag keeps the earlier behaviour) but still records the doubt', async () => {
  const h = harness({ said: [heard('it took twenty:0.4 five:0.4 minutes to finish the batch run')], flags: { selector: 'legacy' } });
  await opened(h);
  assert.equal(await turn(h), ''); assert.equal(confirms(h).length, 0); assert.equal(h.s.asrMeta['user-1'].spans.length, 1);
});
