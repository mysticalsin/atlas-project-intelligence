// G2: special categories (GDPR Art 9). Audit gap closed: "free speech may disclose health, union or religion; no warning, no detection; such text spreads to checkpoint, library,
// evidence quotes and Hindsight". The guard matches phrases; it flags a SENTENCE for "keep this private?" and keeps it out of memory; it never records a trait of the person (D18).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../src/summary.js';
import { cleanNotes, claimsFromNotes } from '../src/evidence.js';
import { projectDocument, retainItems } from '../src/memory.js';
import { specialCategories } from '../src/special.js';
import { PRIVACY } from '../src/policy.generated.js';
import { rig, startMsg, settle, until, cleanup } from './reconnect-harness.js';
import { afterEach } from 'node:test';

afterEach(cleanup);
const D = (id, field, quote, extra = {}) => ({ id, field, item_id: 'u' + id.slice(-1), quote, status: 'reported', active: true, withheld: false, provenance: 'unverified_speech_recognition', ...extra });

test('G2 the read-back flags a line that mentions a sensitive topic ("keep it private?"); other lines keep exactly their old shape; the flag names no category and no person', () => {
  const items = buildSummary([D('D-001', 'contribution', 'I built the claims routing model.'), D('D-002', 'limitations', 'I was out on sick leave for two weeks, so my colleague finished the testing.'), D('D-003', 'outcome', 'Triage fell from 40 to 12 minutes.')]);
  const flagged = items.filter(i => i.sensitive); assert.deepEqual(flagged.map(i => i.detail_id), ['D-002']); assert.equal(flagged[0].sensitive, true);
  for (const i of items.filter(x => !x.sensitive)) assert.ok(!('sensitive' in i), 'unflagged items are exactly as before');
  assert.deepEqual(Object.keys(flagged[0]).sort(), ['asr_unconfirmed', 'detail_id', 'field', 'label', 'provenance', 'quote', 'sensitive', 'status'], 'a boolean and nothing else: no category, no phrase');
  assert.deepEqual(buildSummary([D('D-001', 'limitations', 'Sorry, that is private.', { withheld: true })]), [], 'a kept-private item is not on the card at all');
});

test('G2 the flag travels with the sentence into the evidence draft (source_refs), never onto a person', () => {
  const notes = cleanNotes({ session_id: 's1', project_ref: 'PRJ-1', details: [{ ...D('D-001', 'limitations', 'My union rep joined the steering committee.'), sensitive: true }, { ...D('D-002', 'outcome', 'Triage fell from 40 to 12 minutes.') }] });
  assert.equal(notes.details[0].sensitive, true); assert.ok(!('sensitive' in notes.details[1]));
  const cl = claimsFromNotes('rec', 'alex@mantu.com', notes, 'now'); assert.equal(cl[0].source_refs[0].sensitive, true); assert.ok(!('sensitive' in cl[1].source_refs[0]));
  assert.ok(cl.every(c => !('person_flags' in c) && c.subject_type !== 'sensitive'));
  assert.equal(cleanNotes({ session_id: 's1', details: [{ ...D('D-001', 'outcome', 'x y z'), sensitive: 'yes' }] }).details[0].sensitive, undefined, 'only a real boolean true counts');
});

test('G2 memory: nothing with a sensitive phrase is ever retained, in any language, in any field; the raw conversation never goes', () => {
  const P = { localId: 'p-1', title: 'Claims triage', stage: 'Pilot', sector: 'Insurance', consultant: { role: 'Engineer' }, client: { name: 'Zebracorp' }, details: { technologies: ['Python', 'cancer registry'], deliverables: ['Routing model'] },
    answers: ['x', 'y', '', '', '', ''], conversation: 'I am a union member and was diagnosed with cancer.',
    report: { headline: 'h', summary: 'S', gaps: ['No baseline', 'Mi origen étnico no se registró', 'Ich bin schwanger und fehle'], follow_ups: ['Who owns the dashboard?', 'Je suis syndiqué, que faire ?'] } };
  const text = JSON.stringify(retainItems(P)); assert.doesNotMatch(text, /cancer|union|schwanger|syndiqu|étnico|diagnosed/i); assert.match(text, /No baseline/); assert.match(text, /Who owns the dashboard/);
  assert.equal(retainItems(P).length, 1, 'one project document, no conversation item'); assert.doesNotMatch(projectDocument({ ...P, title: 'x' }), /conversation|union member/);
});

test('G2 the consent and the notice ask people not to share such information; the same sentence in both; and it is not a classification of anyone', () => {
  assert.match(PRIVACY.special_category_sentence, /^Please do not share information about your health, religion, politics, trade-union membership, sexual orientation or ethnic origin\./);
  const notice = PRIVACY.notice.sections.find(s => s.id === 'special'); assert.ok(notice.paragraphs[0] === PRIVACY.special_category_sentence);
  assert.match(notice.paragraphs.join(' '), /never records anything about you from it/);
  assert.deepEqual(specialCategories('We trained the nurses on the new triage app.'), []);
});

test('G2 a live interview: a spoken sensitive line is flagged on the card; the interview itself is unchanged by the guard (no model sees a category, no reply refers to it)', async () => {
  const said = ['Sick leave kept me out for two weeks of the pilot, and my colleague covered the testing in that time.'];
  const h = rig({ said, talk: n => n === 0 ? ['Thanks. ', 'What was the project?'] : ['Right. ', 'What changed?'] });
  await h.s.onText(startMsg()); await until(() => h.events.some(e => e.type === 'ready')); await settle(40);
  for (const f of (await import('./reconnect-harness.js')).frames([[1.2, .2], [1.3, .001]])) { h.tick(); h.s.onBinary(f); }
  await until(() => h.calls.analyst >= 1 && !h.s.busy(), 4000).catch(() => {});
  const view = h.s.summaryView ? h.s.summaryView() : { items: [] };
  const anyModelText = JSON.stringify([h.calls.talker, h.calls.tts]);
  assert.doesNotMatch(anyModelText, /sensitive|special.categor|health condition|Art 9/i, 'the model is never told a category and never says one');
  assert.ok(view.items.length >= 1 && view.items.some(it => it.sensitive === true), 'the line the consultant said is on the card, flagged: ' + JSON.stringify(view.items.map(i => i.quote)));
  await h.s.end(false);
});
