// A caller-supplied cutoff must not decide which consent receipts a housekeeping delete removes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { ensure } from '../src/privacy.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const SUBJECT = 'cdcdcdcdcdcdcdcd';
const OLD = 'abababababababab';
const DELETE_SQL = 'DELETE FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)';

test('a cutoff of 9999 does not delete a current consent receipt and writes one audit line', () => {
  const lib = new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
  ensure(lib);
  lib.recorded(() => {
    lib.exec('INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'r-now', SUBJECT, 'memory', 1, 'n', 'h', STAMP, 'api');
    lib.exec('INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'r-old', OLD, 'memory', 1, 'n', 'h', '2000-01-01T00:00:00.000Z', 'api');
  });
  const count = subject => lib.rows('SELECT COUNT(*) AS n FROM consent_receipts WHERE subject = ?', subject)[0].n;
  const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  let err;
  try {
    lib.housekeeping('consent-retention', () => {
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)");
      lib.exec(DELETE_SQL, '9999-01-01');
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)");
    });
  } catch (error) { err = error; }
  assert.equal(count(SUBJECT), 1);
  assert.equal(count(OLD), 0);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before + 1);
  const line = lib.rows("SELECT action, detail, actor FROM audit WHERE action = 'consent retention'");
  assert.equal(line.length, 1);
  assert.equal(line[0].detail, '1');
  assert.equal(line[0].actor, 'atlas');
  assert.equal(String(line[0].detail).includes('9999'), false);
  assert.equal(String(line[0].detail).includes(SUBJECT), false);
  assert.equal(err, undefined);
});
