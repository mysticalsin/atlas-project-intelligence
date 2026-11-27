// A patched Date.prototype.toISOString must not move the consent cutoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { ensure } from '../src/privacy.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const SUBJECT = 'cdcdcdcdcdcdcdcd';
const DELETE_SQL = 'DELETE FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)';

test('a patched toISOString does not sweep a receipt stamped at the clock', () => {
  const lib = new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
  ensure(lib);
  lib.recorded(() => {
    lib.exec('INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'r-now', SUBJECT, 'memory', 1, 'n', 'h', STAMP, 'api');
  });
  const orig = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { return '9999-01-01T00:00:00.000Z'; };
  let err;
  try {
    lib.housekeeping('consent-retention', () => {
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)");
      lib.exec(DELETE_SQL);
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)");
    });
  } catch (error) { err = error; }
  finally { Date.prototype.toISOString = orig; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts WHERE subject = ?', SUBJECT)[0].n, 1);
  assert.equal(err, undefined);
});
