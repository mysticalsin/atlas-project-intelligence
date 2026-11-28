// A thousands comma is the same figure as the digits. A short comma fraction stays a decimal.
// Synthetic figures only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { numbersIn, parseSlides } from '../src/reuse.js';

const slide = n => JSON.stringify({
  title: 'Queue',
  subtitle: 'Intake',
  summary: 'No figure here.',
  sections: [{ heading: 'Results', bullets: [{ text: 'The queue handled ' + n + ' tickets.', kind: 'fact', source: 'outcome' }] }],
});

test('a short comma fraction stays a decimal and a version stays split', () => {
  assert.deepEqual(numbersIn('from 40 to 12,5 min'), ['40', '12.5']);
  assert.deepEqual(numbersIn('12,50'), ['12.50']);
  assert.deepEqual(numbersIn('1.2.3'), ['1.2', '3']);
  assert.deepEqual(numbersIn('1.000'), ['1.000']);
  assert.deepEqual(numbersIn('12.500'), ['12.500']);
});

test('a thousands comma is the same figure as the digits', () => {
  assert.deepEqual(numbersIn('The queue handled 1,000 tickets.'), ['1000']);
  assert.deepEqual(numbersIn('The queue handled 1000 tickets.'), ['1000']);
  assert.deepEqual(numbersIn('1,000.50'), ['1000.50']);
  assert.deepEqual(numbersIn('1,000,000'), ['1000000']);
  assert.deepEqual(numbersIn('12,500'), ['12500']);
  assert.deepEqual(numbersIn('1.000,50'), ['1000.50']);
});

test('a slide keeps a thousands restatement and drops a different figure', () => {
  const source = 'The queue handled 1000 tickets in the quarter.';
  const kept = parseSlides(slide('1,000'), source);
  assert.equal(kept.sections[0].bullets[0].text, 'The queue handled 1,000 tickets.');
  assert.deepEqual(kept.dropped, []);
  assert.equal(parseSlides(slide('2,000'), source), null);
  assert.equal(parseSlides(slide('1,000'), 'The reading was 1.000.'), null);
  const decimal = parseSlides(slide('12,5'), 'The wait was 12.5 minutes.');
  assert.equal(decimal.sections[0].bullets[0].text, 'The queue handled 12,5 tickets.');
});
