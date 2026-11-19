// Sentinel M-2 on 8cdef06. SQLite variable tokens are one token, including the
// TCL suffix. A named parameter is not a proven read when it hides a write, and
// both doors return SQL_DOOR. The app binds with ? only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { bareSemicolon, provenRead, splitStatements } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const SEED = 20261120;
const FUZZ_N = 24;
const SIGILS = ['$', ':', '@', '#'];
const FORMS = ['id', 'colon', 'paren'];
const INNER = ['$', ':', '@', '#', '?', '(', "'", '"', '-', '/', '*', ';', 'x', 'a', ':'];
const AUDIT_WRITES = [
  'DELETE FROM audit',
  "UPDATE audit SET action = 'wiped'",
  "INSERT INTO audit (actor, action, at, detail) VALUES ('x', 'wiped', 't', '{}')",
  "REPLACE INTO audit (seq, actor, action, at, detail) VALUES (1, 'x', 'wiped', 't', '{}')",
];
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

const EXPLICIT = [];
for (const table of ['refs', 'audit']) {
  const writes = table === 'audit' ? AUDIT_WRITES : [
    'DELETE FROM refs',
    "UPDATE refs SET title = 'wiped'",
    "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('pwn', 'ada@example.test', 'wiped', 'in_review', 1, '{}', '{}')",
    "REPLACE INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'wiped', 'in_review', 1, '{}', '{}')",
  ];
  for (const write of writes) EXPLICIT.push('WITH x AS (SELECT $a(\') ) ' + write);
  EXPLICIT.push('WITH x AS (SELECT :a(((x)) DELETE FROM ' + table);
  EXPLICIT.push('WITH x AS (SELECT @a(--)) DELETE FROM ' + table);
  EXPLICIT.push('WITH x AS (SELECT @a(/*)) DELETE FROM ' + table);
  EXPLICIT.push("SELECT $a(') ; DELETE FROM " + table);
  EXPLICIT.push('WITH x(a) AS MATERIALIZED (SELECT 1) DELETE FROM ' + table);
  EXPLICIT.push('WITH x(a) AS NOT MATERIALIZED (SELECT 1) DELETE FROM ' + table);
}

function bodyOf(form, draw) {
  if (form === 'colon') return 'a::b';
  if (form === 'paren') {
    const len = (draw() % 4) + 1;
    let inner = '';
    for (let k = 0; k < len; k++) inner += INNER[draw() % INNER.length];
    return 'a(' + inner + ')';
  }
  return 'a';
}
const next = lcg(SEED);
const fuzz = [];
for (let n = 0; n < FUZZ_N; n++) {
  const sigil = SIGILS[next() % SIGILS.length];
  const form = FORMS[next() % FORMS.length];
  const body = bodyOf(form, next);
  for (const write of AUDIT_WRITES) fuzz.push('WITH x AS (SELECT ' + sigil + body + ') ' + write);
}
function asRefs(sql) {
  return sql
    .replaceAll('DELETE FROM audit', 'DELETE FROM refs')
    .replaceAll("UPDATE audit SET action = 'wiped'", "UPDATE refs SET title = 'wiped'")
    .replaceAll("INSERT INTO audit (actor, action, at, detail) VALUES ('x', 'wiped', 't', '{}')", "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('pwn', 'ada@example.test', 'wiped', 'in_review', 1, '{}', '{}')")
    .replaceAll("REPLACE INTO audit (seq, actor, action, at, detail) VALUES (1, 'x', 'wiped', 't', '{}')", "REPLACE INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'wiped', 'in_review', 1, '{}', '{}')");
}

function kept(raw, before, sql, refs) {
  if (refs) unchanged(raw, before, sql);
  else {
    assert.equal(auditCount(raw), before.audit, sql);
    assert.equal(chainOf(raw), before.chain, sql);
  }
}
function doors(cases, { refs }) {
  for (const sql of cases) assert.equal(provenRead(sql), false, sql);
  const raw = memorySql();
  const lib = open(raw);
  if (refs) seed(lib);
  const before = refs ? snap(raw) : { audit: auditCount(raw), chain: chainOf(raw) };
  if (refs) {
    assert.equal(before.refs, 1);
    assert.equal(before.title, 'kept');
  }
  assert.equal(before.audit, 1);
  for (const sql of cases) {
    assert.equal(codeOf(() => lib.exec(sql)), 'SQL_DOOR', 'native ' + sql);
    kept(raw, before, sql, refs);
  }
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    if (refs) seed(door);
    const innerBefore = refs ? snap(inner) : { audit: auditCount(inner), chain: chainOf(inner) };
    for (const sql of cases) {
      assert.equal(codeOf(() => door.exec(sql)), 'SQL_DOOR', 'fallback ' + sql);
      kept(inner, innerBefore, sql, refs);
    }
  });
}

test('a variable token does not make a hidden write a proven read', () => {
  assert.equal(EXPLICIT.length, 20);
  assert.ok(EXPLICIT.includes("WITH x AS (SELECT $a(') ) DELETE FROM refs"));
  assert.ok(EXPLICIT.includes('WITH x AS (SELECT :a(((x)) DELETE FROM refs'));
  assert.ok(EXPLICIT.includes('WITH x AS (SELECT @a(--)) DELETE FROM audit'));
  assert.ok(EXPLICIT.includes('WITH x AS (SELECT @a(/*)) DELETE FROM audit'));
  assert.ok(EXPLICIT.includes("SELECT $a(') ; DELETE FROM refs"));
  assert.ok(EXPLICIT.includes('WITH x(a) AS MATERIALIZED (SELECT 1) DELETE FROM refs'));
  assert.equal(provenRead("WITH x AS (SELECT $a(') ) DELETE FROM refs"), false);
  assert.equal(provenRead('WITH x AS (SELECT :a(((x)) DELETE FROM refs'), false);
  assert.equal(provenRead('WITH x AS (SELECT @a(--)) DELETE FROM refs'), false);
  assert.equal(provenRead('WITH x AS (SELECT @a(/*)) DELETE FROM refs'), false);
  assert.equal(provenRead("SELECT $a(') ; DELETE FROM refs"), false);
  assert.equal(splitStatements("SELECT $a(') ; DELETE FROM refs").length, 2);
  assert.equal(bareSemicolon("SELECT $a(') ; DELETE FROM refs"), true);
  assert.equal(provenRead('WITH x(a) AS MATERIALIZED (SELECT 1) DELETE FROM refs'), false);
  assert.equal(provenRead('WITH x(a) AS NOT MATERIALIZED (SELECT 1) SELECT 2'), true);
  assert.equal(provenRead('SELECT 1 AS x$y'), true);
  assert.equal(provenRead("SELECT '$a('"), true);
});

test('both doors refuse a named variable and keep refs and audit', () => {
  doors(EXPLICIT, { refs: true });
});

test('a seeded variable fuzz stays a write on both doors', () => {
  assert.equal(SEED, 20261120);
  assert.equal(fuzz.length, 96);
  doors(fuzz, { refs: false });
  doors(fuzz.map(asRefs), { refs: true });
  console.log('variable fuzz seed ' + SEED + ' explicit ' + EXPLICIT.length + ' generated ' + fuzz.length + ' audit-door-checks ' + (fuzz.length * 2) + ' refs-door-checks ' + (fuzz.length * 2));
});

test('question-mark parameters stay bound and a dollar inside a name is not a parameter', () => {
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  assert.equal(codeOf(() => lib.exec('SELECT ?', 7)), 'ALLOW');
  assert.equal(codeOf(() => lib.exec('SELECT ?1', 7)), 'ALLOW');
  assert.equal(codeOf(() => lib.exec("SELECT '$a('")), 'ALLOW');
  assert.equal(codeOf(() => lib.exec('SELECT 1 AS x$y')), 'ALLOW');
  assert.equal(codeOf(() => lib.exec('SELECT $a')), 'SQL_DOOR');
  assert.equal(codeOf(() => lib.exec('SELECT :a')), 'SQL_DOOR');
  assert.equal(codeOf(() => lib.exec('SELECT @a')), 'SQL_DOOR');
  assert.equal(codeOf(() => lib.exec('SELECT #a')), 'SQL_DOOR');
  assert.equal(codeOf(() => lib.exec('SELECT $a::b')), 'SQL_DOOR');
  assert.equal(codeOf(() => lib.exec('SELECT $::b')), 'SQL_DOOR');
  unchanged(raw, before, 'named reads');
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    assert.equal(codeOf(() => door.exec('SELECT ?', 7)), 'ALLOW');
    assert.equal(codeOf(() => door.exec('SELECT $a')), 'SQL_DOOR');
    assert.equal(codeOf(() => door.exec("SELECT '$a('")), 'ALLOW');
    assert.equal(codeOf(() => door.exec('SELECT 1 AS x$y')), 'ALLOW');
    unchanged(inner, innerBefore, 'fallback named reads');
  });
});
