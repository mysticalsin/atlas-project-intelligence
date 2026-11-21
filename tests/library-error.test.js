'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REFUSAL = 'The shared library is not available here.';

function libraryErrorText() {
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const start = src.indexOf('function libraryErrorText(');
  assert.notEqual(start, -1, 'libraryErrorText is missing');
  let depth = 0;
  let opened = false;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') { depth += 1; opened = true; }
    else if (src[i] === '}') {
      depth -= 1;
      if (opened && depth === 0) return new Function(`${src.slice(start, i + 1)}; return libraryErrorText;`)();
    }
  }
  throw new Error('libraryErrorText is unclosed');
}

test('libraryErrorText clips a usable body and refuses the rest', () => {
  const text = libraryErrorText();
  const long = 'L'.repeat(600);
  assert.equal(text(long), 'L'.repeat(500));
  assert.equal(text(['A'.repeat(2051)]), 'A'.repeat(500));
  assert.equal(text(424242), '424242');
  assert.equal(text({ detail: 'Z'.repeat(5000), message: 'from message' }), 'Z'.repeat(500));
  assert.equal(text({ message: 'from message', error: 'from error' }), 'from message');
  assert.equal(text({ error: 'from error' }), 'from error');
  assert.equal(text(null), REFUSAL);
  assert.equal(text(undefined), REFUSAL);
  assert.equal(text(''), REFUSAL);
  assert.equal(text({}), REFUSAL);
  assert.equal(text({ detail: { nested: true } }), REFUSAL);
});
