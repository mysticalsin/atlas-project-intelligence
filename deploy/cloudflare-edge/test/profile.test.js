// profile.js (WOW_ZERO_CONFIG §5-§7, §9): per-field precedence you > dna > dna_export > signin > guess, the email guess
// and the on-screen first name, edits with `newer`, the DATA_MODE gate, the ASSUMED DNA pull (fake fetcher only, no
// network), people lookup, directory import and push, daily purges, the old-schema start, and the model boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as profile from '../src/profile.js';
import * as rating from '../src/rating.js';
import { featureRoutes, readyGate } from '../src/features.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { projectContext, talkerMessages } from '../src/session.js';
import * as bids from '../src/bids.js';
import * as ask from '../src/ask.js';
import { fakeModel } from '../dev/fake-model.mjs';
import { memorySql } from './sqlite.js';

const NOW = '2026-09-29T10:00:00.000Z', HOUR = 36e5, DAY = 864e5;
const ALEX = { email: 'alex.martin@example.com', role: 'user' }, BEA = { email: 'bea@example.com', role: 'user' };
const ADMIN = { email: 'tony@example.com', role: 'admin' }, REV = { email: 'rev@example.com', role: 'reviewer' }, SYS = { email: 'dna-push', role: 'system' };
const PROD = { DATA_MODE: 'production' }, PUSH = { ...PROD, DIRECTORY_PUSH_SECRET: 'push-secret' };
const ALL_READY = (w, env) => readyGate(w, env, () => true);
const batch = n => String(n).padStart(32, '0').replace(/[^0-9a-f]/g, 'a');

function world({ fetch = null } = {}) {
  const t = { clock: Date.parse(NOW) };
  t.l = new Library(memorySql(), { now: () => new Date(t.clock).toISOString(), services: fetch ? { fetch } : {} });
  return t;
}
const who = u => ({ idp: {}, mail: u.email.includes('@') ? u.email : '', ...u });
// The route as library-routes builds it, with every word READY (the registry gate itself is tested in features.test.js).
async function call(l, user, method, path, body, env = {}, { waitUntil = p => p } = {}) {
  const url = new URL('https://atlas.test/api/library/' + path);
  const ctx = { request: null, url, method, parts: url.pathname.replace('/api/library/', '').split('/').filter(Boolean), body: body || {}, user: who(user), lib: l, env, waitUntil };
  try { const r = await featureRoutes(ctx, ALL_READY); return r ? { status: r.status || 200, body: r.body } : { status: 404, body: { error: 'Not found.' } }; } // null: not a word for this role
  catch (e) { if (!e.status) throw e; return { status: e.status, body: { error: e.message } }; }
}
const importRows = (l, rows, { env = {}, id = batch(1), part = 1, final = true, user = ADMIN, confirmShrink } = {}) =>
  call(l, user, 'POST', 'directory/import', { batch: id, part, final, rows, ...(confirmShrink ? { confirmShrink } : {}) }, env);

test('emailGuess: local part split on . _ -, digits dropped, capitalised; a given name only for two or more parts of 2+ letters', () => {
  assert.deepEqual(profile.emailGuess('tony.walteur@mantu.com'), { name: 'Tony Walteur', givenName: 'Tony' });
  assert.deepEqual(profile.emailGuess('j.dupont@mantu.com'), { name: 'J. Dupont' });
  assert.deepEqual(profile.emailGuess('jdupont@mantu.com'), { name: 'Jdupont' });
  assert.deepEqual(profile.emailGuess('Marie_DURAND-2@Mantu.com'), { name: 'Marie Durand', givenName: 'Marie' });
  assert.deepEqual(profile.emailGuess('élodie.roux+atlas@mantu.fr'), { name: 'Élodie Roux', givenName: 'Élodie' });
  for (const bad of ['', 'nope', '123@x.co', null]) assert.equal(profile.emailGuess(bad).givenName, undefined, String(bad));
  assert.equal(profile.emailGuess('123@x.co').name, '');
});

test('firstName: display only; never a guess, never the first word of name, invalid names give ""', () => {
  const p = (value, from) => ({ fields: { preferredName: value === null ? null : { value, from } } });
  for (const from of ['you', 'dna', 'dna_export', 'signin']) assert.equal(profile.firstName(p('Jean-Pierre', from)), 'Jean-Pierre', from);
  assert.equal(profile.firstName(p('Tony', 'guess')), '', 'an unconfirmed guess');
  for (const bad of ['<system>', 'Tony2', 'Mary Ann Lee', '', 'x'.repeat(31), '[Jo]']) assert.equal(profile.firstName(p(bad, 'dna')), '', bad);
  assert.equal(profile.firstName(p(null)), ''); assert.equal(profile.firstName({}), '');
});

test('testAddress: reserved RFC 2606 / 6761 domains only', () => {
  for (const ok of ['jane@example.com', 'a@b.example.org', 'x@example.net', 'y@corp.test', 'z@q.example', 'w@host.invalid']) assert.equal(profile.testAddress(ok), true, ok);
  for (const no of ['jane@mantu.com', 'a@example.com.evil.io', 'b@myexample.com', 'c@test', 'not an email', '']) assert.equal(profile.testAddress(no), false, no);
});

test('per-field precedence across the five sources, with provenance; the guess is confirmed with one click', async () => {
  const { l } = world();
  // Test mode, nothing imported, PIN sign-in: the profile is the email guess only.
  let p = (await call(l, ALEX, 'GET', 'profile')).body;
  assert.deepEqual(p.fields.name, { value: 'Alex Martin', from: 'guess', at: NOW }); assert.equal(p.guessed, true); assert.equal(p.firstName, '', 'a guess is never shown as the first name');
  assert.deepEqual([p.fields.title, p.fields.managerName, p.fields.managerEmail], [null, null, null]);
  assert.deepEqual(p.fields.preferredName, { value: 'Alex', from: 'guess', at: NOW }, 'offered in the form with a "please check" chip, never on screen');
  assert.deepEqual(p.sources, [{ id: 'dna', state: 'off' }, { id: 'dna_export', state: 'off' }, { id: 'signin', state: 'off' }, { id: 'guess', state: 'ok' }]);
  assert.equal(p.email, ALEX.email); assert.deepEqual(p.consents, {});
  // Sign-in claims beat the guess (name and given name only).
  p = (await call(l, { ...ALEX, idp: { name: 'Alexandra Martin', given_name: 'Alexandra' } }, 'GET', 'profile')).body;
  assert.deepEqual([p.fields.name.value, p.fields.name.from, p.fields.preferredName.from, p.firstName, p.guessed], ['Alexandra Martin', 'signin', 'signin', 'Alexandra', false]);
  // A synthetic export (test mode accepts example.com) beats sign-in, per field.
  assert.equal((await importRows(l, [{ email: ALEX.email, name: 'MARTIN Alex', title: 'Data engineer', managerName: 'Mia Chef', managerEmail: 'mia@example.com' }])).status, 200);
  p = (await call(l, { ...ALEX, idp: { name: 'Alexandra Martin', given_name: 'Alexandra' } }, 'GET', 'profile')).body;
  assert.deepEqual(Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, v && [v.value, v.from]])), {
    name: ['MARTIN Alex', 'dna_export'], preferredName: ['Alexandra', 'signin'], title: ['Data engineer', 'dna_export'], managerName: ['Mia Chef', 'dna_export'], managerEmail: ['mia@example.com', 'dna_export'] });
  assert.equal(p.fields.title.at, NOW, 'the export date, for the chip'); assert.equal(p.firstName, 'Alexandra');
  // A DNA push row (production) beats the export, again per field: DNA gives only the title here.
  assert.equal((await call(l, SYS, 'POST', 'directory/import', { batch: batch(2), part: 1, final: true, rows: [{ email: ALEX.email, title: 'Lead data engineer' }] }, PUSH)).status, 200);
  p = (await call(l, ALEX, 'GET', 'profile', null, PUSH)).body;
  assert.deepEqual([p.fields.title.value, p.fields.title.from, p.fields.name.from], ['Lead data engineer', 'dna', 'dna_export']);
  assert.deepEqual(p.sources.slice(0, 2), [{ id: 'dna', state: 'ok' }, { id: 'dna_export', state: 'ok' }]);
  // Your own edit beats everything.
  p = (await call(l, ALEX, 'POST', 'profile', { set: { title: 'Principal', managerEmail: 'Boss@Example.com' } }, PUSH)).body;
  assert.deepEqual([p.fields.title, p.fields.managerEmail.value, p.fields.managerEmail.from], [{ value: 'Principal', from: 'you', at: NOW }, 'boss@example.com', 'you']);
  // "DUPONT Jean" style names never give a first name: without sign-in claims the export has no given name, and the
  // guess's given name is never shown on screen.
  p = (await call(l, ALEX, 'GET', 'profile', null, PUSH)).body;
  assert.deepEqual([p.fields.name.value, p.fields.preferredName.from, p.firstName], ['MARTIN Alex', 'guess', '']);

  // Guess only -> "Yes, that's me" turns the guess and its given name into your own values.
  const { l: l2 } = world();
  const g = (await call(l2, ALEX, 'POST', 'profile', { confirmGuess: true })).body;
  assert.deepEqual([g.fields.name.value, g.fields.name.from, g.fields.preferredName.value, g.fields.preferredName.from, g.firstName, g.guessed], ['Alex Martin', 'you', 'Alex', 'you', 'Alex', false]);
  assert.equal((await call(l2, ALEX, 'POST', 'profile', { confirmGuess: true })).body.fields.name.value, 'Alex Martin', 'idempotent');
  const { l: l3 } = world();
  const j = (await call(l3, { email: 'j.dupont@example.com', role: 'user' }, 'POST', 'profile', { confirmGuess: true })).body;
  assert.deepEqual([j.fields.name.value, j.fields.preferredName, j.firstName], ['J. Dupont', null, ''], 'no given name in the guess: none invented');
});

test('edits carry a basis: a later source value shows as `newer`; Keep mine re-bases, Use it clears the edit', async () => {
  const { l } = world();
  await importRows(l, [{ email: ALEX.email, name: 'Alex Martin', title: 'Data engineer' }], { id: batch(1) });
  let p = (await call(l, ALEX, 'POST', 'profile', { set: { title: 'Principal' } })).body;
  assert.equal(p.fields.title.newer, undefined, 'no newer value yet');
  assert.deepEqual(JSON.parse(l.rows('SELECT edits FROM profiles')[0].edits).title, { value: 'Principal', at: NOW, basis: 'Data engineer' });
  await importRows(l, [{ email: ALEX.email, name: 'Alex Martin', title: 'Lead data engineer' }], { id: batch(2) });
  p = (await call(l, ALEX, 'GET', 'profile')).body;
  assert.deepEqual(p.fields.title, { value: 'Principal', from: 'you', at: NOW, newer: { value: 'Lead data engineer', from: 'dna_export' } });
  p = (await call(l, ALEX, 'POST', 'profile', { set: { title: 'Principal' } })).body; // Keep mine
  assert.equal(p.fields.title.newer, undefined);
  assert.equal(JSON.parse(l.rows('SELECT edits FROM profiles')[0].edits).title.basis, 'Lead data engineer');
  p = (await call(l, ALEX, 'POST', 'profile', { clear: ['title'] })).body; // Use it
  assert.deepEqual([p.fields.title.value, p.fields.title.from], ['Lead data engineer', 'dna_export']);
  // A guess never argues with an edit.
  const { l: l2 } = world();
  p = (await call(l2, ALEX, 'POST', 'profile', { set: { name: 'Alexandre Martin' } })).body;
  assert.equal(p.fields.name.newer, undefined);
});

test('edits, clear and delete: delete removes edits and consents and leaves directory rows', async () => {
  const { l } = world();
  const T = 'abcdefab-cdef-4abc-8def-0123456789ab';
  const owner = { ...ALEX, tenant: T, tenantEnforced: true };
  const admin = { ...ADMIN, tenant: T, tenantEnforced: true };
  await importRows(l, [{ email: ALEX.email, name: 'Alex Martin', title: 'Data engineer' }], { user: admin });
  l.sql.exec("INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, '', ?, '{}', '{}', '{}', ?, ?, ?)", ALEX.email, ALEX.email, NOW, NOW, NOW);
  await call(l, owner, 'POST', 'profile', { set: { title: 'Principal', preferredName: 'Al', managerName: 'Mia Chef' } });
  await call(l, owner, 'POST', 'profile/consent', { kind: 'spokenAsk', version: 1, granted: true });
  let p = (await call(l, owner, 'POST', 'profile', { clear: ['managerName'], set: { preferredName: '' } })).body;
  assert.deepEqual([p.fields.managerName, p.fields.preferredName.from, p.fields.title.from], [null, 'guess', 'you'], 'clear and an empty value both remove the edit');
  assert.equal((await call(l, ALEX, 'POST', 'profile/delete')).status, 403);
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM profiles WHERE tenant = ''")[0].n, 1);
  assert.deepEqual((await call(l, owner, 'POST', 'profile/delete')).body, { deleted: true, vendorDeletion: 'not-asserted' });
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM profiles WHERE tenant = ?', T)[0].n, 0);
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM profiles WHERE tenant = ''")[0].n, 1);
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM directory WHERE source = 'dna_export'")[0].n, 1, 'the export row stays (admin-managed)');
  assert.deepEqual((await call(l, owner, 'GET', 'profile/consents')).body, { spokenAsk: null });
  p = (await call(l, owner, 'GET', 'profile')).body;
  assert.deepEqual([p.fields.title.value, p.fields.title.from, p.consents], ['Data engineer', 'dna_export', {}], 'sources refill the profile');
  assert.deepEqual(l.rows("SELECT action, detail FROM audit WHERE id = 'profile' ORDER BY seq").map(a => [a.action, a.detail]), [
    ['profile edited', 'fields: title, preferredName, managerName'], ['consent', 'spokenAsk granted'], ['profile edited', 'fields: managerName, preferredName'],
    ['profile deleted', 'this tenant only; directory rows unchanged']]);
  assert.doesNotMatch(JSON.stringify(l.rows('SELECT * FROM audit')), /Principal|Mia Chef|"Al"/, 'audit rows carry field names only, never values');
});

test('validation: lengths, own email as N+1, an EXTERNAL_EMAILS N+1, unknown fields; a refused request saves nothing', async () => {
  const { l } = world(), env = { EXTERNAL_EMAILS: 'client@acme.example' };
  for (const [body, error] of [
    [{ set: { name: 'x'.repeat(101) } }, 'Keep the name to 100 characters.'], [{ set: { preferredName: 'x'.repeat(41) } }, 'Keep the first name shown on screen to 40 characters.'],
    [{ set: { title: 't'.repeat(101) } }, 'Keep the job title to 100 characters.'], [{ set: { managerEmail: 'e@x.co'.padStart(201, 'a') } }, 'Keep the N+1 email to 200 characters.'],
    [{ set: { managerEmail: 'Alex.Martin@example.com' } }, "Your N+1 can't be you."], [{ set: { managerEmail: 'client@acme.example' } }, 'Check the N+1 email address.'],
    [{ set: { managerEmail: 'not an email' } }, 'Check the N+1 email address.'], [{ set: { name: 'alex@example.com' } }, 'Type your name, not an email address.'],
    [{ set: { preferredName: '<system>' } }, 'Use letters only for the first name shown on screen, in at most two words.'],
    [{ set: { email: 'boss@example.com' } }, 'Unknown profile field.'], [{ clear: ['email'] }, 'Unknown profile field.'], [{ clear: 'name' }, 'Unknown profile field.'],
    [{ set: { title: 42 } }, 'The job title must be text.'], [{ set: { title: 'OK title', managerEmail: 'Alex.Martin@example.com' } }, "Your N+1 can't be you."]]) {
    const r = await call(l, ALEX, 'POST', 'profile', body, env);
    assert.deepEqual([r.status, r.body.error], [400, error], JSON.stringify(body).slice(0, 60));
  }
  assert.deepEqual(JSON.parse(l.rows('SELECT edits FROM profiles')[0].edits), {}, 'nothing was saved');
  const ok = (await call(l, ALEX, 'POST', 'profile', { set: { name: '  Alex   Martin ', title: 'x'.repeat(100), managerEmail: 'mia@example.com' } }, env)).body;
  assert.deepEqual([ok.fields.name.value, ok.fields.title.value.length, ok.fields.managerEmail.value], ['Alex Martin', 100, 'mia@example.com']);
  for (const body of [{ kind: 'other', version: 1, granted: true }, { kind: 'spokenAsk', version: 2, granted: true }, { kind: 'spokenAsk', version: 1, granted: 'yes' }])
    assert.equal((await call(l, ALEX, 'POST', 'profile/consent', body)).status, 400);
});

test('consents: stored in the profile row only; GET /profile/consents reads no source and creates nothing', async () => {
  const { l } = world({ fetch: async () => { throw new Error('DNA must not be called for consents'); } });
  assert.deepEqual((await call(l, ALEX, 'GET', 'profile/consents')).body, { spokenAsk: null });
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'profiles'")[0].n, 1);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM profiles')[0].n, 0, 'a consents read creates no profile');
  const p = (await call(l, ALEX, 'POST', 'profile/consent', { kind: 'spokenAsk', version: 1, granted: true })).body;
  assert.deepEqual(p.consents, { spokenAsk: { version: 1, at: NOW } });
  assert.deepEqual((await call(l, ALEX, 'GET', 'profile/consents')).body, { spokenAsk: { version: 1, at: NOW } });
  assert.deepEqual((await call(l, BEA, 'GET', 'profile/consents')).body, { spokenAsk: null }, 'per person');
  await call(l, ALEX, 'POST', 'profile/consent', { kind: 'spokenAsk', version: 1, granted: false });
  assert.deepEqual((await call(l, ALEX, 'GET', 'profile/consents')).body, { spokenAsk: null }, 'revocable');
});

test('only the subject reads their profile: another user never sees it, and the profile is keyed by x-atlas-user', async () => {
  const { l } = world();
  await call(l, ALEX, 'POST', 'profile', { set: { title: 'Secret title' } });
  const bea = (await call(l, BEA, 'GET', 'profile')).body;
  assert.equal(bea.email, BEA.email); assert.doesNotMatch(JSON.stringify(bea), /Secret title|alex/i);
  const entra = { email: '11111111-2222-3333-4444-555555555555:99999999-8888-7777-6666-555555555555', mail: 'alex.martin@example.com', role: 'user' };
  const e = (await call(l, entra, 'GET', 'profile')).body;
  assert.equal(e.fields.title, null, 'the Entra key (tid:oid) is a different profile: edits under the email are not carried over');
});

test('dnaConfig: test mode, each missing variable, bad templates and maps, the header; push configured means pull is never used', () => {
  const MAP = JSON.stringify({ root: 'person', name: 'displayName', givenName: 'first', title: 'job.title' }), OK = { ...PROD, DNA_PROFILE_URL: 'https://dna.example/people/{email}', DNA_FIELD_MAP: MAP, DNA_API_KEY: 'k' };
  const test = profile.dnaConfig({});
  assert.equal(test.status, 'BLOCKED_EXTERNAL'); assert.match(test.reason, /DATA_MODE/);
  const assumed = ['DNA answers HTTPS from the public internet (Cloudflare Workers have no fixed egress IP, so an IP allow-list cannot work)',
    'authentication is a static header or bearer key (mTLS would need a new binding, which is not allowed)', 'one person can be looked up by email or Entra object id'];
  for (const k of ['DNA_PROFILE_URL', 'DNA_FIELD_MAP', 'DNA_API_KEY']) {
    const c = profile.dnaConfig({ ...OK, [k]: '' });
    assert.equal(c.status, 'BLOCKED_EXTERNAL', k); assert.match(c.reason, new RegExp(k));
    for (const need of assumed) assert.ok(c.needs.includes(need), k + ': ' + need);
    assert.ok(c.needs.includes('a production deployment (DATA_MODE=production)'));
  }
  const on = profile.dnaConfig(OK);
  assert.deepEqual([on.status, on.placeholder, on.header, on.template], ['on', 'email', 'Authorization', OK.DNA_PROFILE_URL]); assert.equal(JSON.stringify(on).includes('"k"'), false, 'the key is not in the config');
  assert.equal(profile.dnaConfig({ ...OK, DNA_PROFILE_URL: 'https://dna.example/by-oid/{oid}?fields=basic' }).placeholder, 'oid');
  assert.equal(profile.dnaConfig({ ...OK, DNA_AUTH_HEADER: 'X-DNA-Key' }).header, 'X-DNA-Key');
  for (const bad of ['http://dna.example/{email}', 'https://user:pw@dna.example/{email}', 'https://dna.example/{email}/{oid}', 'https://dna.example/p?api_key=x&e={email}',
    'https://dna.example/p?e={email}&access_token=1', 'https://{email}.dna.example/', 'https://dna.example/{name}', 'https://dna.example/{email}#x', 'https://dna.example/people', 'not a url {email}'])
    assert.equal(profile.dnaConfig({ ...OK, DNA_PROFILE_URL: bad }).status, 'BLOCKED_EXTERNAL', bad);
  for (const bad of ['{}', '{"title":"a"}', '{"name":"a b"}', '{"name":"a.b.c.d.e.f.g.h.i"}', '{"bogus":"x","name":"n"}', 'not json', '{"name":3}', '["name"]', '{"__proto__":"x","name":"n"}'])
    assert.equal(profile.dnaConfig({ ...OK, DNA_FIELD_MAP: bad }).status, 'BLOCKED_EXTERNAL', bad);
  assert.equal(profile.dnaConfig({ ...OK, DNA_AUTH_HEADER: 'Bad Header:' }).status, 'BLOCKED_EXTERNAL');
  const both = profile.dnaConfig({ ...OK, DIRECTORY_PUSH_SECRET: 's' });
  assert.equal(both.status, 'BLOCKED_EXTERNAL'); assert.match(both.reason, /push is configured/);
  assert.equal(profile.pushConfig({}).status, 'BLOCKED_EXTERNAL'); assert.match(profile.pushConfig({ DIRECTORY_PUSH_SECRET: 's' }).reason, /DATA_MODE/);
  assert.match(profile.pushConfig(PROD).reason, /DIRECTORY_PUSH_SECRET/); assert.deepEqual(profile.pushConfig(PUSH), { status: 'on' });
});

// ---- The DNA pull, ASSUMED shape, with a fake fetcher only. ----
const SECRET = 'Bearer SECRET-DNA-KEY-123';
const PULL = { ...PROD, DNA_PROFILE_URL: 'https://dna.example/people/{email}?fields=all', DNA_API_KEY: SECRET,
  DNA_FIELD_MAP: JSON.stringify({ root: 'person', name: 'displayName', givenName: 'first', title: 'job.title', managerName: 'manager.name', managerEmail: 'manager.mail' }) };
const dnaReply = (person, init = {}) => new Response(JSON.stringify({ person, salary: '999999', birthDate: '1990-01-01' }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, ...init });
const PERSON = { displayName: 'Alex Martin', first: 'Alex', job: { title: 'Data engineer' }, manager: { name: 'Mia Chef', mail: 'Mia@Example.com' }, phone: '+33 6 00 00 00 00' };
async function logged(fn) { const lines = [], log = console.log; console.log = x => lines.push(String(x)); try { return [await fn(), lines]; } finally { console.log = log; } }

test('DNA pull: mapped fields only, header-only secret, manual redirects, 3xx / oversize / non-JSON / 404 / timeout handled', async () => {
  const seen = [], { l } = world();
  const fetcher = async (url, init) => { seen.push({ url: String(url), init }); return dnaReply(PERSON); };
  const [p, lines] = await logged(() => profile.resolveProfile(l, PULL, who(ALEX), {}, { fetcher }));
  assert.deepEqual(Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, v && [v.value, v.from]])), { name: ['Alex Martin', 'dna'], preferredName: ['Alex', 'dna'],
    title: ['Data engineer', 'dna'], managerName: ['Mia Chef', 'dna'], managerEmail: ['mia@example.com', 'dna'] });
  assert.equal(p.firstName, 'Alex'); assert.deepEqual(p.sources[0], { id: 'dna', state: 'ok' });
  assert.equal(seen.length, 1); assert.equal(seen[0].url, 'https://dna.example/people/alex.martin%40example.com?fields=all');
  assert.deepEqual([seen[0].init.method, seen[0].init.redirect, seen[0].init.headers.Accept, seen[0].init.headers.Authorization], ['GET', 'manual', 'application/json', SECRET]);
  assert.ok(seen[0].init.signal instanceof AbortSignal);
  assert.deepEqual(lines.map(x => Object.keys(JSON.parse(x))), [['atlas_metric', 'ms', 'status']]); assert.equal(JSON.parse(lines[0]).status, 200);
  const stored = l.rows('SELECT * FROM directory');
  assert.deepEqual(stored.map(r => [r.key, r.source, r.name, r.given_name, r.title, r.manager_name, r.manager_email, r.batch]), [[ALEX.email, 'dna', 'Alex Martin', 'Alex', 'Data engineer', 'Mia Chef', 'mia@example.com', 'pull']]);
  assert.doesNotMatch(JSON.stringify(stored), /999999|1990|\+33/, 'only mapped fields are stored, never the raw response');
  const secretFree = JSON.stringify([seen.map(s => s.url), lines, l.rows('SELECT * FROM audit'), l.rows('SELECT * FROM profiles'), stored]);
  assert.doesNotMatch(secretFree, /SECRET-DNA-KEY/, 'the secret never appears in a URL, a log line, an audit row or storage');
  assert.doesNotMatch(lines.join(), /alex|example\.com/i, 'the log line carries numbers only');

  const outcome = async (reply, { timeoutMs } = {}) => { const w = world(); return profile.resolveProfile(w.l, PULL, who(ALEX), {}, { fetcher: reply, timeoutMs }).then(x => ({ p: x, l: w.l })); };
  for (const [name, reply] of [
    ['3xx', async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })],
    ['oversize', async () => new Response(JSON.stringify({ person: { displayName: 'x'.repeat(70000) } }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['declared oversize', async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': '70000' } })],
    ['non-JSON type', async () => new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['bad JSON', async () => new Response('{nope', { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['refused key', async () => new Response('{}', { status: 401 })], ['server error', async () => new Response('{}', { status: 500 })],
    ['network', async () => { throw new TypeError('fetch failed'); }]]) {
    const { p: x, l: wl } = await logged(() => outcome(reply)).then(r => r[0]);
    assert.deepEqual([x.sources[0], x.fields.name.from], [{ id: 'dna', state: 'error' }, 'guess'], name);
    assert.equal(wl.rows('SELECT COUNT(*) AS n FROM directory')[0].n, 0, name + ': nothing stored');
  }
  const [[missing]] = await Promise.all([logged(() => outcome(async () => new Response('{}', { status: 404 })))]);
  assert.deepEqual(missing.p.sources[0], { id: 'dna', state: 'not_found' });
  assert.equal(missing.l.rows("SELECT name FROM directory WHERE batch = 'pull'")[0].name, '', 'a miss is cached (24 h) with no values');
  // Timeout: a cold first read waits at most the cap, then answers with what it has.
  const hang = (url, init) => new Promise((_, no) => init.signal.addEventListener('abort', () => no(new Error('aborted'))));
  const t0 = Date.now(), [slow] = await logged(() => outcome(hang, { timeoutMs: 60 }));
  assert.ok(Date.now() - t0 < 1500); assert.deepEqual([slow.p.sources[0].state, slow.p.fields.name.from], ['error', 'guess']);
  const deaf = () => new Promise(() => {}); // a fetcher that ignores the abort signal is still capped
  const [slow2] = await logged(() => outcome(deaf, { timeoutMs: 60 }));
  assert.equal(slow2.p.sources[0].state, 'error');
  assert.equal(profile.DNA_TIMEOUT_MS, 2500);
});

test('DNA pull: 24 h cache, a stale value is served while waitUntil refreshes; oid lookup in Entra mode; push configured -> never called', async () => {
  let n = 0, title = 'Data engineer';
  const t = world(), fetcher = async () => { n++; return dnaReply({ ...PERSON, job: { title } }); };
  const resolve = (opts = {}) => logged(() => profile.resolveProfile(t.l, PULL, who(ALEX), {}, { fetcher, ...opts })).then(r => r[0]);
  assert.equal((await resolve()).fields.title.value, 'Data engineer'); assert.equal(n, 1);
  t.clock += 23 * HOUR; await resolve(); assert.equal(n, 1, 'fresh for 24 h');
  t.clock += 2 * HOUR; title = 'Lead data engineer';
  const pending = [], stale = await resolve({ waitUntil: p => pending.push(p) });
  assert.equal(stale.fields.title.value, 'Data engineer', 'the cached value is served at once'); assert.equal(pending.length, 1);
  await logged(() => Promise.all(pending)); assert.equal(n, 2);
  assert.equal((await resolve()).fields.title.value, 'Lead data engineer'); assert.equal(n, 2);
  // Entra: {oid} template, keyed oid:<oid>.
  const seen = [], e = world(), OID = '99999999-8888-7777-6666-555555555555';
  const entraUser = { email: '11111111-2222-3333-4444-555555555555:' + OID, mail: 'alex.martin@example.com', role: 'user' };
  await logged(() => profile.resolveProfile(e.l, { ...PULL, DNA_PROFILE_URL: 'https://dna.example/oid/{oid}' }, entraUser, {}, { fetcher: async u => { seen.push(String(u)); return dnaReply(PERSON); } }));
  assert.deepEqual(seen, ['https://dna.example/oid/' + OID]); assert.equal(e.l.rows('SELECT key FROM directory')[0].key, 'oid:' + OID);
  const pin = await profile.resolveProfile(e.l, { ...PULL, DNA_PROFILE_URL: 'https://dna.example/oid/{oid}' }, who(ALEX), {}, { fetcher: async () => { throw new Error('no oid, no call'); } });
  assert.deepEqual(pin.sources[0], { id: 'dna', state: 'off' });
  // Push configured: the pull is never called, even with every pull variable set.
  const p = world(), never = async () => { throw new Error('pull must never be called when push is configured'); };
  const got = await profile.resolveProfile(p.l, { ...PULL, DIRECTORY_PUSH_SECRET: 's' }, who(ALEX), {}, { fetcher: never });
  assert.deepEqual(got.sources[0], { id: 'dna', state: 'not_found' });
  // Test mode: never called either.
  assert.deepEqual((await profile.resolveProfile(p.l, { ...PULL, DATA_MODE: undefined }, who(ALEX), {}, { fetcher: never })).sources[0], { id: 'dna', state: 'off' });
});

test('people lookup: one exact email, name and title only, stored rows only, 30 per hour, external 403', async () => {
  const never = async () => { throw new Error('people lookup must never call DNA'); };
  const { l } = world({ fetch: never });
  await importRows(l, [{ email: 'jane@example.com', name: 'Jane Example', title: 'Analyst', managerName: 'Boss Person', managerEmail: 'boss@example.com' }]);
  await call(l, BEA, 'POST', 'profile', { set: { name: 'Bobby Secret', title: 'Hidden title' } });
  const r = await call(l, ALEX, 'GET', 'people?email=Jane@Example.com', null, PULL);
  assert.deepEqual(r, { status: 200, body: { email: 'jane@example.com', name: 'Jane Example', title: 'Analyst', from: 'dna_export' } }, 'never the N+1');
  assert.equal((await call(l, ALEX, 'GET', 'people?email=bea@example.com', null, PULL)).status, 404, 'never another user\'s profile edits');
  for (const q of ['people?email=jane', 'people?email=', 'people']) assert.equal((await call(l, ALEX, 'GET', q)).status, 400, q);
  for (const q of ['people?email=*@example.com', 'people?email=jane%25@example.com', 'people?email=%25']) assert.ok([400, 404].includes((await call(l, ALEX, 'GET', q)).status), 'no wildcard: ' + q);
  const { l: l2 } = world({ fetch: never });
  const got = []; for (let i = 0; i < 31; i++) got.push((await call(l2, ALEX, 'GET', 'people?email=nobody@example.com')).status);
  assert.deepEqual([got.slice(0, 30).every(s => s === 404), got[30]], [true, 429]);
  assert.equal((await call(l2, BEA, 'GET', 'people?email=nobody@example.com')).status, 404, 'per user');
  const ext = await call(l, { email: 'c@client.example', role: 'external' }, 'GET', 'people?email=jane@example.com');
  assert.equal(ext.status, 403);
  assert.deepEqual(profile.lookupPerson(l, 'JANE@example.com'), { email: 'jane@example.com', name: 'Jane Example', title: 'Analyst', from: 'dna_export' });
  assert.deepEqual(profile.directoryManager(l, 'jane@example.com'), { email: 'boss@example.com', name: 'Boss Person', from: 'dna_export' });
  assert.equal(profile.directoryManager(l, 'bea@example.com'), null, 'a user-edited N+1 never counts as directory');
  assert.equal(profile.lookupPerson(l, 'not an email'), null);
});

test('directory import: admin only, staged parts, final replace, row numbers without values, test mode synthetic only, unknown keys', async () => {
  const { l } = world();
  for (const u of [ALEX, REV]) assert.equal((await importRows(l, [{ email: 'a@example.com' }], { user: u })).status, 403, u.role);
  assert.equal((await call(l, ALEX, 'GET', 'directory')).status, 403); assert.equal((await call(l, REV, 'POST', 'directory/clear')).status, 403);
  const part1 = await importRows(l, [{ email: 'jane@example.com', name: 'Jane Example', title: 'Analyst' }, { email: 'jane@mantu.com', name: 'Jane Real' },
    { email: 'x@y.test', Salaire: '5000' }], { final: false });
  assert.deepEqual(part1.body, { accepted: 1, rejected: [{ row: 2, reason: 'this test deployment accepts synthetic addresses only' }, { row: 3, reason: 'unknown column' }] });
  assert.equal(profile.lookupPerson(l, 'jane@example.com'), null, 'staged rows are invisible until the final part');
  const part2 = await importRows(l, [{ email: 'not-an-email', name: 'Nobody' }, { email: 'bo@example.org', managerEmail: 'boss@mantu.com' }, { email: 'kim@corp.test', givenName: 'Kim', familyName: 'Lee' },
    { email: 'zed@example.net', managerEmail: 'Zed@example.net' }, { email: 'n@example.com', title: 7 }, 'row'], { part: 2 });
  assert.deepEqual(part2.body, { accepted: 1, rejected: [{ row: 4, reason: 'no valid email' }, { row: 5, reason: 'this test deployment accepts synthetic addresses only' },
    { row: 7, reason: 'the N+1 is the same person' }, { row: 8, reason: 'values must be text' }, { row: 9, reason: 'not a row' }], replaced: { from: 0, to: 2 } });
  assert.doesNotMatch(JSON.stringify([part1.body, part2.body]), /Jane|mantu|Nobody|5000|Kim/, 'rejections carry row numbers and reasons only');
  assert.deepEqual(profile.lookupPerson(l, 'kim@corp.test'), { email: 'kim@corp.test', name: 'Kim Lee', title: '', from: 'dna_export' }, 'a name composed from first and family name');
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM directory WHERE key LIKE '%mantu%'")[0].n, 0, 'no real address landed');
  assert.equal((await importRows(l, [])).status, 409, 'a finished batch cannot be reused');
  const prod = await importRows(l, [{ email: 'jane@mantu.com', name: 'Jane Real' }, { email: 'jane@example.com', name: 'Jane Example' }], { id: batch(3), env: PROD, confirmShrink: true });
  assert.deepEqual(prod.body, { accepted: 2, rejected: [], replaced: { from: 2, to: 2 } }, 'production accepts real addresses');
  for (const [body, error] of [[{ batch: 'x', part: 1, rows: [] }, /batch/], [{ batch: batch(4), part: 0, rows: [] }, /part/], [{ batch: batch(4), part: 41, rows: [] }, /part/],
    [{ batch: batch(4), part: 1, rows: Array(501).fill({ email: 'a@example.com' }) }, /500/], [{ batch: batch(4), part: 1, rows: {} }, /500/], [{ batch: batch(4), part: 1, rows: [], final: 'yes' }, /final/]]) {
    const r = await call(l, ADMIN, 'POST', 'directory/import', body); assert.equal(r.status, 400); assert.match(r.body.error, error);
  }
  const status = (await call(l, ADMIN, 'GET', 'directory')).body;
  assert.deepEqual([status.dataMode, status.rows, status.lastImport.source, status.lastImport.rows, status.lastImport.rejected], ['test', { dna: 0, dna_export: 2 }, 'dna_export', 2, 0]);
  assert.deepEqual(Object.keys(status.sources), ['pull', 'push', 'dna_export', 'signin']);
  assert.deepEqual([status.sources.pull.status, status.sources.push.status, status.sources.dna_export.status, status.sources.signin.status], ['BLOCKED_EXTERNAL', 'BLOCKED_EXTERNAL', 'on', 'BLOCKED_EXTERNAL']);
  assert.match(status.sources.push.reason, /test deployment/); assert.ok(status.sources.pull.needs.length >= 4);
  const prodStatus = (await call(l, ADMIN, 'GET', 'directory', null, { ...PULL, IDENTITY_SOURCE: 'entra' })).body;
  assert.deepEqual([prodStatus.dataMode, prodStatus.sources.pull.status, prodStatus.sources.signin.status], ['production', 'on', 'on']);
  assert.doesNotMatch(JSON.stringify(prodStatus), /SECRET-DNA-KEY|dna\.example/, 'the admin view never shows the key or the template');
  assert.deepEqual((await call(l, ADMIN, 'POST', 'directory/clear')).body, { cleared: 2 });
  assert.equal(profile.lookupPerson(l, 'jane@example.com'), null);
  const audit = l.rows("SELECT action, detail FROM audit WHERE id = 'directory' ORDER BY seq").map(a => a.action + ': ' + a.detail);
  assert.deepEqual(audit, ['directory_import: dna_export: 2 rows, 7 rejected, replaced 0', 'directory_import: dna_export: 2 rows, 0 rejected, replaced 2', 'directory cleared: 2 rows']);
});

test('shrink guard: a final part with M < 0.8·N answers 409 without confirmShrink and discards the staged batch; a push can never confirm', async () => {
  const { l } = world();
  const people = n => Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.com`, name: 'Person ' + i }));
  assert.deepEqual((await importRows(l, people(10), { id: batch(1) })).body.replaced, { from: 0, to: 10 });
  const r = await importRows(l, people(7), { id: batch(2) });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'This replaces 10 rows with 7. That is far fewer people than before: confirm to replace anyway.');
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM directory WHERE source LIKE 'staged:%'")[0].n, 0, 'the staged batch is discarded');
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM directory WHERE source = 'dna_export'")[0].n, 10, 'the directory is untouched');
  assert.equal(l.rows('SELECT state FROM directory_imports WHERE batch = ?', batch(2))[0].state, 'refused');
  assert.equal((await importRows(l, people(8), { id: batch(3) })).status, 200, '0.8·N exactly is not a shrink');
  assert.deepEqual((await importRows(l, people(2), { id: batch(4), confirmShrink: true })).body.replaced, { from: 8, to: 2 });
  // Push (system role, production): same import code, source dna; a shrunken push is refused even when it says confirm.
  const push = (rows, id, extra = {}) => call(l, SYS, 'POST', 'directory/import', { batch: id, part: 1, final: true, rows, ...extra }, PUSH);
  assert.deepEqual((await push(people(5), batch(5))).body.replaced, { from: 0, to: 5 });
  assert.equal((await push(people(1), batch(6), { confirmShrink: true })).status, 409);
  const status = (await call(l, ADMIN, 'GET', 'directory', null, PUSH)).body;
  assert.deepEqual([status.rows.dna, status.sources.push.status, status.sources.push.lastError], [5, 'on', 'HTTP 409'], 'the refused push shows in the admin view');
  // The system role reaches nothing else, and test mode refuses the push.
  const blocked = await call(l, SYS, 'POST', 'directory/import', { batch: batch(7), part: 1, final: true, rows: [] }, {});
  assert.equal(blocked.status, 503); assert.equal(blocked.body.status, 'BLOCKED_EXTERNAL');
  for (const [method, path] of [['GET', 'directory'], ['POST', 'directory/clear'], ['GET', 'profile']]) assert.equal((await call(l, SYS, method, path, {}, PUSH)).status, 404, path);
});

test('daily: profiles unseen for 395 days, pull-cache rows older than 30 days and staged batches older than a day; push rows stay', async () => {
  const t = world();
  // A push's final part replaces every dna row (pull caches included), so the push comes first here.
  await call(t.l, SYS, 'POST', 'directory/import', { batch: batch(1), part: 1, final: true, rows: [{ email: 'kim@example.com', name: 'Kim' }] }, PUSH);
  await logged(() => profile.resolveProfile(t.l, PULL, who(ALEX), {}, { fetcher: async () => dnaReply(PERSON) }));
  await call(t.l, BEA, 'GET', 'profile');
  await importRows(t.l, [{ email: 'lee@example.com' }], { id: batch(2), final: false });
  assert.deepEqual(profile.daily(t.l, t.l.now()), {}, 'nothing is old yet');
  t.clock += 31 * DAY;
  assert.deepEqual(profile.daily(t.l, t.l.now()), { dnaCachePurged: 1, stagedImportsPurged: 1 });
  assert.equal(profile.lookupPerson(t.l, 'kim@example.com').name, 'Kim', 'push rows are replaced by the next push, not purged');
  await call(t.l, BEA, 'GET', 'profile'); // seen today
  t.clock += 365 * DAY;
  assert.deepEqual(profile.daily(t.l, t.l.now()), { profilesPurged: 1 });
  assert.deepEqual(t.l.rows('SELECT subject FROM profiles').map(r => r.subject), [BEA.email]);
  // The system scan-stale block adds the profile counts only once profile is READY (WOW_SPEC §2.1 neutral helpers).
  const scan = await (await libraryRoutes(new Request('https://atlas.test/api/library/scan-stale', { method: 'POST', body: '{}', headers: { 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system' } }), t.l)).json();
  if (!profile.READY) assert.equal('profilesPurged' in scan || 'dnaCachePurged' in scan || 'stagedImportsPurged' in scan, false);
});

test('old schema: two Library instances on one SQL (idempotent ensure), on top of the legacy tables, no ALTER', async () => {
  const sql = memorySql();
  sql.exec('CREATE TABLE refs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_id TEXT, title TEXT, status TEXT, revision INTEGER, content_hash TEXT, practice TEXT, industry TEXT, country TEXT, manager_email TEXT, members TEXT, quality_score INTEGER, created_at TEXT, updated_at TEXT, updated_by TEXT, next_review TEXT, merged_into TEXT, data TEXT, state TEXT, embedding TEXT)');
  for (const round of [1, 2]) {
    const l = new Library(sql, { now: () => NOW });
    profile.ensure(l); profile.ensure(l);
    const p = (await call(l, ALEX, 'POST', 'profile', { set: { title: 'Round ' + round } })).body;
    assert.equal(p.fields.title.value, 'Round ' + round);
    await importRows(l, [{ email: 'r' + round + '@example.com', name: 'R' }], { id: batch(round), confirmShrink: true });
    assert.equal(profile.lookupPerson(l, 'r' + round + '@example.com').name, 'R');
  }
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM profiles').toArray()[0].n, 1);
  const cols = sql.exec('PRAGMA table_info(refs)').toArray().map(c => c.name);
  assert.equal(cols.length, 22);
  assert.equal(cols.at(-1), 'tenant', 'the story column copies a stored tenant and stays blank when none was stored');
});

test('idp claims: bounded name claims from x-atlas-idp; anything malformed is empty', () => {
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.deepEqual(profile.idpClaims(enc({ name: '  Zoë  Lefèvre ', given_name: 'Zoë', family_name: 'Lefèvre', tid: 'x', groups: ['a'] })), { name: 'Zoë Lefèvre', given_name: 'Zoë', family_name: 'Lefèvre' });
  assert.deepEqual(profile.idpClaims(enc({ given_name: 'Ana', family_name: 'Ruiz' })), { name: 'Ana Ruiz', given_name: 'Ana', family_name: 'Ruiz' });
  assert.equal(profile.idpClaims(enc({ name: 'x'.repeat(300) })).name.length, 100);
  for (const bad of ['', 'e30', '!!!', enc([1]), enc({ name: 5 }), 'a'.repeat(3000), null]) assert.deepEqual(profile.idpClaims(bad), {}, String(bad).slice(0, 10));
});

// ---- The model boundary (§0.4, §5.9): the profile never reaches a model, whatever the path. ----
test('leak: "Zelda Quintero, Principal Zebra" never reaches complete or embed across review, merge, bids and Ask; nor the talker', async () => {
  const LEAK = /zelda|quintero|principal zebra/i, ZELDA = { email: 'zelda.quintero@example.com', role: 'user' }, KAI = { email: 'kai@example.com', role: 'user' };
  const seen = [], fake = fakeModel(); let tick = 0;
  const EMBED = async t => [/claims|triage|routing|payout/i.test(t) ? 1 : 0, /retail|loyalty/i.test(t) ? 1 : 0, 0.05];
  const l = new Library(memorySql(), { now: () => new Date(Date.parse(NOW) + tick++ * 1000).toISOString(),
    complete: async m => { seen.push(JSON.stringify(m)); return fake.complete(m); }, embed: async x => { seen.push(String(x)); return EMBED(x); } });
  const p = (await call(l, ZELDA, 'POST', 'profile', { set: { name: 'Zelda Quintero', title: 'Principal Zebra' } })).body;
  assert.equal(p.fields.name.value, 'Zelda Quintero');
  // What syncToLibrary sends (the library is not a model): the full payload, consultant included (roleFrom: 'profile').
  const ref = (title, name, role, answers, people = []) => ({ title, stage: 'Production', sector: 'Insurance', consultant: { name, role }, client: { name: 'Zebracorp', location: 'Lyon', contact: '' },
    details: { projectId: '', country: 'France', consultants: people, technologies: ['Python'], deliverables: [], serviceLines: ['Data & AI'], teamRoles: [], links: [] },
    answers: [...answers, '', '', '', '', '', ''].slice(0, 6), sources: [], report: null, validation: { manager: { name: '', email: '' }, managerStaff: true } });
  const z = await l.upsert(ZELDA, { localId: 'z', reference: ref('Claims triage alias', 'Zelda Quintero', 'Principal Zebra',
    ['Claims bounced between three teams and payouts were slow for customers across the region.', 'I designed the claims routing model and ran the pilot with two teams.', 'We compared rules against a model.',
      'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.', 'Operations dashboard export v3.', 'Any insurer with manual claims routing would benefit.'],
    [{ name: 'Zelda Quintero', email: ZELDA.email, role: 'Principal Zebra' }]) });
  const k = await l.upsert(KAI, { localId: 'k', reference: ref('Payout routing alias', 'Kai Moss', 'Data engineer', ['Payout claims were slow with a manual triage queue.', 'I led the payout routing redesign with operations.']) });
  for (const id of [z.id, k.id]) await l.review({ email: 'atlas', role: 'admin' }, id);
  const merged = await l.merge(REV, { keep: k.id, merge: z.id });
  await l.review({ email: 'atlas', role: 'admin' }, merged.id);
  const row = l.row(merged.id);
  assert.match(row.data.answers[1], /Contribution by another consultant: I designed the claims routing model/);
  assert.ok(row.data.details.consultants.some(c => c.name === 'Zelda Quintero'), 'who contributed is still recorded for people');
  l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved', by: 't', at: '', note: '' } }, 't', 'validated', '');
  await l.index(merged.id);
  const u = { email: 'alex@example.com', mail: 'alex@example.com', role: 'user' }, url = path => new URL('https://atlas.test/api/library/' + path);
  const bidCall = (method, path, body) => bids.routes({ method, url: url(path), parts: path.split('/'), body, user: u, lib: l, env: {}, waitUntil: q => q });
  const bid = (await bidCall('POST', 'bids', { title: 'Prospect claims renewal', alias: 'Blue Heron', prospectNames: ['Acme Prospect'],
    briefText: 'Acme Prospect needs to fix claims triage before its renewal.\nWe need a reference showing claims routing that cut triage time.' })).body;
  const run = (await bidCall('POST', `bids/${bid.id}/match`, {})).body;
  assert.ok(run.match || run.results || run.verdict, 'the match ran');
  await bidCall('POST', `bids/${bid.id}/onepager`, { refIds: [merged.id] }).catch(e => { if (!e.status) throw e; });
  await ask.routes({ method: 'POST', parts: ['ask'], body: { question: 'Who rebuilt claims triage routing for an insurer?' }, user: u, lib: l, env: {} });
  await l.recommend(u, { query: 'An insurer with slow claims triage routing' });
  assert.ok(seen.length >= 8, 'review, index, bids, Ask and recommend all called a model: ' + seen.length);
  for (const input of seen) assert.doesNotMatch(input, LEAK);
  // The talker: an older page still sending the consultant never gets it into the prompt (session.js port of interview.py).
  const ctx = projectContext({ title: 'Claims triage', consultant: 'Zelda Quintero', role: 'Data engineer', answers: [] });
  assert.equal('consultant' in ctx, false); assert.equal(ctx.role, 'Data engineer');
  assert.doesNotMatch(JSON.stringify(talkerMessages(ctx, null, [], 'Begin.')), LEAK);
});

// ---- JEV story rating (docs/JEV_RATING.md §8.4, §13.2): the jevRating consent kind, storedConsent, storedNames. ----
test('jevRating consent: granted, read through GET /profile, revoked; GET /profile/consents is unchanged', async () => {
  const { l } = world({ fetch: async () => { throw new Error('DNA must not be called for consents'); } });
  let p = (await call(l, ALEX, 'POST', 'profile/consent', { kind: 'jevRating', version: 1, granted: true })).body;
  assert.deepEqual(p.consents, { jevRating: { version: 1, at: NOW } }, 'build() adds jevRating only when it is stored');
  assert.deepEqual((await call(l, ALEX, 'GET', 'profile')).body.consents, { jevRating: { version: 1, at: NOW } });
  assert.deepEqual((await call(l, ALEX, 'GET', 'profile/consents')).body, { spokenAsk: null }, 'the consents read still returns exactly { spokenAsk }');
  await call(l, ALEX, 'POST', 'profile/consent', { kind: 'spokenAsk', version: 1, granted: true });
  assert.deepEqual(Object.keys((await call(l, ALEX, 'GET', 'profile')).body.consents).sort(), ['jevRating', 'spokenAsk'], 'the two kinds are independent');
  p = (await call(l, ALEX, 'POST', 'profile/consent', { kind: 'jevRating', version: 1, granted: false })).body;
  assert.deepEqual(p.consents, { spokenAsk: { version: 1, at: NOW } }, 'revoked');
  for (const body of [{ kind: 'jevRating', version: 2, granted: true }, { kind: 'jevRating', version: 1, granted: 'yes' }, { kind: 'jev', version: 1, granted: true }])
    assert.equal((await call(l, ALEX, 'POST', 'profile/consent', body)).status, 400, JSON.stringify(body));
  assert.deepEqual(l.rows("SELECT detail FROM audit WHERE action = 'consent' ORDER BY seq").map(a => a.detail), ['jevRating granted', 'spokenAsk granted', 'jevRating revoked']);
});

test('storedConsent: false when nothing is stored, true after granting, per subject; creates no table', async () => {
  const { l } = world();
  const before = l.rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(r => r.name);
  assert.equal(profile.storedConsent(l, ALEX.email, 'jevRating'), false);
  assert.deepEqual(l.rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(r => r.name), before, 'a read on a fresh library creates nothing');
  await call(l, ALEX, 'POST', 'profile/consent', { kind: 'spokenAsk', version: 1, granted: true });
  assert.equal(profile.storedConsent(l, ALEX.email, 'jevRating'), false, 'another kind does not count');
  await call(l, ALEX, 'POST', 'profile/consent', { kind: 'jevRating', version: 1, granted: true });
  assert.equal(profile.storedConsent(l, ALEX.email, 'jevRating'), true);
  assert.equal(profile.storedConsent(l, BEA.email, 'jevRating'), false, 'per subject');
  assert.equal(profile.storedConsent(l, '', 'jevRating'), false);
});

test('storedNames reads the verified tenant and does not default to a blank-tenant row', () => {
  const { l } = world();
  const tenant = '11111111-1111-4111-8111-111111111111';
  profile.ensure(l);
  l.sql.exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
    VALUES ('ada@example.test', '', 'ada@example.test', '{}', '{"name":"Legacy Name"}', '{}', ?, ?, ?)`, NOW, NOW, NOW);
  l.sql.exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
    VALUES ('Ada@Example.test', ?, 'Ada@Example.test', '{}', '{"name":"Tenant Name"}', '{}', ?, ?, ?)`, tenant, NOW, NOW, NOW);
  assert.deepEqual(profile.storedNames(l, 'ada@example.test'), []);
  assert.deepEqual(profile.storedNames(l, 'ada@example.test', tenant), ['Tenant Name']);
  assert.ok(!rating.ratingInput(l, { title: 'x' }, { owner: 'ada@example.test', tenant }).terms.includes('Legacy Name'));
  assert.ok(rating.ratingInput(l, { title: 'x' }, { owner: 'ada@example.test', tenant }).terms.includes('Tenant Name'));
});

test('storedNames: the stored edit and sign-in names only, never DNA; [] without a profile', async () => {
  const { l } = world({ fetch: async () => { throw new Error('DNA must never be called'); } });
  assert.deepEqual(profile.storedNames(l, ALEX.email), [], 'no profile row');
  const env = { ...PROD, DNA_PROFILE_URL: 'https://dna.example/people/{email}', DNA_FIELD_MAP: '{"name":"n"}', DNA_API_KEY: 'k' };
  const signedIn = { ...ALEX, idp: { name: 'Alexandre Martin', given_name: 'Alexandre' } };
  await call(l, signedIn, 'GET', 'profile', null, env);
  assert.deepEqual(profile.storedNames(l, ALEX.email), ['Alexandre Martin'], 'the sign-in name');
  await call(l, signedIn, 'POST', 'profile', { set: { name: 'Alex Martin-Roux' } });
  assert.deepEqual(profile.storedNames(l, ALEX.email).sort(), ['Alex Martin-Roux', 'Alexandre Martin']);
  l.sql.exec("INSERT INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at) VALUES (?, 'dna', 'Dna Only Name', '', '', '', '', 'pull', ?)", ALEX.email, NOW);
  assert.ok(!profile.storedNames(l, ALEX.email).includes('Dna Only Name'), 'directory rows are not the person\'s stored names');
  assert.deepEqual(profile.storedNames(l, BEA.email), []);
});
