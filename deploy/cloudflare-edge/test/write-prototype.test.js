// MIGRATIONS and HOUSEKEEPING must not inherit Object.prototype.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

function open() {
  return new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
}
function auditTable(lib) {
  return lib.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit'").length;
}

test('a prototype property is not a registered migration', () => {
  const lib = open();
  const key = 'not-a-migration';
  Object.prototype[key] = 'DROP TABLE audit';
  try {
    let err;
    try { Library.migrate(lib, key); }
    catch (error) { err = error; }
    assert.equal(err && err.code, 'SCHEMA_DML');
    assert.equal(auditTable(lib), 1);
  } finally {
    delete Object.prototype[key];
  }
});

test('a prototype property cannot install a trigger', () => {
  const lib = open();
  const key = 'not-a-trigger';
  Object.prototype[key] = 'CREATE TRIGGER pwn_audit BEFORE DELETE ON refs BEGIN SELECT 1; END';
  try {
    let err;
    try { Library.migrate(lib, key); }
    catch (error) { err = error; }
    assert.equal(err && err.code, 'SCHEMA_DML');
    assert.equal(lib.rows("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'pwn_audit'").length, 0);
  } finally {
    delete Object.prototype[key];
  }
});

test('a prototype property is not a housekeeping reason', () => {
  const lib = open();
  const key = 'not-a-reason';
  Object.prototype[key] = ['DROP TABLE audit'];
  try {
    let err;
    try { lib.housekeeping(key, () => lib.exec('DROP TABLE audit')); }
    catch (error) { err = error; }
    assert.equal(err && err.code, 'HOUSEKEEPING_SQL');
    assert.equal(auditTable(lib), 1);
  } finally {
    delete Object.prototype[key];
  }
});
