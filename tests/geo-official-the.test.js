'use strict';
// Official English short names put "the" between the short name and the qualifier.
// Bare Congo and Korea stay ambiguous. A stated qualifier must not.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geo.js');

const codes = result => result.countries.map(country => country.code);

function placed(input, expected) {
  const result = G.resolveLocations(input);
  assert.deepEqual(codes(result), expected, input);
  assert.deepEqual(result.ambiguous, [], input);
  assert.deepEqual(result.unresolved, [], input);
}

test('a qualifier after the names one Congo or one Korea', () => {
  placed('Congo (the Democratic Republic of the)', ['COD']);
  placed('Congo, The Democratic Republic of the', ['COD']);
  placed('Korea (the Republic of)', ['KOR']);
  placed('Korea, The Republic of', ['KOR']);
  placed("Korea (the Democratic People's Republic of)", ['PRK']);
  placed("Korea, The Democratic People's Republic of", ['PRK']);
  placed('Korea (the Republic of) and France', ['KOR', 'FRA']);
  placed("Korea (the Democratic People's Republic of) and France", ['PRK', 'FRA']);
});

test('the short names stay ambiguous', () => {
  for (const input of ['Congo', 'Korea', 'Congo (the)', 'Korea (the)']) {
    const result = G.resolveLocations(input);
    assert.deepEqual(codes(result), [], input);
    assert.ok(result.ambiguous.length === 1, input);
    assert.equal(result.ambiguous[0] === 'Congo' || result.ambiguous[0] === 'Korea', true, input);
  }
  placed('Congo, Democratic Republic of the', ['COD']);
  placed('Korea, Republic of', ['KOR']);
  placed("Democratic People's Republic of Korea", ['PRK']);
});
