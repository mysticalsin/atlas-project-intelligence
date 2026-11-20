// ATLAS-SQLTAIL-EMPTY-ERRSTATE. State machine S4.
// Plan: sqliteRemainder reads sourceSQL outside the prepare try. Empty input,
// whitespace, ';', a block comment, and a line comment prepare no statement.
// node:sqlite then throws ERR_INVALID_STATE ('statement has been finalized').
// The door must answer SQL_EMPTY and must not change a row. A comment in front
// of a real verb stays that verb. The transition table is the lifecycle.
//
// TEST COMMAND:
// cd deploy/cloudflare-edge && node --test test/write-sqltail-lifecycle.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { sqliteRemainder } from '../src/sql-tail.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-20T22:00:00.000Z';
const MESSAGE = 'This input prepares no statement.';
const PHASES = ['idle', 'prepared', 'executed', 'remainder', 'finalized'];
const EVENTS = ['prepare_live', 'prepare_empty', 'prepare_failed', 'execute', 'read_remainder', 'finalize'];
const NEXT = {
  'idle:prepare_live': 'prepared',
  'idle:prepare_empty': 'finalized',
  'idle:prepare_failed': 'idle',
  'prepared:read_remainder': 'remainder',
  'prepared:execute': 'executed',
  'prepared:finalize': 'finalized',
  'executed:read_remainder': 'remainder',
  'executed:finalize': 'finalized',
  'remainder:execute': 'executed',
  'remainder:finalize': 'finalized',
};

function open() {
  return new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
}

function seeded() {
  const lib = open();
  lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
  return lib;
}

function counts(lib) {
  return {
    refs: lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n,
    audit: lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n,
    id: lib.rows("SELECT id FROM refs WHERE id = 'r1'")[0]?.id || null,
  };
}

function expectEmpty(lib, sql) {
  const before = counts(lib);
  let err;
  try { lib.exec(sql); }
  catch (error) { err = error; }
  const after = counts(lib);
  assert.equal(after.refs, before.refs, JSON.stringify(sql));
  assert.equal(after.audit, before.audit, JSON.stringify(sql));
  assert.equal(after.id, 'r1', JSON.stringify(sql));
  assert.ok(err, JSON.stringify(sql));
  assert.equal(err.code, 'SQL_EMPTY', JSON.stringify(sql) + ' ' + err.code + ' ' + err.message);
  assert.equal(err.status, 500, JSON.stringify(sql));
  assert.equal(err.message, MESSAGE, JSON.stringify(sql));
  assert.equal(err.code === 'ERR_INVALID_STATE', false, JSON.stringify(sql));
  assert.equal(String(err.message).includes('finalized'), false, JSON.stringify(sql));
}

function stateFor(phase) {
  if (phase === 'prepared') return { phase, source: null, tail: null };
  if (phase === 'executed') return { phase, source: 'SELECT 1;', tail: null };
  if (phase === 'remainder') return { phase, source: 'SELECT 1;', tail: ' DROP' };
  if (phase === 'finalized') return { phase, source: null, tail: null };
  return { phase: 'idle', source: null, tail: null };
}

function eventFor(type) {
  if (type === 'read_remainder') return { type, input: 'SELECT 1; DROP', source: 'SELECT 1;' };
  return { type };
}

test('empty input is SQL_EMPTY and changes no row', () => {
  const lib = seeded();
  expectEmpty(lib, '');
});

test('whitespace-only input is SQL_EMPTY and changes no row', () => {
  const lib = seeded();
  for (const sql of [' ', '   ', '\t', '\n', '\r', '\f', '\n\t ', ' \r\n\t\f']) expectEmpty(lib, sql);
});

test("';' is SQL_EMPTY and changes no row", () => {
  const lib = seeded();
  for (const sql of [';', ';;', '; ;', '  ;  ', '\n;\n']) expectEmpty(lib, sql);
});

test('a block comment is SQL_EMPTY and changes no row', () => {
  const lib = seeded();
  for (const sql of ['/* */', '/**/', '/* delete */', '/* DROP TABLE refs */', '/* delete */;', '/* a */ /* b */', '/* a */; /* b */']) {
    expectEmpty(lib, sql);
  }
});

test('a line comment is SQL_EMPTY and changes no row', () => {
  const lib = seeded();
  for (const sql of ['--', '-- drop', '-- drop\n', '-- a\n-- b', '-- drop\n  ']) expectEmpty(lib, sql);
});

test('a comment before a real verb stays that verb', async () => {
  const lib = seeded();
  const before = counts(lib);
  lib.recorded(() => lib.exec('/* note */ DELETE FROM refs'));
  const after = counts(lib);
  assert.equal(after.refs, before.refs - 1);
  assert.equal(after.id, null);
  const mod = await import('../src/sql-tail.js');
  assert.equal(typeof mod.readStatementTail, 'function');
  const read = mod.readStatementTail('/* note */ DELETE FROM refs');
  assert.equal(read.effect, 'tail');
  assert.equal(read.code, null);
  assert.equal(read.tail, '');
  assert.equal(read.phase, 'finalized');
  assert.deepEqual(read.phases, ['idle', 'prepared', 'remainder', 'finalized']);
  const selected = open();
  const rows = selected.exec('/* c */ SELECT 1 AS n').toArray();
  assert.equal(rows.length, 1);
  const line = seeded();
  line.recorded(() => line.exec('-- note\nDELETE FROM refs'));
  assert.equal(counts(line).refs, 0);
  const literal = open();
  const quoted = literal.exec("SELECT '/* delete */' AS n").toArray();
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].n, '/* delete */');
});

test('transition table rejects every pair that is not legal', async () => {
  const mod = await import('../src/sql-tail.js');
  assert.equal(typeof mod.statementTransition, 'function');
  assert.deepEqual([...mod.STATEMENT_PHASES], PHASES);
  assert.deepEqual([...mod.STATEMENT_EVENTS], EVENTS);
  const product = [];
  let legal = 0;
  let illegal = 0;
  for (const phase of PHASES) {
    for (const type of EVENTS) {
      const key = phase + ':' + type;
      product.push(key);
      const before = stateFor(phase);
      const snapshot = JSON.stringify(before);
      const result = mod.statementTransition(before, eventFor(type));
      assert.equal(JSON.stringify(before), snapshot, key);
      if (Object.hasOwn(NEXT, key)) {
        legal += 1;
        assert.equal(result.ok, true, key);
        assert.equal(result.illegal, false, key);
        assert.equal(result.denied, false, key);
        assert.equal(result.state.phase, NEXT[key], key);
        assert.equal(result.rejection, undefined, key);
        if (key === 'idle:prepare_empty') assert.equal(result.effect, 'sql_empty');
        if (key === 'prepared:read_remainder' || key === 'executed:read_remainder') {
          assert.equal(result.state.source, 'SELECT 1;');
          assert.equal(result.state.tail, ' DROP');
        }
        if (key === 'remainder:execute' || key === 'remainder:finalize') {
          assert.equal(result.state.source, 'SELECT 1;');
          assert.equal(result.state.tail, ' DROP');
        }
      } else {
        illegal += 1;
        assert.equal(result.ok, false, key);
        assert.equal(result.illegal, true, key);
        assert.equal(result.denied, false, key);
        assert.equal(result.effect, 'sql_empty', key);
        assert.equal(result.state.phase, phase, key);
        assert.equal(result.rejection.atlas_metric, 'sql_tail', key);
        assert.equal(result.rejection.illegal, true, key);
        assert.equal(result.rejection.phase, phase, key);
        assert.equal(result.rejection.event, type, key);
        assert.deepEqual(Object.keys(result.rejection).sort(), ['atlas_metric', 'event', 'illegal', 'phase']);
      }
    }
  }
  assert.equal(product.length, 30);
  assert.equal(legal, 10);
  assert.equal(illegal, 20);
  const unknown = mod.statementTransition({ phase: 'legacy', source: 'x', tail: 'y' }, { type: 'read_remainder' });
  assert.equal(unknown.illegal, true);
  assert.equal(unknown.state.phase, 'idle');
  assert.equal(unknown.state.source, null);
  assert.equal(unknown.state.tail, null);
  const finalized = { phase: 'finalized', source: null, tail: null };
  const read = mod.statementTransition(finalized, { type: 'read_remainder', input: '/* delete */', source: '' });
  const error = mod.statementError(read);
  assert.equal(error.code, 'SQL_EMPTY');
  assert.equal(error.status, 500);
  assert.equal(error.message, MESSAGE);
  assert.equal(error.code === 'ERR_INVALID_STATE', false);
  const warns = [];
  const original = console.warn;
  console.warn = (line) => warns.push(String(line));
  try { mod.noteStatement(read); }
  finally { console.warn = original; }
  assert.equal(warns.length, 1);
  const logged = JSON.parse(warns[0]);
  assert.equal(logged.phase, 'finalized');
  assert.equal(logged.event, 'read_remainder');
  assert.equal(logged.atlas_metric, 'sql_tail');
  assert.equal(Object.hasOwn(logged, 'sql'), false);
});

test('sourceIsPrefix allows a prefix and denies a different source', async () => {
  const mod = await import('../src/sql-tail.js');
  assert.equal(typeof mod.sourceIsPrefix, 'function');
  assert.equal(mod.sourceIsPrefix('SELECT 1; DELETE FROM refs', 'SELECT 1;'), true);
  assert.equal(mod.sourceIsPrefix('SELECT 1', 'DELETE'), false);
  assert.equal(mod.sourceIsPrefix('', ''), true);
  assert.equal(mod.sourceIsPrefix('SELECT 1', 1), false);
  assert.equal(mod.sourceIsPrefix(null, 'SELECT 1'), false);
  const prepared = { phase: 'prepared', source: null, tail: null };
  const allowed = mod.statementTransition(prepared, { type: 'read_remainder', input: 'SELECT 1; DELETE FROM refs', source: 'SELECT 1;' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.denied, false);
  assert.equal(allowed.state.phase, 'remainder');
  assert.equal(allowed.state.tail, ' DELETE FROM refs');
  const denied = mod.statementTransition(prepared, { type: 'read_remainder', input: 'SELECT 1', source: 'DELETE' });
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);
  assert.equal(denied.illegal, false);
  assert.equal(denied.guard, 'sourceIsPrefix');
  assert.equal(denied.effect, null);
  assert.equal(denied.state.phase, 'prepared');
});

test('a real statement still reports the unconsumed tail and does not run it', () => {
  assert.equal(sqliteRemainder('SELECT 1; DELETE FROM refs'), ' DELETE FROM refs');
  assert.equal(sqliteRemainder('NOT SQL AT ALL ???'), null);
  assert.equal(sqliteRemainder('DROP TABLE refs'), '');
  assert.equal(sqliteRemainder('SELECT COUNT(*) AS n FROM refs'), '');
});

test('comment and whitespace boundaries prepare no statement', () => {
  const lib = seeded();
  const bounds = [
    '/* a */ -- b',
    '-- a\n/* b */',
    '   ;  \n  /* delete */  ',
    '/* a */;',
    '--\n;',
    ';\n-- drop',
    '/* /* */',
    '-- drop\r\n',
  ];
  for (const sql of bounds) expectEmpty(lib, sql);
  const kept = open();
  const rows = kept.exec('SELECT 1 -- drop').toArray();
  assert.equal(rows.length, 1);
  const tail = sqliteRemainder('SELECT 1; -- tail');
  assert.equal(tail, ' -- tail');
});

function rngOf(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

function pick(rng, list) {
  return list[rng() % list.length];
}

function commentBody(rng, n) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz 0123456789';
  const words = ['delete', 'drop', 'insert', 'update', 'alter'];
  let out = '';
  for (let i = 0; i < n; i++) {
    if (rng() % 5 === 0) out += pick(rng, words);
    else out += alphabet[rng() % alphabet.length];
  }
  return out;
}

function randomNoise(rng) {
  const kind = rng() % 5;
  const space = [' ', '\n', '\t', '\r', '\f'];
  if (kind === 0) {
    const n = rng() % 12;
    let out = '';
    for (let i = 0; i < n; i++) out += pick(rng, space);
    return out;
  }
  if (kind === 1) {
    let out = '';
    const n = 1 + (rng() % 4);
    for (let i = 0; i < n; i++) out += ';';
    if (rng() % 2 === 0) out = pick(rng, space) + out + pick(rng, space);
    return out;
  }
  if (kind === 2) return '/* ' + commentBody(rng, rng() % 24) + ' */';
  if (kind === 3) return '-- ' + commentBody(rng, rng() % 24) + (rng() % 2 === 0 ? '\n' : '');
  const parts = 1 + (rng() % 4);
  let out = '';
  for (let i = 0; i < parts; i++) {
    const sub = rng() % 4;
    if (sub === 0) out += pick(rng, space);
    else if (sub === 1) out += ';';
    else if (sub === 2) out += '/* ' + commentBody(rng, rng() % 16) + ' */';
    else out += '-- ' + commentBody(rng, rng() % 12) + '\n';
  }
  return out;
}

test('random comment and whitespace input is SQL_EMPTY and changes no row', () => {
  const lib = seeded();
  const rng = rngOf(20261120);
  const seen = new Set();
  for (let i = 0; i < 80; i++) {
    let sql = randomNoise(rng);
    if (seen.has(sql)) sql += ' ';
    seen.add(sql);
    expectEmpty(lib, sql);
  }
  assert.equal(seen.size, 80);
});
