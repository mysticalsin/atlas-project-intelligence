'use strict';
// Applying the same checked note twice used to concatenate it onto the answer again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync(require('path').join(__dirname, '../src/app.js'), 'utf8');
const start = src.indexOf('function appendSections');
const end = src.indexOf('const firstOpenTopic', start);
const appendSections = vm.runInNewContext(`${src.slice(start, end)}\nappendSections`);

test('appending the same checked note twice does not duplicate it', () => {
  const answers = ['The queue was slow.', '', '', '', '', ''];
  const note = ['I rebuilt the routing step.', null, null, null, null, null];
  const once = appendSections(answers, note);
  const twice = appendSections(once, note);
  assert.equal(once[0], 'The queue was slow.\n\nI rebuilt the routing step.');
  assert.equal(twice[0], once[0]);
  const extra = appendSections(twice, ['The fallback stayed manual.', null, null, null, null, null]);
  assert.equal(extra[0], 'The queue was slow.\n\nI rebuilt the routing step.\n\nThe fallback stayed manual.');
});
