// Same-timestamp bid corrections must change the win-loop totals.
// Row 1 won and row 2 lost share a rowid-weighted outcome sum with row 1 withdrawn and row 2 won.
// Synthetic bids only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as winloop from '../src/winloop.js';
import * as bids from '../src/bids.js';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';

const REV = { email: 'rev@example.test', role: 'reviewer' };
const AT = '2026-09-29T00:00:00.000Z';
const Q = 'quantified+unconfirmed';

function library() {
  return new Library(memorySql(), { now: () => '2026-09-29T12:00:00.000Z' });
}

function bid(lib, id, outcome) {
  sqlOf(lib).exec(
    'INSERT INTO bids (id, owner, alias, status, outcome, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, 'owner@example.test', 'alias', 'decided', outcome, AT, AT, AT,
  );
  sqlOf(lib).exec(
    'INSERT INTO bid_references (bid_id, ref_id, revision, proof_type, used_at, used_by) VALUES (?, ?, 1, ?, ?, ?)',
    id, 'story-' + id, Q, AT, 'owner@example.test',
  );
}

test('a same-timestamp outcome correction is not served from the old win-loop cache', async () => {
  const lib = library();
  bids.ensure(lib);
  bid(lib, 'b1', 'won');
  bid(lib, 'b2', 'lost');
  const call = async () => (await winloop.routes({ method: 'GET', parts: ['wins'], lib, user: REV })).body;
  const before = await call();
  const beforeType = before.proofTypes.find(row => row.proofType === Q);
  assert.equal(before.totals.decided, 2);
  assert.equal(beforeType.won, 1);
  assert.equal(beforeType.lost, 1);
  sqlOf(lib).exec("UPDATE bids SET outcome = 'withdrawn' WHERE id = 'b1'");
  sqlOf(lib).exec("UPDATE bids SET outcome = 'won' WHERE id = 'b2'");
  const after = await call();
  const afterType = after.proofTypes.find(row => row.proofType === Q);
  assert.equal(after.totals.decided, 1);
  assert.equal(afterType.used, 2);
  assert.equal(afterType.won, 1);
  assert.equal(afterType.lost, 0);
  assert.equal(afterType.decided, 1);
});
