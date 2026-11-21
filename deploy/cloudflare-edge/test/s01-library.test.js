// Sweep 01 group 3 (library/routes: M3, F1, F5, F6, F7, HAM-02).
// Copied from the red tests at 96712474. Fails on main. Not skipped and not an expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
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
  const owner = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user' };
  const saved = await store.upsert(owner, {
    localId: 'hang',
    reference: { title: 'Hung review', answers: ['I rebuilt the intake queue for the service desk.'] },
  });
  let aborted = false;
  store.complete = (_messages, options) => new Promise((_resolve, reject) => {
    const signal = options && options.signal;
    if (!signal) return;
    const stop = () => {
      aborted = true;
      reject(Object.assign(new Error('The review was aborted.'), { name: 'AbortError' }));
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
  const response = await libraryRoutes(new Request('https://atlas.example.test/api/library/' + saved.id + '/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-user': owner.email, 'x-atlas-email': owner.email },
    body: '{}',
  }), store, { env: {} });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(aborted, true);
  assert.match(JSON.stringify(body.state && body.state.quality), /The review agent did not answer/);
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

test('F1 several saves with no local id are distinct rows, and one explicit local id stays one row', async () => {
  const store = fresh();
  const ids = [];
  for (let n = 0; n < 5; n++) {
    const response = await post(store, 'empty-local@example.test', { reference: { title: 'Empty local ' + n } });
    assert.equal(response.status, 201);
    ids.push((await response.json()).id);
  }
  assert.equal(new Set(ids).size, 5);
  const email = 'same-local@example.test';
  const first = await post(store, email, { localId: 'keep-me', reference: { title: 'First title' } });
  const second = await post(store, email, { localId: 'keep-me', reference: { title: 'Second title' } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await second.json()).id, (await first.json()).id);
});

const IMPORT_ROW_CAP = 10000;
const IMPORT_BYTE_CAP = 1024 * 1024;

test('F5 ten thousand rows finish inside a time and memory bound', { timeout: 25000 }, async () => {
  const store = fresh();
  const admin = { email: 'admin@example.test', mail: 'admin@example.test', role: 'admin' };
  const references = Array.from({ length: IMPORT_ROW_CAP }, (_, index) => ({ externalId: 'bulk-' + index, reference: { title: 'Imported ' + index } }));
  const before = process.memoryUsage().heapUsed;
  const started = Date.now();
  const out = await store.importAll(admin, { references });
  const elapsed = Date.now() - started;
  const heap = process.memoryUsage().heapUsed - before;
  assert.equal(out.created + out.unchanged + out.rejected.length, IMPORT_ROW_CAP);
  assert.equal(out.rejected.length, 0);
  assert.ok(elapsed < 20000, 'elapsed ' + elapsed);
  assert.ok(heap < 256 * 1024 * 1024, 'heap ' + heap);
});

test('F5 a body over the byte ceiling is 413 and is not imported', async () => {
  const store = fresh();
  const response = await libraryRoutes(new Request('https://atlas.example.test/api/library/import', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(IMPORT_BYTE_CAP + 1),
      'x-atlas-user': 'admin@example.test',
      'x-atlas-email': 'admin@example.test',
      'x-atlas-role': 'admin',
    },
    body: 'x'.repeat(64),
  }), store, { env: {} });
  assert.equal(response.status, 413);
  assert.equal(sqlOf(store).exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n, 0);
});

test('F5 more rows than the ceiling is 413 and writes nothing', async () => {
  const store = fresh();
  const admin = { email: 'admin@example.test', mail: 'admin@example.test', role: 'admin' };
  let planned = false;
  store.revisionPlan = async () => {
    planned = true;
    throw Object.assign(new Error('stop'), { status: 499 });
  };
  const references = Array.from({ length: IMPORT_ROW_CAP + 1 }, (_, index) => ({ externalId: 'over-' + index, reference: { title: 'Over ' + index } }));
  await assert.rejects(() => store.importAll(admin, { references }), error => error.status === 413);
  assert.equal(planned, false);
  assert.equal(sqlOf(store).exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n, 0);
});

test('F5 a failure mid-import leaves nothing committed', async () => {
  const sql = memorySql();
  const exec = sql.exec;
  let inserts = 0;
  sql.exec = (query, ...params) => {
    if (/insert into refs/i.test(String(query))) {
      inserts += 1;
      if (inserts >= 3) {
        const error = new Error('disk I/O error');
        error.code = 'ERR_SQLITE_ERROR';
        throw error;
      }
    }
    return exec(query, ...params);
  };
  const store = freshSql(sql);
  const admin = { email: 'admin@example.test', mail: 'admin@example.test', role: 'admin' };
  const references = Array.from({ length: 6 }, (_, index) => ({ externalId: 'crash-' + index, reference: { title: 'Crash ' + index } }));
  await assert.rejects(() => store.importAll(admin, { references }));
  assert.equal(exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n, 0);
});

test('F5 an import accounts for an empty batch and a single row', async () => {
  const store = fresh();
  const admin = { email: 'admin@example.test', mail: 'admin@example.test', role: 'admin' };
  for (const count of [0, 1]) {
    const references = Array.from({ length: count }, (_, index) => ({ externalId: 'small-' + count + '-' + index, reference: { title: 'Small ' + index } }));
    const out = await store.importAll(admin, { references });
    assert.equal(out.created + out.unchanged + out.rejected.length, count);
  }
});

function busyOn(storeSql, pattern) {
  const exec = storeSql.exec;
  let attempts = 0;
  storeSql.exec = (query, ...params) => {
    if (pattern.test(String(query))) {
      attempts += 1;
      const error = new Error('database is locked');
      error.code = 'ERR_SQLITE_ERROR';
      throw error;
    }
    return exec(query, ...params);
  };
  return () => attempts;
}

test('F6 a locked update and a locked invitation retry, then return 503 with Retry-After', async () => {
  const sql = memorySql();
  const store = freshSql(sql);
  const created = await post(store, 'busy-update@example.test', { localId: 'lock-me', reference: { title: 'Before the lock' } });
  assert.equal(created.status, 201);
  const id = (await created.json()).id;
  const updates = busyOn(sql, /update refs/i);
  const revised = await post(store, 'busy-update@example.test', { localId: 'lock-me', reference: { title: 'During the lock' } });
  assert.equal(revised.status, 503);
  assert.equal(revised.headers.get('retry-after'), '1');
  assert.ok(updates() >= 2);
  assert.equal(store.row(id).data.title, 'Before the lock');

  const inviteSql = memorySql();
  const invites = busyOn(inviteSql, /insert into invitations/i);
  const invited = await libraryRoutes(new Request('https://atlas.example.test/api/library/invitations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-atlas-user': 'rev@example.test',
      'x-atlas-email': 'rev@example.test',
      'x-atlas-role': 'reviewer',
    },
    body: JSON.stringify({ email: 'guest@example.test', title: 'Synthetic invite' }),
  }), freshSql(inviteSql), { env: {} });
  assert.equal(invited.status, 503);
  assert.equal(invited.headers.get('retry-after'), '1');
  assert.ok(invites() >= 2);
  assert.equal(inviteSql.exec('SELECT COUNT(*) AS n FROM invitations').toArray()[0].n, 0);
});

test('F6 a library error that is not a lock stays an untyped failure', async () => {
  const sql = memorySql();
  const exec = sql.exec;
  sql.exec = (query, ...params) => {
    if (/insert into refs/i.test(String(query))) {
      const error = new Error('no such column: nope');
      error.code = 'ERR_SQLITE_ERROR';
      throw error;
    }
    return exec(query, ...params);
  };
  const blocked = await post(freshSql(sql), 'broken@example.test', { reference: { title: 'Broken story' } });
  assert.equal(blocked.status, 500);
});

test('HAM-02 scores of zero and four are the ends of the scale, and a client impact without scores is dropped', async () => {
  const store = fresh();
  const pack = score => Object.fromEntries(['business_impact', 'evidence', 'reusability', 'differentiation', 'showcase'].map(key => [key, { score }]));
  const ends = { 0: 0, 4: 100, 2: 50 };
  for (const [score, expected] of Object.entries(ends)) {
    const saved = await store.upsert(user, {
      localId: 'scale-' + score,
      reference: { title: 'Scale ' + score, jev: { primary: { key: 'data_ai', label: 'Data & AI' }, also: [], scores: pack(Number(score)), impact: 99 } },
    });
    assert.equal(store.row(saved.id).data.jev.impact, expected);
    assert.equal(saved.impact, expected);
  }
  const declared = await store.upsert(user, {
    localId: 'declared',
    reference: { title: 'Declared impact', jev: { primary: { key: 'data_ai', label: 'Data & AI' }, also: [], impact: 70 } },
  });
  assert.equal(store.row(declared.id).data.jev.impact, null);
  assert.notEqual(declared.impact, 70);
  const claimed = await store.upsert(user, {
    localId: 'claimed-100',
    reference: { title: 'Claimed perfect impact', jev: { primary: { key: 'data_ai', label: 'Data & AI' }, also: [], impact: 100 } },
  });
  assert.notEqual(store.row(claimed.id).data.jev.impact, 100);
  assert.notEqual(claimed.impact, 100);
  assert.equal(store.row(claimed.id).data.jev.scores, undefined);
});

test('M3 an exact duplicate contribution is not written twice, and the merged answer stays within 6000 characters', async () => {
  const store = lib();
  const reviewer = { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer' };
  const line = 'I designed and built the routing model';
  const answers = text => ['', text, '', '', '', ''];
  const keeper = await store.upsert(
    { email: 'kim@example.test', mail: 'kim@example.test', role: 'user' },
    { localId: 'dup-kept', reference: { title: 'Kept duplicate', answers: answers(line) } },
  );
  const gone = await store.upsert(
    { email: 'ada@example.test', mail: 'ada@example.test', role: 'user' },
    { localId: 'dup-gone', reference: { title: 'Gone duplicate', answers: answers(line) } },
  );
  await store.merge(reviewer, { keep: keeper.id, merge: gone.id });
  assert.equal(store.row(keeper.id).data.answers[1].includes('Contribution by another consultant:'), false);
  const long = 'A'.repeat(6000);
  const wide = await store.upsert(
    { email: 'kim@example.test', mail: 'kim@example.test', role: 'user' },
    { localId: 'wide-kept', reference: { title: 'Wide kept', answers: answers(long) } },
  );
  const extra = await store.upsert(
    { email: 'ada@example.test', mail: 'ada@example.test', role: 'user' },
    { localId: 'wide-gone', reference: { title: 'Wide gone', answers: answers('B'.repeat(80)) } },
  );
  await store.merge(reviewer, { keep: wide.id, merge: extra.id });
  assert.ok(store.row(wide.id).data.answers[1].length <= 6000);
  assert.equal(sqlOf(store).exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n >= 4, true);
});
