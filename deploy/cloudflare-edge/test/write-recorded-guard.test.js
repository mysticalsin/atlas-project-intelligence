// recorded() must not drop audit, drop a consent trigger, or delete those rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { ensure } from '../src/privacy.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

function open() {
  const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
  ensure(lib);
  lib.recorded(() => {
    lib.exec("INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES ('r1', 'abababababababab', 'memory', 1, 'n', 'h', ?, 'api')", STAMP);
    lib.log('library', 'atlas', 'note', 'seed');
  });
  return lib;
}

function refuse(lib, sql) {
  let err;
  try { lib.recorded(() => lib.exec(sql)); }
  catch (error) { err = error; }
  return err;
}

test('recorded refuses DROP TABLE audit and DELETE FROM audit', () => {
  const lib = open();
  const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  const drop = refuse(lib, 'DROP TABLE audit');
  const table = lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit'")[0].n;
  assert.equal(table, 1);
  assert.equal(drop && drop.code, 'SQL_DOOR');
  const del = refuse(lib, 'DELETE FROM audit');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before);
  assert.equal(del && del.code, 'SQL_DOOR');
});

test('recorded refuses a consent trigger drop and a consent delete', () => {
  const lib = open();
  const drop = refuse(lib, 'DROP TRIGGER consent_receipts_no_delete');
  const triggers = lib.rows("SELECT name FROM sqlite_master WHERE type = 'trigger'").map((row) => row.name);
  assert.equal(triggers.includes('consent_receipts_no_delete'), true);
  assert.equal(drop && drop.code, 'SQL_DOOR');
  const del = refuse(lib, 'DELETE FROM consent_receipts');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts')[0].n, 1);
  assert.equal(del && del.code, 'SQL_DOOR');
});

test('recorded refuses UPDATE of audit and audit_anchor and ALTER of audit', () => {
  const lib = open();
  const update = refuse(lib, "UPDATE audit SET detail = 'x'");
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM audit WHERE detail = 'x'")[0].n, 0);
  assert.equal(update && update.code, 'SQL_DOOR');
  const anchor = refuse(lib, 'DELETE FROM audit_anchor');
  const anchorTable = lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'audit_anchor'")[0].n;
  assert.equal(anchorTable, 1);
  assert.equal(anchor && anchor.code, 'SQL_DOOR');
  const alter = refuse(lib, 'ALTER TABLE audit ADD COLUMN extra TEXT');
  const cols = lib.rows("SELECT name FROM pragma_table_info('audit')").map((row) => row.name);
  assert.equal(cols.includes('extra'), false);
  assert.equal(alter && alter.code, 'SQL_DOOR');
});

test('housekeeping can still delete an old consent receipt', () => {
  const lib = open();
  lib.recorded(() => {
    lib.exec("INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES ('old', 'bbbbbbbbbbbbbbbb', 'memory', 1, 'n', 'h', '2000-01-01T00:00:00.000Z', 'api')");
  });
  const sql = 'DELETE FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)';
  let err;
  try {
    lib.housekeeping('consent-retention', () => {
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)");
      lib.exec(sql);
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)");
    });
  } catch (error) { err = error; }
  assert.equal(err, undefined);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts WHERE subject = ?', 'bbbbbbbbbbbbbbbb')[0].n, 0);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts WHERE subject = ?', 'abababababababab')[0].n, 1);
});
