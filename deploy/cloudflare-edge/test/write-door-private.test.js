// _enter and registered are public, and the door map can be replaced from WeakMap.prototype.get.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { anchoredVerdict, verifyChain } from '../src/audit-chain.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

function open() {
  return new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
}
function seed(lib) {
  lib.recorded(() => {
    lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')");
    lib.log('r1', 'ada@example.test', 'saved', 'seed');
  });
}
function withLiedDoors(run) {
  const original = WeakMap.prototype.get;
  WeakMap.prototype.get = function(key) {
    const value = original.call(this, key);
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, 'receiptOnly')) return value;
    return new Proxy(value, {
      get(target, prop, receiver) {
        if (prop === 'open') return 1;
        if (prop === 'kind') return 'recorded';
        if (prop === 'receiptOnly') return true;
        if (prop === 'appended') return false;
        if (prop === 'auditTx') return 1;
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  try { return run(); }
  finally { WeakMap.prototype.get = original; }
}

test('lib._enter cannot delete rows', () => {
  const lib = open();
  seed(lib);
  let err;
  try { lib._enter(() => lib.exec('DELETE FROM refs'), 'recorded'); }
  catch (error) { err = error; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM audit WHERE action = 'schema migration' OR detail = 'DELETE FROM refs'").length, 0);
  assert.equal(typeof lib._enter, 'undefined');
  assert.equal(err instanceof Error, true);
});

test('lib.registered cannot drop a live table', () => {
  const lib = open();
  let err;
  try { lib.registered('drop-manager-trust'); }
  catch (error) { err = error; }
  assert.equal(lib.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_trust'").length, 1);
  assert.equal(typeof lib.registered, 'undefined');
  assert.equal(err instanceof Error, true);
});

test('a patched WeakMap get cannot commit an update on a tampered chain', () => {
  const lib = open();
  seed(lib);
  sqlOf(lib).exec("UPDATE audit SET detail = detail || ' tampered' WHERE action != 'chain-start'");
  let err;
  try {
    withLiedDoors(() => lib.recorded(() => {
      lib.exec('UPDATE refs SET title = ? WHERE id = ?', 'stolen', 'r1');
    }));
  } catch (error) { err = error; }
  assert.equal(err && err.code, 'CHAIN_DAMAGED');
  assert.equal(lib.rows('SELECT title FROM refs WHERE id = ?', 'r1')[0].title, 'kept');
});

test('a patched WeakMap get cannot insert with no door open', () => {
  const lib = open();
  lib.schema(() => lib.exec('CREATE TABLE teams_seen (activity_id TEXT PRIMARY KEY, at TEXT)'));
  let err;
  try {
    withLiedDoors(() => lib.exec("INSERT INTO teams_seen (activity_id, at) VALUES ('sneak', '2026-11-17T05:00:00.000Z')"));
  } catch (error) { err = error; }
  assert.equal(err && err.code, 'SQL_DOOR');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM teams_seen')[0].n, 0);
});

test('a patched WeakMap get cannot leave a log line off the anchor', () => {
  const lib = open();
  withLiedDoors(() => lib.schema(() => lib.log('library', 'ada@example.test', 'sneak', 'off anchor')));
  sqlOf(lib).exec("DELETE FROM audit WHERE action = 'sneak'");
  const after = anchoredVerdict(sqlOf(lib), verifyChain(sqlOf(lib), SALT, lib.dbId));
  assert.equal(after.ok, false);
});

test('a registered migration writes one metadata audit line and moves the anchor', () => {
  const sql = memorySql();
  sql.exec('CREATE TABLE manager_trust (owner TEXT NOT NULL, email TEXT NOT NULL, source TEXT, at TEXT, PRIMARY KEY (owner, email))');
  sql.exec("INSERT INTO manager_trust (owner, email, source, at) VALUES ('ada@example.test', 'sam@example.test', 'manual', '2026-11-17T05:00:00.000Z')");
  const lib = new Library(sql, { now: () => STAMP, auditKey: SALT });
  const lines = lib.rows('SELECT action, detail FROM audit');
  assert.equal(lines.some(row => row.action === 'schema migration' && row.detail === 'drop-manager-trust'), true);
  assert.equal(lines.some(row => row.action === 'schema migration' && row.detail === 'rename-manager-trust'), true);
  assert.equal(lines.some(row => String(row.detail).includes('SELECT ') || String(row.detail).includes('DROP TABLE')), false);
  const anchor = sql.exec('SELECT n FROM audit_anchor').toArray()[0];
  assert.equal(anchor.n >= lines.filter(row => row.action !== 'chain-start').length, true);
});
