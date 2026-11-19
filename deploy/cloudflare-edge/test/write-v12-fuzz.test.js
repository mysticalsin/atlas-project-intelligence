// One lexer, every quote style. A parenthesis, a semicolon, or a quote inside a
// CTE name or an alias must not hide the write that follows the CTE list.
// The generator is a fixed seed so a failure names the same statement again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const SEED = 20261119;
const FUZZ_N = 24;
const WRITES = [
  'DELETE FROM audit',
  "UPDATE audit SET action = 'wiped'",
  "INSERT INTO audit (actor, action, at, detail) VALUES ('x', 'wiped', 't', '{}')",
  "REPLACE INTO audit (seq, actor, action, at, detail) VALUES (1, 'x', 'wiped', 't', '{}')",
];
const STYLES = ['single', 'double', 'bracket', 'tick'];
const EXPLICIT_PAYLOADS = ['x(', 'x)', 'x;', "x'(", 'x"(', 'x`(', 'x(;', ''];

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
}
function wrap(style, payload) {
  if (style === 'single') return "'" + payload.replaceAll("'", "''") + "'";
  if (style === 'double') return '"' + payload.replaceAll('"', '""') + '"';
  if (style === 'bracket') return '[' + payload + ']';
  return '`' + payload.replaceAll('`', '``') + '`';
}
function statement(name, alias, write) {
  const called = alias ? ' AS ' + alias : '';
  return 'WITH ' + name + ' AS (SELECT 1' + called + ') ' + write;
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
function countOf(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n);
}
function chainOf(raw) {
  const rows = raw.exec('SELECT seq, action, "commit" FROM audit ORDER BY seq').toArray();
  return rows.map((row) => row.seq + ' ' + row.action + ' ' + row.commit).join('\n');
}
function open(raw) {
  return new Library(raw, { auditKey: SALT, now: () => STAMP });
}
function shut(raw) {
  return new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
}

const explicit = [];
for (const style of STYLES) {
  for (const payload of EXPLICIT_PAYLOADS) {
    const quoted = wrap(style, payload);
    for (const write of WRITES) {
      explicit.push(statement(quoted, '', write));
      explicit.push(statement('a', quoted, write));
    }
  }
}
for (const style of STYLES) {
  const quoted = wrap(style, 'x(');
  for (const write of WRITES) {
    explicit.push('WITH ' + quoted + ' AS ((SELECT 1)) ' + write);
    explicit.push(statement(quoted, quoted, write));
  }
}
explicit.push('WITH /*(*/ "x(" AS (SELECT 1) /*;*/ DELETE FROM audit');
explicit.push("WITH /*'*/ 'x(' AS (SELECT 1) /*)*/ DELETE FROM audit");
explicit.push('WITH /*`*/ `x(` AS (SELECT 1) /*;*/ DELETE FROM audit');
explicit.push('WITH /*[*/ [x(] AS (SELECT 1) /*)*/ DELETE FROM audit');
explicit.push('WITH "x(" AS (SELECT 1 AS "x(") DELETE FROM audit');

const alphabet = ['(', ')', ';', "'", '"', '`', 'x', 'y'];
const next = lcg(SEED);
const fuzz = [];
for (let n = 0; n < FUZZ_N; n++) {
  const len = (next() % 4) + 1;
  let payload = '';
  for (let k = 0; k < len; k++) payload += alphabet[next() % alphabet.length];
  for (const style of STYLES) {
    const quoted = wrap(style, payload);
    for (const write of WRITES) fuzz.push(statement(quoted, quoted, write));
  }
}

function doors(cases) {
  const raw = memorySql();
  const lib = open(raw);
  const count = countOf(raw);
  const chain = chainOf(raw);
  assert.equal(count, 1);
  for (const sql of cases) {
    assert.equal(codeOf(() => lib.exec(sql)), 'SQL_DOOR', 'native ' + sql);
    assert.equal(countOf(raw), count, 'native count ' + sql);
    assert.equal(chainOf(raw), chain, 'native chain ' + sql);
  }
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    const innerCount = countOf(inner);
    const innerChain = chainOf(inner);
    assert.equal(innerCount, 1);
    for (const sql of cases) {
      assert.equal(codeOf(() => door.exec(sql)), 'SQL_DOOR', 'fallback ' + sql);
      assert.equal(countOf(inner), innerCount, 'fallback count ' + sql);
      assert.equal(chainOf(inner), innerChain, 'fallback chain ' + sql);
    }
  });
}

test('quoted CTE names and aliases stay writes on both doors', () => {
  assert.equal(explicit.length, 293);
  assert.ok(explicit.includes('WITH "x(" AS (SELECT 1) DELETE FROM audit'));
  assert.ok(explicit.includes('WITH a AS (SELECT 1 AS "x(") DELETE FROM audit'));
  assert.ok(explicit.includes("WITH '' AS (SELECT 1) DELETE FROM audit"));
  assert.ok(explicit.includes('WITH "" AS (SELECT 1) DELETE FROM audit'));
  assert.ok(explicit.includes('WITH [] AS (SELECT 1) DELETE FROM audit'));
  assert.ok(explicit.includes('WITH `` AS (SELECT 1) DELETE FROM audit'));
  doors(explicit);
});

test('a seeded fuzz of quoted CTE names and aliases stays a write on both doors', () => {
  assert.equal(SEED, 20261119);
  assert.equal(fuzz.length, 384);
  doors(fuzz);
  console.log('fuzz seed ' + SEED + ' explicit ' + explicit.length + ' generated ' + fuzz.length + ' statements ' + (explicit.length + fuzz.length) + ' door-checks ' + ((explicit.length + fuzz.length) * 2));
});
