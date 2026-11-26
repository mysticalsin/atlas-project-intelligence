// A retained memory is cut on a character boundary. A limit that lands inside a
// two-unit character must leave that character out, not store one half of it.
// Synthetic titles only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDocument } from '../src/memory.js';

const SMILE = '\uD83D\uDE00';

function loneSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      i += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return true;
  }
  return false;
}

function document(extra) {
  return projectDocument({
    localId: 'p-1',
    title: 'T',
    stage: 'Pilot',
    client: { name: 'Zebracorp' },
    details: {},
    answers: ['', '', '', '', '', ''],
    ...extra,
  });
}

test('a title limit keeps a whole character and drops one that does not fit', () => {
  const fits = 'x'.repeat(138) + SMILE;
  const kept = document({ title: fits });
  assert.equal(fits.length, 140);
  assert.equal(kept.includes(SMILE), true);
  assert.equal(loneSurrogate(kept), false);

  const split = 'x'.repeat(139) + SMILE;
  const cut = document({ title: split });
  assert.equal(split.length, 141);
  assert.equal(cut.includes('Project "' + 'x'.repeat(139) + '"'), true);
  assert.equal(cut.includes(SMILE), false);
  assert.equal(cut.includes('\uD83D'), false);
  assert.equal(loneSurrogate(cut), false);

  const bmp = 'y'.repeat(140);
  assert.equal(document({ title: bmp }).includes('Project "' + bmp + '"'), true);
});

test('an answer limit does not store half of a character', () => {
  const answer = 'a'.repeat(1499) + SMILE;
  const text = document({ answers: [answer, '', '', '', '', ''] });
  assert.equal(answer.length, 1501);
  assert.equal(text.includes('Context: ' + 'a'.repeat(1499)), true);
  assert.equal(text.includes(SMILE), false);
  assert.equal(text.includes('\uD83D'), false);
  assert.equal(loneSurrogate(text), false);
});
