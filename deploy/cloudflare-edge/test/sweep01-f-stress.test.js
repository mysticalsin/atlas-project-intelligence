// Sweep 01 group 9. Both F2 tests are copied from PR #31 at 96712474b59d6b058ef00479f2bb2d4eb065801e.
// The other tests in that file belong to other groups and are not on this branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';
import * as profile from '../src/profile.js';

const TENANT = 'abcdefab-cdef-4abc-8def-0123456789ab';
const fresh = () => new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });

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
