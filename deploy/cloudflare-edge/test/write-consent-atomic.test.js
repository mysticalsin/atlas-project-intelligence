// The consent delete and its audit line commit together. A 409 rolls the delete back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { ensure } from '../src/privacy.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const OLD = 'abababababababab';
const DELETE_SQL = 'DELETE FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)';

test('a 409 after the consent delete keeps the receipt', () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP, auditKey: SALT });
  ensure(lib);
  lib.log('library', 'atlas', 'note', 'seed');
  lib.recorded(() => lib.exec(
    'INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'r-old', OLD, 'memory', 1, 'n', 'h', '2000-01-01T00:00:00.000Z', 'api',
  ));
  const inner = sqlOf(lib).exec.bind(sqlOf(lib));
  sqlOf(lib).exec = (query, ...params) => {
    const result = inner(query, ...params);
    if (String(query).startsWith('DELETE FROM consent_receipts WHERE subject')) {
      inner("UPDATE audit SET detail = detail || ' tampered' WHERE action != 'chain-start'");
    }
    return result;
  };
  let err;
  try {
    lib.housekeeping('consent-retention', () => {
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)");
      lib.exec(DELETE_SQL, '2000-01-01');
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)");
    });
  } catch (error) { err = error; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts WHERE subject = ?', OLD)[0].n, 1);
  assert.equal(err && err.status, 409);
});
