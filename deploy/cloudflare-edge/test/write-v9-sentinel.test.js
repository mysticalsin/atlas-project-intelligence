// Sentinel residuals on 4c11808c. The name resolver, provenRead, the eval
// tripwire, and the four SQL scanners. Each failure is an assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { bareSemicolon, leadingWords, placeholderCount, provenRead, splitStatements } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';
import { lintSource } from './write-lint.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

function native() {
  const driver = memorySql();
  const lib = new Library(driver, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.log('library', 'atlas', 'note', 'seed'));
  return lib;
}

function run(lib, sql, door) {
  let err;
  try {
    if (door === 'schema') lib.schema(() => lib.exec(sql));
    else lib.recorded(() => lib.exec(sql));
  } catch (error) { err = error; }
  return err ? (err.code || 'ERR') : 'ALLOW';
}

test('a patched push or Set.has cannot hide a guarded name', () => {
  const push = Array.prototype.push;
  const has = Set.prototype.has;
  try {
    const lib = native();
    Array.prototype.push = function () { return this.length; };
    assert.equal(run(lib, 'DELETE FROM audit', 'recorded'), 'SQL_DOOR');
    Array.prototype.push = push;
    assert.equal(lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n, 2);
    Set.prototype.has = function () { return true; };
    assert.equal(run(native(), 'DELETE FROM main.audit', 'recorded'), 'SQL_DOOR');
    Set.prototype.has = function () { return false; };
    assert.equal(run(native(), 'CREATE INDEX IF NOT EXISTS refs_owner_local ON refs(owner)', 'schema'), 'ALLOW');
  } finally {
    Array.prototype.push = push;
    Set.prototype.has = has;
  }
});

test('provenRead accepts a pragma only when the verb is pragma', () => {
  assert.equal(provenRead('DELETE FROM refs PRAGMA user_version'), false);
  assert.equal(provenRead('UPDATE refs SET id = id PRAGMA writable_schema'), false);
  assert.equal(provenRead('PRAGMA user_version'), true);
  assert.equal(provenRead('EXPLAIN PRAGMA user_version'), true);
  assert.equal(provenRead('EXPLAIN QUERY PLAN PRAGMA table_info(refs)'), true);
  assert.equal(provenRead('PRAGMA user_version = 7'), false);
});

test('eval plants the lint missed are violations', () => {
  const plants = [
    "[eval][0]('1');\n",
    "({e: eval}).e('1');\n",
    "Reflect.apply(eval, null, ['1']);\n",
    '[1].map(eval);\n',
    "globalThis.Function('return 1')();\n",
    "(0, Function)('return 1');\n",
  ];
  for (const source of plants) {
    assert.ok(lintSource('plant.js', source).exec.length >= 1, source);
  }
});

test('the four scanners agree on quotes, comments, and placeholders', () => {
  const rows = [
    { sql: 'SELECT "a;""b?"', split: 1, semi: false, holes: 0, words: ['select', 'a;"b?'] },
    { sql: 'SELECT `a``;b`', split: 1, semi: false, holes: 0, words: ['select', 'a`;b'] },
    { sql: 'SELECT [a;b?]', split: 1, semi: false, holes: 0, words: ['select', 'a;b?'] },
    { sql: "SELECT 'a;''b?'", split: 1, semi: false, holes: 0, words: ['select'] },
    { sql: 'SELECT ? -- ?\n', split: 1, semi: false, holes: 1, words: ['select'] },
    { sql: 'SELECT 1; DELETE FROM refs', split: 2, semi: true, holes: 0, words: ['select', '1', 'delete', 'from', 'refs'] },
    { sql: 'PRAGMA "main"."writable_schema"', split: 1, semi: false, holes: 0, words: ['pragma', 'main', 'writable_schema'] },
  ];
  for (const row of rows) {
    assert.deepEqual(leadingWords(row.sql), row.words, row.sql);
    assert.equal(splitStatements(row.sql).length, row.split, row.sql);
    assert.equal(bareSemicolon(row.sql), row.semi, row.sql);
    assert.equal(placeholderCount(row.sql), row.holes, row.sql);
  }
  assert.equal(run(native(), 'DELETE FROM "audit""tail"', 'recorded'), 'ERR_SQLITE_ERROR');
});
