// A prototype patched after import must not hide a write or widen a housekeeping allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { ensure } from '../src/privacy.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const SHAPE = 'DELETE FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)';

function seeded() {
  const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
  return lib;
}

function poisonCalls() {
  const saved = {
    call: Function.prototype.call,
    apply: Function.prototype.apply,
    bind: Function.prototype.bind,
    reflect: Reflect.apply,
  };
  Function.prototype.call = function () { return null; };
  Function.prototype.apply = function () { return null; };
  Function.prototype.bind = function () { return null; };
  Reflect.apply = function () { return null; };
  return () => {
    Function.prototype.call = saved.call;
    Function.prototype.apply = saved.apply;
    Function.prototype.bind = saved.bind;
    Reflect.apply = saved.reflect;
  };
}

test('poisoned call, apply, bind, and Reflect.apply still refuse a door-shut delete', () => {
  const lib = seeded();
  const restore = poisonCalls();
  let err;
  let left;
  try {
    try { lib.exec('DELETE FROM refs'); }
    catch (error) { err = error; }
  } finally {
    restore();
  }
  left = lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n;
  assert.equal(left, 1);
  assert.equal(err && err.code, 'SQL_DOOR');
});

test('a recorded insert still lands while call, apply, bind, and Reflect.apply are poisoned', () => {
  const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
  const restore = poisonCalls();
  let err;
  let left;
  try {
    try {
      lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r2', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
    } catch (error) { err = error; }
  } finally {
    restore();
  }
  left = lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n;
  assert.equal(err, undefined);
  assert.equal(left, 1);
});

test('a patched trim cannot make DELETE FROM audit match the consent allowlist', () => {
  const lib = seeded();
  ensure(lib);
  const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  const orig = String.prototype.trim;
  String.prototype.trim = function () {
    const s = orig.call(this);
    if (s.replace(/\s+/g, ' ').startsWith('DELETE FROM audit')) return SHAPE;
    return s;
  };
  let err;
  try {
    try {
      lib.housekeeping('consent-retention', () => {
        lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)");
        lib.exec('DELETE FROM audit');
        lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)");
      });
    } catch (error) { err = error; }
  } finally {
    String.prototype.trim = orig;
  }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before);
  assert.equal(err && err.code, 'HOUSEKEEPING_SQL');
});

test('a patched Array.some cannot allow a delete the housekeeping reason does not list', () => {
  const lib = seeded();
  lib.schema(() => lib.exec('CREATE TABLE teams_seen (activity_id TEXT PRIMARY KEY, at TEXT)'));
  const orig = Array.prototype.some;
  Array.prototype.some = function () { return true; };
  let err;
  try {
    try { lib.housekeeping('teams-seen', () => lib.exec('DELETE FROM refs')); }
    catch (error) { err = error; }
  } finally {
    Array.prototype.some = orig;
  }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
  assert.equal(err && err.code, 'HOUSEKEEPING_SQL');
});
