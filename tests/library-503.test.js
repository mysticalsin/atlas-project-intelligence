'use strict';
// A 503 body of JSON null must throw the library error with status attached, not a TypeError.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync(require('path').join(__dirname, '../src/app.js'), 'utf8');
const start = src.indexOf('function libraryErrorText');
const end = src.indexOf('async function libraryApi', start);
const line = src.split('\n').find(row => row.includes('const data=await r.json()'));
const body = line.replace('const data=await r.json().catch(()=>({}));', 'const data = null;');

test('a 503 JSON null attaches status before it throws', async () => {
  const run = vm.runInNewContext(`${src.slice(start, end)}\nasync function go(r){${body}}\ngo`);
  const r = { status: 503, ok: false };
  await assert.rejects(() => run(r), err => err.status === 503 && err.message === 'The shared library is not available here.' && !(err instanceof TypeError));
});
