// A title or answer with no visible characters must not reach scoring.
// Synthetic project text only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, projectState } from '../src/classify.js';

const ANSWER = 'The queue was slow before the change.';

function project(title, context) {
  return { title, role: '', sector: '', stage: '', answers: [context, '', '', '', '', ''] };
}

test('spaces or format characters do not count as a title or an answer', async () => {
  for (const title of [' ', '   ', '\t', '\n', '\u00a0', '\u200b', '\u200b\u200c\u2060']) {
    assert.throws(() => projectState(project(title, ANSWER)), /Add at least one answer before scoring/, JSON.stringify(title));
  }
  for (const context of [' ', '\t\n', '\u200b', '\ufeff']) {
    assert.throws(() => projectState(project('Synthetic queue', context)), /Add at least one answer before scoring/, JSON.stringify(context));
  }
  let called = false;
  await assert.rejects(
    classify({ TYPESAFE_API_KEY: 'fixture-not-a-live-key' }, project('   ', ANSWER), async () => { called = true; throw new Error('scored'); }),
    error => error.status === 400 && /Add at least one answer before scoring/.test(error.message),
  );
  assert.equal(called, false);
  const kept = projectState(project('Synthetic queue', ANSWER + '\u200b'));
  assert.equal(kept.title, 'Synthetic queue');
  assert.equal(kept.account.context, ANSWER + '\u200b');
});
