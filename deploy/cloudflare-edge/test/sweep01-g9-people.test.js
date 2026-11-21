// Sweep 01 group 9 red tests. ATLAS-08, the v4 lookup rules, and addendum G9-v4-L1.
// They fail on current profile.js. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as profile from '../src/profile.js';
import { eraseMine } from '../src/subject-rights.js';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';

const TENANT = 'abcdefab-cdef-4abc-8def-0123456789ab';
const OTHER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const NOW = '2026-11-21T00:00:00.000Z';
const NEXT = '2026-11-22T00:00:00.000Z';
const ALEX_NAME = 'Alex Example';

const caller = (role = 'user', email = 'ada@example.test') => ({
  email, mail: email, role, tenant: TENANT, tenantEnforced: true,
});

function open(now = NOW) {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => now });
  return { sql, lib };
}

function again(sql, now = NOW) {
  return new Library(sql, { now: () => now });
}

function directory(lib, tenant, row) {
  profile.ensure(lib);
  lib.recorded(() => {
    lib.exec(
      `INSERT INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant)
       VALUES (?, 'dna_export', ?, '', ?, '', ?, 'seed', ?, ?)`,
      row.email, row.name, row.title || '', row.manager || '', NOW, tenant,
    );
  });
}

function story(lib, spec) {
  const consultants = spec.consultants || [];
  const members = ',' + consultants.map(c => c.email).join(',') + ',';
  const data = JSON.stringify({ title: 'Story', details: { consultants }, client: { name: 'Example Client' } });
  const state = JSON.stringify({ version: 1, tenant: spec.tenant, sharedWith: spec.sharedWith || [] });
  lib.recorded(() => {
    lib.exec(
      `INSERT INTO refs (id, owner, title, status, revision, members, data, state, tenant, updated_by, created_at, updated_at)
       VALUES (?, ?, 'Story', ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      spec.id, spec.owner, spec.status || 'in_review', members, data, state, spec.tenant,
      spec.updatedBy == null ? null : spec.updatedBy, NOW, NOW,
    );
  });
}

async function people(lib, user, address) {
  const url = new URL('https://atlas.test/api/library/people?email=' + encodeURIComponent(address));
  try {
    const r = await profile.routes({ method: 'GET', parts: ['people'], user, lib, env: {}, url, body: {} });
    return { status: r.status || 200, body: r.body };
  } catch (e) {
    if (!e.status) throw e;
    return { status: e.status, body: { error: e.message } };
  }
}

function lookupCount(lib, email) {
  return lib.rows('SELECT COUNT(*) AS n FROM people_lookup WHERE caller = ?', email)[0].n;
}

function seedAtlas(lib, user = caller()) {
  directory(lib, TENANT, { email: 'alex@example.test', name: ALEX_NAME, title: 'Analyst', manager: 'lead@example.test' });
  directory(lib, TENANT, { email: 'boss@example.test', name: 'Boss Person', title: 'Director', manager: '' });
  directory(lib, TENANT, { email: user.email, name: 'Ada Example', title: 'Consultant', manager: 'boss@example.test' });
  directory(lib, TENANT, { email: 'ada@example.test', name: 'Ada Colleague', title: 'Engineer', manager: '' });
  directory(lib, TENANT, { email: 'sam@example.test', name: 'Sam Stone', title: 'Designer', manager: '' });
  story(lib, {
    id: 'self-wrote', owner: user.email, tenant: TENANT, updatedBy: user.email,
    consultants: [{ name: 'Ada Colleague', email: 'ada@example.test', role: 'Engineer' }],
  });
  story(lib, {
    id: 'other-wrote', owner: 'editor@example.test', tenant: TENANT, updatedBy: 'editor@example.test',
    sharedWith: [user.email],
    consultants: [{ name: 'Sam Stone', email: 'sam@example.test', role: 'Designer' }],
  });
}

test('ATLAS-08 a user lookup is the directory manager or a story someone else wrote', async () => {
  const { lib } = open();
  const user = caller();
  seedAtlas(lib, user);
  const alex = await people(lib, user, 'alex@example.test');
  assert.equal(alex.status, 403);
  assert.equal(JSON.stringify(alex.body).includes(ALEX_NAME), false);
  const boss = await people(lib, user, 'boss@example.test');
  assert.equal(boss.status, 200);
  assert.equal(boss.body.name, 'Boss Person');
  assert.equal(boss.body.title, 'Director');
  assert.equal(Object.hasOwn(boss.body, 'manager_email'), false);
  const selfWrote = await people(lib, user, 'ada@example.test');
  assert.equal(selfWrote.status, 403);
  assert.equal(JSON.stringify(selfWrote.body).includes('Ada Colleague'), false);
  const otherWrote = await people(lib, user, 'sam@example.test');
  assert.equal(otherWrote.status, 200);
  assert.equal(otherWrote.body.name, 'Sam Stone');
  assert.equal(otherWrote.body.title, 'Designer');
  for (const address of ['alex@example.test.au', 'xalex@example.test']) {
    const hit = await people(lib, user, address);
    assert.equal(hit.status, 403, address);
    assert.equal(JSON.stringify(hit.body).includes(ALEX_NAME), false, address);
  }
  for (const role of ['admin', 'reviewer']) {
    const hit = await people(lib, caller(role), 'alex@example.test');
    assert.equal(hit.status, 200, role);
    assert.equal(hit.body.name, ALEX_NAME);
    assert.equal(hit.body.title, 'Analyst');
    assert.equal(Object.hasOwn(hit.body, 'manager_email'), false, role);
    for (const address of ['alex@example.test.au', 'xalex@example.test']) {
      const prefix = await people(lib, caller(role), address);
      assert.equal(prefix.status, 404, role + ' ' + address);
      assert.equal(JSON.stringify(prefix.body).includes(ALEX_NAME), false);
    }
  }
  const presales = await people(lib, caller('presales'), 'alex@example.test');
  assert.equal(presales.status, 403);
  assert.equal(JSON.stringify(presales.body).includes(ALEX_NAME), false);
});

test('M1 a caller-set manager email does not unlock directory lookup', async () => {
  const { lib } = open();
  const user = caller();
  seedAtlas(lib, user);
  const saved = await profile.routes({
    method: 'POST', parts: ['profile'], user, lib, env: {}, body: { set: { managerEmail: 'alex@example.test' } },
  });
  assert.equal(saved.body.fields.managerEmail.value, 'alex@example.test');
  const hit = await people(lib, user, 'alex@example.test');
  assert.equal(hit.status, 403);
  assert.equal(JSON.stringify(hit.body).includes(ALEX_NAME), false);
  const boss = await people(lib, user, 'boss@example.test');
  assert.equal(boss.status, 200);
  assert.equal(boss.body.name, 'Boss Person');
});

test('M2 a self-written consultant does not unlock lookup', async () => {
  const { lib } = open();
  const user = caller();
  directory(lib, TENANT, { email: 'ada@example.test', name: 'Ada Colleague', title: 'Engineer', manager: '' });
  directory(lib, TENANT, { email: 'sam@example.test', name: 'Sam Stone', title: 'Designer', manager: '' });
  story(lib, {
    id: 'mine', owner: user.email, tenant: TENANT, updatedBy: user.email,
    consultants: [{ name: 'Ada Colleague', email: 'ada@example.test', role: 'Engineer' }],
  });
  story(lib, {
    id: 'theirs', owner: 'editor@example.test', tenant: TENANT, updatedBy: 'editor@example.test',
    sharedWith: [user.email],
    consultants: [{ name: 'Sam Stone', email: 'sam@example.test', role: 'Designer' }],
  });
  story(lib, {
    id: 'unstamped', owner: 'editor@example.test', tenant: TENANT, updatedBy: null,
    sharedWith: [user.email],
    consultants: [{ name: 'Alex Example', email: 'alex@example.test', role: 'Analyst' }],
  });
  directory(lib, TENANT, { email: 'alex@example.test', name: ALEX_NAME, title: 'Analyst', manager: '' });
  assert.equal((await people(lib, user, 'ada@example.test')).status, 403);
  assert.equal((await people(lib, user, 'sam@example.test')).status, 200);
  const missingEditor = await people(lib, user, 'alex@example.test');
  assert.equal(missingEditor.status, 403);
  assert.equal(JSON.stringify(missingEditor.body).includes(ALEX_NAME), false);
});

test('D1 a presales lookup does not cross tenants', async () => {
  const { lib } = open();
  const user = caller('presales');
  directory(lib, TENANT, { email: 'far@example.test', name: 'Far Person', title: 'Lead', manager: '' });
  directory(lib, OTHER, { email: 'far@example.test', name: 'Far Person', title: 'Lead', manager: '' });
  directory(lib, TENANT, { email: 'near@example.test', name: 'Near Person', title: 'Lead', manager: '' });
  story(lib, {
    id: 'other-tenant', owner: user.email, tenant: OTHER, updatedBy: 'editor@example.test',
    consultants: [{ name: 'Far Person', email: 'far@example.test', role: 'Lead' }],
  });
  story(lib, {
    id: 'role-only', owner: 'editor@example.test', tenant: TENANT, updatedBy: 'editor@example.test',
    consultants: [{ name: 'Near Person', email: 'near@example.test', role: 'Lead' }],
  });
  const far = await people(lib, user, 'far@example.test');
  assert.equal(far.status, 403);
  assert.equal(JSON.stringify(far.body).includes('Far Person'), false);
  const near = await people(lib, user, 'near@example.test');
  assert.equal(near.status, 403);
  assert.equal(JSON.stringify(near.body).includes('Near Person'), false);
  const asUser = caller('user');
  story(lib, {
    id: 'shared', owner: 'editor@example.test', tenant: TENANT, updatedBy: 'editor@example.test',
    sharedWith: [asUser.email],
    consultants: [{ name: 'Near Person', email: 'near@example.test', role: 'Lead' }],
  });
  assert.equal((await people(lib, asUser, 'near@example.test')).status, 200);
});

test('a published story and another tenant and a missing directory row do not unlock a title', async () => {
  const { lib } = open();
  const user = caller();
  directory(lib, TENANT, { email: 'pub@example.test', name: 'Public Title', title: 'Hidden', manager: '' });
  directory(lib, OTHER, { email: 'foreign@example.test', name: 'Foreign Title', title: 'Hidden', manager: '' });
  directory(lib, TENANT, { email: 'boss@example.test', name: 'Boss Person', title: 'Director', manager: '' });
  story(lib, {
    id: 'public', owner: 'editor@example.test', tenant: TENANT, updatedBy: 'editor@example.test',
    status: 'published',
    consultants: [{ name: 'Public Title', email: 'pub@example.test', role: 'Lead' }],
  });
  story(lib, {
    id: 'foreign', owner: user.email, tenant: OTHER, updatedBy: 'editor@example.test',
    consultants: [{ name: 'Foreign Title', email: 'foreign@example.test', role: 'Lead' }],
  });
  const published = await people(lib, user, 'pub@example.test');
  assert.equal(published.status, 403);
  assert.equal(JSON.stringify(published.body).includes('Public Title'), false);
  const foreign = await people(lib, user, 'foreign@example.test');
  assert.equal(foreign.status, 403);
  assert.equal(JSON.stringify(foreign.body).includes('Foreign Title'), false);
  assert.equal((await people(lib, user, 'boss@example.test')).status, 403);
});

test('M2 the thirty-first distinct lookup in a day is refused after eviction', async () => {
  const { sql, lib } = open();
  const user = caller();
  directory(lib, TENANT, { email: 'boss@example.test', name: 'Boss Person', title: 'Director', manager: '' });
  directory(lib, TENANT, { email: user.email, name: 'Ada Example', title: 'Consultant', manager: 'boss@example.test' });
  for (let i = 0; i < 30; i++) {
    const hit = await people(lib, user, 'n' + i + '@example.test');
    assert.equal(hit.status, 403, 'slot ' + i);
  }
  const evicted = again(sql);
  const over = await people(evicted, user, 'boss@example.test');
  assert.equal(over.status, 429);
  assert.equal(JSON.stringify(over.body).includes('Boss Person'), false);
  const adminSql = memorySql();
  const adminLib = new Library(adminSql, { now: () => NOW });
  const admin = caller('admin', 'admin@example.test');
  for (let i = 0; i < 30; i++) assert.equal((await people(adminLib, admin, 'a' + i + '@example.test')).status, 404);
  const adminNext = again(adminSql);
  assert.equal((await people(adminNext, admin, 'a30@example.test')).status, 404);
});

test('L2 one caller lookups do not spend the other caller cap', async () => {
  const { sql, lib } = open();
  const first = caller('user', 'ada@example.test');
  const second = caller('user', 'bea@example.test');
  for (let i = 0; i < 30; i++) assert.equal((await people(lib, first, 'n' + i + '@example.test')).status, 403);
  sqlOf(lib).exec(
    'INSERT INTO people_lookup (caller, day, address) VALUES (?, ?, ?)',
    first.email, '2026-11-20', 'yesterday@example.test',
  );
  const other = await people(lib, second, 'other@example.test');
  assert.notEqual(other.status, 429);
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM people_lookup WHERE day < '2026-11-21'")[0].n, 0);
  const evicted = again(sql);
  assert.equal((await people(evicted, second, 'fresh@example.test')).status, 403);
  assert.equal((await people(evicted, first, 'one-more@example.test')).status, 429);
});

test('L1 erasing a profile does not delete the caller lookup rows or reset the daily cap', async () => {
  const { sql, lib } = open();
  const user = caller();
  await profile.routes({ method: 'POST', parts: ['profile'], user, lib, env: {}, body: { set: { name: 'Ada Example' } } });
  for (let i = 0; i < 30; i++) assert.equal((await people(lib, user, 'n' + i + '@example.test')).status, 403);
  const before = lookupCount(lib, user.email);
  assert.equal(before, 30);
  const removed = await profile.routes({ method: 'POST', parts: ['profile', 'delete'], user, lib, env: {}, body: {} });
  assert.equal(removed.body.deleted, true);
  assert.equal(lookupCount(lib, user.email), before);
  eraseMine(lib, user, 'ab'.repeat(16));
  assert.equal(lookupCount(lib, user.email), before);
  const old = new Date(Date.parse(NOW) - 400 * 86400000).toISOString();
  profile.ensure(lib);
  lib.recorded(() => {
    lib.exec(
      'INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      user.email, TENANT, user.email, '{}', '{}', '{}', old, old, old,
    );
  });
  profile.daily(lib, NOW, { tenantEnforced: true, tenant: TENANT });
  assert.equal(lookupCount(lib, user.email), before);
  const evicted = again(sql);
  const over = await people(evicted, user, 'one-more@example.test');
  assert.equal(over.status, 429);
  assert.equal(lookupCount(evicted, user.email), before);
});

test('L5 offset forms of one instant are kept or deleted together', () => {
  const forms = (instant) => {
    const z = new Date(instant).toISOString();
    return [z, z.replace(/Z$/, '+00:00'), z.replace(/Z$/, '-00:00'), z.replace(/Z$/, '+0000')];
  };
  const { lib } = open();
  const now = NOW;
  const cutoff = Date.parse(now) - 395 * 86400000;
  profile.ensure(lib);
  const insert = (subject, seen) => sqlOf(lib).exec(
    'INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    subject, TENANT, subject, '{}', '{}', '{}', NOW, NOW, seen,
  );
  for (const seen of forms(cutoff)) insert('keep-' + seen, seen);
  for (const seen of forms(cutoff - 1)) insert('drop-' + seen, seen);
  insert('bad-word@example.test', 'not-a-date');
  insert('bad-empty@example.test', '');
  insert('bad-calendar@example.test', '2026-13-40T00:00:00Z');
  profile.daily(lib, now, { tenantEnforced: true, tenant: TENANT });
  const left = new Set(lib.rows('SELECT email FROM profiles').map(r => r.email));
  const kept = forms(cutoff).map(seen => left.has('keep-' + seen));
  const dropped = forms(cutoff - 1).map(seen => left.has('drop-' + seen));
  assert.equal(new Set(kept).size, 1);
  assert.equal(kept[0], true);
  assert.equal(new Set(dropped).size, 1);
  assert.equal(dropped[0], false);
  assert.equal(left.has('bad-word@example.test'), true);
  assert.equal(left.has('bad-empty@example.test'), true);
  assert.equal(left.has('bad-calendar@example.test'), true);
});

test('F2 a partition of profile fields and a later revoke keep every unrelated key', async () => {
  const { lib } = open();
  const user = caller();
  const values = {
    name: 'Ada Example',
    preferredName: 'Ada',
    title: 'Delivery Lead',
    managerName: 'Mina North',
    managerEmail: 'mina@example.test',
  };
  const keys = Object.keys(values);
  let seed = 9;
  const order = keys.slice();
  for (let i = order.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  const left = order.slice(0, 2);
  const right = order.slice(2);
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
  const post = (set) => profile.routes({ method: 'POST', parts: ['profile'], user, lib, env, body: { set } });
  const both = Promise.all([
    post(Object.fromEntries(left.map(k => [k, values[k]]))),
    post(Object.fromEntries(right.map(k => [k, values[k]]))),
  ]);
  await Promise.race([gate, new Promise(resolve => setTimeout(resolve, 500))]);
  release();
  await both;
  const view = await profile.routes({ method: 'GET', parts: ['profile'], user, lib, env, body: {} });
  for (const key of keys) assert.equal(view.body.fields[key].value, values[key], key);
  assert.equal(view.body.fields.name.value, 'Ada Example');
  let consentWaiting = 0;
  let consentRelease;
  const consentGate = new Promise(resolve => { consentRelease = resolve; });
  lib.services = {
    fetch: async () => {
      consentWaiting += 1;
      if (consentWaiting >= 2) consentRelease();
      await consentGate;
      return new Response(JSON.stringify({ name: 'Dna Name' }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  const grant = (kind, granted) => profile.routes({
    method: 'POST', parts: ['profile', 'consent'], user, lib, env, body: { kind, version: 1, granted },
  });
  const grants = Promise.all([grant('spokenAsk', true), grant('jevRating', true)]);
  await Promise.race([consentGate, new Promise(resolve => setTimeout(resolve, 500))]);
  consentRelease();
  await grants;
  let revokeWaiting = 0;
  let revokeRelease;
  const revokeGate = new Promise(resolve => { revokeRelease = resolve; });
  lib.services = {
    fetch: async () => {
      revokeWaiting += 1;
      if (revokeWaiting >= 2) revokeRelease();
      await revokeGate;
      return new Response(JSON.stringify({ name: 'Dna Name' }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  const revoke = Promise.all([grant('spokenAsk', false), grant('jevRating', true)]);
  await Promise.race([revokeGate, new Promise(resolve => setTimeout(resolve, 500))]);
  revokeRelease();
  await revoke;
  const row = JSON.parse(lib.rows('SELECT consents FROM profiles')[0].consents || '{}');
  assert.equal(row.spokenAsk, undefined);
  assert.equal(row.jevRating.version, 1);
});

test('L1 a profile save that conflicts twice fails closed', async () => {
  const { lib } = open();
  const user = caller();
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
  const post = (set) => profile.routes({ method: 'POST', parts: ['profile'], user, lib, env, body: { set } });
  const both = Promise.all([post({ name: 'Ada Example' }), post({ title: 'Delivery Lead' })]);
  await Promise.race([gate, new Promise(resolve => setTimeout(resolve, 500))]);
  release();
  await both;
  lib.services = { fetch: async () => new Response(JSON.stringify({ name: 'Dna Name' }), { status: 200, headers: { 'content-type': 'application/json' } }) };
  const rowid = lib.rows('SELECT rowid AS id FROM profiles')[0].id;
  const orig = lib.exec.bind(lib);
  let bumps = 0;
  lib.exec = (sql, ...params) => {
    if (bumps < 2 && String(sql).includes('AND updated_at = ?')) {
      bumps += 1;
      orig('UPDATE profiles SET updated_at = ? WHERE rowid = ?', 'conflict-' + bumps, rowid);
    }
    return orig(sql, ...params);
  };
  let status = 0;
  try {
    await post({ preferredName: 'Ada' });
    status = 200;
  } catch (e) {
    status = e.status || 0;
  }
  lib.exec = orig;
  assert.equal(status, 409);
  assert.equal(bumps, 2);
  const edits = JSON.parse(lib.rows('SELECT edits FROM profiles')[0].edits || '{}');
  assert.equal(edits.preferredName, undefined);
  assert.equal(edits.name.value, 'Ada Example');
  assert.equal(edits.title.value, 'Delivery Lead');
});
