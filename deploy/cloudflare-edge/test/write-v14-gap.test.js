// Sentinel and Devin gaps on e0e3eba. SQLite 3.53.4 tokenize.c: IdChar is
// line 168 (high bit, letter, digit, '_', '$'). CC_DIGIT at lines 433-497
// consumes a number and then every trailing IdChar, and line 493 marks that
// token TK_ILLEGAL. `1$a` is one illegal token, not a `$a` parameter. CC_ID
// at line 571 starts an identifier on a non-ASCII byte, and line 592 keeps
// the following `$`. A comment is not a token, so the classifier's first
// word is still EXPLAIN. That is not the bare form. The primary door allows
// EXPLAIN only when the text, after whitespace, starts with that word and
// the statement is one statement. `/* x */ EXPLAIN ...` does not, so both
// doors return SQL_DOOR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { bareSemicolon, namedVariable, placeholderCount, provenRead } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";
const NUMBER = "SELECT 1$a(') ; DELETE FROM refs";
const NONASCII = "SELECT é$a(') ; DELETE FROM refs";
const COMMENT = '/* x */ EXPLAIN QUERY PLAN DELETE FROM refs';
const COMMENT_READ = '/* x */ EXPLAIN QUERY PLAN SELECT 1';
const SPLIT = 'EXPLAIN QUERY PLAN SELECT 1; DELETE FROM refs';
// SELECT 1 VACUUM and SELECT 1 REINDEX are column aliases. The real
// statements stay here. Alias rows are in write-sqltext-alias-explain.test.js.
const TRAILING = [
  'SELECT 1 DETACH other',
  'VACUUM',
  'VACUUM main',
  'REINDEX',
  'REINDEX refs',
  'SELECT 1 PRAGMA user_version',
];

function hide(run) {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  try { return run(); }
  finally { process.getBuiltinModule = orig; }
}
function codeOf(run) {
  try { run(); return 'ALLOW'; }
  catch (err) { return err.code || 'ERR'; }
}
function refsCount(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n);
}
function auditCount(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n);
}
function chainOf(raw) {
  return raw.exec('SELECT seq, action, "commit" FROM audit ORDER BY seq').toArray()
    .map((row) => row.seq + ' ' + row.action + ' ' + row.commit).join('\n');
}
function snap(raw) {
  return { refs: refsCount(raw), audit: auditCount(raw), chain: chainOf(raw) };
}
function open(raw) {
  return new Library(raw, { auditKey: SALT, now: () => STAMP });
}
function shut(raw) {
  return new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
}
function seed(lib) {
  lib.recorded(() => lib.exec(REFS_SEED));
}
function doors(cases, expectCode) {
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  for (const sql of cases) {
    assert.equal(codeOf(() => lib.exec(sql)), expectCode, sql);
    assert.deepEqual(snap(raw), before, sql);
  }
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    for (const sql of cases) {
      assert.equal(codeOf(() => door.exec(sql)), expectCode, 'fallback ' + sql);
      assert.deepEqual(snap(inner), innerBefore, sql);
    }
  });
}

test('a number followed by an identifier character is not a parameter', () => {
  assert.equal(placeholderCount('SELECT 1$a(?)'), 1);
  assert.equal(namedVariable('SELECT 1$a(?)'), false);
  assert.equal(bareSemicolon(NUMBER), false, NUMBER);
  assert.equal(namedVariable(NUMBER), false, NUMBER);
  assert.equal(provenRead(NUMBER), false, NUMBER);
  doors([NUMBER, 'SELECT 1$a(?)'], 'SQL_DOOR');
});

test('a non-ASCII identifier keeps the dollar inside the name', () => {
  assert.equal(bareSemicolon(NONASCII), false, NONASCII);
  assert.equal(namedVariable(NONASCII), false, NONASCII);
  assert.equal(provenRead(NONASCII), false, NONASCII);
  doors([NONASCII], 'SQL_DOOR');
});

test('EXPLAIN is refused unless it is the first word of one statement', () => {
  doors([COMMENT, COMMENT_READ, SPLIT], 'SQL_DOOR');
});

test('detach and pragma after a read, and a real vacuum or reindex, are writes', () => {
  for (const sql of TRAILING) assert.equal(provenRead(sql), false, sql);
  doors(TRAILING, 'SQL_DOOR');
});
