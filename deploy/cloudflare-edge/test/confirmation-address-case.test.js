// A confirmer is the same person when only the letter case differs.
// Synthetic addresses only. No provider, Entra, Hindsight, or Teams call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';

const ORIGIN = 'https://atlas.example';
const SENTENCE = 'I built the routing model for the queue myself.';

function reference(manager) {
  return {
    title: 'Synthetic queue pilot',
    consultant: { name: 'Alex Martin', role: 'Data engineer' },
    client: { name: 'Zebracorp', location: 'Lyon', contact: 'Jane Doe' },
    details: { projectId: 'PRJ-1', country: 'France', consultants: [{ name: 'Kim', email: 'kim@example.test', role: 'Analyst' }] },
    validation: { manager: { name: 'Named manager', email: manager } },
    answers: [
      'The queue was slow before the change.',
      SENTENCE,
      'We compared two approaches and kept one.',
      'The queue fell from 40 to 12 minutes.',
      'The dashboard export shows the change.',
      '',
    ],
  };
}

function setup() {
  const sql = memorySql();
  let n = 0;
  const l = new Library(sql, { now: () => '2026-09-29T08:00:00.000Z', newId: () => (++n).toString(16).padStart(32, '0') });
  const call = async (user, method, path, body) => {
    const response = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, {
      method,
      headers: { 'x-atlas-user': user.email, 'x-atlas-role': user.role, 'x-atlas-email': user.mail, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    }), l, { env: { ORIGIN, ATLAS_TENANT_ISOLATION: 'local-synthetic' } });
    return { status: response.status, body: await response.json() };
  };
  return { l, call };
}

async function proposed(s, user, id) {
  const candidates = (await s.call(user, 'GET', 'claims/' + id)).body.candidates;
  const item = candidates.find(candidate => candidate.text === SENTENCE);
  assert.ok(item, 'the sentence is a claim candidate');
  const saved = await s.call(user, 'POST', 'claims', { refId: id, items: [item] });
  assert.equal(saved.status, 201);
  return saved.body.claims[0].id;
}

function requests(l) {
  return l.rows('SELECT COUNT(*) AS n FROM confirmation_requests')[0].n;
}

test('a reviewer cannot ask the owner when only the letter case differs', async () => {
  const s = setup();
  const owner = { email: 'Alex@example.test', mail: 'alex@example.test', role: 'user' };
  const reviewer = { email: 'Rev@example.test', mail: 'rev@example.test', role: 'reviewer' };
  const id = (await s.l.upsert(owner, { localId: 'owner-case', reference: reference('Alex@example.test') })).id;
  const row = s.l.row(id);
  assert.equal(row.owner, 'Alex@example.test');
  assert.equal(row.data.validation.manager.email, 'alex@example.test');
  const claimId = await proposed(s, reviewer, id);
  const asked = await s.call(reviewer, 'POST', 'confirmations', { refId: id, claimIds: [claimId] });
  assert.equal(asked.status, 409);
  assert.match(asked.body.error, /independent/);
  assert.equal(requests(s.l), 0);
});

test('a listed member keeps their sign-in spelling and is still not independent', async () => {
  const s = setup();
  const owner = { email: 'alex@example.test', mail: 'alex@example.test', role: 'user' };
  const reviewer = { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer' };
  const id = (await s.l.upsert(owner, { localId: 'member-case', reference: reference('Kim@example.test') })).id;
  assert.equal(s.l.row(id).members, ',kim@example.test,');
  // A merge copies the other story's owner into members without folding it.
  sqlOf(s.l).exec('UPDATE refs SET members = ? WHERE id = ?', ',Kim@example.test,', id);
  const claimId = await proposed(s, reviewer, id);
  const asked = await s.call(reviewer, 'POST', 'confirmations', { refId: id, claimIds: [claimId] });
  assert.equal(asked.status, 409);
  assert.match(asked.body.error, /independent/);
  assert.equal(requests(s.l), 0);
});

test('a different person is still asked', async () => {
  const s = setup();
  const owner = { email: 'Alex@example.test', mail: 'alex@example.test', role: 'user' };
  const reviewer = { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer' };
  const id = (await s.l.upsert(owner, { localId: 'other-person', reference: reference('sam@example.test') })).id;
  const claimId = await proposed(s, reviewer, id);
  const asked = await s.call(reviewer, 'POST', 'confirmations', { refId: id, claimIds: [claimId] });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.request.toEmail, 'sam@example.test');
  assert.equal(requests(s.l), 1);
});
