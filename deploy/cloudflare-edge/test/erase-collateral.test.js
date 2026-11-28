// Erase refuses rate_hits collateral it would otherwise skip.
// Synthetic addresses only. eraseRateHits is not added here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import { ensureJourney } from '../src/journey.js';
import { eraseMine } from '../src/subject-rights.js';
import * as privacy from '../src/privacy.js';
import * as util from '../src/util.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADA = 'ada@example.test';
const ADA_MAIL = 'ada.other@example.test';
const BOB = 'bob@example.test';
const SUBJ = 'ab'.repeat(16);
const REFUSED = 'Erasure refused. Rate-limit rows for this subject would remain, so nothing was erased.';

function library() {
  return new Library(memorySql(), { now: () => '2026-11-18T00:00:00.000Z' });
}

function user(email = ADA, mail = email) {
  return { email, mail, role: 'user', tenant: TENANT, tenantEnforced: true };
}

function seedJourney(lib, subject) {
  ensureJourney(lib);
  sqlOf(lib).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', subject, TENANT, '{}', '2026-11-18T00:00:00.000Z');
}

function journeys(lib) {
  return sqlOf(lib).exec('SELECT subject FROM journey ORDER BY subject').toArray().map(row => row.subject);
}

function rateHits(lib) {
  const names = sqlOf(lib).exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_hits'").toArray();
  if (!names.length) return [];
  return sqlOf(lib).exec('SELECT bucket FROM rate_hits ORDER BY bucket').toArray().map(row => row.bucket);
}

function addHits(lib, buckets) {
  const sql = sqlOf(lib);
  sql.exec('CREATE TABLE IF NOT EXISTS rate_hits (bucket TEXT NOT NULL, at_ms INTEGER NOT NULL)');
  for (const bucket of buckets) sql.exec('INSERT INTO rate_hits (bucket, at_ms) VALUES (?, ?)', bucket, 1);
}

function flag(lib) {
  privacy.ensure(lib);
  sqlOf(lib).exec('INSERT OR REPLACE INTO privacy_flags (subject, restricted, object_scoring, object_matching, object_memory, updated_at) VALUES (?, 1, 0, 0, 0, ?)', ADA, '2026-11-18T00:00:00.000Z');
}

function restricted(lib) {
  return sqlOf(lib).exec('SELECT restricted FROM privacy_flags WHERE subject = ?', ADA).toArray()[0]?.restricted;
}

function logs(lib) {
  return sqlOf(lib).exec('SELECT COUNT(*) AS n FROM erasure_log').toArray()[0].n;
}

function refuse(lib, who) {
  assert.throws(() => eraseMine(lib, who, SUBJ), err => err.status === 409 && err.message === REFUSED);
}

test('a subject rate-limit key is not skipped and nothing is erased', () => {
  const lib = library();
  seedJourney(lib, ADA);
  seedJourney(lib, BOB);
  flag(lib);
  addHits(lib, ['ask:' + ADA, 'bid-create:' + TENANT + ':' + ADA]);
  const helper = typeof util.eraseRateHits === 'function';
  if (!helper) {
    refuse(lib, user());
    assert.deepEqual(journeys(lib), [ADA, BOB]);
    assert.deepEqual(rateHits(lib), ['ask:' + ADA, 'bid-create:' + TENANT + ':' + ADA]);
    assert.equal(restricted(lib), 1);
    assert.equal(logs(lib), 0);
    return;
  }
  const out = eraseMine(lib, user(), SUBJ);
  assert.equal(out.erased, true);
  assert.equal(out.counts.rateHits, 2);
  assert.deepEqual(journeys(lib), [BOB]);
  assert.deepEqual(rateHits(lib), []);
  assert.equal(restricted(lib), 1);
});

test('a mail alias and a mid-key address refuse and leave the exact key in place', () => {
  const lib = library();
  seedJourney(lib, ADA);
  flag(lib);
  addHits(lib, ['ask:' + ADA, 'ask:' + ADA_MAIL, 'people:' + ADA + ':tail']);
  refuse(lib, user(ADA, ADA_MAIL));
  assert.deepEqual(journeys(lib), [ADA]);
  assert.deepEqual(rateHits(lib), ['ask:' + ADA_MAIL, 'ask:' + ADA, 'people:' + ADA + ':tail']);
  assert.equal(restricted(lib), 1);
  assert.equal(logs(lib), 0);
});

test('a longer address and another person do not refuse, and their rows stay', () => {
  const lib = library();
  seedJourney(lib, ADA);
  seedJourney(lib, BOB);
  flag(lib);
  addHits(lib, ['ask:' + ADA + '.au', 'ask:' + BOB]);
  const out = eraseMine(lib, user(), SUBJ);
  assert.equal(out.erased, true);
  assert.equal(out.counts.rateHits, undefined);
  assert.deepEqual(journeys(lib), [BOB]);
  assert.deepEqual(rateHits(lib), ['ask:' + ADA + '.au', 'ask:' + BOB]);
  assert.equal(restricted(lib), 1);
  assert.equal(logs(lib), 1);
});

test('no rate_hits table still erases the subject journey and leaves the restriction', () => {
  const lib = library();
  seedJourney(lib, ADA);
  flag(lib);
  const out = eraseMine(lib, user(), SUBJ);
  assert.equal(out.erased, true);
  assert.deepEqual(journeys(lib), []);
  assert.deepEqual(rateHits(lib), []);
  assert.equal(restricted(lib), 1);
});
