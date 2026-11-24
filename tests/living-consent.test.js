const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('profileReuse is granted only after an explicit confirm', () => {
  const src = readFileSync(join(__dirname, '../src/living-ui.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function post'), src.indexOf('const TOPIC_LABEL'));
  assert.match(fn, /if\(e\.message!=='Consent required\.'\)throw e;\s*if\(!window\.confirm\('Reuse your published profile for this CV and review\?'\)\)throw Error\('Profile reuse was not granted\.'\);\s*await api\('\/profile\/consent',\{method:'POST',body:\{kind:'profileReuse',version:1,granted:true\}\}\);/);
});
