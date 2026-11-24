const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');

function brandTaglines(html) {
  return ['EXPERIENCE INTO STORIES', 'Experience into stories'].filter(phrase => html.includes(phrase));
}

test('the brand tagline is covered by the unit suite and make test-ui', () => {
  assert.deepEqual(brandTaglines(readFileSync(join(root, 'src/shell.html'), 'utf8')), []);
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /for t in [^\n]*\bliving\b/);
  const make = readFileSync(join(root, 'Makefile'), 'utf8');
  assert.match(make, /tests\/living_browser\.py/);
});
