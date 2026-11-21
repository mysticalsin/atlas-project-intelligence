// Sweep 01 group 7 (languages, L3). Copied from the red tests at 96712474.
// Fails on main. Not skipped and not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, GREETINGS, WELCOME_BACK, FILLERS, unfinished } from '../src/languages.js';

test('L3 every advertised language has a greeting, a welcome back, and fillers', () => {
  for (const code of Object.keys(LANGUAGES)) {
    assert.equal(typeof GREETINGS[code], 'string', code);
    assert.equal(typeof WELCOME_BACK[code], 'string', code);
    assert.ok(Array.isArray(FILLERS[code]) && FILLERS[code].length > 0, code);
  }
});

test('L3 an unfinished check in Japanese does not use the English trailing-word list', () => {
  assert.equal(unfinished('プロジェクトの範囲 and', 'ja'), false);
});
