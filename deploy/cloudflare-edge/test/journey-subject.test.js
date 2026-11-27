// Live journey read and save match the same tenant-scoped, case-insensitive subject as erasure.
// Mixed-case duplicates are left in place. Read and save use one row: newest updated_at, then greatest rowid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { ensureJourney, journeyView, saveJourney, JOURNEY_READ_SQL, JOURNEY_ALL_SQL, JOURNEY_COUNT_SQL, JOURNEY_DELETE_SQL, JOURNEY_UPDATE_SQL } from '../src/journey.js';
import { privacyRoutes } from '../src/operate.js';
import { ensure as ensureProfile, routes as profileRoutes } from '../src/profile.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function lib() {
  return new Library(memorySql(), { now: () => '2026-11-08T00:00:00.000Z' });
}

function lowerUser(tenant = TENANT) {
  return { email: 'ada@example.test', role: 'user', tenant, tenantEnforced: true };
}

function seed(library, subject, tenant, title, updated) {
  ensureJourney(library);
  sqlOf(library).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', subject, tenant,
    JSON.stringify({ version: 1, fields: { title: { value: title, source: 'you', confirmed: true } }, confirmed: {}, stage: 'project' }), updated);
}

function titlesOf(library, tenant) {
  return library.rows('SELECT subject, payload, updated_at FROM journey WHERE tenant = ? ORDER BY rowid', tenant)
    .map(row => ({ subject: row.subject, title: JSON.parse(row.payload).fields.title.value, updated_at: row.updated_at }));
}

async function exported(library, email, tenant) {
  const response = await libraryRoutes(new Request('https://atlas.test/api/library/privacy/export', {
    headers: { 'x-atlas-user': email, 'x-atlas-role': 'user', 'x-atlas-email': email, 'x-atlas-tenant': tenant, 'x-atlas-tenant-enforced': '1' },
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
  return response.json();
}

async function erased(library, email, tenant) {
  const response = await libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', {
    method: 'POST', body: '{}',
    headers: { 'x-atlas-user': email, 'x-atlas-role': 'user', 'x-atlas-email': email, 'x-atlas-tenant': tenant, 'x-atlas-tenant-enforced': '1' },
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
  return response.json();
}

function exportTitles(journey) {
  const rows = Array.isArray(journey) ? journey : [journey].filter(Boolean);
  return rows.map(row => row?.fields?.title?.value).filter(Boolean);
}

test('a lower-case sign-in reads a mixed-case journey row', () => {
  const library = lib();
  seed(library, 'Ada@Example.test', TENANT, 'Alias', '2026-11-01T00:00:00.000Z');
  assert.equal(journeyView(library, lowerUser()).fields.title?.value, 'Alias');
});

test('save updates a mixed-case journey instead of inserting a duplicate', async () => {
  const library = lib();
  seed(library, 'Ada@Example.test', TENANT, 'Alias', '2026-11-01T00:00:00.000Z');
  await saveJourney(library, lowerUser(), { stage: 'project', fields: { title: { value: 'Edited', source: 'you', confirmed: true } } });
  const rows = titlesOf(library, TENANT);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows, [{ subject: 'Ada@Example.test', title: 'Edited', updated_at: '2026-11-08T00:00:00.000Z' }]);
});

test('read of two mixed-case rows is the newest updated_at, then the greatest rowid', () => {
  const library = lib();
  seed(library, 'Ada@Example.test', TENANT, 'Older', '2026-11-01T00:00:00.000Z');
  seed(library, 'ADA@example.test', TENANT, 'Newer', '2026-11-02T00:00:00.000Z');
  assert.equal(journeyView(library, lowerUser()).fields.title?.value, 'Newer');
  const tied = lib();
  seed(tied, 'Ada@Example.test', TENANT, 'First', '2026-11-03T00:00:00.000Z');
  seed(tied, 'ADA@example.test', TENANT, 'Second', '2026-11-03T00:00:00.000Z');
  assert.equal(journeyView(tied, lowerUser()).fields.title?.value, 'Second');
});

test('save updates only the row the read rule picks and leaves the other duplicate', async () => {
  const library = lib();
  seed(library, 'Ada@Example.test', TENANT, 'Older', '2026-11-01T00:00:00.000Z');
  seed(library, 'ADA@example.test', TENANT, 'Newer', '2026-11-02T00:00:00.000Z');
  await saveJourney(library, lowerUser(), { stage: 'project', fields: { title: { value: 'Edited', source: 'you', confirmed: true } } });
  assert.deepEqual(titlesOf(library, TENANT), [
    { subject: 'Ada@Example.test', title: 'Older', updated_at: '2026-11-01T00:00:00.000Z' },
    { subject: 'ADA@example.test', title: 'Edited', updated_at: '2026-11-08T00:00:00.000Z' },
  ]);
});

test('export and erasure take every matching journey row and never another tenant', async () => {
  const library = lib();
  seed(library, 'Ada@Example.test', TENANT, 'Older', '2026-11-01T00:00:00.000Z');
  seed(library, 'ADA@example.test', TENANT, 'Newer', '2026-11-02T00:00:00.000Z');
  seed(library, 'ada@example.test', OTHER, 'Other tenant', '2026-11-04T00:00:00.000Z');
  const pack = await exported(library, 'ada@example.test', TENANT);
  assert.deepEqual(exportTitles(pack.journey).sort(), ['Newer', 'Older']);
  assert.deepEqual(pack.omitted, { count: 0, rows: [] });
  assert.equal(JSON.stringify(pack).includes('Other tenant'), false);
  const body = await erased(library, 'ada@example.test', TENANT);
  assert.equal(body.outcomes.find(item => item.store === 'journey').removed, 2);
  assert.deepEqual(titlesOf(library, TENANT), []);
  assert.deepEqual(titlesOf(library, OTHER), [{ subject: 'ada@example.test', title: 'Other tenant', updated_at: '2026-11-04T00:00:00.000Z' }]);
});

test('another tenant is not read or saved as this sign-in', async () => {
  const library = lib();
  seed(library, 'Ada@Example.test', OTHER, 'Other tenant', '2026-11-01T00:00:00.000Z');
  assert.equal(journeyView(library, lowerUser()).fields.title?.value, undefined);
  await saveJourney(library, lowerUser(), { stage: 'project', fields: { title: { value: 'Mine', source: 'you', confirmed: true } } });
  assert.deepEqual(titlesOf(library, OTHER), [{ subject: 'Ada@Example.test', title: 'Other tenant', updated_at: '2026-11-01T00:00:00.000Z' }]);
  assert.deepEqual(titlesOf(library, TENANT), [{ subject: 'ada@example.test', title: 'Mine', updated_at: '2026-11-08T00:00:00.000Z' }]);
  const pack = await exported(library, 'ada@example.test', TENANT);
  assert.deepEqual(exportTitles(pack.journey), ['Mine']);
  assert.equal(JSON.stringify(pack).includes('Other tenant'), false);
});

test('a malformed or non-object journey payload does not fail the export', async () => {
  const library = lib();
  seedRaw(library, 'Ada@Example.test', TENANT, '{', '2026-11-04T00:00:00.000Z');
  seedRaw(library, 'ADA@example.test', TENANT, '[]', '2026-11-04T00:00:01.000Z');
  seed(library, 'ada@example.test', TENANT, 'Kept', '2026-11-05T00:00:00.000Z');
  seedRaw(library, 'Ada@Example.test', OTHER, '{', '2026-11-04T00:00:00.000Z');
  const response = await libraryRoutes(new Request('https://atlas.test/api/library/privacy/export', {
    headers: { 'x-atlas-user': 'ada@example.test', 'x-atlas-role': 'user', 'x-atlas-email': 'ada@example.test', 'x-atlas-tenant': TENANT, 'x-atlas-tenant-enforced': '1' },
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.journey.length, 1);
  assert.deepEqual(exportTitles(body.journey), ['Kept']);
  const ids = library.rows('SELECT rowid AS id, payload FROM journey WHERE tenant = ? ORDER BY updated_at DESC, rowid DESC', TENANT);
  const unparsed = ids.filter(row => row.payload === '{' || row.payload === '[]').map(row => row.id);
  const other = library.rows('SELECT rowid AS id FROM journey WHERE tenant = ?', OTHER)[0].id;
  assert.deepEqual(body.omitted, { count: 2, rows: unparsed.map(id => ({ id, source: 'journey', reason: 'unparseable' })) });
  assert.equal(body.omitted.rows.some(row => row.id === other), false);
  const direct = await privacyRoutes({
    method: 'GET', parts: ['privacy', 'export'], user: lowerUser(), lib: library, env: { DATA_MODE: 'production' },
  });
  assert.deepEqual(direct.body.omitted, body.omitted);
  assert.equal(direct.body.journey.length, 1);
});

test('an unreadable story is named in the same export omission as an unreadable journey', async () => {
  const library = lib();
  seedRaw(library, 'Ada@Example.test', TENANT, '{', '2026-11-04T00:00:00.000Z');
  seed(library, 'ada@example.test', TENANT, 'Kept', '2026-11-05T00:00:00.000Z');
  seedStory(library, 'kept-story', TENANT, JSON.stringify({ version: 1, tenant: TENANT }), 'Kept story');
  seedStory(library, 'brace-story', TENANT, '{', 'Brace');
  seedStory(library, 'array-story', TENANT, '[]', 'Array');
  seedStory(library, 'other-brace', OTHER, '{', 'Other brace');
  seedStory(library, 'other-kept', OTHER, JSON.stringify({ version: 1, tenant: OTHER }), 'Other tenant story');
  seedStory(library, 'foreign-brace', TENANT, '{', 'Foreign brace', 'other@example.test');
  const response = await libraryRoutes(new Request('https://atlas.test/api/library/privacy/export', {
    headers: { 'x-atlas-user': 'ada@example.test', 'x-atlas-role': 'user', 'x-atlas-email': 'ada@example.test', 'x-atlas-tenant': TENANT, 'x-atlas-tenant-enforced': '1' },
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.stories.map(row => row.id), ['kept-story']);
  assert.equal(body.stories[0].title, 'Kept story');
  const journeyId = library.rows('SELECT rowid AS id, payload FROM journey WHERE tenant = ?', TENANT).find(row => row.payload === '{').id;
  assert.deepEqual(body.omitted, {
    count: 3,
    rows: [
      { id: journeyId, source: 'journey', reason: 'unparseable' },
      { id: 'array-story', source: 'story', reason: 'unparseable' },
      { id: 'brace-story', source: 'story', reason: 'unparseable' },
    ],
  });
  for (const id of ['other-brace', 'other-kept', 'foreign-brace', 'kept-story']) assert.equal(body.omitted.rows.some(row => row.id === id), false);
  assert.equal(JSON.stringify(body).includes('Other tenant story'), false);
  const direct = await privacyRoutes({
    method: 'GET', parts: ['privacy', 'export'], user: lowerUser(), lib: library, env: { DATA_MODE: 'production' },
  });
  assert.deepEqual(direct.body.omitted, body.omitted);
  assert.deepEqual(direct.body.stories.map(row => row.id), ['kept-story']);
});

test('export keeps the journey row subject and updatedAt when the payload repeats them', async () => {
  const library = lib();
  seedRaw(library, 'Ada@Example.test', TENANT, JSON.stringify({
    subject: 'evil@example.test', updatedAt: '1999-01-01T00:00:00.000Z', version: 1,
    fields: { title: { value: 'Kept', source: 'you', confirmed: true } }, confirmed: {}, stage: 'project',
  }), '2026-11-04T00:00:00.000Z');
  const response = await libraryRoutes(new Request('https://atlas.test/api/library/privacy/export', {
    headers: { 'x-atlas-user': 'ada@example.test', 'x-atlas-role': 'user', 'x-atlas-email': 'ada@example.test', 'x-atlas-tenant': TENANT, 'x-atlas-tenant-enforced': '1' },
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.journey.length, 1);
  assert.equal(body.journey[0].subject, 'Ada@Example.test');
  assert.equal(body.journey[0].updatedAt, '2026-11-04T00:00:00.000Z');
  assert.equal(body.journey[0].fields.title.value, 'Kept');
});

function seedStory(library, id, tenant, state, title, owner = 'ada@example.test') {
  sqlOf(library).exec(`INSERT INTO refs (id, owner, local_id, title, status, revision, content_hash, data, state, members, created_at, updated_at, next_review, tenant)
    VALUES (?, ?, ?, ?, 'in_review', 1, 'h', '{}', ?, ',', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', ?)`,
  id, owner, id, title, state, tenant);
}

function seedProfile(library, tenant, edits, consents, subject = 'ada@example.test') {
  ensureProfile(library);
  sqlOf(library).exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
    VALUES (?, ?, ?, ?, '{}', ?, '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z')`,
  subject, tenant, subject, edits, consents);
}

function seedRaw(library, subject, tenant, payload, updated) {
  ensureJourney(library);
  sqlOf(library).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', subject, tenant, payload, updated);
}

test('a missing profile stays null and an unreadable profile part is omitted', async () => {
  const problems = [];
  const check = async (label, fn) => {
    try { await fn(); }
    catch (error) { problems.push(label + ': ' + error.message); }
  };
  await check('missing table', async () => {
    const library = lib();
    assert.equal(library.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profiles'").length, 0);
    const body = await exported(library, 'ada@example.test', TENANT);
    assert.equal(body.profile, null);
    assert.deepEqual(body.omitted, { count: 0, rows: [] });
  });
  await check('no row', async () => {
    const library = lib();
    ensureProfile(library);
    seedProfile(library, OTHER, '{', '{"hidden":true}');
    const body = await exported(library, 'ada@example.test', TENANT);
    assert.equal(body.profile, null);
    assert.deepEqual(body.omitted, { count: 0, rows: [] });
    assert.equal(JSON.stringify(body).includes('hidden'), false);
  });
  await check('bad edits', async () => {
    const library = lib();
    seedProfile(library, TENANT, '{', '{"spokenAsk":true}');
    const body = await exported(library, 'ada@example.test', TENANT);
    assert.equal(body.profile.edits, undefined);
    assert.deepEqual(body.profile.consents, { spokenAsk: true });
    assert.equal(body.profile.updatedAt, '2026-11-08T00:00:00.000Z');
    assert.deepEqual(body.omitted, { count: 1, rows: [{ id: 'edits', source: 'profile', reason: 'unparseable' }] });
  });
  await check('bad consents', async () => {
    const library = lib();
    seedProfile(library, TENANT, '{"title":{"value":"Kept"}}', '[');
    const body = await exported(library, 'ada@example.test', TENANT);
    assert.deepEqual(body.profile.edits, { title: { value: 'Kept' } });
    assert.equal(body.profile.consents, undefined);
    assert.equal(body.profile.updatedAt, '2026-11-08T00:00:00.000Z');
    assert.deepEqual(body.omitted, { count: 1, rows: [{ id: 'consents', source: 'profile', reason: 'unparseable' }] });
    const direct = await privacyRoutes({
      method: 'GET', parts: ['privacy', 'export'], user: lowerUser(), lib: library, env: { DATA_MODE: 'production' },
    });
    assert.deepEqual(direct.body.omitted, body.omitted);
    assert.deepEqual(direct.body.profile, body.profile);
  });
  await check('both parts unreadable', async () => {
    const library = lib();
    seedProfile(library, TENANT, '{', '[]');
    const body = await exported(library, 'ada@example.test', TENANT);
    assert.deepEqual(body.profile, { updatedAt: '2026-11-08T00:00:00.000Z' });
    assert.deepEqual(body.omitted, {
      count: 2,
      rows: [
        { id: 'edits', source: 'profile', reason: 'unparseable' },
        { id: 'consents', source: 'profile', reason: 'unparseable' },
      ],
    });
  });
  assert.deepEqual(problems, []);
});

const LETTERED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function privacyHeaders(tenant, email = 'ada@example.test') {
  return { 'x-atlas-user': email, 'x-atlas-role': 'user', 'x-atlas-email': email, 'x-atlas-tenant': tenant, 'x-atlas-tenant-enforced': '1' };
}

async function privacyExport(library, tenant = TENANT, email = 'ada@example.test') {
  return libraryRoutes(new Request('https://atlas.test/api/library/privacy/export', {
    headers: privacyHeaders(tenant, email),
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
}

async function privacyDelete(library, tenant = TENANT) {
  return libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', {
    method: 'POST', body: '{}', headers: privacyHeaders(tenant),
  }), library, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
}

function insertProfile(library, subject, tenant, edits, updated = '2026-11-01T00:00:00.000Z') {
  sqlOf(library).exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
    VALUES (?, ?, ?, ?, '{}', '{}', '2026-11-01T00:00:00.000Z', ?, ?)`, subject, tenant, subject, edits, updated, updated);
}

test('a legacy profile schema does not fail the export, and folded profile rows are named', async () => {
  const problems = [];
  const check = async (label, fn) => {
    try { await fn(); }
    catch (error) { problems.push(label + ': ' + error.message); }
  };
  await check('legacy table', async () => {
    const library = lib();
    seed(library, 'ada@example.test', TENANT, 'Kept', '2026-11-05T00:00:00.000Z');
    sqlOf(library).exec(`CREATE TABLE profiles (subject TEXT PRIMARY KEY, email TEXT, edits TEXT, signin TEXT, consents TEXT, created_at TEXT, updated_at TEXT, seen_at TEXT)`);
    sqlOf(library).exec(`INSERT INTO profiles (subject, email, edits, signin, consents, created_at, updated_at, seen_at)
      VALUES ('ada@example.test', 'ada@example.test', '{"title":{"value":"Legacy"}}', '{}', '{}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
    const response = await privacyExport(library);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(exportTitles(body.journey), ['Kept']);
    assert.equal(body.profile, null);
    assert.equal(JSON.stringify(body).includes('Legacy'), false);
    const stored = library.rows('SELECT rowid AS id, subject, tenant FROM profiles');
    assert.deepEqual(stored.map(row => ({ subject: row.subject, tenant: row.tenant })), [{ subject: 'ada@example.test', tenant: '' }]);
    assert.deepEqual(body.omitted, { count: 1, rows: [{ id: stored[0].id, source: 'profile', reason: 'legacy_unscoped' }] });
    const erased = await (await privacyDelete(library)).json();
    assert.equal(erased.outcomes.find(item => item.store === 'profile').removed, 0);
    assert.deepEqual(library.rows('SELECT subject, tenant FROM profiles'), [{ subject: 'ada@example.test', tenant: '' }]);
    const again = await (await privacyExport(library)).json();
    assert.equal(again.profile, null);
    assert.equal(JSON.stringify(again).includes('Legacy'), false);
    assert.deepEqual(again.omitted, { count: 1, rows: [{ id: stored[0].id, source: 'profile', reason: 'legacy_unscoped' }] });
  });
  await check('mixed-case subject', async () => {
    const library = lib();
    seedProfile(library, TENANT, '{"title":{"value":"Kept"}}', '{}', 'Ada@Example.test');
    const body = await (await privacyExport(library)).json();
    assert.deepEqual(body.profile.edits, { title: { value: 'Kept' } });
    assert.deepEqual(body.omitted, { count: 0, rows: [] });
  });
  await check('uppercase tenant', async () => {
    const library = lib();
    seedProfile(library, LETTERED.toUpperCase(), '{"title":{"value":"Upper"}}', '{}');
    const body = await (await privacyExport(library, LETTERED)).json();
    assert.deepEqual(body.profile.edits, { title: { value: 'Upper' } });
    assert.deepEqual(body.omitted, { count: 0, rows: [] });
  });
  await check('folded duplicates', async () => {
    const library = lib();
    ensureProfile(library);
    sqlOf(library).exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
      VALUES ('Ada@Example.test', ?, 'Ada@Example.test', '{"title":{"value":"Older"}}', '{}', '{}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`, TENANT);
    sqlOf(library).exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
      VALUES ('ADA@example.test', ?, 'ADA@example.test', '{"title":{"value":"Newer"}}', '{}', '{}', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z')`, TENANT);
    const older = library.rows("SELECT rowid AS id FROM profiles WHERE subject = 'Ada@Example.test'")[0].id;
    const body = await (await privacyExport(library)).json();
    assert.deepEqual(body.profile.edits, { title: { value: 'Newer' } });
    assert.equal(body.profile.updatedAt, '2026-11-03T00:00:00.000Z');
    assert.deepEqual(body.omitted, { count: 1, rows: [{ id: older, source: 'profile', reason: 'duplicate' }] });
  });
  await check('other sql still fails the export', async () => {
    const library = lib();
    ensureProfile(library);
    const rows = library.rows.bind(library);
    library.rows = (q, ...p) => {
      if (String(q).includes('FROM profiles')) throw new Error('disk I/O error');
      return rows(q, ...p);
    };
    const response = await privacyExport(library);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, 'The library could not complete that request.');
  });
  assert.deepEqual(problems, []);
});

test('export and erasure share one profile match, and a broken migration does not drop the row', async () => {
  const problems = [];
  const check = async (label, fn) => {
    try { await fn(); }
    catch (error) { problems.push(label + ': ' + error.message); }
  };
  await check('unscoped names the row and skips another tenant', async () => {
    const library = lib();
    ensureProfile(library);
    insertProfile(library, 'ada@example.test', '', '{"title":{"value":"Legacy"}}');
    insertProfile(library, 'ada@example.test', OTHER, '{"title":{"value":"Secret"}}');
    const body = await (await privacyExport(library)).json();
    assert.equal(body.profile, null);
    assert.equal(JSON.stringify(body).includes('Legacy'), false);
    assert.equal(JSON.stringify(body).includes('Secret'), false);
    const id = library.rows("SELECT rowid AS id FROM profiles WHERE tenant = ''")[0].id;
    assert.deepEqual(body.omitted, { count: 1, rows: [{ id, source: 'profile', reason: 'legacy_unscoped' }] });
  });
  await check('erasure removes every folded row in this tenant only', async () => {
    const library = lib();
    ensureProfile(library);
    insertProfile(library, 'Ada@Example.test', LETTERED, '{"title":{"value":"One"}}', '2026-11-01T00:00:00.000Z');
    insertProfile(library, 'ADA@example.test', '\t' + LETTERED.toUpperCase() + ' ', '{"title":{"value":"Two"}}', '2026-11-03T00:00:00.000Z');
    insertProfile(library, 'ada@example.test', OTHER, '{"title":{"value":"Foreign"}}');
    const erased = await (await privacyDelete(library, LETTERED)).json();
    assert.equal(erased.outcomes.find(item => item.store === 'profile').removed, 2);
    const body = await (await privacyExport(library, LETTERED)).json();
    assert.equal(body.profile, null);
    assert.deepEqual(body.omitted, { count: 0, rows: [] });
    assert.equal(JSON.stringify(body).includes('Foreign'), false);
    const foreign = library.rows('SELECT edits FROM profiles');
    assert.equal(foreign.length, 1);
    assert.equal(JSON.parse(foreign[0].edits).title.value, 'Foreign');
  });
  await check('a profile read keeps the folded legacy edits', async () => {
    const library = lib();
    ensureProfile(library);
    insertProfile(library, 'Ada@Example.test', '\t' + TENANT, '{"title":{"value":"LEGACYEDIT"}}', '2026-11-01T00:00:00.000Z');
    const user = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true, idp: {} };
    const read = await profileRoutes({ method: 'GET', parts: ['profile'], user, lib: library, env: { DATA_MODE: 'production' }, body: {} });
    assert.equal(read.body.fields.title.value, 'LEGACYEDIT');
    const body = await (await privacyExport(library)).json();
    assert.deepEqual(body.profile.edits, { title: { value: 'LEGACYEDIT' } });
    assert.deepEqual(body.omitted, { count: 0, rows: [] });
    const rows = library.rows('SELECT subject, tenant, edits FROM profiles');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject, 'ada@example.test');
    assert.equal(rows[0].tenant, TENANT);
    assert.equal(JSON.parse(rows[0].edits).title.value, 'LEGACYEDIT');
  });
  await check('a profiles_v2 left by a failed migration is recovered', async () => {
    const library = lib();
    sqlOf(library).exec(`CREATE TABLE profiles_v2 (
      subject TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT '', email TEXT, edits TEXT, signin TEXT, consents TEXT,
      created_at TEXT, updated_at TEXT, seen_at TEXT, PRIMARY KEY (subject, tenant))`);
    sqlOf(library).exec(`INSERT INTO profiles_v2 (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
      VALUES ('ada@example.test', ?, 'ada@example.test', '{"title":{"value":"Recovered"}}', '{}', '{}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`, TENANT);
    const response = await privacyExport(library);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.profile.edits, { title: { value: 'Recovered' } });
    assert.equal(library.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profiles_v2'").length, 0);
  });
  await check('a rename failure does not drop the profile', async () => {
    const library = lib();
    sqlOf(library).exec(`CREATE TABLE profiles (subject TEXT, tenant TEXT, email TEXT, edits TEXT, signin TEXT, consents TEXT, created_at TEXT, updated_at TEXT, seen_at TEXT)`);
    sqlOf(library).exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
      VALUES ('ada@example.test', ?, 'ada@example.test', '{"title":{"value":"Kept"}}', '{}', '{}', '2026-11-01T00:00:00.000Z', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`, TENANT);
    const exec = sqlOf(library).exec.bind(sqlOf(library));
    sqlOf(library).exec = (q, ...p) => {
      if (String(q).includes('RENAME TO profiles')) throw new Error('rename failed');
      return exec(q, ...p);
    };
    assert.equal((await privacyExport(library)).status, 500);
    sqlOf(library).exec = exec;
    const body = await (await privacyExport(library)).json();
    assert.deepEqual(body.profile.edits, { title: { value: 'Kept' } });
  });
  await check('legacy duplicate subjects keep the newer parsed time', async () => {
    const library = lib();
    sqlOf(library).exec(`CREATE TABLE profiles (subject TEXT, tenant TEXT, email TEXT, edits TEXT, signin TEXT, consents TEXT, created_at TEXT, updated_at TEXT, seen_at TEXT)`);
    sqlOf(library).exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
      VALUES ('ada@example.test', ?, 'ada@example.test', '{"title":{"value":"Newer"}}', '{}', '{}', '2026-11-01T00:00:00.000Z', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`, TENANT);
    sqlOf(library).exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
      VALUES ('ada@example.test', ?, 'ada@example.test', '{"title":{"value":"Older"}}', '{}', '{}', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`, TENANT);
    const response = await privacyExport(library);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.profile.edits, { title: { value: 'Newer' } });
    assert.equal(body.profile.updatedAt, '2026-11-10T00:00:00.000Z');
    assert.deepEqual(body.omitted, { count: 1, rows: [{ id: 2, source: 'profile', reason: 'duplicate' }] });
    assert.equal(JSON.stringify(body).includes('Older'), false);
  });
  await check('folded rows sort by parsed time, not text or rowid', async () => {
    const library = lib();
    ensureProfile(library);
    insertProfile(library, 'Ada@Example.test', TENANT, '{"title":{"value":"Newer"}}', '2026-11-10T00:00:00.000Z');
    insertProfile(library, 'ADA@example.test', TENANT, '{"title":{"value":"Older"}}', '2026-11-02T00:00:00.000Z');
    const body = await (await privacyExport(library)).json();
    assert.deepEqual(body.profile.edits, { title: { value: 'Newer' } });
    assert.equal(body.profile.updatedAt, '2026-11-10T00:00:00.000Z');
    const older = library.rows("SELECT rowid AS id FROM profiles WHERE subject = 'ADA@example.test'")[0].id;
    assert.deepEqual(body.omitted, { count: 1, rows: [{ id: older, source: 'profile', reason: 'duplicate' }] });
  });
  await check('a null timestamp loses and an equal timestamp keeps the greatest rowid', async () => {
    const dated = lib();
    ensureProfile(dated);
    insertProfile(dated, 'ada@example.test', TENANT, '{"title":{"value":"Dated"}}', '2026-11-03T00:00:00.000Z');
    insertProfile(dated, 'ADA@example.test', TENANT, '{"title":{"value":"Undated"}}', null);
    const datedBody = await (await privacyExport(dated)).json();
    assert.deepEqual(datedBody.profile.edits, { title: { value: 'Dated' } });
    const tied = lib();
    ensureProfile(tied);
    insertProfile(tied, 'ada@example.test', TENANT, '{"title":{"value":"First"}}', '2026-11-03T00:00:00.000Z');
    insertProfile(tied, 'ADA@example.test', TENANT, '{"title":{"value":"Second"}}', '2026-11-03T00:00:00.000Z');
    const tiedBody = await (await privacyExport(tied)).json();
    assert.deepEqual(tiedBody.profile.edits, { title: { value: 'Second' } });
    assert.equal(tiedBody.omitted.rows[0].id, 1);
    assert.equal(tiedBody.omitted.rows[0].reason, 'duplicate');
    const bad = lib();
    ensureProfile(bad);
    insertProfile(bad, 'ada@example.test', TENANT, '{"title":{"value":"Real"}}', '2026-11-02T00:00:00.000Z');
    insertProfile(bad, 'ADA@example.test', TENANT, '{"title":{"value":"Garbage"}}', 'not-a-date');
    const badBody = await (await privacyExport(bad)).json();
    assert.deepEqual(badBody.profile.edits, { title: { value: 'Real' } });
  });
  await check('a tab-padded tenant matches', async () => {
    const library = lib();
    ensureProfile(library);
    insertProfile(library, 'ada@example.test', '\t' + TENANT, '{"title":{"value":"Tabbed"}}');
    const body = await (await privacyExport(library)).json();
    assert.deepEqual(body.profile.edits, { title: { value: 'Tabbed' } });
    assert.deepEqual(body.omitted, { count: 0, rows: [] });
  });
  await check('the fold is JavaScript lower, not SQLite ASCII lower', async () => {
    const library = lib();
    ensureProfile(library);
    const stored = 'İda@Example.test';
    insertProfile(library, stored, TENANT, '{"title":{"value":"Folded"}}');
    const direct = await privacyRoutes({
      method: 'GET', parts: ['privacy', 'export'],
      user: { email: stored.toLowerCase(), mail: stored.toLowerCase(), role: 'user', tenant: TENANT, tenantEnforced: true },
      lib: library, env: { DATA_MODE: 'production' },
    });
    assert.deepEqual(direct.body.profile.edits, { title: { value: 'Folded' } });
  });
  assert.deepEqual(problems, []);
});

test('journey read, save, export and erasure plans use the subject index and do not scan', () => {
  const library = lib();
  ensureJourney(library);
  const args = ['ada@example.test', TENANT];
  const plans = {
    read: library.rows('EXPLAIN QUERY PLAN ' + JOURNEY_READ_SQL, ...args),
    export: library.rows('EXPLAIN QUERY PLAN ' + JOURNEY_ALL_SQL, ...args),
    count: library.rows('EXPLAIN QUERY PLAN ' + JOURNEY_COUNT_SQL, ...args),
    delete: library.rows('EXPLAIN QUERY PLAN ' + JOURNEY_DELETE_SQL, ...args),
    update: library.rows('EXPLAIN QUERY PLAN ' + JOURNEY_UPDATE_SQL, '{}', '2026-11-08T00:00:00.000Z', 1),
  };
  for (const [name, rows] of Object.entries(plans)) {
    const text = rows.map(row => row.detail).join('\n');
    assert.equal(text.includes('SCAN journey'), false, name + '\n' + text);
    assert.equal(text.includes('SEARCH journey USING'), true, name + '\n' + text);
    if (name === 'update') assert.match(text, /INTEGER PRIMARY KEY/, name + '\n' + text);
    else assert.equal(text.includes('journey_tenant_subject'), true, name + '\n' + text);
  }
});

const DIRECTORY = `CREATE TABLE directory (
  key TEXT NOT NULL, source TEXT NOT NULL, name TEXT, given_name TEXT, title TEXT,
  manager_name TEXT, manager_email TEXT, batch TEXT, fetched_at TEXT, tenant TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (key, source))`;
const DIRECTORY_V2 = `CREATE TABLE directory_v2 (
  key TEXT NOT NULL, source TEXT NOT NULL, name TEXT, given_name TEXT, title TEXT,
  manager_name TEXT, manager_email TEXT, batch TEXT, fetched_at TEXT, tenant TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (key, source, tenant))`;
const PROFILE_V2 = `CREATE TABLE profiles_v2 (
  subject TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT '', email TEXT, edits TEXT, signin TEXT, consents TEXT,
  created_at TEXT, updated_at TEXT, seen_at TEXT, PRIMARY KEY (subject, tenant))`;

function seedDirectory(library, table, name) {
  sqlOf(library).exec(`INSERT INTO ${table} (key, source, name, tenant) VALUES ('ada@example.test', 'dna', ?, '')`, name);
}

test('a DROP TABLE directory failure does not make the next export return 500', async () => {
  const drop = lib();
  sqlOf(drop).exec(DIRECTORY);
  seedDirectory(drop, 'directory', 'Kept');
  const exec = sqlOf(drop).exec.bind(sqlOf(drop));
  sqlOf(drop).exec = (q, ...args) => {
    if (String(q).trim() === 'DROP TABLE directory') throw new Error('drop failed');
    return exec(q, ...args);
  };
  assert.equal((await privacyExport(drop)).status, 500);
  sqlOf(drop).exec = exec;
  assert.equal((await privacyExport(drop)).status, 200);
  assert.deepEqual(drop.rows('SELECT name FROM directory').map(row => row.name), ['Kept']);
});

test('a directory rename failure does not leave the live table empty', async () => {
  const rename = lib();
  sqlOf(rename).exec(DIRECTORY);
  seedDirectory(rename, 'directory', 'Kept');
  const exec = sqlOf(rename).exec.bind(sqlOf(rename));
  sqlOf(rename).exec = (q, ...args) => {
    if (String(q).includes('directory_v2 RENAME TO directory')) throw new Error('rename failed');
    return exec(q, ...args);
  };
  assert.equal((await privacyExport(rename)).status, 500);
  sqlOf(rename).exec = exec;
  assert.equal((await privacyExport(rename)).status, 200);
  assert.deepEqual(rename.rows('SELECT name FROM directory').map(row => row.name), ['Kept']);
});

test('a directory that already has both the live table and directory_v2 still exports', async () => {
  const both = lib();
  sqlOf(both).exec(DIRECTORY);
  sqlOf(both).exec(DIRECTORY_V2);
  seedDirectory(both, 'directory', 'Kept');
  seedDirectory(both, 'directory_v2', 'Kept');
  assert.equal((await privacyExport(both)).status, 200);
  assert.deepEqual(both.rows('SELECT name FROM directory').map(row => row.name), ['Kept']);
  assert.equal(both.rows("SELECT name FROM sqlite_master WHERE name = 'directory_v2'").length, 0);
});

test('a stranded directory_v2 is renamed back to directory', () => {
  const stranded = lib();
  sqlOf(stranded).exec(DIRECTORY_V2);
  seedDirectory(stranded, 'directory_v2', 'Recovered');
  ensureProfile(stranded);
  assert.deepEqual(stranded.rows('SELECT name FROM directory').map(row => row.name), ['Recovered']);
  assert.equal(stranded.rows("SELECT name FROM sqlite_master WHERE name = 'directory_v2'").length, 0);
});

test('profile storage without transactionSync is refused before any migration', () => {
  const sql = memorySql();
  const bare = { exec: (...args) => sql.exec(...args) };
  assert.throws(() => new Library(bare, { now: () => '2026-11-08T00:00:00.000Z' }), /atomic/);
  assert.equal(sql.exec("SELECT name FROM sqlite_master WHERE name = 'profiles'").toArray().length, 0);
});

test('a populated profiles_v2 is not dropped when the live profiles table already has rows', () => {
  const library = lib();
  sqlOf(library).exec(PROFILE_V2.replace('CREATE TABLE profiles_v2', 'CREATE TABLE profiles'));
  sqlOf(library).exec(PROFILE_V2);
  const stamp = '2026-11-08T00:00:00.000Z';
  for (const [table, title] of [['profiles', 'Live'], ['profiles_v2', 'Parked']]) {
    sqlOf(library).exec(`INSERT INTO ${table} (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
      VALUES (?, ?, 'ada@example.test', ?, '{}', '{}', ?, ?, ?)`, 'ada@example.test', TENANT, JSON.stringify({ title: { value: title } }), stamp, stamp, stamp);
  }
  let error = null;
  try { ensureProfile(library); } catch (e) { error = e; }
  assert.equal(library.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'profiles_v2'")[0].n, 1, 'populated profiles_v2 was dropped');
  assert.match(String(error && error.message), /profiles_v2/);
  assert.equal(library.rows('SELECT COUNT(*) AS n FROM profiles')[0].n, 1);
});
