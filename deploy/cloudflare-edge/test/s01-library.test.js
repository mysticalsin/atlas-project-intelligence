// Sweep 01 group 3 (library/routes: M3, F1, F5, F6, F7, HAM-02).
// Copied from the red tests at 96712474. Fails on main. Not skipped and not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';
import { libraryRoutes } from '../src/library-routes.js';
import { impact as serverImpact } from '../src/classify.js';

const lib = () => new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });
const fresh = () => new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });

function post(store, email, body) {
  return libraryRoutes(new Request('https://atlas.example.test/api/library', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-user': email, 'x-atlas-email': email },
    body: JSON.stringify(body),
  }), store, { env: {} });
}

function freshSql(sql) {
  return new Library(sql, { now: () => '2026-11-21T00:00:00.000Z' });
}

test('M3 a shorter contribution that sits inside the kept answer is still attributed', async () => {
  const store = lib();
  const reviewer = { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer' };
  const kept = 'I designed and built the routing model and ran the pilot with two teams.';
  const retired = 'I designed and built the routing model';
  const answers = line => ['', line, '', '', '', ''];
  const keeper = await store.upsert(
    { email: 'kim@example.test', mail: 'kim@example.test', role: 'user' },
    { localId: 'kept-story', reference: { title: 'Kept story', answers: answers(kept) } },
  );
  const gone = await store.upsert(
    { email: 'ada@example.test', mail: 'ada@example.test', role: 'user' },
    { localId: 'retired-story', reference: { title: 'Retired story', answers: answers(retired) } },
  );
  await store.merge(reviewer, { keep: keeper.id, merge: gone.id });
  const text = store.row(keeper.id).data.answers[1];
  assert.match(text, /Contribution by another consultant:/);
  assert.match(text, /I designed and built the routing model/);
});

test('F1 a second save with no local id is a conflict or a distinct row, never an untyped 500', async () => {
  const store = fresh();
  const first = await post(store, 'empty-local@example.test', { reference: { title: 'First empty local id' } });
  const second = await post(store, 'empty-local@example.test', { reference: { title: 'Second empty local id' } });
  assert.equal(first.status, 201);
  const body = await second.json();
  assert.notEqual(second.status, 500);
  assert.ok(second.status === 409 || (second.status === 201 && body.id && body.id !== (await first.clone().json()).id));
});

test('F5 an import reports every row, including those past five hundred', async () => {
  const store = fresh();
  const admin = { email: 'admin@example.test', mail: 'admin@example.test', role: 'admin' };
  const references = Array.from({ length: 501 }, (_, index) => ({
    externalId: 'row-' + index,
    reference: { title: 'Imported ' + index },
  }));
  const out = await store.importAll(admin, { references });
  assert.equal(out.created + out.unchanged + out.rejected.length, 501);
});

test('F6 a locked library write is unavailable, and a later write still works', async () => {
  const sql = memorySql();
  let locked = false;
  const exec = sql.exec;
  sql.exec = (query, ...params) => {
    if (locked && /insert into refs/i.test(String(query))) {
      const error = new Error('database is locked');
      error.code = 'ERR_SQLITE_ERROR';
      throw error;
    }
    return exec(query, ...params);
  };
  const store = freshSql(sql);
  locked = true;
  const blocked = await post(store, 'busy@example.test', { reference: { title: 'Locked story' } });
  assert.equal(blocked.status, 503);
  locked = false;
  const later = await post(store, 'busy@example.test', { reference: { title: 'After the lock' } });
  assert.equal(later.status, 201);
});

test('F7 a review whose model call never returns stops on a deadline', async () => {
  const store = fresh();
  const user = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user' };
  const saved = await store.upsert(user, {
    localId: 'hang',
    reference: { title: 'Hung review', answers: ['I rebuilt the intake queue for the service desk.'] },
  });
  store.complete = () => new Promise(() => {});
  const pending = store.review(user, saved.id);
  const outcome = await Promise.race([
    pending.then(() => 'settled', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('still-running'), 2500)),
  ]);
  assert.notEqual(outcome, 'still-running');
});

const user = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user' };

test('HAM-02 a client-supplied library impact is ignored and the server score is stored', async () => {
  const store = new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });
  const scores = {
    business_impact: { score: 2 },
    evidence: { score: 2 },
    reusability: { score: 2 },
    differentiation: { score: 2 },
    showcase: { score: 2 },
  };
  const saved = await store.upsert(user, {
    localId: 'impact',
    reference: {
      title: 'Impact story',
      jev: { primary: { key: 'data_ai', label: 'Data & AI' }, also: [], scores, impact: 99 },
    },
  });
  const expected = serverImpact(scores);
  const stored = store.row(saved.id).data.jev.impact;
  assert.equal(stored, expected);
  assert.equal(saved.impact, expected);
});
