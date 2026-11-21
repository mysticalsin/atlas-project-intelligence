// Sweep 01 stress findings. Each test encodes the behaviour main should have.
// They fail on main. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';
import { libraryRoutes } from '../src/library-routes.js';
import { consume } from '../src/ratelimit.js';
import { applyState, loadState } from '../src/privacy.js';
import * as profile from '../src/profile.js';

const TENANT = 'abcdefab-cdef-4abc-8def-0123456789ab';
const fresh = () => new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });

function post(lib, email, body) {
  return libraryRoutes(new Request('https://atlas.example.test/api/library', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-user': email, 'x-atlas-email': email },
    body: JSON.stringify(body),
  }), lib, { env: {} });
}

test('F1 a second save with no local id is a conflict or a distinct row, never an untyped 500', async () => {
  const lib = fresh();
  const first = await post(lib, 'empty-local@example.test', { reference: { title: 'First empty local id' } });
  const second = await post(lib, 'empty-local@example.test', { reference: { title: 'Second empty local id' } });
  assert.equal(first.status, 201);
  const body = await second.json();
  assert.notEqual(second.status, 500);
  assert.ok(second.status === 409 || (second.status === 201 && body.id && body.id !== (await first.clone().json()).id));
});

test('F2 two profile edits that overlap a directory read both survive', async () => {
  const lib = fresh();
  const user = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
  let waiting = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  lib.services = {
    fetch: async () => {
      waiting += 1;
      if (waiting >= 2) release();
      await gate;
      return new Response(JSON.stringify({ name: 'Dna Name', title: 'Dna Title' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  };
  const env = {
    DATA_MODE: 'production',
    DNA_PROFILE_URL: 'https://dna.example.test/people/{email}',
    DNA_FIELD_MAP: JSON.stringify({ name: 'name', title: 'title' }),
    DNA_API_KEY: 'synthetic-key',
  };
  const call = (set) => profile.routes({ method: 'POST', parts: ['profile'], user, lib, env, body: { set } });
  const both = Promise.all([call({ name: 'Ada Example' }), call({ title: 'Delivery Lead' })]);
  await Promise.race([gate, new Promise(resolve => setTimeout(resolve, 500))]);
  release();
  await both;
  const view = await profile.routes({ method: 'GET', parts: ['profile'], user, lib, env, body: {} });
  assert.equal(view.body.fields.name.value, 'Ada Example');
  assert.equal(view.body.fields.title.value, 'Delivery Lead');
});

test('F2 two consent grants that overlap a directory read both survive', async () => {
  const lib = fresh();
  const user = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
  let waiting = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  lib.services = {
    fetch: async () => {
      waiting += 1;
      if (waiting >= 2) release();
      await gate;
      return new Response(JSON.stringify({ name: 'Dna Name', title: 'Dna Title' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  };
  const env = {
    DATA_MODE: 'production',
    DNA_PROFILE_URL: 'https://dna.example.test/people/{email}',
    DNA_FIELD_MAP: JSON.stringify({ name: 'name', title: 'title' }),
    DNA_API_KEY: 'synthetic-key',
  };
  const grant = (kind) => profile.routes({
    method: 'POST', parts: ['profile', 'consent'], user, lib, env, body: { kind, version: 1, granted: true },
  });
  const both = Promise.all([grant('spokenAsk'), grant('jevRating')]);
  await Promise.race([gate, new Promise(resolve => setTimeout(resolve, 500))]);
  release();
  await both;
  const row = lib.rows('SELECT consents FROM profiles')[0];
  const consents = JSON.parse(row.consents || '{}');
  assert.equal(consents.spokenAsk?.version, 1);
  assert.equal(consents.jevRating?.version, 1);
});

function counter() {
  const data = new Map();
  return {
    async get(keys) {
      await new Promise(resolve => setImmediate(resolve));
      const out = new Map();
      for (const key of keys) if (data.has(key)) out.set(key, structuredClone(data.get(key)));
      return out;
    },
    async put(entries) {
      await new Promise(resolve => setImmediate(resolve));
      for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value));
    },
  };
}

test('F3 a shared limit cannot be passed by overlapping consumes', async () => {
  const storage = counter();
  const check = [{ bucket: 'inbound', max: 5, windowMs: 60000 }];
  const now = 1_700_000_030_000;
  const results = await Promise.all(Array.from({ length: 40 }, () => consume(storage, check, { now, subj: 'person' })));
  const allowed = results.filter(result => result.ok).length;
  assert.ok(allowed <= 5, String(allowed));
});

test('F4 overlapping consent writes keep every purpose that was granted', async () => {
  let value;
  const storage = {
    async get() {
      await new Promise(resolve => setImmediate(resolve));
      return value ? structuredClone(value) : undefined;
    },
    async put(_key, next) {
      await new Promise(resolve => setImmediate(resolve));
      value = structuredClone(next);
    },
  };
  const pause = async () => { await new Promise(resolve => setImmediate(resolve)); };
  await Promise.all([
    applyState(storage, { transcription: true }, { beforeCommit: pause }),
    applyState(storage, { draft: true }, { beforeCommit: pause }),
  ]);
  const state = await loadState(storage);
  assert.equal(state.purposes.transcription?.granted, true);
  assert.equal(state.purposes.draft?.granted, true);
});

test('F5 an import reports every row, including those past five hundred', async () => {
  const lib = fresh();
  const admin = { email: 'admin@example.test', mail: 'admin@example.test', role: 'admin' };
  const references = Array.from({ length: 501 }, (_, index) => ({
    externalId: 'row-' + index,
    reference: { title: 'Imported ' + index },
  }));
  const out = await lib.importAll(admin, { references });
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
  const lib = freshSql(sql);
  locked = true;
  const blocked = await post(lib, 'busy@example.test', { reference: { title: 'Locked story' } });
  assert.equal(blocked.status, 503);
  locked = false;
  const later = await post(lib, 'busy@example.test', { reference: { title: 'After the lock' } });
  assert.equal(later.status, 201);
});

function freshSql(sql) {
  return new Library(sql, { now: () => '2026-11-21T00:00:00.000Z' });
}

test('F7 a review whose model call never returns stops on a deadline', async () => {
  const lib = fresh();
  const user = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user' };
  const saved = await lib.upsert(user, {
    localId: 'hang',
    reference: { title: 'Hung review', answers: ['I rebuilt the intake queue for the service desk.'] },
  });
  lib.complete = () => new Promise(() => {});
  const pending = lib.review(user, saved.id);
  const outcome = await Promise.race([
    pending.then(() => 'settled', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('still-running'), 2500)),
  ]);
  assert.notEqual(outcome, 'still-running');
});

test('F8 a clock that moves backward does not open a fresh rate-limit window', async () => {
  const storage = counter();
  const check = [{ bucket: 'inbound', max: 3, windowMs: 60000 }];
  const now = 1_700_000_030_000;
  for (let i = 0; i < 3; i++) assert.equal((await consume(storage, check, { now, subj: 'person' })).ok, true);
  assert.equal((await consume(storage, check, { now, subj: 'person' })).ok, false);
  const earlier = await consume(storage, check, { now: now - 60000, subj: 'person' });
  assert.equal(earlier.ok, false);
});
