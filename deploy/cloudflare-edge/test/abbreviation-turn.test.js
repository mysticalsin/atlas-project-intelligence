// A capitalised trailing word after a one-letter abbreviation is still that word.
// "plan A" and "Dr. A" stay finished. Synthetic utterances only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unfinished } from '../src/languages.js';

test('a capitalised trailing word after an abbreviation is unfinished', () => {
  const hanging = [
    'We started at 5 p.m. And',
    'It was 3 a.m. And',
    'We met on King St. And',
    'The client is U.S. And',
    'Meet Mr. And',
    'On a migre a 5 p.m. Et',
    'Wir starten um 5 p.m. Und',
  ];
  for (const text of hanging) {
    const lang = text.startsWith('On a') ? 'fr' : text.startsWith('Wir') ? 'de' : 'en';
    assert.equal(unfinished(text, lang), true, text);
  }
  assert.equal(unfinished('We started at 5 p.m. and', 'en'), true);
  assert.equal(unfinished('We went with plan A.', 'en'), false);
  assert.equal(unfinished('Our sponsor was Dr. A', 'en'), false);
  assert.equal(unfinished('We rebuilt the intake. And', 'en'), true);
  assert.equal(unfinished('It went well. Thanks', 'en'), false);
  assert.equal(unfinished('We met on King St. Paris', 'en'), false);
});
