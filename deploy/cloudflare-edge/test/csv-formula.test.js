// A leading space or line feed must not leave a formula starter in the first
// executable character. Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, neutralizeFormula, toCsv } from '../src/csvsafe.js';

const starters = ['=', '+', '-', '@', '\t', '\r'];

test('a formula starter is still stored as text', () => {
  assert.equal(neutralizeFormula('=HYPERLINK("http://evil.test")'), `'=HYPERLINK("http://evil.test")`);
  assert.equal(neutralizeFormula('+1'), "'+1");
  assert.equal(neutralizeFormula('-1'), "'-1");
  assert.equal(neutralizeFormula('@cmd'), "'@cmd");
  assert.equal(neutralizeFormula('\t=1'), "'\t=1");
  assert.equal(neutralizeFormula('\r=1'), "'\r=1");
  assert.equal(neutralizeFormula('normal'), 'normal');
  assert.equal(neutralizeFormula(''), '');
});

test('a leading space or line feed does not hide a formula starter', () => {
  for (const lead of [' ', '  ', '\n', ' \n ', '\n ']) {
    for (const starter of starters) {
      const raw = lead + starter + '1';
      const stored = neutralizeFormula(raw);
      assert.equal(stored[0], "'", JSON.stringify(raw));
      assert.equal(stored.slice(1), raw, JSON.stringify(raw));
    }
  }
  assert.equal(neutralizeFormula('  normal'), '  normal');
  assert.equal(neutralizeFormula(' 12'), ' 12');
  assert.equal(neutralizeFormula('\nplain'), '\nplain');
  assert.equal(neutralizeFormula(' '), ' ');
  assert.equal(neutralizeFormula('\n'), '\n');
});

test('the exported cell keeps the apostrophe in front of a spaced formula', () => {
  assert.equal(csvCell(' =1+2'), "' =1+2");
  const csv = toCsv(['note'], [{ note: ' =1+1' }]);
  assert.equal(csv.split('\r\n')[1], "' =1+1");
});
