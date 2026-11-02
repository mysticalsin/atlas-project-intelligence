// Agent Brain v2.1 T16: the conversation-rubric linter. docs/agent-brain-v2.1/eval/conversation_rubric.json holds annotated examples (good: lines of the pack;
// bad: the pack's own anti-patterns, plus a few authored from the rubric's level-1 description) and this file holds the deterministic rules that must rate
// them: good at least 4, bad at most 2. It also lints every stock line ATLAS can say (question bank, acknowledgements, read-back lines, pause lines, greeting).
// REGRESSION AID, NOT A HUMAN RATING: string rules cannot judge warmth, curiosity or fit. Quality with real consultants is rated by people (release gate 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BANNED_PRAISE_SRC, QUESTION_BANK, ACKS, SELECTOR_LINES, PAUSE_LINES, RESUME_LINES } from '../src/policy.generated.js';
import { GREETING_PIECES, WELCOME_BACK_PIECES } from '../src/languages.js';
import { SUMMARY_LINES } from '../src/session.js';

const RUBRIC = JSON.parse(readFileSync(new URL('../../../docs/agent-brain-v2.1/eval/conversation_rubric.json', import.meta.url), 'utf8'));
const { start, penalties, floor } = RUBRIC.linter, { good_min: GOOD_MIN, bad_max: BAD_MAX } = RUBRIC.thresholds;

const BANNED = new RegExp(BANNED_PRAISE_SRC, 'i');
const sentences = text => (String(text).match(/[^.!?—]+[.!?]*/g) || []).map(s => s.trim()).filter(Boolean);
const STOP = new Set('the and for with that this from into your you what which when where how was were are have has had did does could would should tell about there their they them then than also just only such'.split(' '));
const content = s => new Set((s.toLowerCase().replace(/[’']s\b/g, '').match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w)));
const RESULT_PRAISE = /\b(wow|amazing|incredible|impressive|fantastic|brilliant|huge|substantial improvement|meaningful result|great result|strong result)\b/i;
const TAG = /,\s*(correct|right|okay|yes|no)\s*\?\s*$|\b(isn['\u2019]t it|wasn['\u2019]t it|aren['\u2019]t you|didn['\u2019]t you|don['\u2019]t you (think|agree))\s*\?\s*$/i;
const THERAPY = /\b(how does (that|this|it) make you feel|must have been (so |very |really )?(hard|painful|difficult|awful|terrible) for you|it['’]?s ok(ay)? to feel|i hear you|your feelings|you must feel|i understand how you feel|safe space|take a deep breath)\b/i;
const FORM = /^(please (provide|enter|list|state|specify|supply)\b|next question\b|list your\b|provide (the|your)\b|enter your\b|state your\b)/i;
const IDENTITY = /\byou(?:['’]re| are)\s+(?:clearly|obviously|definitely|certainly|such)\b|\byou(?:['’]re| are)\s+(?:an?\s+)?(?:expert|genius|star|natural)\b/i;
const EMPTY = /^(great|wonderful|excellent|perfect|fantastic|lovely|superb|nice|good job|well done)\W*$/i;

// The linter: the set of rules a line breaks, and the rating those rules leave (start minus the penalty of each distinct rule, never below the floor).
export function lint(text, ctx = {}) {
  const flags = [], list = sentences(text), questions = list.filter(s => /\?\s*$/.test(s)), asks = (String(text).match(/\?/g) || []).length;
  if (asks > 1) flags.push('question_count');
  if (BANNED.test(text)) flags.push('banned_praise');
  if (questions.some(q => TAG.test(q))) flags.push('leading_closed');
  if (RESULT_PRAISE.test(text) && typeof ctx.user_said === 'string' && /\d/.test(ctx.user_said) && ctx.basis_known !== true) flags.push('praise_before_basis');
  for (const fact of Array.isArray(ctx.known) ? ctx.known : []) {
    const k = content(fact);
    if (questions.some(q => { const c = content(q); return c.size >= 3 && [...c].filter(w => k.has(w)).length / c.size >= 0.6; })) { flags.push('repeats_known'); break; }
  }
  if (THERAPY.test(text)) flags.push('therapy_tone');
  if (list.some(s => FORM.test(s))) flags.push('form_command');
  if (IDENTITY.test(text)) flags.push('identity_praise');
  if (list.some(s => s.split(/\s+/).length <= 3 && EMPTY.test(s))) flags.push('empty_praise');
  const score = Math.max(floor, start - flags.reduce((n, f) => n + penalties[f], 0));
  return { flags, score };
}

test('the rubric file says what it is: a regression aid, one engineer\'s annotation, never a consultant score; ids are unique; every item has a source', () => {
  assert.match(RUBRIC.disclaimer, /REGRESSION AID, NOT A HUMAN RATING/); assert.match(RUBRIC.disclaimer, /never a consultant/); assert.match(RUBRIC.disclaimer, /pilot users/);
  assert.deepEqual(RUBRIC.thresholds, { good_min: 4, bad_max: 2 });
  assert.equal(new Set(RUBRIC.items.map(i => i.id)).size, RUBRIC.items.length);
  assert.ok(RUBRIC.items.filter(i => i.kind === 'good').length >= 30 && RUBRIC.items.filter(i => i.kind === 'bad').length >= 9);
  for (const i of RUBRIC.items) { assert.ok(['good', 'bad'].includes(i.kind) && i.speaker === 'atlas' && i.text && i.source && Number.isInteger(i.rating) && i.rating >= 1 && i.rating <= 5, i.id); }
  for (const f of Object.keys(penalties)) assert.ok(RUBRIC.items.some(i => i.kind === 'bad' && (i.expect_flags || []).includes(f)) || f === 'praise_before_basis', `a bad example exercises ${f}`);
});

test('good examples (the pack\'s own lines) rate at least 4, by hand and by the linter, and break no rule beyond praise-before-basis', () => {
  for (const i of RUBRIC.items.filter(x => x.kind === 'good')) {
    const r = lint(i.text, i.context);
    assert.ok(i.rating >= GOOD_MIN, `${i.id}: annotated ${i.rating}`);
    assert.ok(r.score >= GOOD_MIN, `${i.id}: linter ${r.score} for ${JSON.stringify(r.flags)}: ${i.text}`);
    assert.ok(r.flags.every(f => f === 'praise_before_basis'), `${i.id}: ${r.flags}`);
    assert.ok(r.score >= i.rating - 1 || r.score === start, `${i.id}: the annotation and the linter agree within a point (hand ${i.rating}, linter ${r.score})`);
  }
});

test('bad examples (the pack\'s anti-patterns) rate at most 2, by hand and by the linter, and break exactly the rules they are annotated with', () => {
  for (const i of RUBRIC.items.filter(x => x.kind === 'bad')) {
    const r = lint(i.text, i.context);
    assert.ok(i.rating <= BAD_MAX, `${i.id}: annotated ${i.rating}`);
    assert.ok(r.score <= BAD_MAX, `${i.id}: linter ${r.score} for ${JSON.stringify(r.flags)}: ${i.text}`);
    assert.deepEqual([...r.flags].sort(), [...i.expect_flags].sort(), `${i.id}: the rules it breaks`);
  }
});

test('each rule is exercised from both sides: it fires on its own anti-pattern and stays quiet on a plain good question', () => {
  const quiet = lint('What was the baseline for that figure?'); assert.deepEqual(quiet, { flags: [], score: 5 });
  const cases = { question_count: 'What was it? And who did it?', banned_praise: 'Brilliant. What happened next?', leading_closed: 'The client was happy, right?', form_command: 'Please state the budget.',
    identity_praise: 'You are obviously a genius.', empty_praise: 'Perfect! What changed?', therapy_tone: 'I hear you. What happened?' };
  for (const [flag, text] of Object.entries(cases)) assert.ok(lint(text).flags.includes(flag), `${flag}: ${text}`);
  assert.ok(lint('Impressive. What happened next?', { user_said: 'We cut it by 40%.' }).flags.includes('praise_before_basis'));
  assert.ok(!lint('Impressive. What happened next?', { user_said: 'We cut it by 40%.', basis_known: true }).flags.includes('praise_before_basis'), 'once the basis is known, the praise is earned');
  assert.ok(lint('What was the claims intake rebuild for the insurer?', { known: ['We rebuilt the claims intake for the insurer.'] }).flags.includes('repeats_known'));
  assert.ok(!lint('What was the baseline for that figure?', { known: ['We rebuilt the claims intake for the insurer.'] }).flags.includes('repeats_known'));
});

test('every stock line ATLAS can say passes the linter at 4 or better: questions, acknowledgements, read-back and close lines, pause lines, the greeting', () => {
  const lines = [];
  for (const [intent, langs] of Object.entries(QUESTION_BANK)) for (const t of langs.en || []) lines.push([`question:${intent}`, t]);
  for (const [cat, langs] of Object.entries(ACKS)) for (const t of langs.en || []) lines.push([`ack:${cat}`, t]);
  for (const [k, langs] of Object.entries(SELECTOR_LINES)) for (const t of langs.en || []) lines.push([`selector:${k}`, t]);
  for (const t of [...(PAUSE_LINES.en || []), ...(RESUME_LINES.en || [])]) lines.push(['pause/resume', t]);
  for (const [k, v] of Object.entries(SUMMARY_LINES)) for (const t of v.en || []) lines.push([`summary:${k}`, t]);
  for (const t of [...GREETING_PIECES.en, ...WELCOME_BACK_PIECES.en]) lines.push(['greeting', t]);
  assert.ok(lines.length > 100, `the bank is read: ${lines.length} lines`);
  for (const [where, t] of lines) { const r = lint(t); assert.ok(r.score >= GOOD_MIN, `${where}: ${JSON.stringify(r.flags)}: ${t}`); }
});
