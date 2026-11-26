// A missing consent_receipts category must not become a zero-day sweep.
// The shipped period is 2190 days. A receipt from the day before stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { ensure } from '../src/privacy.js';
import { RETENTION } from '../src/policy.generated.js';
import { find } from '../src/primordials.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const RECENT = '2026-11-16T05:00:00.000Z';
const SUBJECT = 'cdcdcdcdcdcdcdcd';
const DELETE_SQL = 'DELETE FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)';

function sweep() {
  const lib = new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
  ensure(lib);
  lib.recorded(() => {
    lib.exec('INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'r-recent', SUBJECT, 'memory', 1, 'n', 'h', RECENT, 'api');
  });
  let err;
  try {
    lib.housekeeping('consent-retention', () => {
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)");
      lib.exec(DELETE_SQL);
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)");
    });
  } catch (error) { err = error; }
  return {
    left: lib.rows('SELECT COUNT(*) AS n FROM consent_receipts WHERE subject = ?', SUBJECT)[0].n,
    code: err && err.code,
  };
}

test('a miss is null, and a present category is the row', () => {
  assert.equal(find([{ id: 'drafts', days: 90 }], (item) => item.id === 'consent_receipts'), null);
  assert.equal(find([{ id: 'consent_receipts', days: 2190 }], (item) => item.id === 'consent_receipts').days, 2190);
});

test('a missing consent category does not delete a receipt from the day before', () => {
  const saved = RETENTION.categories;
  try {
    const kept = sweep();
    assert.equal(kept.left, 1);
    assert.equal(kept.code, undefined);
    RETENTION.categories = saved.filter((item) => item.id !== 'consent_receipts');
    const missed = sweep();
    assert.equal(missed.code, 'SQL_DOOR');
    assert.equal(missed.left, 1);
  } finally {
    RETENTION.categories = saved;
  }
});
