// The local TypeSafe stand-in. build.py does not inline this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeTypesafe } from '../dev/fake-typesafe.mjs';
import { jevRelevant } from '../src/memory.js';

const KEY = 'local-fake-key';

function post(fake, body) {
  return fake('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a bracket index is the memory text the noul rule scores', async () => {
  const fake = fakeTypesafe({ key: KEY });
  const res = await post(fake, {
    model: 'jev-latest',
    state: {
      project: { title: 'Claims' },
      memories: ['Prefers short questions.', '   '],
      reference: { story: { outcome: 'Triage time fell.', evidence: '' } },
    },
    questions: {
      keep: { type: 'noul', instructions: 'Would `memories[0]` help with `project`?' },
      blank: { type: 'noul', instructions: 'Would `memories[1]` help with `project`?' },
      missing: { type: 'noul', instructions: 'Would `memories[2]` help with `project`?' },
      dot: { type: 'noul', instructions: 'Does `reference.story.outcome` name a result?' },
      empty: { type: 'noul', instructions: 'Does `reference.story.evidence` name a source?' },
    },
  });
  assert.equal(res.status, 200);
  const answers = (await res.json()).answers;
  assert.equal(answers.keep.noul, 0.9);
  assert.equal(answers.blank.noul, 0.1);
  assert.equal(answers.missing.noul, 0.1);
  assert.equal(answers.dot.noul, 0.9);
  assert.equal(answers.empty.noul, 0.1);
});

test('jevRelevant keeps a non-empty preference asked as memories[0]', async () => {
  const fake = fakeTypesafe({ key: KEY });
  const memories = [
    { text: 'Own project note.', tags: ['project:p-1'] },
    { text: 'Prefers short questions.', tags: [] },
    { text: '   ', tags: [] },
  ];
  const got = await jevRelevant({ TYPESAFE_API_KEY: KEY }, memories, { id: 'p-1', title: 'Claims', stage: 'Pilot', sector: 'Insurance' }, fake);
  assert.deepEqual(got.memories.map(m => m.text), ['Own project note.', 'Prefers short questions.']);
  assert.equal(got.checked, 2);
});

test('build.py does not inline this test or the stand-in', () => {
  const build = readFileSync(new URL('../../../build.py', import.meta.url), 'utf8');
  assert.equal(build.includes('fake-typesafe-path.test.js'), false);
  assert.equal(build.includes('fake-typesafe.mjs'), false);
});
