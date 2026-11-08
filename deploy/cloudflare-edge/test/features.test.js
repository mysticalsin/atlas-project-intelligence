// Feature registry and the fixed module contract (WOW_SPEC §2.1, §2.4, §6.3, §F1.10). Written in T1-S0; it must
// keep passing as T1, T2 and T3 replace their stubs: it checks names, gating and neutral behaviour while not READY.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as features from '../src/features.js';
import * as util from '../src/util.js';
import * as scrub from '../src/scrub.js';
import * as snippets from '../src/snippets.js';
import * as review from '../src/review.js';
import * as bids from '../src/bids.js';
import * as ask from '../src/ask.js';
import * as winloop from '../src/winloop.js';
import * as customerJev from '../src/customer-jev.js';
import * as gaps from '../src/gaps.js';
import * as gapPolicy from '../src/gap-policy.js';
import * as claims from '../src/claims.js';
import * as outreach from '../src/outreach.js';
import * as teams from '../src/teams.js';
import * as teamsRoutes from '../src/teams-routes.js';
import * as confirmPage from '../src/confirm-page.js';
import * as profile from '../src/profile.js';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';

const F = 'function';
const CONTRACT = {
  'features.js': [features, { WORDS: 'object', SYSTEM_WORDS: 'object', EXTERNAL_WORDS: 'object', EMAIL_AUTH_WORDS: 'object', readyOf: F, featureRoutes: F, flags: F, SPOKEN_ASK_APPROVED: 'boolean' }],
  // WOW_ZERO_CONFIG §6: the profile.js exports.
  'profile.js': [profile, { READY: 'boolean', routes: F, ensure: F, resolveProfile: F, firstName: F, emailGuess: F, lookupPerson: F, directoryManager: F,
    dnaConfig: F, pushConfig: F, testAddress: F, daily: F }],
  'util.js': [util, { str: F, para: F, list: F, email: F, obj: F, https: F, fail: F, uuidish: F, inList: F, rateLimit: F }],
  'scrub.js': [scrub, { STOPLIST: 'object', libraryNames: F, nameMatcher: F, pseudonymise: F, unmask: F, forOthers: F, maskedPreview: F, recordText: F, recordView: F }],
  'snippets.js': [snippets, { splitSentences: F, TOPIC_KEYS: 'object', claimKey: F, snippetsOf: F }],
  'review.js': [review, { clientScrub: F, reviewReference: F, forModel: F, completeness: F, parseReview: F, READY_SCORE: 'number', REVIEW_POLICY: 'string' }],
  'bids.js': [bids, { READY: 'boolean', routes: F, ensure: F, getRequirement: F, bidView: F, STRONG: 'number', PARTIAL: 'number', SIM_FLOOR: 'object',
    parseRequirements: F, parseBidRank: F, parseOnePager: F, REQUIREMENTS_POLICY: 'string', BID_RANK_POLICY: 'string', ONEPAGER_POLICY: 'string' }],
  'ask.js': [ask, { READY: 'boolean', routes: F }],
  'winloop.js': [winloop, { READY: 'boolean', routes: F, MIN_N: 'number', wilson: F, winSignals: F, guidance: F, proofTypeOf: F, fetchWinHint: F }],
  'customer-jev.js': [customerJev, { customerJev: F }],
  'gaps.js': [gaps, { READY: 'boolean', routes: F, ensure: F, listForBid: F, resolveForInterview: F, expire: F }],
  'gap-policy.js': [gapPolicy, { gapSystemBlock: F, gapNotes: F, gapStatus: F, gapGuidance: F, timePlan: F }],
  'claims.js': [claims, { READY: 'boolean', routes: F, ensure: F, CURRENCY: 'string', claimSummary: F, confirmationStatus: F, expire: F }],
  'outreach.js': [outreach, { READY: 'boolean', routes: F, ensure: F, system: F, onTrigger: F, daily: F, queue: F, parseCsv: F }],
  'teams.js': [teams, { teamsStatus: F, teamsClient: F, verifyBotActivity: F, interviewCard: F }],
  'teams-routes.js': [teamsRoutes, { teamsRoutes: F }],
  'confirm-page.js': [confirmPage, { CONFIRM_HTML: 'string' }],
};

test('every module exports its §6.3 contract names', () => {
  for (const [file, [mod, names]] of Object.entries(CONTRACT))
    for (const [name, type] of Object.entries(names)) assert.equal(typeof mod[name], type, `${file} ${name}`);
  assert.equal(winloop.MIN_N, 5); assert.ok(['sentence', 'revision'].includes(claims.CURRENCY));
  assert.ok(scrub.STOPLIST instanceof Set); assert.ok(Array.isArray(snippets.TOPIC_KEYS));
  assert.deepEqual(Object.keys(features.WORDS).sort(), ['ask', 'bids', 'claims', 'confirmations', 'directory', 'gaps', 'outreach', 'people', 'profile', 'staffing', 'wins']);
  assert.deepEqual(Object.keys(features.SYSTEM_WORDS), ['teams-event', 'directory']);
  assert.deepEqual([...features.EXTERNAL_WORDS], ['confirmations']); assert.deepEqual([...features.EMAIL_AUTH_WORDS].sort(), ['claims', 'confirmations', 'gaps']);
  assert.equal(features.WORDS.confirmations, claims.routes); assert.equal(features.WORDS.staffing, outreach.routes); assert.equal(features.SYSTEM_WORDS['teams-event'], outreach.system);
  for (const w of ['profile', 'people', 'directory']) assert.equal(features.WORDS[w], profile.routes, w);
  assert.equal(features.SYSTEM_WORDS.directory, profile.routes);
});

const OWNER = { email: 'alex@mantu.com', role: 'user' };
const call = (l, method, path, who, body, env = {}) => libraryRoutes(new Request('https://atlas.test' + path, { method,
  headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, ...(who.mail ? { 'x-atlas-email': who.mail } : {}), 'Content-Type': 'application/json' },
  body: method === 'POST' ? JSON.stringify(body || {}) : undefined }), l, { env });
const NOT_AVAILABLE = 'This feature is not available in this deployment.';

test('dispatch order: GET /api/library/bids is a feature word, never lib.get("bids")', async () => {
  const l = new Library(memorySql(), { newId: () => 'bids' });
  assert.equal((await l.upsert(OWNER, { localId: 'x', reference: { title: 'A reference whose id is "bids"' } })).id, 'bids');
  const r = await call(l, 'GET', '/api/library/bids', OWNER);
  // Not READY: the registry's 404; READY: the caller's bid list. Either way never the reference whose id is "bids".
  if (!features.readyOf('bids', {})) { assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: NOT_AVAILABLE }); }
  else { assert.equal(r.status, 200); assert.deepEqual(await r.json(), { items: [], truncated: false, limit: 200, next: null }); }
  assert.equal((await call(l, 'GET', '/api/library/bids/anything/else', OWNER)).status, 404, 'deeper bid paths never fall through to the generic routes');
  for (const word of Object.keys(features.WORDS)) {
    const res = await call(l, 'GET', '/api/library/' + word, OWNER);
    if (!features.readyOf(word, {})) { assert.equal(res.status, 404, word); assert.deepEqual(await res.json(), { error: NOT_AVAILABLE }, word); }
  }
  assert.equal((await call(l, 'GET', '/api/library/constructor', OWNER)).status, 404, 'prototype names are never handlers');
  assert.equal((await (await call(l, 'GET', '/api/library/nope', OWNER)).json()).error, 'Reference not found.', 'other words still reach the generic routes');
});

test('READY gating and the Entra rule: email-authorised words are off in Entra mode, whatever READY says', async () => {
  const ctx = (word, role = 'user', env = {}) => ({ parts: [word], user: { email: 'a@x.co', mail: 'a@x.co', role }, env, lib: null, body: {}, method: 'GET' });
  for (const word of Object.keys(features.WORDS)) {
    const got = await features.featureRoutes(ctx(word), () => false);
    assert.deepEqual(got, { status: 404, body: { error: NOT_AVAILABLE } }, word);
  }
  const allReady = (w, env) => features.readyGate(w, env, () => true);
  for (const word of ['gaps', 'claims', 'confirmations']) {
    assert.equal(allReady(word, { IDENTITY_SOURCE: 'entra' }), false, word);
    assert.deepEqual(await features.featureRoutes(ctx(word, 'user', { IDENTITY_SOURCE: 'entra' }), allReady), { status: 404, body: { error: NOT_AVAILABLE } });
    assert.equal(allReady(word, {}), true);
  }
  for (const word of ['bids', 'ask', 'wins', 'outreach', 'staffing', 'profile', 'people', 'directory']) assert.equal(allReady(word, { IDENTITY_SOURCE: 'entra' }), true, word);
  const bidsCtx = { ...ctx('bids'), lib: new Library(memorySql(), {}) };
  assert.deepEqual(await features.featureRoutes(bidsCtx, () => true), await bids.routes(bidsCtx), 'a READY word reaches its module handler');
  for (const word of Object.keys(features.WORDS)) assert.equal(features.readyOf(word, {}), !!({ bids, ask, wins: winloop, gaps, claims, confirmations: claims, outreach, staffing: outreach,
    profile, people: profile, directory: profile })[word].READY, word);
  assert.equal(features.readyOf('directory', {}), profile.READY, 'the system push word follows profile.READY too');
});

// WOW_ZERO_CONFIG §6, §9: the three profile words, READY-gated like every WOW module; externals get 403.
test('Z profile words: profile, people and directory are READY-gated, work in both identity modes and are never external', async () => {
  const l = new Library(memorySql(), {}), EXT = { email: 'c@client.example', mail: 'c@client.example', role: 'external' };
  for (const word of ['profile', 'people', 'directory']) {
    assert.equal(features.EXTERNAL_WORDS.has(word), false, word); assert.equal(features.EMAIL_AUTH_WORDS.has(word), false, word);
    assert.deepEqual(await features.featureRoutes({ parts: [word], user: EXT, env: {} }, () => true), { status: 403, body: { error: 'Not available to external confirmers.' } }, word);
    const r = await call(l, 'GET', '/api/library/' + word, OWNER);
    if (!profile.READY) { assert.equal(r.status, 404, word); assert.deepEqual(await r.json(), { error: NOT_AVAILABLE }, word); }
    const ext = await call(l, 'GET', '/api/library/' + word, EXT);
    assert.equal(ext.status, 403, 'external: ' + word);
  }
  const entraCtx = { method: 'GET', parts: ['profile'], url: new URL('https://atlas.test/api/library/profile'), body: {},
    user: { email: '11111111-2222-3333-4444-555555555555:99999999-8888-7777-6666-555555555555', mail: 'alex@mantu.com', role: 'user', idp: {} }, lib: l, env: { IDENTITY_SOURCE: 'entra' } };
  const got = await features.featureRoutes(entraCtx, (w, env) => features.readyGate(w, env, () => true));
  assert.equal(got.body.email, 'alex@mantu.com', 'Entra mode: the profile is keyed by x-atlas-user and still answers');
  // The system push forward reaches only directory/import, and only through SYSTEM_WORDS.
  const SYS = { email: 'dna-push', role: 'system' };
  assert.equal((await call(l, 'POST', '/api/library/profile', SYS, {})).status, 404, 'profile is not a system word');
  if (!profile.READY) assert.equal((await call(l, 'POST', '/api/library/directory/import', SYS, {})).status, 404);
});

test('flags: every key, conservative defaults, opt-in vars and the Entra rule', () => {
  const keys = ['bids', 'ask', 'spokenAsk', 'wins', 'customerJev', 'pdfBriefs', 'gaps', 'gapInterview', 'claims', 'clientConfirm', 'outreach', 'staffing', 'teams', 'phone', 'profile'];
  const f = features.flags({});
  assert.deepEqual(Object.keys(f), keys);
  assert.equal(f.phone, 'BLOCKED_EXTERNAL'); assert.equal(f.teams, teams.teamsStatus({}));
  // WOW_ZERO_CONFIG §4 D1/D2 (intentional assertion changes, recorded in handoff/status/Z.md): SPOKEN_ASK and
  // PDF_BRIEFS are no longer variables. spokenAsk = ask && SPOKEN_ASK_APPROVED (a code constant); pdfBriefs = bids.
  // D1 approved by Tony: "it should just work and ask for consent and that's it" (consent at the moment of use).
  assert.equal(features.SPOKEN_ASK_APPROVED, true, 'D1 approved: spoken Ask follows Ask, with the per-use consent prompt');
  assert.equal(f.spokenAsk, features.readyOf('ask', {}), 'spokenAsk equals on(ask)');
  for (const v of ['0', '1', 'false']) assert.equal(features.flags({ SPOKEN_ASK: v }).spokenAsk, f.spokenAsk, 'the removed SPOKEN_ASK variable changes nothing');
  assert.equal(f.pdfBriefs, features.readyOf('bids', {}), 'pdfBriefs equals on(bids)');
  assert.equal(f.profile, profile.READY, 'profile follows profile.READY');
  const on = (w, env) => features.readyGate(w, env, () => true);
  const all = features.flags({}, on);
  assert.deepEqual([all.bids, all.ask, all.spokenAsk, all.customerJev, all.pdfBriefs, all.clientConfirm, all.gaps, all.profile], [true, true, true, false, true, false, true, true]);
  assert.equal(features.flags({}, on, { spokenAskApproved: false }).spokenAsk, false, 'the test seam can still turn it off');
  const opt = features.flags({ TYPESAFE_API_KEY: 'k', CLIENT_CONFIRM: '1', EXTERNAL_EMAILS: 'c@client.example' }, on, { spokenAskApproved: true });
  assert.deepEqual([opt.spokenAsk, opt.pdfBriefs, opt.customerJev, opt.clientConfirm], [true, true, true, true]);
  assert.equal(features.flags({}, (w, env) => w !== 'ask' && on(w, env), { spokenAskApproved: true }).spokenAsk, false, 'spokenAsk never exceeds ask');
  assert.equal(features.flags({}, (w, env) => w !== 'bids' && on(w, env)).pdfBriefs, false, 'pdfBriefs never exceeds bids');
  assert.equal(features.flags({ CLIENT_CONFIRM: '1' }, on).clientConfirm, false, 'client confirmation also needs EXTERNAL_EMAILS');
  const entra = features.flags({ IDENTITY_SOURCE: 'entra', CLIENT_CONFIRM: '1', EXTERNAL_EMAILS: 'c@client.example' }, on);
  assert.deepEqual([entra.gaps, entra.gapInterview, entra.claims, entra.clientConfirm, entra.bids, entra.ask, entra.wins, entra.profile], [false, false, false, false, true, true, true, true]);
});

test('external role: only `confirmations` is reachable; nothing else in the library answers', async () => {
  const l = new Library(memorySql(), {});
  const own = await l.upsert(OWNER, { localId: 'x', reference: { title: 'T', client: { name: 'Zebracorp' } } });
  const EXT = { email: 'c@client.example', mail: 'c@client.example', role: 'external' };
  assert.deepEqual(await features.featureRoutes({ parts: ['bids'], user: EXT, env: {} }, () => true), { status: 403, body: { error: 'Not available to external confirmers.' } });
  for (const [method, path] of [['GET', '/api/library'], ['POST', '/api/library'], ['GET', '/api/library/' + own.id], ['POST', '/api/library/recommend'], ['GET', '/api/library/analytics'], ['GET', '/api/library/invitations']]) {
    const r = await call(l, method, path, EXT, { reference: { title: 'x' } });
    assert.equal(r.status, 404, method + ' ' + path); assert.deepEqual(await r.json(), { error: 'Not found.' });
  }
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1, 'an external POST never reaches upsert');
  assert.equal((await call(l, 'GET', '/api/library/bids', EXT)).status, 403);
  const inbox = await call(l, 'GET', '/api/library/confirmations/inbox', EXT);
  if (!claims.READY) assert.equal(inbox.status, 404); else assert.notEqual(inbox.status, 403);
});

test('system words: trigger and scan-stale keep their responses; teams-event is READY-gated; users cannot reach them', async () => {
  const l = new Library(memorySql(), {}), SYS = { email: 'pm-system', role: 'system' };
  const t = await call(l, 'POST', '/api/library/trigger', SYS, { email: 'alex@mantu.com', reason: 'milestone', projectId: 'PRJ-3' });
  assert.equal(t.status, 201); assert.equal((await t.json()).source, 'pm-system');
  const scan = await (await call(l, 'POST', '/api/library/scan-stale', { email: 'atlas-cron', role: 'system' })).json();
  if (!outreach.READY) assert.deepEqual(scan, { invited: 0 }); else assert.equal(scan.invited, 0);
  const ev = await call(l, 'POST', '/api/library/teams-event', { email: 'teams-bot', role: 'system' }, { kind: 'install' });
  if (!outreach.READY) { assert.equal(ev.status, 404); assert.deepEqual(await ev.json(), { error: NOT_AVAILABLE }); }
  assert.deepEqual(await (await call(l, 'POST', '/api/library/bids', SYS)).json(), { error: 'Not found.' }, 'user words are not system words');
  assert.equal((await call(l, 'POST', '/api/library/teams-event', OWNER, { kind: 'install' })).status, 404, 'a user cannot post a Teams event');
  assert.equal((await call(l, 'POST', '/api/library/trigger', OWNER, { email: 'x@y.co' })).status, 404);
});

test('helpers called from existing paths stay neutral while their module is not READY', async () => {
  const l = new Library(memorySql(), {});
  const row = l.row((await l.upsert(OWNER, { localId: 'x', reference: { title: 'T', answers: ['Costs fell 20% after launch.'] } })).id);
  if (!outreach.READY) {
    const inv = outreach.onTrigger(l, 'pm-system', { email: 'alex@mantu.com', reason: 'milestone', projectId: 'P' });
    assert.equal(inv.email, 'alex@mantu.com'); assert.equal(inv.source, 'pm-system');
    assert.deepEqual(outreach.daily(l), {}); assert.deepEqual(outreach.queue(l, { kind: 'interview_invite', subjectId: inv.id, toEmail: inv.email, preview: {} }), []);
  }
  if (!claims.READY) { assert.deepEqual(claims.claimSummary(l, row), { confirmed: 0, total: 0, current: 0 }); assert.equal(claims.confirmationStatus(l, row).size, 0); }
  if (!gaps.READY) assert.deepEqual(gaps.listForBid(l, OWNER, 'b1'), []);
  if (!winloop.READY) { assert.deepEqual(winloop.guidance(l), { hint: null, decided: 0, basis: 'not built' }); assert.equal(winloop.winSignals(l).size, 0); }
  assert.equal(await winloop.fetchWinHint({}, { user: 'a', role: 'user', mail: 'a' }), null, 'no LIBRARY binding: null, never a throw');
  assert.equal(customerJev.customerJev({}), null, 'JEV is off without TYPESAFE_API_KEY');
});

// §2.4: the four pre-WOW tables with one legacy row; every module must work on top without an ALTER.
const LEGACY = [
  `CREATE TABLE refs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_id TEXT, title TEXT, status TEXT, revision INTEGER, content_hash TEXT,
    practice TEXT, industry TEXT, country TEXT, manager_email TEXT, members TEXT, quality_score INTEGER, created_at TEXT, updated_at TEXT, updated_by TEXT,
    next_review TEXT, merged_into TEXT, data TEXT, state TEXT, embedding TEXT)`,
  'CREATE UNIQUE INDEX refs_owner_local ON refs(owner, local_id)',
  'CREATE TABLE revisions (id TEXT, revision INTEGER, data TEXT, author TEXT, at TEXT, PRIMARY KEY (id, revision))',
  'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)',
  'CREATE TABLE invitations (id TEXT PRIMARY KEY, email TEXT, project_id TEXT, title TEXT, reason TEXT, slot TEXT, reference_id TEXT, status TEXT, created_at TEXT, source TEXT)',
];
test('legacy-schema start: every module runs on the four old tables, twice (idempotent ensure), with no ALTER', async () => {
  const sql = memorySql();
  for (const q of LEGACY) sql.exec(q);
  const data = { title: 'Legacy', stage: '', sector: 'Energy', consultant: { name: 'Alex', role: 'Engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: 'Jane Doe' },
    details: { projectId: 'P1', country: 'France', consultants: [], links: [], technologies: [], deliverables: [], serviceLines: [], teamRoles: [] },
    answers: ['Zebracorp had slow claims across regions.', 'I built the routing model myself.', '', 'Triage fell from 40 to 12 minutes.', '', ''], sources: [], report: null, jev: null, validation: { manager: { name: '', email: '' }, managerStaff: false } };
  sql.exec(`INSERT INTO refs (id, owner, local_id, title, status, revision, content_hash, data, state, members, created_at, updated_at, next_review)
    VALUES ('legacy1', 'alex@mantu.com', 'l1', 'Legacy', 'published', 1, 'h', ?, '{"quality":{"status":"ready","score":90},"validation":{"status":"validated"}}', ',', '2025-01-01', '2025-01-01', '2025-07-01')`, JSON.stringify(data));
  sql.exec("INSERT INTO invitations (id, email, project_id, title, reason, slot, reference_id, status, created_at, source) VALUES ('i1', 'alex@mantu.com', 'P1', 'Legacy', 'manual', '', '', 'open', '2025-01-01', 'x')");
  for (const round of [1, 2]) {
    const l = new Library(sql, { now: () => '2026-09-29T00:00:00.000Z' }), row = l.row('legacy1');
    for (const m of [bids, gaps, claims, outreach]) m.ensure(l);
    const user = { email: 'alex@mantu.com', mail: 'alex@mantu.com', role: 'user' };
    for (const word of [...Object.keys(features.WORDS)]) {
      const ctx = { request: new Request('https://atlas.test/api/library/' + word), url: new URL('https://atlas.test/api/library/' + word), method: 'GET', parts: [word], body: {}, user, lib: l, env: {}, waitUntil: p => p };
      try { await features.featureRoutes(ctx, () => true); } catch (e) { assert.ok(e.status, `${word} (round ${round}): ${e.message}`); }
    }
    try { await features.featureRoutes({ method: 'POST', parts: ['teams-event'], body: { kind: 'install', activityId: 'a' + round }, user: { email: 'teams-bot', role: 'system' }, lib: l, env: {}, waitUntil: p => p }, () => true); }
    catch (e) { assert.ok(e.status, 'teams-event: ' + e.message); }
    assert.equal(typeof gaps.expire(l, l.now()), 'number'); assert.equal(typeof claims.expire(l, l.now()), 'number');
    assert.equal(typeof outreach.daily(l), 'object'); assert.ok(Array.isArray(gaps.listForBid(l, user, 'none')));
    assert.equal(typeof claims.claimSummary(l, row).confirmed, 'number'); assert.ok(claims.confirmationStatus(l, row) instanceof Map);
    assert.equal(typeof winloop.proofTypeOf(l, row), 'string'); assert.ok(winloop.winSignals(l) instanceof Map); assert.equal(typeof winloop.guidance(l), 'object');
    assert.throws(() => bids.getRequirement(l, user, 'none', 'R1'), e => e.status === 404); assert.equal(bids.bidView(l, user, 'none').view, 'other');
    assert.deepEqual(scrub.libraryNames(l), { clients: ['Zebracorp'], contacts: ['Jane Doe'] });
    assert.equal(scrub.recordView(l, row.data).answers[0], 'the client had slow claims across regions.');
    assert.deepEqual(snippets.snippetsOf(l, row.data).map(s => s.id), ['A1.1', 'A2.1', 'A4.1']);
    assert.equal(l.get(user, 'legacy1').title, 'Legacy', 'the legacy row still reads');
  }
  const cols = sql.exec('PRAGMA table_info(refs)').toArray().map(c => c.name);
  assert.deepEqual([cols.length, cols.at(-1)], [22, 'tenant'], 'the only refs change is the stored tenant column');
  for (const t of ['bids', 'bid_references']) assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", t).toArray()[0].n, 1, t);
});

test('util: single helper copy, exact email lists, uuid-ish ids and a soft per-instance rate limit', () => {
  assert.equal(util.inList('Ann@Client.Example ', 'x@y.co, ann@client.example'), true);
  assert.equal(util.inList('ann@client.example', 'client.example'), false, 'never a domain match');
  assert.equal(util.inList('', ',,'), false); assert.equal(util.inList('a@b.co', undefined), false);
  assert.equal(util.uuidish('0123456789ABCDEF0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(util.uuidish('01234567-89ab-cdef-0123-456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  for (const bad of ['', 'x', '../etc', '0123456789abcdef0123456789abcdeg', null]) assert.equal(util.uuidish(bad), '', String(bad));
  assert.equal(util.fail(429, 'Slow down.').status, 429); assert.equal(util.email(' A@B.CO '), 'a@b.co'); assert.equal(util.str('  a   b ', 10), 'a b');
  let now = Date.parse('2026-09-29T00:00:00Z'); const l = { now: () => new Date(now).toISOString() }, other = { now: l.now };
  assert.deepEqual([1, 2, 3].map(() => util.rateLimit(l, 'ask:alex', 2, 60000)), [true, true, false]);
  assert.equal(util.rateLimit(l, 'ask:kim', 2, 60000), true, 'per key'); assert.equal(util.rateLimit(other, 'ask:alex', 2, 60000), true, 'per Library instance');
  now += 60001; assert.equal(util.rateLimit(l, 'ask:alex', 2, 60000), true, 'the window slides');
});
