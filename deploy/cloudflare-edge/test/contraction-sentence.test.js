// A full stop after a contraction ends the sentence. The letter after the
// apostrophe is not an initial, so the voice can speak that sentence on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sentences, Phrases } from '../src/speech.js';

test('a contraction before a full stop ends the sentence', () => {
  assert.deepEqual(sentences("I don't. Next"), [["I don't."], 'Next']);
  assert.deepEqual(sentences("I don't. "), [["I don't."], '']);
  assert.deepEqual(sentences("We can't. Then"), [["We can't."], 'Then']);
  assert.deepEqual(sentences("We won't. And"), [["We won't."], 'And']);
  assert.deepEqual(sentences("That isn't. "), [["That isn't."], '']);
  assert.deepEqual(sentences("It's. Next"), [["It's."], 'Next']);
  assert.deepEqual(sentences("I don\u2019t. Next"), [["I don\u2019t."], 'Next']);
  const spoken = new Phrases();
  assert.deepEqual(spoken.feed("I don't. "), ["I don't."]);
  assert.deepEqual(spoken.flush(), []);
});

test('initials and abbreviations still keep the sentence open', () => {
  assert.deepEqual(sentences('Dr. Patel led it. And'), [['Dr. Patel led it.'], 'And']);
  assert.deepEqual(sentences('We used A.I. to triage. Then we'), [['We used A.I. to triage.'], 'Then we']);
  assert.deepEqual(sentences('The U.S. team stayed. Next'), [['The U.S. team stayed.'], 'Next']);
  assert.deepEqual(sentences('1. We migrated. 2. We trained. 3'), [['1. We migrated.', '2. We trained.'], '3']);
});
