// Cursor review of 8cdef06. An unclosed quote, identifier, or block comment
// is not a proven read. A write verb inside a CTE body, or after the depth-0
// verb, is not a proven read. Both doors return SQL_DOOR. REPLACE( stays a
// function. EXPLAIN QUERY PLAN of one delete stays the accepted residual.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { provenRead } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const SEED = 20261121;
const FUZZ_N = 16;
const OPENERS = ["'", '"', '[', '`', '/*'];
const SAFE = ['(', '(', ')', ';', 'x', 'y', '/', '-', ' '];
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
}
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
function refsTitle(raw) {
  return raw.exec("SELECT title FROM refs WHERE id = 'r1'").toArray()[0].title;
}
function auditCount(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n);
}
function chainOf(raw) {
  return raw.exec('SELECT seq, action, "commit" FROM audit ORDER BY seq').toArray()
    .map((row) => row.seq + ' ' + row.action + ' ' + row.commit).join('\n');
}
function snap(raw) {
  return { refs: refsCount(raw), title: refsTitle(raw), audit: auditCount(raw), chain: chainOf(raw) };
}
function unchanged(raw, before, sql) {
  const after = snap(raw);
  assert.equal(after.refs, before.refs, sql);
  assert.equal(after.title, before.title, sql);
  assert.equal(after.audit, before.audit, sql);
  assert.equal(after.chain, before.chain, sql);
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
function doors(cases) {
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  for (const sql of cases) {
    assert.equal(codeOf(() => lib.exec(sql)), 'SQL_DOOR', sql);
    unchanged(raw, before, sql);
  }
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    for (const sql of cases) {
      assert.equal(codeOf(() => door.exec(sql)), 'SQL_DOOR', 'fallback ' + sql);
      unchanged(inner, innerBefore, sql);
    }
  });
}

const UNCLOSED = [
  "SELECT '",
  'SELECT "',
  'SELECT [',
  'SELECT `',
  'SELECT 1 /*',
  "SELECT ' DELETE FROM refs",
  'SELECT " DELETE FROM refs',
  'SELECT [ DELETE FROM refs',
  'SELECT ` DELETE FROM refs',
  'SELECT 1 /* DELETE FROM refs',
  "SELECT ' DELETE FROM audit",
  'SELECT " DELETE FROM audit',
  'SELECT [ DELETE FROM audit',
  'SELECT ` DELETE FROM audit',
  'SELECT 1 /* DELETE FROM audit',
];

function fixedTail(opener) {
  const common = ['', '(', '((', ')', '(((', '--', ';', ' DELETE FROM refs'];
  if (opener === "'") return common.concat(['"', '`', '/*', '*/', '[']);
  if (opener === '"') return common.concat(["'", '`', '/*', '[']);
  if (opener === '[') return common.concat(["'", '"', '`', '/*']);
  if (opener === '`') return common.concat(["'", '"', '/*', '[']);
  return common.concat(["'", '"', '`', '[', '*', '/', '--']);
}
const unclosedFuzz = [];
for (const opener of OPENERS) {
  for (const tail of fixedTail(opener)) unclosedFuzz.push('SELECT 1 ' + opener + tail);
}
const draw = lcg(SEED);
for (const opener of OPENERS) {
  for (let n = 0; n < FUZZ_N; n++) {
    const len = (draw() % 6) + 1;
    let tail = '';
    for (let k = 0; k < len; k++) tail += SAFE[draw() % SAFE.length];
    unclosedFuzz.push('SELECT 1 ' + opener + tail);
  }
}

function body(table, verb) {
  if (verb === 'delete') return 'DELETE FROM ' + table + ' RETURNING *';
  if (verb === 'update') {
    const set = table === 'refs' ? "title = 'wiped'" : "action = 'wiped'";
    return 'UPDATE ' + table + ' SET ' + set + ' RETURNING *';
  }
  if (verb === 'replace') return "REPLACE INTO " + table + " (id) VALUES ('pwn') RETURNING *";
  return "INSERT INTO " + table + " (id) VALUES ('pwn') ON CONFLICT(id) DO UPDATE SET id = id RETURNING *";
}
const INNER = [];
for (const table of ['refs', 'audit']) {
  for (const verb of ['delete', 'update', 'replace', 'insert']) {
    INNER.push('WITH x AS (' + body(table, verb) + ') SELECT 1');
  }
  INNER.push('SELECT 1 DELETE FROM ' + table);
  INNER.push('WITH x AS (SELECT 1) SELECT 1 FROM (DELETE FROM ' + table + ' RETURNING *)');
}
const COLUMN = [];
for (const table of ['refs', 'audit']) COLUMN.push('WITH select(a) AS (SELECT 1) DELETE FROM ' + table);

test('an unterminated quote, identifier, or block comment is not a proven read', () => {
  assert.equal(UNCLOSED.length, 15);
  assert.ok(UNCLOSED.includes("SELECT '"));
  assert.ok(UNCLOSED.includes('SELECT "'));
  assert.ok(UNCLOSED.includes('SELECT ['));
  assert.ok(UNCLOSED.includes('SELECT `'));
  assert.ok(UNCLOSED.includes('SELECT 1 /*'));
  assert.ok(UNCLOSED.includes('SELECT 1 /* DELETE FROM refs'));
  for (const sql of UNCLOSED) assert.equal(provenRead(sql), false, sql);
  assert.equal(provenRead("SELECT 'ok'"), true);
  assert.equal(provenRead('SELECT "title" FROM refs'), true);
  assert.equal(provenRead('SELECT [title] FROM refs'), true);
  assert.equal(provenRead('SELECT `title` FROM refs'), true);
  assert.equal(provenRead('SELECT 1 /* comment */'), true);
  assert.equal(provenRead("SELECT 1 /* ' */"), true);
});

test('an unterminated lexeme is refused on both doors', () => {
  doors(UNCLOSED);
});

test('a seeded unclosed fuzz is refused on both doors', () => {
  assert.equal(SEED, 20261121);
  assert.equal(OPENERS.length, 5);
  assert.equal(unclosedFuzz.length, 144);
  assert.ok(unclosedFuzz.includes("SELECT 1 '"));
  assert.ok(unclosedFuzz.includes('SELECT 1 "'));
  assert.ok(unclosedFuzz.includes('SELECT 1 ['));
  assert.ok(unclosedFuzz.includes('SELECT 1 `'));
  assert.ok(unclosedFuzz.includes('SELECT 1 /*'));
  assert.ok(unclosedFuzz.includes("SELECT 1 ' DELETE FROM refs"));
  assert.ok(unclosedFuzz.includes('SELECT 1 /*((('));
  doors(unclosedFuzz);
  console.log('unclosed fuzz seed ' + SEED + ' openers ' + OPENERS.length + ' statements ' + unclosedFuzz.length + ' door-checks ' + (unclosedFuzz.length * 2));
});

test('a write verb inside a read is refused on both doors', () => {
  assert.equal(INNER.length, 12);
  assert.ok(INNER.includes('WITH x AS (DELETE FROM refs RETURNING *) SELECT 1'));
  assert.ok(INNER.includes('WITH x AS (UPDATE refs SET title = \'wiped\' RETURNING *) SELECT 1'));
  assert.ok(INNER.includes("WITH x AS (REPLACE INTO refs (id) VALUES ('pwn') RETURNING *) SELECT 1"));
  assert.ok(INNER.includes("WITH x AS (INSERT INTO refs (id) VALUES ('pwn') ON CONFLICT(id) DO UPDATE SET id = id RETURNING *) SELECT 1"));
  assert.ok(INNER.includes('SELECT 1 DELETE FROM refs'));
  assert.ok(INNER.includes('WITH x AS (SELECT 1) SELECT 1 FROM (DELETE FROM audit RETURNING *)'));
  for (const sql of INNER) assert.equal(provenRead(sql), false, sql);
  doors(INNER);
});

test('a column list does not hide the statement verb', () => {
  assert.deepEqual(COLUMN, [
    'WITH select(a) AS (SELECT 1) DELETE FROM refs',
    'WITH select(a) AS (SELECT 1) DELETE FROM audit',
  ]);
  for (const sql of COLUMN) assert.equal(provenRead(sql), false, sql);
  doors(COLUMN);
});

test('REPLACE( stays a function and a closed comment stays a read', () => {
  const reads = [
    "SELECT REPLACE(title, 'a', 'b') FROM refs",
    'SELECT 1 AS "delete"',
    'SELECT 1 AS begin',
    'WITH x AS (SELECT 1) SELECT 2',
    'SELECT 1 /* comment */',
    "SELECT 'ok'",
  ];
  for (const sql of reads) assert.equal(provenRead(sql), true, sql);
  assert.equal(provenRead('SELECT 1 AS delete'), true);
  assert.equal(provenRead('SELECT 1 AS replace'), true);
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  for (const sql of reads) {
    assert.equal(codeOf(() => lib.exec(sql)), 'ALLOW', sql);
    unchanged(raw, before, sql);
  }
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    for (const sql of reads) {
      assert.equal(codeOf(() => door.exec(sql)), 'ALLOW', 'fallback ' + sql);
      unchanged(inner, innerBefore, sql);
    }
  });
});

test('EXPLAIN QUERY PLAN of one delete stays the accepted residual', () => {
  const sql = 'EXPLAIN QUERY PLAN DELETE FROM refs';
  assert.equal(provenRead(sql), false);
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  assert.equal(codeOf(() => lib.exec(sql)), 'ALLOW');
  unchanged(raw, before, sql);
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    assert.equal(codeOf(() => door.exec(sql)), 'SQL_DOOR');
    unchanged(inner, innerBefore, sql);
  });
});
