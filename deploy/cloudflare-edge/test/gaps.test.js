// F2 gap requests (WOW_SPEC §F2.1, §F2.2, §F2.8): gaps.js on the real Library (node:sqlite), the real masking (scrub.js)
// and the real bid renderer (bids.js). Routes are exercised through the registry with a readiness test that is always
// on (so these tests run whatever READY says) while keeping the Entra rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as gaps from '../src/gaps.js';
import * as bids from '../src/bids.js';
import * as outreach from '../src/outreach.js';
import * as features from '../src/features.js';
import * as profile from '../src/profile.js';
import { pseudonymise } from '../src/scrub.js';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { FIELDS } from '../src/policy.generated.js';
import { memorySql } from './sqlite.js';

const U = (email, role = 'user') => ({ email, mail: email, role });
const OWNER = U('olivia@mantu.com'), ADMIN = U('tony@mantu.com', 'admin'), REV = U('rev@mantu.com', 'reviewer');
const ALEX = U('alex@mantu.com'), SAM = U('sam@mantu.com'), KIM = U('kim@mantu.com');
const NAMES = /Acme|Zebracorp|Jane Doe|zebracorp\.example|olivia|Olivia/;
const ON = (word, env) => features.readyGate(word, env, () => true);

async function call(lib, method, path, user, body = {}, env = {}) {
  const url = new URL('https://atlas.test/api/library/' + path), parts = url.pathname.replace(/^\/api\/library\/?/, '').split('/').filter(Boolean);
  const ctx = { request: new Request(url, { method }), url, method, parts, body, user, lib, env, waitUntil: p => p };
  try { const r = await features.featureRoutes(ctx, ON); return { status: r.status || 200, body: r.body }; }
  catch (e) { if (!e.status) throw e; return { status: e.status, body: { error: e.message } }; }
}

let clock;
async function setup(sql = memorySql()) {
  clock = '2026-09-01T00:00:00.000Z';
  const lib = new Library(sql, { now: () => clock });
  const saved = await lib.upsert(ALEX, { localId: 'z', reference: { title: 'Claims triage', client: { name: 'Zebracorp', contact: 'Jane Doe' },
    consultant: { name: 'Alex Martin', role: 'Lead' }, details: { projectId: 'OPP-42', consultants: [{ name: 'Sam Lee', email: 'sam@mantu.com', role: 'Analyst' }, { name: 'Noa Nomail', role: 'Dev' }] } } });
  sqlOf(lib).exec("UPDATE refs SET status = 'published' WHERE id = ?", saved.id); // readable by everyone at the public level
  bids.ensure(lib);
  let map = {};
  const pz = t => { const p = pseudonymise(lib, t, { prospects: ['Acme Prospect'], map }); map = p.map; return p.text; };
  const alias = pz('Zebracorp-style renewal');
  const reqs = [['R1', 'Claims routing for Acme Prospect, like Zebracorp', 'capability'], ['R2', 'Measured cycle-time cut', 'outcome'], ['R3', 'ISO 27001 audit report', 'credential'],
    ['R4', 'Workflow redesign', 'capability'], ['R5', 'Automation', 'capability'], ['R6', 'Insurance claims', 'sector'], ['R7', 'On-premise only', 'constraint'],
    ['R8', 'A second audit', 'credential'], ['R9', 'Odd', 'mystery']].map(([id, text, kind]) => ({ id, text: pz(text), kind, must: true }));
  sqlOf(lib).exec(`INSERT INTO bids (id, owner, owner_mail, title, alias, prospects, brief, pseudo, requirements, customer, req_method, status, outcome, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'b1', OWNER.email, OWNER.email, 'Acme Prospect claims bid', alias, JSON.stringify(['Acme Prospect']),
    'Brief text', JSON.stringify(map), JSON.stringify(reqs), '{}', 'manual', 'open', 'pending', clock, clock);
  return { lib, sql, ref: saved.id };
}
const ask = (lib, requirementIds, assignee, user = OWNER, env = {}) => call(lib, 'POST', 'gaps', user, { bidId: 'b1', requirementIds, assignee }, env);

test('create, assign and permissions: bid owner or admin create; assignee, creator, reviewer and admin read; everyone else 404', async () => {
  const { lib, ref } = await setup();
  const r = await ask(lib, ['R1', 'R2'], { refId: ref, person: 0 });
  assert.equal(r.status, 201);
  const g = r.body;
  assert.match(g.id, /^[a-f0-9]{32}$/); assert.equal(g.bidId, 'b1'); assert.deepEqual(g.requirementIds, ['R1', 'R2']); assert.equal(g.status, 'open');
  assert.equal(g.referenceId, ref); assert.equal(g.results, null); assert.equal(g.assigneeName, 'Alex Martin');
  assert.deepEqual(g.draft.subject, 'Can you give 5 minutes of proof for a bid?'); assert.equal(g.draft.link, 'https://atlas.test/go/gap/' + g.id, 'a /go/ link that survives sign-in (WOW_ZERO_CONFIG §3.9)');
  assert.ok(g.draft.body.includes('https://atlas.test/go/gap/' + g.id) && g.draft.body.includes('2 specific proof points'));
  assert.equal((await ask(lib, ['R1'], { email: 'lee@mantu.com' }, ADMIN)).status, 201, 'an admin may ask on any bid');
  for (const who of [REV, KIM, ALEX]) assert.equal((await ask(lib, ['R1'], { email: 'kim@mantu.com' }, who)).status, 404, who.email);
  for (const who of [ALEX, OWNER, REV, ADMIN]) assert.equal((await call(lib, 'GET', 'gaps/' + g.id, who)).status, 200, who.email);
  for (const who of [KIM, SAM, { email: 'alex@mantu.com', mail: '', role: 'user' }]) assert.equal((await call(lib, 'GET', 'gaps/' + g.id, who)).status, 404, who.email);
  assert.deepEqual((await call(lib, 'GET', 'gaps', ALEX)).body.assigned.map(x => x.id), [g.id]);
  assert.deepEqual((await call(lib, 'GET', 'gaps', OWNER)).body.created.map(x => x.id), [g.id]);
  assert.deepEqual((await call(lib, 'GET', 'gaps', KIM)).body, { assigned: [], created: [], assignedPage: { truncated: false, limit: 100, next: null }, createdPage: { truncated: false, limit: 100, next: null } });
  assert.equal((await call(lib, 'GET', 'gaps/' + 'f'.repeat(32), ADMIN)).status, 404);
  assert.equal((await call(lib, 'GET', 'gaps/not-an-id', ADMIN)).status, 404);
  assert.equal((await call(lib, 'PUT', 'gaps/' + g.id, ADMIN)).status, 404);
  assert.equal((await call(lib, 'GET', `gaps/${g.id}/interview/x`, ALEX)).status, 404);
  const env = { ORIGIN: 'https://atlas.example' };
  assert.equal((await ask(lib, ['R3'], { email: 'kim@mantu.com' }, OWNER, env)).body.draft.link.startsWith('https://atlas.example/go/gap/'), true);
});

test('{refId, person}: 0 is the reference owner, n a listed consultant; a missing email or person is a 400; public access needed; the email only for full access', async () => {
  const { lib, ref } = await setup();
  const owner = await ask(lib, ['R1'], { refId: ref, person: 0 }, ADMIN);
  assert.deepEqual([owner.body.assigneeEmail, owner.body.assigneeName], ['alex@mantu.com', 'Alex Martin'], 'an admin has full access: the email is returned');
  const sam = await ask(lib, ['R1'], { refId: ref, person: 1 }, OWNER);
  assert.equal(sam.status, 201); assert.equal(sam.body.assigneeName, 'Sam Lee');
  assert.ok(!('assigneeEmail' in sam.body) && sam.body.draft.to === '', 'the owner of the bid only sees the reference publicly: no email');
  assert.ok(!JSON.stringify(sam.body).includes('sam@mantu.com'));
  assert.ok(!('assigneeEmail' in (await call(lib, 'GET', 'gaps/' + sam.body.id, OWNER)).body));
  assert.equal((await call(lib, 'GET', 'gaps/' + sam.body.id, SAM)).body.assigneeEmail, 'sam@mantu.com', 'the assignee sees their own email');
  assert.equal((await call(lib, 'GET', 'gaps/' + sam.body.id, ADMIN)).body.assigneeEmail, 'sam@mantu.com');
  assert.ok(!('assigneeEmail' in (await call(lib, 'GET', 'gaps/' + sam.body.id, REV)).body), 'reviewers see the name only');
  assert.deepEqual((await ask(lib, ['R1'], { refId: ref, person: 2 })).body, { error: 'This person has no email on the reference; type their email.' });
  for (const person of [3, -1, 1.5, '1', null]) assert.equal((await ask(lib, ['R1'], { refId: ref, person })).status, 400, String(person));
  assert.equal((await ask(lib, ['R1'], { refId: ref, person: 1 }, OWNER, { EXTERNAL_EMAILS: 'client@acme.example, SAM@mantu.com' })).status, 400, 'never an external contact');
  assert.equal((await ask(lib, ['R1'], { email: 'Client@Acme.example' }, OWNER, { EXTERNAL_EMAILS: 'client@acme.example' })).status, 400);
  for (const assignee of [{ email: 'not-an-email' }, {}, null, { refId: 'missing', person: 0 }]) assert.ok([400, 404].includes((await ask(lib, ['R1'], assignee)).status));
  const typed = await ask(lib, ['R1'], { email: ' Kim@Mantu.com ' });
  assert.equal(typed.body.assigneeEmail, 'kim@mantu.com'); assert.equal(typed.body.draft.to, 'kim@mantu.com'); assert.ok(!('assigneeName' in typed.body));
  sqlOf(lib).exec("UPDATE refs SET status = 'in_review' WHERE id = ?", ref);
  assert.deepEqual((await ask(lib, ['R1'], { refId: ref, person: 0 })).body, { error: 'Reference not found.' }, 'at least public access to the reference');
  assert.equal((await call(lib, 'POST', 'gaps', OWNER, { bidId: 'b1', requirementIds: ['R1'], assignee: { email: 'kim@mantu.com' }, referenceId: ref })).status, 404);
});

// WOW_ZERO_CONFIG §5.8: a blank assignee name comes from the stored directory rows only (dna, dna_export).
test('Z assignee name: a blank name is filled from stored directory rows only; never from anyone\'s profile edits, never a typed name overwritten', async () => {
  const { lib, ref } = await setup(), at = '2026-09-01T00:00:00.000Z';
  profile.ensure(lib);
  const dir = (key, source, name) => sqlOf(lib).exec('INSERT OR REPLACE INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    key, source, name, '', 'Data lead', 'Boss', 'boss@mantu.com', 'b1', at);
  sqlOf(lib).exec('INSERT INTO profiles (subject, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'lee@mantu.com', 'lee@mantu.com',
    JSON.stringify({ name: { value: 'Lee From Profile', at, basis: '' } }), '{}', '{}', at, at, at);
  const lee = await ask(lib, ['R1'], { email: 'lee@mantu.com' });
  assert.equal(lee.status, 201); assert.ok(!('assigneeName' in lee.body), 'a profile edit is never read for someone else');
  dir('kim@mantu.com', 'dna_export', 'Kim Park');
  const kim = await ask(lib, ['R1'], { email: 'kim@mantu.com' });
  if (!profile.READY) { assert.ok(!('assigneeName' in kim.body), 'a stub while the profile module is not READY'); return; }
  assert.equal(kim.body.assigneeName, 'Kim Park', 'typed email, name from the DNA export row');
  assert.deepEqual(gaps.listForBid(lib, OWNER, 'b1').find(x => x.id === kim.body.id).assigneeName, 'Kim Park');
  dir('kim@mantu.com', 'dna', 'Kim Park-Lee');
  assert.equal((await ask(lib, ['R1'], { email: 'kim@mantu.com' })).body.assigneeName, 'Kim Park-Lee', 'dna before dna_export');
  dir('alex@mantu.com', 'dna', 'Directory Alex');
  assert.equal((await ask(lib, ['R1'], { refId: ref, person: 0 })).body.assigneeName, 'Alex Martin', 'a name on the reference is kept');
  assert.ok(!JSON.stringify((await ask(lib, ['R1'], { email: 'kim@mantu.com' })).body).includes('Data lead'), 'the name only, never the title or the N+1');
});

test('requirement kind -> field: one field per ask, a collision takes the next field, none left is "Split these into two requests."', async () => {
  const { lib } = await setup();
  const fields = async ids => { const r = await ask(lib, ids, { email: 'kim@mantu.com' }); return r.status === 201 ? r.body.asks.map(a => [a.id, a.field, a.label]) : r.body.error; };
  assert.deepEqual(await fields(['R1']), [['G1', 'contribution', FIELDS.contribution[0]]]);
  assert.deepEqual(await fields(['R1', 'R4']), [['G1', 'contribution', FIELDS.contribution[0]], ['G2', 'intervention', FIELDS.intervention[0]]]);
  assert.deepEqual(await fields(['R2', 'R3', 'R6']), [['G1', 'outcome', FIELDS.outcome[0]], ['G2', 'evidence', FIELDS.evidence[0]], ['G3', 'problem', FIELDS.problem[0]]]);
  assert.deepEqual((await fields(['R6', 'R7'])).map(x => x[1]), ['problem', 'customer_fit']);
  assert.deepEqual((await fields(['R7', 'R6'])).map(x => x[1]), ['customer_fit', 'problem']);
  assert.equal(await fields(['R1', 'R4', 'R5']), 'Split these into two requests.');
  assert.equal(await fields(['R3', 'R8']), 'Split these into two requests.');
  assert.equal(await fields(['R9']), 'Unknown requirement kind.');
  for (const ids of [[], ['R1', 'R2', 'R3', 'R4'], ['R1', 'R1'], [1], 'R1']) assert.equal((await ask(lib, ids, { email: 'kim@mantu.com' })).status, 400, JSON.stringify(ids));
  assert.equal((await ask(lib, ['R99'], { email: 'kim@mantu.com' })).status, 404);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM gap_requests')[0].n, 5, 'refused requests store nothing');
});

test('masking: prospect and library client never reach the assignee, reviewers, the talker, outreach previews, the draft or the audit; the bid owner sees their own words', async () => {
  const { lib, ref } = await setup();
  const created = (await ask(lib, ['R1', 'R2'], { refId: ref, person: 0 })).body;
  assert.equal(created.asks[0].ask, 'Proof the bid needs: Claims routing for Acme Prospect, like Zebracorp', 'the bid owner: author view');
  assert.equal(created.bidAlias, 'Zebracorp-style renewal');
  assert.equal((await call(lib, 'GET', 'gaps/' + created.id, ADMIN)).body.asks[0].ask, created.asks[0].ask, 'admins are authors of every bid');
  for (const who of [ALEX, REV]) {
    const g = (await call(lib, 'GET', 'gaps/' + created.id, who)).body;
    assert.equal(g.asks[0].ask, 'Proof the bid needs: Claims routing for [company], like [company]', who.email);
    assert.equal(g.bidAlias, '[company]-style renewal');
    assert.doesNotMatch(JSON.stringify(g), NAMES, who.email);
  }
  const talker = (await call(lib, 'GET', `gaps/${created.id}/interview`, ALEX)).body;
  assert.doesNotMatch(JSON.stringify(talker), NAMES);
  assert.doesNotMatch(created.draft.body + created.draft.subject, NAMES); assert.doesNotMatch(created.draft.body, /Alex|Martin/, 'the draft names nobody');
  if (outreach.READY) {
    const rows = lib.rows("SELECT channel, status, payload FROM outreach WHERE kind = 'gap_request' AND subject_id = ?", created.id);
    assert.deepEqual(rows.map(o => [o.channel, o.status]).sort(), [['email_draft', 'pending_approval'], ['teams', 'pending_approval']], 'queued, never sent');
    for (const o of rows) assert.doesNotMatch(o.payload, NAMES);
    assert.deepEqual(created.outreach.map(o => o.channel).sort(), ['email_draft', 'teams']);
  } else assert.deepEqual(created.outreach, []);
  assert.doesNotMatch(lib.rows('SELECT asks FROM gap_requests WHERE id = ?', created.id)[0].asks, NAMES, 'stored in placeholder form');
  for (const a of lib.rows('SELECT action, detail FROM audit')) assert.doesNotMatch(a.detail, NAMES, a.action);
});

test('the interview route: the assignee only, an open request only, always the other view', async () => {
  const { lib, ref } = await setup();
  const g = (await ask(lib, ['R1', 'R2'], { refId: ref, person: 0 })).body;
  const r = await call(lib, 'GET', `gaps/${g.id}/interview`, ALEX);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { asks: [{ id: 'G1', field: 'contribution', label: FIELDS.contribution[0], ask: 'Proof the bid needs: Claims routing for [company], like [company]' },
    { id: 'G2', field: 'outcome', label: FIELDS.outcome[0], ask: 'Proof the bid needs: Measured cycle-time cut' }], bidAlias: '[company]-style renewal', referenceId: ref, projectId: 'OPP-42' });
  for (const who of [OWNER, ADMIN, REV, KIM, SAM, { email: 'alex@mantu.com', mail: '', role: 'admin' }]) assert.equal((await call(lib, 'GET', `gaps/${g.id}/interview`, who)).status, 404, who.email);
  const d = (await ask(lib, ['R3'], { email: 'alex@mantu.com' })).body;
  assert.equal((await call(lib, 'POST', `gaps/${d.id}/dismiss`, ALEX, {})).status, 200);
  assert.equal((await call(lib, 'GET', `gaps/${d.id}/interview`, ALEX)).status, 404, 'dismissed');
  assert.equal((await call(lib, 'GET', `gaps/${g.id}/interview`, ALEX)).body.projectId, 'OPP-42');
  const typed = (await ask(lib, ['R3'], { email: 'kim@mantu.com' })).body;
  assert.deepEqual([(await call(lib, 'GET', `gaps/${typed.id}/interview`, KIM)).body.referenceId, (await call(lib, 'GET', `gaps/${typed.id}/interview`, KIM)).body.projectId], [null, null]);
  clock = '2026-10-02T00:00:00.000Z'; // 31 days later
  assert.equal((await call(lib, 'GET', `gaps/${g.id}/interview`, ALEX)).status, 404, 'expired (even before the daily sweep)');
  assert.equal((await call(lib, 'GET', 'gaps/' + g.id, OWNER)).body.status, 'expired');
});

test('answers: sent by the assignee only, pseudonymised with a request map, own words back to the assignee, uniform labels for the bid team, audit without text', async () => {
  const { lib, ref } = await setup();
  const g = (await ask(lib, ['R1', 'R2', 'R3'], { refId: ref, person: 0 })).body;
  const refBefore = lib.rows('SELECT status, revision, content_hash FROM refs WHERE id = ?', ref)[0];
  const said = 'We did this for Zebracorp; mail jane@zebracorp.example for the audit.';
  const body = { results: [{ askId: 'G1', status: 'answered_unverified', quotes: ['  ' + said + '  ', 'x'.repeat(900), 'three', 'four', 'five', 'six', 'seven'] },
    { askId: 'G2', status: 'unknown', quotes: ["I don't know."] }], referenceId: ref };
  for (const [who, status] of [[OWNER, 404], [KIM, 404], [ADMIN, 404]]) assert.equal((await call(lib, 'POST', `gaps/${g.id}/answer`, who, body)).status, status, who.email);
  for (const bad of [{ results: [{ askId: 'G9', status: 'open', quotes: [] }] }, { results: [{ askId: 'G1', status: 'verified', quotes: [] }] }, { results: [] }, {}])
    assert.equal((await call(lib, 'POST', `gaps/${g.id}/answer`, ALEX, bad)).status, 400, JSON.stringify(bad));
  const mine = await call(lib, 'POST', `gaps/${g.id}/answer`, ALEX, body);
  assert.equal(mine.status, 200); assert.equal(mine.body.status, 'answered'); assert.equal(mine.body.answeredAt, clock);
  assert.deepEqual(mine.body.results.map(r => [r.askId, r.status, r.provenance]), [['G1', 'answered_unverified', 'unverified_speech_recognition'],
    ['G2', 'unknown', 'unverified_speech_recognition'], ['G3', 'open', 'unverified_speech_recognition']]);
  assert.deepEqual(mine.body.results[0].quotes, [said, 'x'.repeat(400), 'three', 'four', 'five'], 'their own words back: trimmed, at most 5, 400 characters each');
  const stored = lib.rows('SELECT results, pseudo FROM gap_requests WHERE id = ?', g.id)[0];
  assert.doesNotMatch(stored.results, NAMES); assert.match(stored.pseudo, /Zebracorp/);
  for (const who of [OWNER, REV, ADMIN]) {
    const seen = (await call(lib, 'GET', 'gaps/' + g.id, who)).body;
    assert.equal(seen.results[0].quotes[0], 'We did this for [company]; mail [contact] for the audit.', who.email);
    assert.doesNotMatch(JSON.stringify(seen.results), NAMES);
  }
  assert.equal((await call(lib, 'GET', 'gaps/' + g.id, ALEX)).body.results[0].quotes[0], said);
  const audit = lib.rows("SELECT actor, detail FROM audit WHERE action = 'gap answered'");
  assert.deepEqual(audit, [{ actor: 'alex@mantu.com', detail: 'answered 1, unknown 1, deferred 0, open 1' }]);
  assert.equal((await call(lib, 'POST', `gaps/${g.id}/answer`, ALEX, body)).status, 409, 'answered once');
  assert.deepEqual(lib.rows('SELECT status, revision, content_hash FROM refs WHERE id = ?', ref)[0], refBefore, 'a reference never changes');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1, 'no new reference');
  assert.equal((await call(lib, 'GET', `gaps/${g.id}/interview`, ALEX)).status, 404, 'no second interview');
});

test('dismiss: the assignee or the creator, an open request only', async () => {
  const { lib } = await setup();
  const a = (await ask(lib, ['R1'], { email: 'alex@mantu.com' })).body, b = (await ask(lib, ['R2'], { email: 'alex@mantu.com' })).body;
  for (const who of [KIM, REV, ADMIN]) assert.equal((await call(lib, 'POST', `gaps/${a.id}/dismiss`, who, {})).status, 404, who.email);
  assert.equal((await call(lib, 'POST', `gaps/${a.id}/dismiss`, ALEX, { note: 'Not my project, sorry.' })).body.status, 'dismissed');
  assert.equal((await call(lib, 'POST', `gaps/${a.id}/dismiss`, ALEX, {})).status, 409);
  assert.equal((await call(lib, 'POST', `gaps/${b.id}/dismiss`, OWNER, {})).body.status, 'dismissed');
  assert.deepEqual(lib.rows("SELECT detail FROM audit WHERE action = 'gap dismissed' ORDER BY seq").map(r => r.detail), ['by assignee', 'by creator']);
  assert.deepEqual((await call(lib, 'GET', 'gaps', ALEX)).body.assigned, [], 'only open requests are listed as assigned');
});

test('listForBid: summaries for the bid owner, reviewers and admins only, never an email', async () => {
  const { lib, ref } = await setup();
  const g = (await ask(lib, ['R1', 'R2'], { refId: ref, person: 1 })).body;
  const expected = [{ id: g.id, requirementIds: ['R1', 'R2'], status: 'open', assigneeName: 'Sam Lee', answeredAt: null }];
  for (const who of [OWNER, REV, ADMIN]) assert.deepEqual(gaps.listForBid(lib, who, 'b1'), gaps.READY ? expected : [], who.email);
  for (const [who, bid] of [[KIM, 'b1'], [SAM, 'b1'], [OWNER, 'nope'], [null, 'b1']]) assert.deepEqual(gaps.listForBid(lib, who, bid), []);
});

// resolveForInterview talks to a fake LibraryStore binding that turns the forwarded headers into the caller, exactly as
// library-routes.js does, and serves the real gaps.js route.
function fakeEnv(lib, seen, respond = null) {
  return { LIBRARY: { idFromName: name => { seen.push(['idFromName', name]); return 'do:' + name; },
    get: id => ({ fetch: async req => {
      seen.push([id, req.method, req.url, Object.fromEntries(req.headers)]);
      if (respond) return respond(req);
      const user = { email: req.headers.get('x-atlas-user') || '', mail: (req.headers.get('x-atlas-email') || '').toLowerCase(), role: req.headers.get('x-atlas-role') || 'user', tenant: req.headers.get('x-atlas-tenant') || '', tenantEnforced: req.headers.get('x-atlas-tenant-enforced') === '1' };
      const r = await call(lib, req.method, new URL(req.url).pathname.replace('/api/library/', ''), user);
      return new Response(JSON.stringify(r.body), { status: r.status });
    } }) } };
}
test('resolveForInterview: the verified identity only; spoofed or foreign identities, bad ids and library failures give null', async () => {
  const { lib, ref } = await setup();
  const g = (await ask(lib, ['R1', 'R2'], { refId: ref, person: 0 })).body, seen = [];
  const got = await gaps.resolveForInterview(fakeEnv(lib, seen), { user: 'alex@mantu.com', role: 'user', mail: 'alex@mantu.com' }, g.id);
  assert.deepEqual(got, (await call(lib, 'GET', `gaps/${g.id}/interview`, ALEX)).body);
  assert.doesNotMatch(JSON.stringify(got), NAMES);
  assert.deepEqual(seen, [['idFromName', 'global'], ['do:global', 'GET', `https://atlas.internal/api/library/gaps/${g.id}/interview`,
    { 'x-atlas-email': 'alex@mantu.com', 'x-atlas-role': 'user', 'x-atlas-tenant': '', 'x-atlas-tenant-enforced': '0', 'x-atlas-user': 'alex@mantu.com' }]]);
  assert.ok(await gaps.resolveForInterview(fakeEnv(lib, []), { user: 'alex@mantu.com', role: 'user', mail: 'ALEX@mantu.com' }, g.id), 'the email is compared lower-cased');
  for (const identity of [{ user: 'alex@mantu.com', role: 'admin', mail: 'kim@mantu.com' }, { user: 'olivia@mantu.com', role: 'user', mail: 'olivia@mantu.com' },
    { user: 'alex@mantu.com', role: 'user', mail: '' }, { user: 'tony@mantu.com', role: 'admin', mail: 'tony@mantu.com' }])
    assert.equal(await gaps.resolveForInterview(fakeEnv(lib, []), identity, g.id), null, JSON.stringify(identity));
  const none = [];
  for (const [env, identity, id] of [[fakeEnv(lib, none), { user: 'alex@mantu.com\r\nx-atlas-role: admin', role: 'user', mail: 'alex@mantu.com' }, g.id],
    [fakeEnv(lib, none), { user: 'alex@mantu.com', role: 'user', mail: 'alex@mantu.com' }, g.id.toUpperCase()], [fakeEnv(lib, none), { user: 'alex@mantu.com', mail: 'alex@mantu.com' }, '../x'],
    [fakeEnv(lib, none), { user: '', mail: 'alex@mantu.com' }, g.id], [{}, { user: 'alex@mantu.com', mail: 'alex@mantu.com' }, g.id], [undefined, null, g.id]])
    assert.equal(await gaps.resolveForInterview(env, identity, id), null);
  assert.equal(none.filter(x => x[0] !== 'idFromName').length, 0, 'nothing was fetched for a bad id, identity or binding');
  const id = { user: 'alex@mantu.com', role: 'user', mail: 'alex@mantu.com' };
  for (const respond of [() => { throw new Error('down'); }, () => new Response('{}', { status: 500 }), () => new Response('not json'), () => new Response('{"asks":[]}'), () => new Response('null')])
    assert.equal(await gaps.resolveForInterview(fakeEnv(lib, [], respond), id, g.id), null);
});

const LEGACY = [
  `CREATE TABLE refs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_id TEXT, title TEXT, status TEXT, revision INTEGER, content_hash TEXT,
    practice TEXT, industry TEXT, country TEXT, manager_email TEXT, members TEXT, quality_score INTEGER, created_at TEXT, updated_at TEXT, updated_by TEXT,
    next_review TEXT, merged_into TEXT, data TEXT, state TEXT, embedding TEXT)`,
  'CREATE TABLE revisions (id TEXT, revision INTEGER, data TEXT, author TEXT, at TEXT, PRIMARY KEY (id, revision))',
  'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)',
  'CREATE TABLE invitations (id TEXT PRIMARY KEY, email TEXT, project_id TEXT, title TEXT, reason TEXT, slot TEXT, reference_id TEXT, status TEXT, created_at TEXT, source TEXT)',
];
test('expire: open requests older than 30 days, with its own ensure, on a fresh schema and on an old one; ensure is idempotent', async () => {
  const { lib, sql } = await setup();
  const old = (await ask(lib, ['R1'], { email: 'alex@mantu.com' })).body, answered = (await ask(lib, ['R2'], { email: 'alex@mantu.com' })).body;
  await call(lib, 'POST', `gaps/${answered.id}/answer`, ALEX, { results: [{ askId: 'G1', status: 'unknown', quotes: [] }] });
  clock = '2026-09-20T00:00:00.000Z';
  const fresh = (await ask(lib, ['R3'], { email: 'alex@mantu.com' })).body;
  clock = '2026-10-02T00:00:00.000Z';
  assert.equal(gaps.expire(lib, clock), gaps.READY ? 1 : 0);
  if (gaps.READY) {
    const status = id => lib.rows('SELECT status FROM gap_requests WHERE id = ?', id)[0].status;
    assert.deepEqual([status(old.id), status(answered.id), status(fresh.id)], ['expired', 'answered', 'open']);
    assert.equal(gaps.expire(lib, new Date(clock)), 0, 'nothing left to expire');
  }
  const again = new Library(sql, { now: () => clock }); gaps.ensure(again); gaps.ensure(again);
  assert.equal(again.rows('SELECT COUNT(*) AS n FROM gap_requests')[0].n, 3, 'a second Library over the same SQL keeps the rows');
  const legacy = memorySql();
  for (const q of LEGACY) legacy.exec(q);
  const l = new Library(legacy, { now: () => clock });
  assert.equal(gaps.expire(l, l.now()), 0);
  if (gaps.READY) assert.equal(legacy.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'gap_requests'").toArray()[0].n, 1, 'expire ran its own ensure');
  const refCols = legacy.exec('PRAGMA table_info(refs)').toArray().map(c => c.name);
  assert.deepEqual([refCols.length, refCols.at(-1)], [22, 'tenant'], 'the only refs change is the stored tenant column, left blank');
});

test('Access mode only: with IDENTITY_SOURCE=entra the word answers 404 through the registry', async () => {
  const { lib } = await setup();
  const ctx = env => ({ url: new URL('https://atlas.test/api/library/gaps'), method: 'GET', parts: ['gaps'], body: {}, user: ALEX, lib, env, waitUntil: p => p });
  for (const ready of [ON, features.readyOf]) assert.deepEqual(await features.featureRoutes(ctx({ IDENTITY_SOURCE: 'entra' }), ready), { status: 404, body: { error: 'This feature is not available in this deployment.' } });
  assert.deepEqual((await features.featureRoutes(ctx({}), ON)).body, { assigned: [], created: [], assignedPage: { truncated: false, limit: 100, next: null }, createdPage: { truncated: false, limit: 100, next: null } });
  assert.equal(features.flags({ IDENTITY_SOURCE: 'entra' }, ON).gapInterview, false);
});

test('wired through libraryRoutes when READY: headers are the identity, and the Entra deployment answers 404', async () => {
  const { lib } = await setup();
  const req = (method, path, who, body) => new Request('https://atlas.test/api/library/' + path, { method, headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, 'x-atlas-email': who.mail, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const created = await libraryRoutes(req('POST', 'gaps', OWNER, { bidId: 'b1', requirementIds: ['R1'], assignee: { email: 'alex@mantu.com' } }), lib, { env: {} });
  if (!gaps.READY) { assert.equal(created.status, 404); return; }
  assert.equal(created.status, 201);
  const id = (await created.json()).id;
  assert.equal((await libraryRoutes(req('GET', `gaps/${id}/interview`, ALEX), lib, { env: {} })).status, 200);
  assert.equal((await libraryRoutes(req('GET', `gaps/${id}/interview`, ALEX), lib, { env: { IDENTITY_SOURCE: 'entra' } })).status, 404);
  assert.equal(features.flags({}).gapInterview, true);
});

test('end to end, the new model input: a gap interview talker never sees a prospect or library client name (route -> resolveForInterview -> Session)', async () => {
  const { Session } = await import('../src/session.js');
  const { lib, ref } = await setup();
  const g = (await ask(lib, ['R1', 'R2'], { refId: ref, person: 0 })).body, env = fakeEnv(lib, []), talker = [], events = [];
  const s = new Session({ io: { send: e => events.push(e), sendBytes() {}, close() {} }, csrf: 't', voice: 'v', model: 'm', sleep: () => new Promise(r => setImmediate(r)),
    ai: { async transcribe() { return ''; }, async synthesize() { return new Uint8Array(960); }, async *chatStream(m) { talker.push(m); yield 'Hello there.'; }, async analyst() { return []; } },
    gaps: id => gaps.resolveForInterview(env, { user: 'alex@mantu.com', role: 'user', mail: 'alex@mantu.com' }, id) });
  try {
    await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 't', project: { title: 'Proof for [company]-style renewal' }, capture: true, gap: g.id }));
    for (let i = 0; i < 2000 && !talker.length; i++) await new Promise(r => setImmediate(r));
    assert.equal(events[0].type, 'ready'); assert.equal(events[0].gaps.length, 2);
    assert.ok(JSON.stringify(talker[0]).includes('Proof the bid needs: Claims routing for [company], like [company]'));
    assert.doesNotMatch(JSON.stringify(talker) + JSON.stringify(events), NAMES);
  } finally { await s.end(false); }
});

// Review finding 6: the other view of a bid's own text, shown to its author, marks which names are library clients.
test('no self-assignment: neither the requester nor the bid owner can be the assignee; a request already assigned to the bid owner has no interview', async () => {
  const { lib } = await setup();
  gaps.ensure(lib);
  const mine = await lib.upsert(OWNER, { localId: 'o', reference: { title: 'Olivia\'s own project', client: { name: 'Otherco' }, consultant: { name: 'Olivia', role: 'Lead' } } });
  const count = () => ['gap_requests', 'audit'].map(t => lib.rows(`SELECT COUNT(*) AS n FROM ${t}`)[0].n);
  const before = count();
  for (const [who, assignee] of [[OWNER, { email: 'olivia@mantu.com' }], [OWNER, { email: ' Olivia@Mantu.COM ' }], [OWNER, { refId: mine.id, person: 0 }],
    [ADMIN, { email: 'tony@mantu.com' }], [ADMIN, { email: 'olivia@mantu.com' }]]) {
    const r = await ask(lib, ['R1'], assignee, who);
    assert.deepEqual([r.status, r.body.error], [400, 'Ask someone else for proof.'], who.email + ' -> ' + JSON.stringify(assignee));
  }
  assert.deepEqual(count(), before, 'a refused request stores nothing and logs nothing');
  const g = (await ask(lib, ['R1'], { email: 'kim@mantu.com' })).body;
  sqlOf(lib).exec('UPDATE gap_requests SET email = ? WHERE id = ?', OWNER.mail, g.id); // stored before this rule existed
  assert.equal((await call(lib, 'GET', `gaps/${g.id}/interview`, OWNER)).status, 404);
  assert.equal(await gaps.resolveForInterview(fakeEnv(lib, []), { user: OWNER.email, role: 'user', mail: OWNER.mail }, g.id), null);
  assert.equal((await call(lib, 'GET', 'gaps/' + g.id, OWNER)).body.asks[0].ask, 'Proof the bid needs: Claims routing for Acme Prospect, like Zebracorp', 'the owner keeps the author view');
});

// Review finding 15: an ask cut in placeholder form ('[Company 1]' dropped whole, a plain name cut) shows the author which names are masked.
test('a long ask is cut in the caller\'s view, never in placeholder form: the author sees their own words cut the same way, library client or not', async () => {
  const { lib } = await setup();
  const pad = 'w'.repeat(130) + ' ', typed = { R1: pad + 'Zebracorp tail words', R2: pad + 'Fakeco12 tail words' };
  const edited = await bids.routes({ method: 'POST', parts: ['bids', 'b1', 'requirements'], user: OWNER, lib, env: {},
    body: { requirements: [{ id: 'R1', text: typed.R1, kind: 'capability' }, { id: 'R2', text: typed.R2, kind: 'outcome' }] } });
  assert.ok(edited.body);
  const cut = t => Array.from('Proof the bid needs: ' + t).slice(0, 160).join('');
  for (const id of ['R1', 'R2']) {
    const g = (await ask(lib, [id], { email: 'alex@mantu.com' })).body;
    assert.equal(g.asks[0].ask, cut(typed[id]), id + ': the author view is their own words, cut at 160 characters');
    assert.equal((await call(lib, 'GET', 'gaps/' + g.id, OWNER)).body.asks[0].ask, cut(typed[id]));
    for (const other of [(await call(lib, 'GET', `gaps/${g.id}/interview`, ALEX)).body.asks[0].ask, (await call(lib, 'GET', 'gaps/' + g.id, ALEX)).body.asks[0].ask]) {
      assert.ok(Array.from(other).length <= 160, other);
      assert.doesNotMatch(other, /Zebrac|\[[A-Za-z]*$/, 'no library client, no half label');
      assert.ok(other.startsWith('Proof the bid needs: ' + 'w'.repeat(130)));
    }
  }
});
