// Sweep 01 group 4 (gaps, M4). Copied from the red tests at 96712474.
// Fails on main. Not skipped and not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as features from '../src/features.js';
import * as bids from '../src/bids.js';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';

const lib = () => new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });

test('M4 a gap answer cannot name a reference the assignee cannot open in full', async () => {
  const store = lib();
  const owner = { email: 'olivia@example.test', mail: 'olivia@example.test', role: 'user' };
  const alex = { email: 'alex@example.test', mail: 'alex@example.test', role: 'user' };
  const kim = { email: 'kim@example.test', mail: 'kim@example.test', role: 'user' };
  const published = await store.upsert(alex, { localId: 'alex-story', reference: { title: 'Claims triage', consultant: { name: 'Alex', role: 'Lead' } } });
  sqlOf(store).exec("UPDATE refs SET status = 'published' WHERE id = ?", published.id);
  const hidden = await store.upsert(kim, { localId: 'kim-story', reference: { title: 'Hidden story', consultant: { name: 'Kim', role: 'Lead' } } });
  bids.ensure(store);
  const clock = '2026-11-21T00:00:00.000Z';
  sqlOf(store).exec(`INSERT INTO bids (id, owner, owner_mail, title, alias, prospects, brief, pseudo, requirements, customer, req_method, status, outcome, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'b1', owner.email, owner.email, 'Synthetic bid', 'Alias', '[]', 'Brief', '{}',
    JSON.stringify([{ id: 'R1', text: 'A proof point', kind: 'capability', must: true }]),
    '{}', 'manual', 'open', 'pending', clock, clock);
  const call = async (method, path, user, body = {}) => {
    const url = new URL('https://atlas.example.test/api/library/' + path);
    const parts = url.pathname.replace(/^\/api\/library\/?/, '').split('/').filter(Boolean);
    const ctx = { request: new Request(url, { method }), url, method, parts, body, user, lib: store, env: {}, waitUntil: p => p };
    try {
      const r = await features.featureRoutes(ctx, (word, env) => features.readyGate(word, env, () => true));
      return { status: r.status || 200, body: r.body };
    } catch (e) {
      if (!e.status) throw e;
      return { status: e.status, body: { error: e.message } };
    }
  };
  const created = await call('POST', 'gaps', owner, { bidId: 'b1', requirementIds: ['R1'], assignee: { refId: published.id, person: 0 } });
  assert.equal(created.status, 201, created.body?.error || 'gap created');
  const before = sqlOf(store).exec('SELECT reference_id, status FROM gap_requests WHERE id = ?', created.body.id).toArray()[0];
  const answered = await call('POST', `gaps/${created.body.id}/answer`, alex, {
    results: [{ askId: 'G1', status: 'answered_unverified', quotes: ['A quote.'] }],
    referenceId: hidden.id,
  });
  const after = sqlOf(store).exec('SELECT reference_id, status FROM gap_requests WHERE id = ?', created.body.id).toArray()[0];
  assert.equal(answered.status, 403);
  assert.equal(after.status, 'open');
  assert.equal(after.reference_id, before.reference_id);
});

test('M4 an assignee can attach their own reference, and omitting one keeps the original', async () => {
  const store = lib();
  const owner = { email: 'olivia@example.test', mail: 'olivia@example.test', role: 'user' };
  const alex = { email: 'alex@example.test', mail: 'alex@example.test', role: 'user' };
  const first = await store.upsert(alex, { localId: 'alex-a', reference: { title: 'Claims triage', consultant: { name: 'Alex', role: 'Lead' } } });
  const second = await store.upsert(alex, { localId: 'alex-b', reference: { title: 'Follow-up triage', consultant: { name: 'Alex', role: 'Lead' } } });
  sqlOf(store).exec("UPDATE refs SET status = 'published' WHERE id IN (?, ?)", first.id, second.id);
  bids.ensure(store);
  const clock = '2026-11-21T00:00:00.000Z';
  sqlOf(store).exec(`INSERT INTO bids (id, owner, owner_mail, title, alias, prospects, brief, pseudo, requirements, customer, req_method, status, outcome, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'b2', owner.email, owner.email, 'Synthetic bid', 'Alias', '[]', 'Brief', '{}',
    JSON.stringify([{ id: 'R1', text: 'A proof point', kind: 'capability', must: true }]),
    '{}', 'manual', 'open', 'pending', clock, clock);
  const call = async (method, path, user, body = {}) => {
    const url = new URL('https://atlas.example.test/api/library/' + path);
    const parts = url.pathname.replace(/^\/api\/library\/?/, '').split('/').filter(Boolean);
    const ctx = { request: new Request(url, { method }), url, method, parts, body, user, lib: store, env: {}, waitUntil: p => p };
    try {
      const r = await features.featureRoutes(ctx, (word, env) => features.readyGate(word, env, () => true));
      return { status: r.status || 200, body: r.body };
    } catch (e) {
      if (!e.status) throw e;
      return { status: e.status, body: { error: e.message } };
    }
  };
  const created = await call('POST', 'gaps', owner, { bidId: 'b2', requirementIds: ['R1'], assignee: { refId: first.id, person: 0 } });
  assert.equal(created.status, 201, created.body?.error || 'gap created');
  const attached = await call('POST', `gaps/${created.body.id}/answer`, alex, {
    results: [{ askId: 'G1', status: 'answered_unverified', quotes: ['A quote.'] }],
    referenceId: second.id,
  });
  const row = sqlOf(store).exec('SELECT reference_id, status FROM gap_requests WHERE id = ?', created.body.id).toArray()[0];
  assert.equal(attached.status, 200);
  assert.equal(row.reference_id, second.id);
  assert.equal(row.status, 'answered');
  sqlOf(store).exec(`INSERT INTO bids (id, owner, owner_mail, title, alias, prospects, brief, pseudo, requirements, customer, req_method, status, outcome, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'b3', owner.email, owner.email, 'Second synthetic bid', 'Alias', '[]', 'Brief', '{}',
    JSON.stringify([{ id: 'R1', text: 'A proof point', kind: 'capability', must: true }]),
    '{}', 'manual', 'open', 'pending', clock, clock);
  const other = await call('POST', 'gaps', owner, { bidId: 'b3', requirementIds: ['R1'], assignee: { refId: first.id, person: 0 } });
  assert.equal(other.status, 201);
  const kept = await call('POST', `gaps/${other.body.id}/answer`, alex, {
    results: [{ askId: 'G1', status: 'answered_unverified', quotes: ['A quote.'] }],
  });
  const left = sqlOf(store).exec('SELECT reference_id FROM gap_requests WHERE id = ?', other.body.id).toArray()[0];
  assert.equal(kept.status, 200);
  assert.equal(left.reference_id, first.id);
});
