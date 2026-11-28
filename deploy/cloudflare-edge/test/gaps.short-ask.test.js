// A short gap ask is the requirement text. The half-label cleanup belongs only to a cut
// that landed inside an unclosed bracket. A complete placeholder and a short unclosed
// note stay. A cut that ends on that fragment still drops the fragment.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as gaps from '../src/gaps.js';
import * as bids from '../src/bids.js';
import * as features from '../src/features.js';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'owner@example.test', mail: 'owner@example.test', role: 'user' };
const ASSIGNEE = { email: 'assignee@example.test', mail: 'assignee@example.test', role: 'user' };
const ON = (word, env) => features.readyGate(word, env, () => true);
const PROOF = 'Proof the bid needs: ';

async function call(lib, method, path, user, body) {
  const url = new URL('https://atlas.test/api/library/' + path);
  const parts = url.pathname.replace(/^\/api\/library\/?/, '').split('/').filter(Boolean);
  const ctx = { request: new Request(url, { method }), url, method, parts, body, user, lib, env: {}, waitUntil: p => p };
  try {
    const r = await features.featureRoutes(ctx, ON);
    return { status: r.status || 200, body: r.body };
  } catch (e) {
    if (!e.status) throw e;
    return { status: e.status, body: { error: e.message } };
  }
}

function seed(lib, requirement) {
  const clock = '2026-09-01T00:00:00.000Z';
  sqlOf(lib).exec(`INSERT INTO bids (id, owner, owner_mail, title, alias, prospects, brief, pseudo, requirements, customer, req_method, status, outcome, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'b1', OWNER.email, OWNER.email, 'Synthetic bid', 'A bid', '[]', 'Brief', '{}',
  JSON.stringify([{ id: 'R1', text: requirement, kind: 'capability', must: true }]),
  '{}', 'manual', 'open', 'pending', clock, clock);
}

async function asksFor(requirement) {
  const lib = new Library(memorySql(), { now: () => '2026-09-01T00:00:00.000Z' });
  bids.ensure(lib);
  gaps.ensure(lib);
  seed(lib, requirement);
  const created = await call(lib, 'POST', 'gaps', OWNER, { bidId: 'b1', requirementIds: ['R1'], assignee: { email: ASSIGNEE.email } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const author = await call(lib, 'GET', 'gaps/' + id, OWNER);
  const other = await call(lib, 'GET', 'gaps/' + id + '/interview', ASSIGNEE);
  assert.equal(author.status, 200);
  assert.equal(other.status, 200);
  return { author: author.body.asks[0].ask, other: other.body.asks[0].ask };
}

test('a short ask keeps an unclosed bracket and a finished placeholder', async () => {
  const note = await asksFor('See annex [Draft');
  assert.equal(note.author, PROOF + 'See annex [Draft');
  assert.equal(note.other, PROOF + 'See annex [Draft');
  const whole = await asksFor('See annex [Annex 1]');
  assert.equal(whole.author, PROOF + 'See annex [Annex 1]');
  assert.equal(whole.other, PROOF + 'See annex [Annex 1]');
});

test('a cut that ends inside an unclosed bracket still drops that fragment', async () => {
  const marker = ' [Ab';
  const pad = 'w'.repeat(160 - PROOF.length - marker.length);
  const tail = 'cdefghij';
  const shown = await asksFor(pad + marker + tail);
  const kept = PROOF + pad;
  assert.equal(shown.author, kept);
  assert.equal(shown.other, kept);
  assert.equal([...shown.author].length <= 160, true);
  assert.equal(shown.author.includes(tail), false);
});
