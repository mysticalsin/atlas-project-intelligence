'use strict';
// A long interview quote is walked in 480-character windows because the country resolver reads at most 500.
// The window used to end on a space and the next window started there, so the last word of a country could
// cross the cut and the name was never handed to the resolver whole.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/storyboard-core.js');
const G = require('../src/geo.js');

function quote(left, word, at) {
  assert.ok(left.length < at, left);
  return 'a'.repeat(at - left.length) + left + ' ' + word + ' afterwards the notes continue.';
}

const CASES = [
  ['GBR', 'the United Kingdom', 'We worked in the United', 'Kingdom'],
  ['USA', 'the United States', 'We worked in the United', 'States'],
  ['ZAF', 'South Africa', 'We worked in South', 'Africa'],
  ['NZL', 'New Zealand', 'We worked in New', 'Zealand'],
  ['CZE', 'the Czech Republic', 'We worked in the Czech', 'Republic'],
  ['KOR', 'South Korea', 'We worked in South', 'Korea'],
  ['SDS', 'South Sudan', 'We worked in South', 'Sudan'],
  ['PNG', 'Papua New Guinea', 'We worked in Papua New', 'Guinea'],
  ['TTO', 'Trinidad and Tobago', 'We worked across Trinidad and', 'Tobago'],
];

test('a long quote still pins a cued multi-word country across a place window', () => {
  for (const [code, name, left, word] of CASES) {
    const short = B.pinsOf('We worked in ' + name + '.', G);
    assert.deepEqual(short.pins.map(p => p.code), [code], 'short ' + name);
    assert.deepEqual(short.notMapped, [], 'short ' + name);
    for (let at = 400; at <= 1600; at++) {
      const got = B.pinsOf(quote(left, word, at), G);
      assert.deepEqual(got.pins.map(p => p.code), [code], name + ' at ' + at);
      assert.deepEqual(got.notMapped, [], name + ' at ' + at + ' unmapped ' + got.notMapped.map(x => x.text).join(','));
    }
  }
});

test('the board keeps the country and does not list the cut-off tail', () => {
  const q = quote('We worked in South', 'Sudan', 476);
  const m = B.model({
    quality: {candidate_details: [{id: 'D-001', field: 'outcome', quote: q, status: 'reported', active: true}]},
    geo: G,
    policy: {FIELDS: {outcome: ['Observed outcome']}},
  });
  assert.deepEqual(m.pins, [{code: 'SDS', name: 'South Sudan', detailIds: ['D-001']}]);
  assert.deepEqual(m.placesNotMapped, []);
});
