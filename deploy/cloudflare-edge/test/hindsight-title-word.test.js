// Local Hindsight recall. The stand-in keeps a sentence that shares two query words.
// A measured outcome that shares only the quoted project title was dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeHindsight } from '../dev/fake-hindsight.mjs';
import { hindsight, projectDocument, retainItems, recallQuery, memoryNote } from '../src/memory.js';

const ENV = {
  HINDSIGHT_URL: 'https://hindsight.local.invalid',
  HINDSIGHT_API_KEY: 'local-hindsight-key',
  HINDSIGHT_OPT_IN: '1',
  CSRF_SECRET: 'csrf',
  ATLAS_TENANT_ISOLATION: 'local-synthetic',
};
const P = {
  localId: 'p-123', title: 'Claims triage alias', stage: 'Pilot', sector: 'Insurance',
  consultant: { role: 'Data engineer' },
  client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', technologies: ['Python'], deliverables: [] },
  answers: ['Zebracorp in Lyon had slow claims.', 'I built the model.', '', 'Triage fell from 40 to 12 minutes.', '', ''],
  report: { headline: 'Claims triage rebuilt', summary: 'The consultant rebuilt triage.', gaps: ['No named source'], follow_ups: ['Who owns the dashboard?'] },
  conversation: 'I prefer short questions.',
};

test('recall keeps an outcome that shares only the project title', async () => {
  const outcome = projectDocument(P).split('\n').find(line => line.startsWith('Outcome:'));
  assert.equal(outcome, 'Outcome: Triage fell from 40 to 12 minutes.');
  const fake = fakeHindsight();
  const hs = hindsight(ENV, fake);
  await hs.retain('atlas-x', retainItems(P, '2026-09-27T10:00:00.000Z'));
  const post = await fake('https://hindsight.local.invalid/v1/default/banks/atlas-x/memories', {
    method: 'POST',
    headers: { Authorization: 'Bearer local-hindsight-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [
      { document_id: 'other', content: 'Triage fell from 40 to 12 minutes on Otherland.', tags: ['atlas', 'project:other'], timestamp: '2026-09-01T00:00:00.000Z' },
      { document_id: 'noise', content: 'I like tea and biscuits.', tags: ['atlas', 'project:p-123'], timestamp: '2026-09-01T00:00:00.000Z' },
    ] }),
  });
  assert.equal(post.status, 200);
  const got = await hs.recall('atlas-x', recallQuery({ id: 'p-123', title: P.title }), { tags: ['project:p-123'] });
  const texts = got.map(row => row.text);
  const note = memoryNote(got);
  assert.ok(texts.includes(outcome), texts.join('\n'));
  assert.equal(note.includes('Triage fell from 40 to 12 minutes'), true);
  assert.equal(note.includes('not evidence'), true);
  assert.equal(texts.some(line => line.includes('Still missing or unverified')), true);
  assert.equal(texts.some(line => line.includes('biscuits')), false);
  assert.equal(texts.some(line => line.includes('Otherland')), false);
  assert.equal(JSON.stringify(got).includes('Zebracorp'), false);
});
