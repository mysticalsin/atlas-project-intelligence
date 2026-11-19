// A failed close of privacy_gate must not leave deletes of receipts allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { ensure, retentionGate } from '../src/privacy.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const SUBJECT = 'cdcdcdcdcdcdcdcd';

test('a failed gate close does not leave a receipt deletable', () => {
  const lib = new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
  ensure(lib);
  lib.recorded(() => lib.exec(
    'INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'r-now', SUBJECT, 'memory', 1, 'n', 'h', STAMP, 'api',
  ));
  const sql = sqlOf(lib);
  const inner = sql.exec.bind(sql);
  sql.exec = (query, ...params) => {
    if (String(query).includes("VALUES ('receipts', 0)")) throw new Error('close failed');
    return inner(query, ...params);
  };
  let err;
  try { retentionGate(lib, () => {}); }
  catch (error) { err = error; }
  let deleted = 'refused';
  try { lib.recorded(() => lib.exec('DELETE FROM consent_receipts')); deleted = 'ran'; }
  catch { deleted = 'refused'; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts WHERE subject = ?', SUBJECT)[0].n, 1);
  assert.equal(deleted, 'refused');
  assert.equal(err && err.message, 'close failed');
});
