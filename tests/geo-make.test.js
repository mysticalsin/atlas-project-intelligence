// The Natural Earth check is a make target. The default test recipes do not run it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const make = readFileSync(new URL('../Makefile', import.meta.url), 'utf8');

function recipe(name) {
  const match = new RegExp('^' + name + ':[\\s\\S]*?(?=\\n\\S|$)', 'm').exec(make);
  return match ? match[0] : '';
}

test('make geo-ne-check is opt-in and the default recipes do not run it', () => {
  assert.match(recipe('geo-ne-check'), /^geo-ne-check:/);
  assert.match(recipe('geo-ne-check'), /node tests\/geo-ne-check\.js/);
  assert.equal(recipe('test').includes('geo-ne-check'), false);
  assert.equal(recipe('test-ui').includes('geo-ne-check'), false);
  assert.equal(recipe('test-edge').includes('geo-ne-check'), false);
});
