// The local sheet stand-in must keep every challenge answer the page sends.
// src/app.js joins groups as "Group\nQ: ...\nA: ..." separated by a blank line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeModel } from '../dev/fake-model.mjs';
import { SHEET_POLICY, parseDraft, TBD } from '../src/sheet.js';

const GROUPS = [
  'Results and ROI\nQ: What measurable gain did the client get?\nA: Triage fell from 40 to 12 minutes on the sample dashboard.',
  'Team and delivery\nQ: How many consultants, where, and at what seniority?\nA: 5 consultants: 3 in Paris, 2 in Madrid.',
].join('\n\n');

async function draft(answers, document = '') {
  const input = JSON.stringify({
    project: { title: 'Queue pilot', sector: 'Insurance' },
    current_sheet: {},
    consultant_answers_to_challenges: answers,
    source_document: document,
  });
  const raw = await fakeModel().complete([
    { role: 'system', content: SHEET_POLICY },
    { role: 'user', content: input },
  ]);
  return parseDraft(raw);
}

test('every challenge answer is kept, including one that contains a blank line', async () => {
  const out = await draft(GROUPS);
  assert.match(out.sections.value, /Triage fell from 40 to 12 minutes on the sample dashboard/);
  assert.match(out.sections.value, /5 consultants: 3 in Paris, 2 in Madrid/);
  const blank = await draft('Results and ROI\nQ: What changed?\nA: Line one of the result.\n\nLine two of the same answer.');
  assert.match(blank.sections.value, /Line one of the result\.\n\nLine two of the same answer/);
});

test('a reply with no answer marker is kept whole, and an empty reply stays incomplete', async () => {
  const plain = await draft('The plan A: keep the manual fallback.');
  assert.equal(plain.sections.value, 'The plan A: keep the manual fallback.');
  const empty = await draft('');
  assert.equal(empty.sections.value, TBD);
});
