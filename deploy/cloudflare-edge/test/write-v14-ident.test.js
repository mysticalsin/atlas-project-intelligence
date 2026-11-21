// Sentinel F-T on 3c5924b. SQLite IdChar includes '$' (tokenize.c:168), so
// a$b is one identifier. scanSemi and placeholderCount must not start a
// variable at the dollar inside that name. A real $b( suffix still does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bareSemicolon, placeholderCount } from '../src/sql-text.js';

const HIDDEN_SEMI = "SELECT a$b('); DELETE FROM refs')";
const REAL_SPLIT = 'SELECT a$b ; DELETE FROM refs';
const REAL_SUFFIX = "SELECT $b('); DELETE FROM refs')";

test('a dollar inside an identifier does not hide a semicolon', () => {
  assert.equal(bareSemicolon(HIDDEN_SEMI), false, HIDDEN_SEMI);
  assert.equal(bareSemicolon(REAL_SPLIT), true, REAL_SPLIT);
  assert.equal(bareSemicolon(REAL_SUFFIX), true, REAL_SUFFIX);
});

test('placeholderCount does not treat a dollar inside a name as a parameter', () => {
  assert.equal(placeholderCount('SELECT a$b'), 0);
  assert.equal(placeholderCount('SELECT a$b(?)'), 1);
  assert.equal(placeholderCount('SELECT a$b(?1)'), 1);
  assert.equal(placeholderCount("SELECT $b(?)"), 0);
});
