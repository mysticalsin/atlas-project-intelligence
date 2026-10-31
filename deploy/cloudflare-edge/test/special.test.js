// Special-category guard (G2): parity with atlas_voice/privacy_config.py and the properties that matter (flags a sentence, never a person; no false alarm on plain project talk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { specialCategories, normalizeText, isSpecial, uncoveredLanguage } from '../src/special.js';
import { SPECIAL_PHRASES } from '../src/policy.generated.js';

const V = JSON.parse(readFileSync(new URL('./special.vectors.json', import.meta.url)));

test('special categories: parity with Python for the matcher and its normal form', () => {
  for (const [t, e] of V.cases) assert.deepEqual(specialCategories(t), e, JSON.stringify(t));
  for (const [t, e] of V.normalize) assert.equal(normalizeText(t), e, JSON.stringify(t));
  for (const [t, e] of V.uncovered) assert.equal(uncoveredLanguage(t), e, 'uncovered ' + JSON.stringify(t));
});

test('the six Art 9 categories are present, in every supported language, and plain project talk raises nothing', () => {
  assert.deepEqual(Object.keys(SPECIAL_PHRASES), ['health', 'union', 'religion', 'politics', 'sexual_orientation', 'ethnicity']);
  assert.equal(isSpecial('We rebuilt the claims router, cut triage from 40 to 12 minutes and trained two teams.'), false);
  assert.equal(isSpecial('There was a race condition in the queue, and the union of both tables was slow.'), false);
  assert.deepEqual(specialCategories('Je suis syndiqué et musulman'), ['union', 'religion']);
  for (const [t, c] of [['ich bin schwanger', 'health'], ['sono incinta', 'health'], ['mijn politieke mening', 'politics'], ['orientação sexual', 'sexual_orientation'], ['origen étnico', 'ethnicity'], ['trade union', 'union'], ['my faith', 'religion']])
    assert.ok(specialCategories(t).includes(c), t);
});

test('the guard returns category ids only: no phrase, no span, nothing that could be stored as a trait of a person', () => {
  const out = specialCategories('I have cancer and my religion matters to me');
  assert.deepEqual(out, ['health', 'religion']);
  assert.ok(out.every(c => typeof c === 'string' && c in SPECIAL_PHRASES));
});
