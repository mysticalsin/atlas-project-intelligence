// Agent Brain v2.1 T11: summary.js on its own (pure). The card's items, the open points, the few facts ATLAS may read back and the figures those
// facts allow, the talker's note, and the redaction of withheld words. Fixtures are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InterviewLedger } from '../src/ledger.js';
import { FIELDS } from '../src/policy.generated.js';
import { ReplyGuard } from '../src/speech.js';
import { buildSummary, buildUnknowns, summaryFacts, summaryNote, redact, withheldQuotes, clip, MAX_ITEMS, MAX_FACTS, QUOTE_CHARS, SUMMARY_QUESTION } from '../src/summary.js';

const d = (id, field, quote, extra = {}) => ({ id, field, item_id: 'u1', quote, status: 'reported', active: true, supersedes: '', provenance: 'unverified_speech_recognition', ...extra });
const SAMPLE = [
  d('D-001', 'outcome', 'Triage time dropped from 14 minutes to 9 minutes'),
  d('D-002', 'problem', 'Tickets bounced between three teams'),
  d('D-003', 'contribution', 'I rebuilt the routing rules'),
  d('D-004', 'measurement', "I don't know the baseline period", { status: 'unknown' }),
  d('D-005', 'intervention', 'We added a triage queue', { asr_unconfirmed: true }),
  d('D-006', 'problem', 'Old wording that was corrected', { active: false }),
  d('D-007', 'limitations', 'Keep this private', { withheld: true }),
];

test('buildSummary: active, non-withheld details in the story order, with exactly the card keys', () => {
  const items = buildSummary(SAMPLE);
  assert.deepEqual(items.map(i => i.detail_id), ['D-002', 'D-003', 'D-005', 'D-001', 'D-004'], 'problem, contribution, intervention, outcome, measurement');
  for (const i of items) assert.deepEqual(Object.keys(i).sort(), ['asr_unconfirmed', 'detail_id', 'field', 'label', 'provenance', 'quote', 'status']);
  assert.deepEqual(items.map(i => i.label), items.map(i => FIELDS[i.field][0]));
  assert.equal(items.find(i => i.detail_id === 'D-005').asr_unconfirmed, true);
  assert.equal(items.find(i => i.detail_id === 'D-004').status, 'unknown');
  assert.ok(!items.some(i => ['D-006', 'D-007'].includes(i.detail_id)), 'superseded and withheld details are history, not the card');
  assert.ok(items.every(i => i.provenance === 'unverified_speech_recognition' && typeof i.asr_unconfirmed === 'boolean'));
});

test('buildSummary: takes a real ledger, keeps provenance and exposes the complete ledger quote for review', () => {
  const l = new InterviewLedger('Pilot'), long = 'We rebuilt the whole intake flow ' + '😀 wide '.repeat(60);
  l.addTranscript('u1', long); l.addTranscript('user-typed-1001', 'It was a different flow entirely, I think.');
  l.record({ details: [{ field: 'intervention', item_id: 'u1', quote: long.trim() }] });
  l.record({ details: [{ field: 'intervention', item_id: 'user-typed-1001', quote: 'It was a different flow entirely, I think.', supersedes: 'D-001' }] }, 'consultant_typed');
  const items = buildSummary(l);
  assert.equal(items.length, 1); assert.equal(items[0].provenance, 'consultant_typed'); assert.equal(items[0].status, 'uncertain');
  const l2 = new InterviewLedger('Pilot'); l2.addTranscript('u1', long); l2.record({ details: [{ field: 'intervention', item_id: 'u1', quote: long.trim() }] });
  const q = buildSummary(l2)[0].quote;
  assert.equal(q, long.trim(), 'the full quote is reviewable, including the end');
  assert.ok(q.length <= QUOTE_CHARS);
  assert.equal(clip('short  text', 160), 'short text');
});

test('buildSummary: bounded, tolerant of junk, never mutates the ledger', () => {
  const many = Array.from({ length: 130 }, (_, i) => d('D-' + String(i + 1).padStart(3, '0'), 'outcome', 'Detail number ' + i));
  assert.equal(buildSummary(many).length, MAX_ITEMS);
  assert.deepEqual(buildSummary(null), []); assert.deepEqual(buildSummary({}), []); assert.deepEqual(buildSummary([null, 5, { field: 'nope', quote: 'x', active: true }, { field: 'problem', active: true }]), []);
  const before = JSON.stringify(SAMPLE); buildSummary(SAMPLE); assert.equal(JSON.stringify(SAMPLE), before);
  assert.equal(buildSummary([d('D-001', 'problem', 'x problem', { status: 'weird' })])[0].status, 'reported');
});

test('buildUnknowns: unsure speech, "I don\'t know", skipped and left-open fields, by name only; an answered field is not open', () => {
  const u = buildUnknowns(SAMPLE, { skipped: ['stakes', 'problem', 'nonsense', 5], deferred: ['adoption', 'outcome'] });
  assert.deepEqual(u.map(x => [x.kind, x.field]), [['unconfirmed_speech', 'intervention'], ['unknown', 'measurement'], ['skipped', 'stakes'], ['deferred', 'adoption']]);
  assert.deepEqual(u.filter(x => x.detail_id).map(x => x.detail_id), ['D-005', 'D-004']);
  assert.ok(u.every(x => x.label === FIELDS[x.field][0] && Object.keys(x).every(k => ['kind', 'field', 'label', 'detail_id'].includes(k))), 'no quote or free text');
  assert.deepEqual(buildUnknowns([], {}), []); assert.deepEqual(buildUnknowns(SAMPLE), buildUnknowns(SAMPLE, { skipped: [], deferred: [] }));
  const open = Array.from({ length: 30 }, (_, i) => d('D-' + String(i + 1).padStart(3, '0'), 'measurement', 'Not known ' + i, { status: 'unknown' }));
  assert.ok(buildUnknowns(open).length <= 12);
});

test('summaryFacts: at most four, one per field, the story\'s spine first; doubt and "I don\'t know" are not facts; numbers are exactly those in the facts', () => {
  const { facts, numbers } = summaryFacts(buildSummary(SAMPLE));
  assert.equal(facts.length, 3, 'problem, contribution, outcome (the unsure intervention and the unknown measurement are open points)');
  assert.deepEqual(facts, ['tickets bounced between three teams', 'you rebuilt the routing rules', 'triage time dropped from 14 minutes to 9 minutes'], 'clauses addressed to them, no field labels');
  assert.ok(facts.every(f => f.length <= 120));
  assert.deepEqual(numbers.sort(), ['14', '9']);
  const all = Object.keys(FIELDS).map((f, i) => d('D-' + String(i + 1).padStart(3, '0'), f, `Answer ${i + 100} about ${f}`));
  const r = summaryFacts(buildSummary(all));
  assert.equal(r.facts.length, MAX_FACTS); assert.deepEqual(r.facts.map(f => f.split(' ').pop()), ['problem', 'contribution', 'intervention', 'outcome']);
  assert.equal(summaryFacts(buildSummary(all), { max: 2 }).facts.length, 2);
  assert.deepEqual(summaryFacts([], {}), { facts: [], numbers: [] }); assert.deepEqual(summaryFacts(null), { facts: [], numbers: [] });
  assert.equal(summaryFacts(buildSummary(all), { max: 0 }).facts.length, 0);
  const long = summaryFacts(buildSummary([d('D-001', 'outcome', 'word '.repeat(80))]));
  assert.ok(Array.from(long.facts[0]).length <= 100);
});

test('summaryNote: the facts, at most three open points by name, the one question; a reflection asks the move\'s own check question', () => {
  const items = buildSummary(SAMPLE), { facts } = summaryFacts(items), unknowns = buildUnknowns(SAMPLE, { skipped: ['stakes', 'adoption', 'customer_fit'], deferred: [] });
  const note = summaryNote(facts, unknowns);
  assert.ok(note.startsWith('SUMMARY FACTS (server') && note.includes('1) "tickets bounced between three teams"') && note.endsWith(SUMMARY_QUESTION));
  assert.equal((note.match(/OPEN POINTS/g) || []).length, 1);
  const open = note.split('OPEN POINTS')[1].split('Then ask')[0]; assert.ok(open.split(';').length <= 3, 'at most three open points');
  assert.ok(!note.includes('Keep this private') && !note.includes('Old wording'), 'withheld and superseded words are nowhere');
  assert.match(summaryNote([], []), /none: nothing is firm enough/);
  const r = summaryNote(facts.slice(0, 2), [], { reflect: true, question: 'What important thing have we missed?' });
  assert.ok(r.startsWith('REFLECTION FACTS') && r.includes('What important thing have we missed?') && !r.includes('OPEN POINTS') && !r.includes(SUMMARY_QUESTION));
});

test('redact and withheldQuotes: a withheld quote becomes a marker wherever it is, whatever the whitespace; regex characters are literal', () => {
  const l = [d('D-001', 'problem', 'Zebracorp (Lyon) lost $4.5m [secret]', { withheld: true }), d('D-002', 'outcome', 'Visible detail'), d('D-003', 'stakes', 'Old private', { withheld: true, active: false })];
  assert.deepEqual(withheldQuotes(l), ['Zebracorp (Lyon) lost $4.5m [secret]', 'Old private']);
  assert.equal(redact('Old private', withheldQuotes(l)), '[kept private]');
  assert.equal(redact('Consultant: Well, Zebracorp  (Lyon)\nlost $4.5m [secret] last year. ATLAS: Zebracorp (Lyon) lost $4.5m [secret].', withheldQuotes(l)),
    'Consultant: Well, [kept private] last year. ATLAS: [kept private].');
  assert.equal(redact('nothing here', ['absent words']), 'nothing here'); assert.equal(redact('abc', []), 'abc'); assert.equal(redact('abc', ['']), 'abc'); assert.equal(redact(undefined, ['x']), '');
});

test('with the facts as its summary facts the ReplyGuard drops every figure that is not one of them (the adversarial talker)', () => {
  const { facts, numbers } = summaryFacts(buildSummary(SAMPLE));
  const guard = new ReplyGuard({ summaryFacts: [...facts, ...numbers], maxWords: 90 });
  const said = guard.push('Triage fell from 14 minutes to 9 minutes. You saved 99 percent and 1200 hours. ');
  assert.deepEqual(said, ['Triage fell from 14 minutes to 9 minutes.']);
  assert.equal(guard.stats.dropped_unknown_number, 1);
  assert.deepEqual(new ReplyGuard({ summaryFacts: [], maxWords: 90 }).push('It was 9 minutes. '), [], 'with no facts, no figure at all');
});
