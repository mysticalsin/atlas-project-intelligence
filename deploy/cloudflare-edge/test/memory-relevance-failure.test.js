// A failed relevance check must not carry another project's memory into the note.
// Synthetic memories only. No Hindsight, JEV, or network call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jevRelevant, memoryNote } from '../src/memory.js';

const workerSrc = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const fnMatch = workerSrc.match(/^export function memoriesAfterFailedRelevance\(found, project\) \{[\s\S]*?\n\}/m);

async function loadFilter() {
  assert.ok(fnMatch, 'worker.js exports memoriesAfterFailedRelevance');
  const href = 'data:text/javascript,' + encodeURIComponent(fnMatch[0] + '\n');
  return (await import(href)).memoriesAfterFailedRelevance;
}

const found = [
  { text: 'Desk queue pilot: the baseline was not measured.', tags: ['atlas', 'project:p-1'] },
  { text: 'Prefers short questions.', tags: [] },
  { text: 'Warehouse label pilot: the other desk cut overtime.', tags: ['atlas', 'project:p-9'] },
];

test('a failed relevance check drops another project from the interview note', async () => {
  const memoriesAfterFailedRelevance = await loadFilter();
  const fetcher = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(
    () => jevRelevant({ TYPESAFE_API_KEY: 'k' }, found, { id: 'p-1', title: 'Desk queue' }, fetcher),
    (error) => error.message === 'JEV HTTP 503',
  );
  const unfiltered = memoryNote(found);
  assert.match(unfiltered, /Warehouse label pilot/);
  const kept = memoriesAfterFailedRelevance(found, { id: 'p-1' });
  const note = memoryNote(kept);
  assert.match(note, /Desk queue pilot/);
  assert.doesNotMatch(note, /Warehouse label pilot/);
  assert.doesNotMatch(note, /Prefers short questions/);
  assert.match(workerSrc, /found = memoriesAfterFailedRelevance\(found, project\)/);
});

test('only the sanitized project tag is kept', async () => {
  const memoriesAfterFailedRelevance = await loadFilter();
  const rows = [
    { text: 'Kept for the sanitized id.', tags: ['project:p1'] },
    { text: 'Raw slash id is not the tag.', tags: ['project:p/1'] },
    { text: 'A new interview does not keep an old project.', tags: ['project:p-9'] },
  ];
  assert.deepEqual(memoriesAfterFailedRelevance(rows, { id: 'p/1' }).map((row) => row.text), ['Kept for the sanitized id.']);
  assert.deepEqual(memoriesAfterFailedRelevance(rows, { id: 'new' }), []);
  assert.deepEqual(memoriesAfterFailedRelevance(rows, {}), []);
  assert.deepEqual(memoriesAfterFailedRelevance(null, { id: 'p1' }), []);
});
