'use strict';
// The directory import stages at most 20,000 people (40 parts of 500). The header is not a person.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/profile-core.js');

const file = (n, {newline = true} = {}) => 'email\n' + Array.from({length: n}, (_, i) => `p${i}@example.com`).join('\n') + (newline ? '\n' : '');

test('exactly maxRows people parse when the file ends with a newline', () => {
  assert.equal(C.parseCsv(file(3), {maxRows: 3}).rows.length, 3);
  assert.throws(() => C.parseCsv(file(4), {maxRows: 3}), /more than 3 rows/);
});

test('one person past the cap is refused when the file has no trailing newline', () => {
  assert.equal(C.parseCsv(file(3, {newline: false}), {maxRows: 3}).rows.length, 3);
  assert.throws(() => C.parseCsv(file(4, {newline: false}), {maxRows: 3}), /more than 3 rows/);
});

test('a 20000-person directory with a trailing newline parses, and 20001 does not', () => {
  assert.equal(C.parseCsv(file(20000)).rows.length, 20000);
  assert.throws(() => C.parseCsv(file(20001)), /more than 20,000 rows/);
});
