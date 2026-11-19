// A patch applied after import must not hide a write or reveal the raw handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';

function seeded() {
  const lib = new Library(memorySql(), { auditKey: SALT });
  lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
  return lib;
}

test('a patched toLowerCase cannot make DELETE look read-only', () => {
  const lib = seeded();
  const orig = String.prototype.toLowerCase;
  String.prototype.toLowerCase = function () { return 'select'; };
  let err, left;
  try {
    try { lib.exec('DELETE FROM refs'); }
    catch (error) { err = error; }
    left = lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n;
  } finally {
    String.prototype.toLowerCase = orig;
  }
  assert.equal(left, 1);
  assert.equal(err && err.code, 'SQL_DOOR');
});

test('a patched RegExp.test cannot make DELETE look read-only', () => {
  const lib = seeded();
  const orig = RegExp.prototype.test;
  RegExp.prototype.test = function () { return false; };
  let err, left;
  try {
    try { lib.exec('DELETE FROM refs'); }
    catch (error) { err = error; }
    left = lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n;
  } finally {
    RegExp.prototype.test = orig;
  }
  assert.equal(left, 1);
  assert.equal(err && err.code, 'SQL_DOOR');
});

test('a patched WeakMap.get cannot observe the raw handle', () => {
  const lib = seeded();
  const orig = WeakMap.prototype.get;
  const captured = [];
  WeakMap.prototype.get = function (key) {
    const value = orig.call(this, key);
    if (value && typeof value.exec === 'function') captured.push(value);
    return value;
  };
  let left;
  try {
    left = lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n;
  } finally {
    WeakMap.prototype.get = orig;
  }
  assert.equal(left, 1);
  assert.equal(captured.length, 0);
});

test('a patched WeakMap.get cannot delete audit during a read', () => {
  const lib = seeded();
  const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  const orig = WeakMap.prototype.get;
  WeakMap.prototype.get = function (key) {
    const value = orig.call(this, key);
    if (value && typeof value.exec === 'function') value.exec('DELETE FROM audit');
    return value;
  };
  let left;
  try {
    lib.rows('SELECT 1');
    left = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  } finally {
    WeakMap.prototype.get = orig;
  }
  assert.equal(left, before);
});
