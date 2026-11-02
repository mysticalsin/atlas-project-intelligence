// textfold.js: parity with atlas_voice/textfold.py (fold and plain), and the properties the guards rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fold, plain } from '../src/textfold.js';

const V = JSON.parse(readFileSync(new URL('./fold.vectors.json', import.meta.url)));

test('fold and plain: parity with Python', () => { for (const [t, f, p] of V) { assert.equal(fold(t), f, 'fold ' + JSON.stringify(t)); assert.equal(plain(t), p, 'plain ' + JSON.stringify(t)); } });

test('look-alike letters, invisible characters and full-width forms read as the plain word; real text in other scripts is left as it is', () => {
  assert.equal(fold('vеrified'), 'verified'); assert.equal(fold('v​erified'), 'verified'); assert.equal(fold('ＵＮＩＯＮ'), 'union');
  assert.equal(plain('Vérifié'), 'verifie'); assert.equal(plain('Straße'), 'strasse');
  assert.ok(/[Ѐ-ӿ]/.test(fold('Привет')), 'Cyrillic words keep their other letters (only the look-alikes fold)');
});
