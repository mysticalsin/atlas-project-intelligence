'use strict';
// The record dialog used to throw when a quality object had a score but no issue arrays.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync(require('path').join(__dirname, '../src/app.js'), 'utf8');

function take(from, until) {
  const start = src.indexOf(from);
  const end = src.indexOf(until, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return src.slice(start, end);
}

test('a quality object without issue arrays still renders the record dialog', () => {
  const body = take('function showRecord', 'const claims=$');
  const q = { score: 40, status: 'needs_work', readyScore: 75, completeness: 10, aiScore: null, summary: 'Synthetic score' };
  const reads = [...body.matchAll(/q\.(blockers|missing|issues|recommendations)\.length/g)];
  assert.equal(reads.length, 0, 'the dialog still reads a missing array');
  const helper = take('function qualityLists', 'function showRecord');
  const qualityLists = vm.runInNewContext(`${helper}\nqualityLists`);
  const lists = qualityLists(q);
  assert.equal(JSON.stringify(lists), JSON.stringify({ blockers: [], holds: [], missing: [], issues: [], recommendations: [] }));
});
