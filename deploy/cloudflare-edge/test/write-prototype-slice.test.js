// A patched slice or push must not classify a delete as a read.
// statementTail stays the real tail: the poison is only on the classifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const INSERT = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')";

function libraryWithTail() {
  const orig = String.prototype.slice;
  const driver = memorySql();
  const realTail = driver.statementTail.bind(driver);
  driver.statementTail = (q) => {
    const live = String.prototype.slice;
    String.prototype.slice = orig;
    try { return realTail(q); }
    finally { String.prototype.slice = live; }
  };
  const lib = new Library(driver, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec(INSERT));
  return lib;
}

function fallbackLibrary() {
  const db = new DatabaseSync(':memory:');
  const exec = (q, ...params) => {
    let rest = String(q ?? '');
    let rows = [];
    let offset = 0;
    while (rest.trim()) {
      rest = rest.replace(/^(\s*;)+/, '');
      if (!rest.trim()) break;
      const stmt = db.prepare(rest);
      const src = stmt.sourceSQL;
      const marks = (src.match(/\?/g) || []).length;
      const slice = params.slice(offset, offset + marks);
      offset += marks;
      rows = stmt.all(...slice);
      rest = rest.slice(src.length);
    }
    return { toArray: () => rows.map((row) => ({ ...row })) };
  };
  const transactionSync = (fn) => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already closed */ }
      throw error;
    }
  };
  const lib = new Library({ exec, transactionSync }, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec(INSERT));
  return lib;
}

function left(lib) {
  return lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n;
}

function reseed(lib) {
  if (left(lib) === 0) lib.recorded(() => lib.exec(INSERT));
}

test('a patched slice still refuses a delete when the tail parser is real', () => {
  const lib = libraryWithTail();
  const orig = String.prototype.slice;
  for (const value of [false, true, 0, -1]) {
    String.prototype.slice = function () { return value; };
    let err;
    try { lib.exec('DELETE FROM refs'); }
    catch (error) { err = error; }
    finally { String.prototype.slice = orig; }
    assert.equal(left(lib), 1, String(value));
    assert.equal(err && (err.code === 'SQL_DOOR' || err.code === 'SQL_MULTI'), true, String(value));
    reseed(lib);
  }
});

test('a patched push still refuses a delete', () => {
  const lib = libraryWithTail();
  const orig = Array.prototype.push;
  Array.prototype.push = function (value) {
    this.length = 0;
    return orig.call(this, value);
  };
  let err;
  try { lib.exec('DELETE FROM refs'); }
  catch (error) { err = error; }
  finally { Array.prototype.push = orig; }
  assert.equal(left(lib), 1);
  assert.equal(err && (err.code === 'SQL_DOOR' || err.code === 'SQL_MULTI'), true);
});

test('a push that drops the second part does not run the fallback delete', () => {
  const origModule = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : origModule(name));
  const orig = Array.prototype.push;
  try {
    const lib = fallbackLibrary();
    Array.prototype.push = function (value) {
      if (this.length >= 1) return this.length;
      return orig.call(this, value);
    };
    let err;
    try { lib.exec('SELECT 1; DELETE FROM refs'); }
    catch (error) { err = error; }
    finally { Array.prototype.push = orig; }
    assert.equal(left(lib), 1);
    assert.equal(err && (err.code === 'SQL_DOOR' || err.code === 'SQL_MULTI'), true);
  } finally {
    process.getBuiltinModule = origModule;
    Array.prototype.push = orig;
  }
});

test('a patched charCodeAt still refuses a delete', () => {
  const lib = libraryWithTail();
  const orig = String.prototype.charCodeAt;
  String.prototype.charCodeAt = function () { return 0; };
  let err;
  try { lib.exec('DELETE FROM refs'); }
  catch (error) { err = error; }
  finally { String.prototype.charCodeAt = orig; }
  assert.equal(left(lib), 1);
  assert.equal(err && (err.code === 'SQL_DOOR' || err.code === 'SQL_MULTI'), true);
});

const SWEEP = [
  ['String', 'toLowerCase', () => 'select'],
  ['String', 'trim', () => ''],
  ['Array', 'some', () => false],
  ['Array', 'includes', () => false],
  ['Array', 'every', () => true],
  ['RegExp', 'exec', () => null],
  ['RegExp', 'test', () => false],
  ['Object', 'hasOwn', () => false],
  ['Object', 'keys', () => []],
  ['Reflect', 'apply', () => undefined],
];

test('poisoning a built-in the classifier can reach still refuses the delete', () => {
  const lib = libraryWithTail();
  for (const [kind, name, fn] of SWEEP) {
    const host = kind === 'String' ? String.prototype : kind === 'Array' ? Array.prototype : kind === 'RegExp' ? RegExp.prototype : kind === 'Object' ? Object : Reflect;
    const orig = host[name];
    host[name] = fn;
    let err;
    try { lib.exec('DELETE FROM refs'); }
    catch (error) { err = error; }
    finally { host[name] = orig; }
    assert.equal(left(lib), 1, kind + '.' + name);
    assert.ok(err, kind + '.' + name);
    reseed(lib);
  }
});
