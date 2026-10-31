// Agent Brain v2.1 T16: the conversation evaluation. Pack scenarios 1-9 (07_Evaluation_and_QA/ATLAS_Evaluation_Framework.md section 3) driven through the
// REAL Session: the real selector, turn pre-pass, acknowledgements, ReplyGuard, state machine, ledger, summary, checkpoint and (for the read-back) the real
// evidence store. Only the outside world is faked (speech recognition, voice, talker model, evidence analyst) with the rig of reconnect-harness.js.
// Every scenario runs in two talker modes (fixtures/eval/talkers.json):
//   scripted     says exactly the move's proposed wording, as a well-behaved model would;
//   adversarial  ignores it: "Amazing!", the same opener every turn, two or three questions, invented figures in the read-back.
// and after every consultant turn the same invariants must hold: at most one question voiced, no banned praise voiced, an acknowledgement that fits the answer
// (a setback is never met with an upbeat one, an unbased result is never "earned"), no question asked twice or asked of what is already known, the expected
// transitions in the audit trail, and the consultant's name in no model message.
// The data of each scenario (what is said, what the analyst files, what must follow) lives in fixtures/eval/*.json; this file is the player and the checks.
// A regression aid, not a measure of how humane the live model is: Llama adherence and Aura naturalness are judged with pilot users (COVERAGE.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BANNED_PRAISE_SRC, ACKS } from '../src/policy.generated.js';
import { SUMMARY_QUESTION } from '../src/summary.js';
import { analyzeTurn } from '../src/turns.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { evidence, postDraftFromInterview } from '../src/evidence.js';
import { memorySql } from './sqlite.js';
import { rig, opened, talked, send, say, until, settle, cleanup, named, screen, startMsg, sessionIdOf, written, USER, PROJECT } from './reconnect-harness.js';

test.afterEach(cleanup);

const FX = id => JSON.parse(readFileSync(new URL(`./fixtures/eval/${id}.json`, import.meta.url), 'utf8'));
const TALK = FX('talkers').adversarial, BANNED = new RegExp(BANNED_PRAISE_SRC, 'i');
const NAME = PROJECT.consultant; // 'Alex': it must reach no model, no voice and no event of the interview
const UPBEAT = new Set(['earned_result', 'promising_unverified']);
const MODES = ['scripted', 'adversarial'];

// ---- the talkers ----
const wordingOf = messages => {
  const note = messages.filter(m => m.role === 'system' && m.content.startsWith('NEXT MOVE')).map(m => m.content).pop() || '';
  const m = /proposed wording: ("(?:[^"\\]|\\.)*")/.exec(note);
  return { wording: m ? JSON.parse(m[1]) : '', summary: /kind: summary/.test(note) };
};
const firstQuestion = text => (text.match(/[^.?!]*\?/) || [''])[0].trim();
const scripted = (n, messages) => n === 0 ? ['What was the project?'] : [wordingOf(messages).wording || 'Please go on.'];
const adversarial = (n, messages) => {
  if (n === 0) return TALK.opening;
  const { wording, summary } = wordingOf(messages);
  if (summary) return [...TALK.lead, TALK.invented, SUMMARY_QUESTION + ' ', TALK.third_question];
  return [...TALK.lead, (firstQuestion(wording) || TALK.fallback_question) + ' ', TALK.second_question, TALK.third_question];
};
const talkerOf = mode => mode === 'adversarial' ? adversarial : scripted;

// ---- the speech recognition and the evidence analyst of a scenario ----
const words = (spec, conf = 0.95) => spec.split(' ').map((t, i) => { const [w, c] = t.split(':'); return { w, c: c ? Number(c) : conf, s: Math.round(i * 400) / 1000, e: Math.round(i * 400 + 350) / 1000 }; });
const heard = spec => ({ text: spec.replace(/:[0-9.]+/g, ''), language: 'en', words: words(spec) });
const utterance = t => t.heard ? heard(t.heard) : t.said;
const textOf = t => t.heard ? heard(t.heard).text : t.said;
// The analyst files what the fixture says for the turn, in the consultant's exact words (the ledger checks every quote against the transcript).
function analystFor(turns, offset, seen) {
  return async messages => {
    seen.push(messages);
    const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment, idx = Number(seg.item_id.split('-')[1]) - 1 - offset, filings = (turns[idx]?.file || []).map(x => ({ ...x, item_id: seg.item_id }));
    return filings.length ? [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details: filings }) }] : [];
  };
}

// A real library behind a fake Worker binding: the draft a confirmed read-back makes is checked where "owner only" and "never submitted" are enforced.
function library() {
  let t = 0, n = 0;
  const lib = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') });
  const env = { LIBRARY: { idFromName: name => name, get: () => ({ fetch: async req => libraryRoutes(req, lib, {}) }) } };
  return { lib, ev: evidence(lib), hook: notes => postDraftFromInterview(env, { user: USER, role: 'user', mail: USER }, notes) };
}
const OWNER = { email: USER, role: 'user' };

// ---- playing a scenario ----
const voicedSince = (h, from) => screen({ events: h.events.slice(from) });
const subseq = (all, want) => { let i = 0; for (const x of all) if (x === want[i]) i++; return i === want.length; };

// One consultant turn: speak, wait for the reply to be composed and voiced, collect what the checks need.
async function turn(h, i, t, { offset = 0 } = {}) {
  const from = h.events.length, before = h.calls.talker.length, acks = named(h.metrics, 'ack').length, asked = h.s.humane.asked.length;
  talked(h);
  await until(() => h.calls.talker.length === before + 1 && !h.s.busy());
  await h.s.turnJob; await settle(20);
  const moves = h.s.humane.asked.slice(asked), ackNow = named(h.metrics, 'ack').slice(acks);
  return { i: offset + i, text: textOf(t), analysis: analyzeTurn(textOf(t), 'en', {}), voiced: voicedSince(h, from), move: moves.at(-1) || null, ack: ackNow.at(-1)?.category ?? null, fixture: t };
}

const partial = (got, want, msg) => { for (const [k, v] of Object.entries(want)) assert.equal(got?.[k], v, `${msg}: move.${k}`); };

// The per-turn invariants every scenario and both talkers must satisfy.
function invariants(h, t, mode) {
  const label = `[${mode}] turn ${t.i + 1}`;
  const q = (t.voiced.match(/\?/g) || []).length;
  assert.ok(q <= 1, `${label}: at most one question voiced, got ${q}: ${JSON.stringify(t.voiced)}`);
  assert.ok(!BANNED.test(t.voiced), `${label}: no banned praise voiced: ${JSON.stringify(t.voiced)}`);
  if (t.ack !== null) {
    assert.ok(Object.hasOwn(ACKS, t.ack), `${label}: the acknowledgement is one of the banks`);
    if (t.analysis.cues.includes('describes_setback')) assert.ok(!UPBEAT.has(t.ack) && t.ack !== 'thanks_detail', `${label}: a setback is never met with an upbeat acknowledgement (${t.ack})`);
    if (t.analysis.cues.includes('metric') || t.analysis.cues.includes('estimate')) assert.notEqual(t.ack, 'earned_result', `${label}: a figure whose basis is unknown is never "earned"`);
  }
}

function finish(h, fx, mode, turns) {
  const asked = h.s.humane.asked.filter(m => m.why !== 'repeat_last');
  const keys = asked.map(m => `${m.kind === 'confirm_asr' ? 'asr' : m.intent}|${m.field}|${m.say}`);
  assert.equal(new Set(keys).size, keys.length, `[${mode}] no question is asked twice: ${JSON.stringify(keys)}`);
  for (const m of asked) {
    assert.ok(!(m.intent === 'role' && h.s.prefill.role), `[${mode}] the role is known from the prefill and is not asked`);
    assert.ok(!/\b(what|which) (is your )?(role|sector|industry|stage)\b/i.test(m.say), `[${mode}] nothing the prefill already holds is asked: ${m.say}`);
  }
  assert.deepEqual(h.s.prefill, { role: PROJECT.role, sector: PROJECT.sector, stage: PROJECT.stage }, 'the prefill is the authorised context only');
  const audit = h.s.machine.audit.map(a => a.event);
  assert.ok(subseq(audit, fx.audit), `[${mode}] the audit trail holds ${fx.audit.join(' > ')}: ${audit.join(' > ')}`);
  assert.ok(!audit.includes('state_error') && !named(h.metrics, 'state_error').length && !named(h.metrics, 'selector_error').length, `[${mode}] no illegal transition, no selector failure`);
  const toModels = JSON.stringify([h.calls.talker, h.seen, h.calls.tts, h.events]);
  assert.ok(!toModels.includes(NAME), `[${mode}] the consultant's name is in no model message, voice line or event`);
  // The opening and every reply: one question at most, whatever the talker wrote (the opening is a reply too).
  for (const m of h.s.history.filter(x => x.role === 'assistant')) assert.ok((m.content.match(/\?/g) || []).length <= 1, `[${mode}] one question per reply: ${JSON.stringify(m.content)}`);
  if (mode === 'adversarial') {
    const stats = named(h.metrics, 'reply_guard'), sum = k => stats.reduce((n, s) => n + (s[k] || 0), 0);
    assert.ok(sum('dropped_after_question') >= 1 && sum('dropped_praise') >= 1, `[${mode}] the adversarial talker really misbehaved and the guard really acted: ${JSON.stringify(stats)}`);
    const opener = s => (s.match(/[^.?!]*[.?!]/) || [''])[0].trim().toLowerCase();
    const replies = turns.map(t => opener(t.voiced.replace(/^\s+/, '')));
    for (let k = 1; k < replies.length; k++) assert.ok(!replies[k] || replies[k] !== replies[k - 1], `[${mode}] no repeated opener: ${JSON.stringify(replies)}`);
  }
}

// Check what the fixture expects of one turn, then the invariants.
function checkTurn(h, t, mode) {
  const e = t.fixture.expect || {};
  if (e.move) partial(t.move, e.move, `turn ${t.i + 1} (${t.text.slice(0, 40)})`);
  if (e.not_intent) assert.ok(!e.not_intent.includes(t.move?.intent), `turn ${t.i + 1}: not ${t.move?.intent}`);
  if (Object.hasOwn(e, 'ack')) assert.equal(t.ack, e.ack, `turn ${t.i + 1}: acknowledgement`);
  if (mode === 'scripted') {
    if (e.scripted_says) assert.match(t.voiced, new RegExp(e.scripted_says, 'i'), `turn ${t.i + 1}: what was voiced`);
    if (e.scripted_not) assert.doesNotMatch(t.voiced, new RegExp(e.scripted_not, 'i'), `turn ${t.i + 1}: what was voiced`);
  }
  invariants(h, t, mode);
}

// Start a scenario: a Session on the default v2 flags with ReplyGuard on, the talker of the mode, the analyst of the fixture.
async function start(fx, mode, { session = {}, said = null, storage, clk, offset = 0 } = {}) {
  const seen = [], h = rig({ said: said || fx.turns.map(utterance), talk: talkerOf(mode), session, flags: process.env.EVAL_MUTATE === 'guard-off' ? { replyGuard: 'off' } : process.env.EVAL_MUTATE === 'acks-legacy' ? { acks: 'legacy' } : {}, ...(storage ? { storage, clk } : {}) });
  h.s.ai.analyst = analystFor(fx.turns, offset, seen); h.seen = seen;
  return h;
}
async function play(fx, mode, opts = {}) {
  const h = await start(fx, mode, opts); await opened(h);
  const opening = screen(h);
  assert.ok((opening.match(/\?/g) || []).length <= 1 && !BANNED.test(opening), `[${mode}] the opening holds the same rules`);
  const turns = [];
  for (let i = 0; i < fx.turns.length; i++) { const t = await turn(h, i, fx.turns[i]); checkTurn(h, t, mode); turns.push(t); }
  return { h, turns };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------

test('S1 vague "helped improve the platform" gets one request for a concrete example, then the conversation moves on', async () => {
  const fx = FX('s1_vague_claim');
  for (const mode of MODES) { const { h, turns } = await play(fx, mode); finish(h, fx, mode, turns); await cleanup(); }
});

test('S2 a team result claimed as one\'s own: ownership is asked neutrally, once, with no accusation', async () => {
  const fx = FX('s2_team_result');
  for (const mode of MODES) {
    const { h, turns } = await play(fx, mode); finish(h, fx, mode, turns);
    const ownership = h.s.humane.asked.filter(m => m.intent === 'team_ownership');
    assert.equal(ownership.length, 1, `[${mode}] asked once`);
    assert.ok(ownership[0].say.split('?').length === 2 && !/\b(you|your)\b.*\b(claim|admit|prove)\b/i.test(ownership[0].say), `[${mode}] neutral wording: ${ownership[0].say}`);
    const detail = h.s.ledger.details.find(d => d.field === 'contribution' && d.active);
    assert.match(detail.quote, /^I led the ingestion stream/, `[${mode}] the personal contribution is filed in the consultant's own words, separate from the team outcome`);
    assert.ok(h.s.ledger.details.some(d => d.field === 'outcome'), `[${mode}] the team outcome stays a separate detail`);
    await cleanup();
  }
});

test('S3 "80% better" with no baseline: the measurement context is asked one part at a time (kind, period, baseline) and the figure is never praised as a fact', async () => {
  const fx = FX('s3_percent_no_baseline');
  for (const mode of MODES) {
    const { h, turns } = await play(fx, mode); finish(h, fx, mode, turns);
    assert.deepEqual(h.s.humane.asked.map(m => m.intent).slice(0, 3), ['metric_kind', 'metric_period', 'metric_baseline'], `[${mode}] one part of the measurement at a time`);
    assert.ok(turns.every(t => (t.move.say.match(/\?/g) || []).length === 1), `[${mode}] every move is exactly one question`);
    assert.notEqual(turns[0].ack, 'earned_result', `[${mode}] the first mention of the figure gets no earned praise`);
    assert.ok(!h.s.ledger.details.some(d => d.status === 'reported' && d.field === 'measurement'), `[${mode}] nothing is filed as a measured result before the consultant gives its basis`);
    await cleanup();
  }
});

test('S4 an approximate metric stays an estimate: filed as uncertain, read back as such, and no figure of the model\'s own joins the read-back', async () => {
  const fx = FX('s4_approximate_metric');
  for (const mode of MODES) {
    const { ev, hook } = library();
    const { h, turns } = await play(fx, mode, { session: { evidence: hook } }); finish(h, fx, mode, turns);
    const d = h.s.ledger.details.find(x => x.field === 'outcome');
    assert.equal(d.status, 'uncertain', `[${mode}] the ledger labels the figure an estimate`);
    const card = h.events.filter(e => e.type === 'summary').at(-1), item = card.items.find(i => i.field === 'outcome');
    assert.equal(item.status, 'uncertain', `[${mode}] the read-back card shows it as the consultant's estimate`);
    const voiced = turns.at(-1).voiced;
    if (mode === 'adversarial') {
      assert.ok(!/\b(99|1200)\b/.test(voiced) && !/saving of 5/.test(voiced), `[${mode}] an invented figure is dropped from the read-back: ${voiced}`);
      assert.ok(named(h.metrics, 'reply_guard').at(-1).dropped_unknown_number >= 1, `[${mode}] and the guard counted it`);
    }
    assert.ok(voiced.includes(SUMMARY_QUESTION), `[${mode}] the read-back ends in the one question: ${voiced}`);
    // Confirming makes ONE owner-only draft; the figure keeps its "uncertain" status all the way into the evidence record.
    await send(h, { type: 'confirm_summary' });
    await until(() => h.events.some(e => e.type === 'evidence_draft'));
    const draft = ev.get(OWNER, h.events.find(e => e.type === 'evidence_draft').id), claim = draft.claims.find(c => c.source_refs[0].field === 'outcome');
    assert.equal(claim.source_refs[0].ledger_status, 'uncertain', `[${mode}] the estimate is still an estimate in the evidence record`);
    assert.deepEqual([draft.state, draft.claims.every(c => c.review_status === 'draft'), draft.mine], ['evidence_draft', true, true], `[${mode}] a private draft, not submitted`);
    await cleanup();
  }
});

test('S5 a client that cannot be named: accepted without pressure, anonymisation offered once, the interview moves on', async () => {
  const fx = FX('s5_confidential_client');
  for (const mode of MODES) {
    const { h, turns } = await play(fx, mode); finish(h, fx, mode, turns);
    assert.equal(h.s.humane.asked.filter(m => m.intent === 'anonymise').length, 1, `[${mode}] offered once`);
    assert.ok(ACKS.confidential_ok.en.some(l => h.s.humane.acks.includes(l)), `[${mode}] the acknowledgement played is one of the confidentiality lines`);
    assert.ok(!h.s.ledger.details.some(d => /NDA|client name/i.test(d.quote)), `[${mode}] the refusal is not filed as a fact about the project`);
    await cleanup();
  }
});

test('S6 a correction makes a new revision: the old detail stays in the history, the read-back and the evidence draft carry the corrected one and link back', async () => {
  const fx = FX('s6_correction');
  for (const mode of MODES) {
    const { ev, hook } = library();
    const { h, turns } = await play(fx, mode, { session: { evidence: hook } }); finish(h, fx, mode, turns);
    const [old, fresh] = h.s.ledger.details.filter(d => d.field === 'contribution');
    assert.deepEqual([old.active, fresh.active, fresh.supersedes], [false, true, old.id], `[${mode}] the correction supersedes; nothing is overwritten`);
    assert.equal(old.quote, 'I led the whole migration project', `[${mode}] the earlier version is kept, unchanged, in the history`);
    const card = h.events.filter(e => e.type === 'summary').at(-1);
    assert.deepEqual(card.items.filter(i => i.field === 'contribution').map(i => i.quote), ['I only led the data migration'], `[${mode}] the read-back shows only the corrected version`);
    await send(h, { type: 'confirm_summary' });
    await until(() => h.events.some(e => e.type === 'evidence_draft'));
    assert.ok(subseq(h.s.machine.audit.map(a => a.event), ['request_summary', 'confirm_summary']), `[${mode}] the confirmation is audited`);
    const draft = ev.get(OWNER, h.events.find(e => e.type === 'evidence_draft').id), claims = draft.claims.filter(c => c.source_refs[0].field === 'contribution');
    assert.deepEqual(claims.map(c => c.statement), ['I only led the data migration'], `[${mode}] one claim, the corrected wording`);
    assert.equal(claims[0].source_refs[0].supersedes_ledger_id, `${sessionIdOf(h)}:${old.id}`, `[${mode}] it links to the version it replaced`);
    assert.equal(draft.revision, 1, `[${mode}] the first evidence revision is the corrected content; later changes make revision 2 (eval-workflow W8, S16)`);
    await cleanup();
  }
});

test('S7 speech recognition doubts a number: ATLAS confirms it aloud once, a correction is recorded, nothing is converted silently', async () => {
  const fx = FX('s7_asr_mishearing');
  for (const mode of MODES) {
    const { h, turns } = await play(fx, mode); finish(h, fx, mode, turns);
    const ev = h.events.find(e => e.type === 'user_text');
    assert.equal(ev.asr.spans[0].text, 'twenty five', `[${mode}] the doubtful span is named in the event`);
    assert.equal(h.s.humane.asked.filter(m => m.intent === 'confirm_asr').length, 1, `[${mode}] confirmed once, never looped`);
    const span = h.s.asrMeta['user-1'].spans[0];
    assert.deepEqual([span.status, span.corrected_to], ['corrected', 'thirty five'], `[${mode}] the consultant's "no, thirty five" is what is kept`);
    const [old, fresh] = h.s.ledger.details.filter(d => d.field === 'outcome');
    assert.deepEqual([old.active, fresh.active, fresh.provenance], [false, true, 'consultant_corrected'], `[${mode}] the correction supersedes the misheard figure; the old one stays in the history`);
    assert.match(fresh.quote, /thirty five/);
    await cleanup();
  }
});

test('S7b a proper noun the recogniser doubts is confirmed by name, and "yes" settles it', async () => {
  const fx = FX('s7b_asr_proper_noun');
  for (const mode of MODES) {
    const { h, turns } = await play(fx, mode); finish(h, fx, mode, turns);
    assert.equal(h.s.asrMeta['user-1'].spans[0].kind, 'proper_noun', `[${mode}] a capitalised, non-initial, low-confidence word`);
    assert.equal(h.s.asrMeta['user-1'].spans[0].status, 'confirmed', `[${mode}] the consultant's yes confirmed it`);
    assert.equal(h.s.humane.asked.filter(m => m.intent === 'confirm_asr').length, 1, `[${mode}] asked once`);
    await cleanup();
  }
});

test('S8 the consultant interrupts ATLAS: her speech is cut at once, what she had said is recorded as interrupted, and listening resumes with the new answer', async () => {
  const fx = FX('s8_interruption');
  for (const mode of MODES) {
    const said = [...fx.turns.map(utterance), fx.interrupt.said];
    const h = await start(fx, mode, { said }); await opened(h);
    const first = await turn(h, 0, fx.turns[0]); checkTurn(h, first, mode);
    // ATLAS is audible (a reply item with audio queued and well into playback) and the consultant speaks over her for more than half a second.
    const cleared = h.events.filter(e => e.type === 'clear_audio').length, talkerCalls = h.calls.talker.length, from = h.events.length;
    h.s.queue.push({ gen: h.s.gen, item: h.s.replyItem, bytes: new Uint8Array(960) });
    h.s.sentMs[h.s.replyItem] = 3000;
    say(h, [[0.6, .5]]);
    assert.ok(h.events.filter(e => e.type === 'clear_audio').length > cleared && h.events.some((e, i) => i >= from && e.type === 'user_speaking'), `[${mode}] her speech stops at once (clear_audio) and the consultant is heard (user_speaking)`);
    assert.equal(h.s.queue.length, 0, `[${mode}] no queued audio of hers survives the interruption`);
    say(h, [[1.3, .001]]);
    await until(() => h.calls.talker.length === talkerCalls + 1 && !h.s.busy());
    await h.s.turnJob; await settle(20);
    assert.ok(h.s.history.some(m => m.role === 'assistant' && m.content.includes(fx.interrupt.expect_history_marker)), `[${mode}] what was heard of her is recorded as interrupted`);
    assert.ok(h.s.history.some(m => m.role === 'user' && m.content.includes('baseline was fourteen minutes')), `[${mode}] listening resumed: the interrupting answer was transcribed and answered`);
    const reply = voicedSince(h, from);
    assert.ok((reply.match(/\?/g) || []).length <= 1 && !BANNED.test(reply), `[${mode}] the reply after the interruption holds the same rules`);
    assert.ok(h.s.machine.state === 'discovery' && !h.s.busy() && !h.s.finished, `[${mode}] the interview carries on in discovery, not stuck, not ended`);
    finish(h, fx, mode, [first]);
    await cleanup();
  }
});

test('S9 a mid-interview disconnect: the checkpoint restores, the unanswered question is said again with no model call, and the interview carries on', async () => {
  const fx = FX('s9_disconnect');
  for (const mode of MODES) {
    const { h, turns } = await play(fx, mode); await written(h);
    const question = h.s.lastQuestion.text, id = sessionIdOf(h);
    await h.s.suspend();
    assert.ok(h.s.finished && h.events.some(e => e.type === 'state' && e.state === 'suspended' && e.event === 'disconnect'), `[${mode}] the drop is audited as a suspension, not an ending`);
    assert.ok(!h.events.some(e => e.type === 'notes' || e.type === 'ended'), `[${mode}] no notes, no ending: the interview is not over`);
    // A second socket, the same person, the same storage: start with resume.
    const r = await start(fx, mode, { said: [fx.after_resume.said], storage: h.storage, clk: h.clk, offset: 1 });
    r.s.ai.analyst = analystFor([{}, ...fx.turns, {}], 0, h.seen);
    r.seen = h.seen;
    await r.s.onText(startMsg({ resume: id }));
    await until(() => r.s.finished || r.events.some(e => e.type === 'restore'));
    await until(() => r.s.finished || (!r.s.busy() && r.bytes.length > 0));
    assert.ok(!r.events.some(e => e.type === 'error'), `[${mode}] the resume was accepted`);
    assert.equal(r.calls.talker.length, 0, `[${mode}] re-asking costs no model call`);
    const back = screen(r);
    assert.ok(back.includes(question), `[${mode}] the last unanswered question is said again: ${back}`);
    assert.ok(!back.includes('What was the project?'), `[${mode}] the opening question the consultant already answered is not asked again`);
    assert.equal(r.events.find(e => e.type === 'restore').user[0].text, fx.turns[0].said, `[${mode}] the consultant's earlier answer is restored on screen`);
    assert.equal(r.s.humane.asked.length, h.s.humane.asked.length, `[${mode}] one question, one entry in the asked log across the drop`);
    assert.ok(subseq(r.s.machine.audit.map(a => a.event), ['start', 'consent_given', 'disconnect', 'reconnect']), `[${mode}] the audit trail holds the drop and the return`);
    // The next answer is answered normally, with the whole history, and does not repeat what was asked before the drop.
    r.s.playedMs[r.s.currentItem] = 1e9;
    const next = await turn(r, 0, { said: fx.after_resume.said, expect: {} });
    assert.ok(next.move.intent !== 'team_ownership', `[${mode}] the question asked before the drop is not asked again: ${next.move.intent}`);
    invariants(r, next, mode);
    const toModels = JSON.stringify([h.calls.talker, r.calls.talker, h.seen, r.calls.tts]);
    assert.ok(!toModels.includes(NAME), `[${mode}] the consultant's name reached no model on either side of the drop`);
    await cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The invariants are not vacuous: a deliberately bad reply fails them, so a regression in ReplyGuard or the ack gate would be caught here.
test('E0 the invariant checks catch what they claim to catch (negative control)', () => {
  const bad = { i: 0, voiced: 'Amazing work! What was it? And who did it?', ack: 'earned_result', analysis: { cues: ['metric'] }, fixture: {} };
  assert.throws(() => invariants({ s: { humane: { asked: [] } }, metrics: [] }, bad, 'scripted'), /at most one question/);
  assert.throws(() => invariants({}, { ...bad, voiced: 'Amazing work!' }, 'scripted'), /banned praise/);
  assert.throws(() => invariants({}, { ...bad, voiced: 'Thanks.' }, 'scripted'), /never "earned"/);
  assert.throws(() => invariants({}, { ...bad, voiced: 'Thanks.', ack: 'promising_unverified', analysis: { cues: ['describes_setback'] } }, 'scripted'), /setback/);
  assert.doesNotThrow(() => invariants({}, { ...bad, voiced: 'Thanks. What was it?', ack: 'neutral', analysis: { cues: ['describes_setback'] } }, 'scripted'));
});

// ---- the conversation examples that are not numbered pack scenarios but pin the same behaviours (Personality doc sections 3 and 9) ----
test('X1 a difficult project experience: a neutral acknowledgement, never upbeat, and no judgement of the person', async () => {
  const fx = FX('x1_setback');
  for (const mode of MODES) {
    const { h, turns } = await play(fx, mode); finish(h, fx, mode, turns);
    assert.ok(turns[0].analysis.cues.includes('describes_setback') && !turns[0].analysis.cues.includes('describes_achievement'), `[${mode}] the cue describes the event, not the person (D18)`);
    assert.ok(ACKS.setback_neutral.en.some(l => h.s.humane.acks.includes(l)), `[${mode}] the acknowledgement played is one of the setback lines`);
    await cleanup();
  }
});

test('X2 a rushed consultant: essentials first, no acknowledgement on the first turn, still one question', async () => {
  const fx = FX('x2_rushed');
  for (const mode of MODES) { const { h, turns } = await play(fx, mode); finish(h, fx, mode, turns); assert.equal(h.s.humane.rushed, true, `[${mode}] rushed mode is on`); await cleanup(); }
});

test('X3 no exact metric: "I do not know the numbers" is accepted, the figure is not demanded again; "I don\'t have the numbers" and "I don\'t have that data" are recognised as a deferral too (T16 finding, fixed in H1)', async () => {
  const fx = FX('x3_no_metric');
  for (const mode of MODES) {
    const { h, turns } = await play(fx, mode); finish(h, fx, mode, turns);
    assert.equal(h.s.ledger.details.find(d => d.field === 'outcome').status, 'reported', `[${mode}] the qualitative outcome is kept as said`);
    await cleanup();
  }
  // T16 finding (COVERAGE.md said "read as a plain answer"): "I don't have the numbers" / "I don't have that data" now defer the point like "I don't know".
  assert.deepEqual(analyzeTurn("We reduced manual work a lot, but I don't have the numbers.", 'en', { asked_field: 'measurement' }).intents, ['dont_know']);
  assert.deepEqual(analyzeTurn("I don't have that data.", 'en', { asked_field: 'measurement' }).intents, ['dont_know']);
  assert.deepEqual(analyzeTurn('We do not have the figures for that.', 'en').intents, ['dont_know']);
  assert.deepEqual(analyzeTurn('We reduced manual work a lot after the new tooling, but I do not know the exact numbers.', 'en', { asked_field: 'measurement' }).intents, ['dont_know']);
});
