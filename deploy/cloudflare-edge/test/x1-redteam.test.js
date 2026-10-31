// v2.2 X1: regression tests for the red-team RETEST findings (governance, privacy, platform): H1, M2-M8, L1-L10 and the two earlier partials (win-loop, search in a URL).
// Each test is a PoC from /tmp/claude-501/audit3/red/pocs/ turned into an assertion, and each fails on commit e113613.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as claims from '../src/claims.js';
import * as outreach from '../src/outreach.js';
import * as profile from '../src/profile.js';
import * as bids from '../src/bids.js';
import * as gaps from '../src/gaps.js';
import * as ask from '../src/ask.js';
import * as winloop from '../src/winloop.js';
import * as privacy from '../src/privacy.js';
import * as ks from '../src/kill-switches.js';
import * as connectors from '../src/connectors.js';
import * as sr from '../src/subject-rights.js'; // namespace import: on e113613 `mentions` does not exist and the tests fail instead of the file
const { exportMine, eraseMine, holdRoutes } = sr;
import { sweep } from '../src/retention.js';
import { verifyChain } from '../src/audit-chain.js';
import { customerJev } from '../src/customer-jev.js';
import { jevRanker } from '../src/jev.js';
import { classify } from '../src/classify.js';
import { storyRater } from '../src/rating.js';
import { hindsight } from '../src/memory.js';
import { memoryRoutes } from '../src/memory-routes.js';
import { meRoutes } from '../src/me-routes.js';
import { scheduled } from '../src/app.js';
import { memorySql } from './sqlite.js';
import { FakeStorage } from './reconnect-harness.js';
import { ENV, ORIGIN, session, ns } from './security-harness.js';
import { resetAnnounced } from '../src/security-log.js';

const who = (e, role = 'user') => ({ email: e, mail: e, role });
const ALICE = who('alice@mantu.com'), BOB = who('bob@mantu.com'), CAROL = who('carol@mantu.com'), FRIEND = who('friend@mantu.com'), SAM = who('sam@mantu.com'), REV = who('reviewer@mantu.com', 'reviewer'), ADMIN = who('admin@mantu.com', 'admin');
const subjOf = e => [...e].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0').repeat(4);
const ANSWERS = ['The client had a very slow claims triage process that took forty minutes per claim on average.', 'I personally designed and delivered the automated triage pipeline end to end.',
  'We used an agile approach with weekly demos to the claims operations team and the CFO.', 'Triage time dropped from 40 to 12 minutes per claim within three months of go-live.',
  'Measured by the client operations team over a full quarter, signed off by their CFO.', 'This matters for any insurer with manual triage and growing claim volumes.'];
const ref = (title, extra = {}) => ({ title, sector: 'Insurance', consultant: { name: 'Alice', role: 'Lead' }, client: { name: 'AcmeCorp', location: 'Paris', contact: 'Dupont, CFO' },
  details: { projectId: extra.pid || 'P-1', country: 'France', consultants: extra.people || [], technologies: ['Python'], serviceLines: ['Data'] }, answers: ANSWERS,
  validation: extra.validation || { manager: { name: 'Friend', email: FRIEND.email } } });
let t = 0;
const tick = () => new Date(Date.UTC(2026, 9, 31, 9, 0, t++)).toISOString();
function world(opts = {}) {
  const l = new Library(memorySql(), { now: opts.now || tick, complete: opts.complete ?? null, embed: opts.embed ?? null, services: opts.services });
  profile.ensure(l); // the table the profile module makes on first use (a store without it is the L4 test)
  const call = async (u, method, path, body, { env = {}, storage = null } = {}) => {
    const r = await libraryRoutes(new Request('https://atlas.test' + path, { method, headers: { 'x-atlas-user': u.email, 'x-atlas-role': u.role, 'x-atlas-email': u.mail || '', 'x-atlas-subj': u.subj || subjOf(u.email), 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), l, { env: { ORIGIN: 'https://atlas.test', ...env }, waitUntil: p => p, storage });
    return { ...(await r.json()), http: r.status };
  };
  return { l, call };
}
// A reference as the review and the N+1 would leave it: published.
async function publish(l, owner, title, extra = {}) {
  const s = await l.upsert(owner, { localId: 'p-' + title, reference: ref(title, extra) }), row = l.row(s.id);
  l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', by: 'sam@mantu.com', at: '', note: '' } }, 'sam@mantu.com', 'validated', '');
  return s.id;
}
const flagged = (l, e, patch) => privacy.setFlags(l, e, patch);
const SUBJ = e => subjOf(e);

// ================= H1: erasure must not upgrade a self-declared N+1's confirmation =================
test('H1: a co-author\'s erasure (or the confirmer\'s, or the retention sweep) never turns a self-declared N+1 confirmation into manager_confirmed', async () => {
  const { l, call } = world();
  const id = await publish(l, ALICE, 'H1 story', { people: [{ name: 'Bob', email: BOB.email, role: 'Dev' }] });
  const cands = await call(BOB, 'GET', '/api/library/claims/' + id);
  const target = cands.candidates.find(c => c.topic === 3);
  const proposed = await call(BOB, 'POST', '/api/library/claims', { refId: id, items: [target] });
  const rq = await call(BOB, 'POST', '/api/library/confirmations', { refId: id, claimIds: [proposed.claims[0].id] });
  assert.equal(rq.request.managerSource, 'self_declared');
  const done = await call(FRIEND, 'POST', '/api/library/confirmations/' + rq.request.id, { decisions: [{ claimId: proposed.claims[0].id, decision: 'confirm' }] });
  assert.equal(done.http, 200);
  const status = () => [...claims.confirmationStatus(l, l.row(id), { independent: true }).values()];
  assert.deepEqual(status(), ['consultant_named'], 'before: a self-named N+1 is "consultant_named"');
  eraseMine(l, BOB, SUBJ(BOB.email)); // the requester erases
  assert.deepEqual(status(), ['consultant_named'], 'after the requester\'s erasure');
  assert.equal(claims.claimSummary(l, l.row(id), { independent: true }).confirmed, 0, 'and it does not count as an independent confirmation');
  eraseMine(l, FRIEND, SUBJ(FRIEND.email)); // the confirmer erases too
  assert.deepEqual(status(), ['consultant_named'], 'after the confirmer\'s erasure');
  sweep(l, { now: new Date(Date.now() + 5 * 365 * 864e5).toISOString() }); // the retention sweep deletes the finished request rows
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM confirmation_requests')[0].n, 0, 'request rows are gone');
  assert.deepEqual(status(), ['consultant_named'], 'after the request rows are swept');
  assert.equal(l.rows('SELECT by_source FROM claims')[0].by_source, 'self_declared', 'the claim row itself keeps who answered it');
});

test('H1: a claims table created before by_source gets the column back-filled from the request that decided each claim', async () => {
  const sql = memorySql(), l0 = new Library(sql, {});
  l0.sql.exec('CREATE TABLE claims (id TEXT PRIMARY KEY, ref_id TEXT, revision INTEGER, topic INTEGER, idx INTEGER, text TEXT, sentence_hash TEXT, status TEXT, by_mail TEXT, at TEXT, confirmed_revision INTEGER, note TEXT, created_by TEXT, created_at TEXT)');
  l0.sql.exec("CREATE TABLE confirmation_requests (id TEXT PRIMARY KEY, ref_id TEXT, revision INTEGER, kind TEXT, to_email TEXT, manager_source TEXT, claim_ids TEXT, status TEXT, created_by TEXT, created_by_mail TEXT, created_at TEXT, expires_at TEXT, decided_at TEXT)");
  l0.sql.exec("INSERT INTO claims VALUES ('c1', 'r1', 1, 3, 0, 'x', 'h', 'manager_confirmed', 'friend@mantu.com', 'T1', 1, '', 'bob@mantu.com', 'T0')");
  l0.sql.exec("INSERT INTO confirmation_requests VALUES ('q1', 'r1', 1, 'manager', 'friend@mantu.com', 'self_declared', '[\"c1\"]', 'done', 'bob@mantu.com', 'bob@mantu.com', 'T0', 'T9', 'T1')");
  claims.ensure(l0);
  assert.equal(l0.rows('SELECT by_source FROM claims')[0].by_source, 'self_declared');
});

// ================= M2: AI_OFF stops every model and third-party call =================
test('M2: ATLAS_AI_OFF stops the TypeSafe bid ranker (no outbound call, honest note) and every other client of a model or third party', async () => {
  const seen = [];
  const { l } = world({ services: { fetch: async (u, i) => { seen.push(String(u)); throw new Error('no network in this test'); } } });
  const id = await publish(l, ALICE, 'Claims triage routing automation story');
  bids.ensure(l);
  const customer = JSON.stringify({ problem: 'Claims bounce between teams', buyer: 'Head of claims', constraints: 'On premise', desired_outcome: 'Faster triage' });
  l.sql.exec(`INSERT INTO bids (id, owner, owner_mail, title, alias, prospects, brief, pseudo, requirements, customer, req_method, status, outcome, created_at, updated_at)
    VALUES ('b1', ?, ?, 'T', 'Alias', '[]', 'brief', '{}', ?, ?, 'manual', 'open', 'pending', 'x', 'x')`, CAROL.email, CAROL.email, JSON.stringify([{ id: 'R1', text: 'Proof of claims triage routing automation', kind: 'capability', must: true }]), customer);
  const env = { TYPESAFE_API_KEY: 'k', ATLAS_AI_OFF: '1' };
  const out = (await bids.routes({ method: 'POST', parts: ['bids', 'b1', 'match'], url: new URL('https://atlas.test/api/library/bids/b1/match'), body: { useJev: true, jevConsent: true }, user: CAROL, lib: l, env, waitUntil: p => p })).body;
  assert.deepEqual(seen, [], 'no call to api.typesafe.ai while AI is off');
  assert.doesNotMatch(out.method, /JEV$/); assert.doesNotMatch(out.method, /Workers AI/, 'the note no longer claims a fallback to a model that is off too'); assert.match(out.method, /switched off by the operator/);
  assert.ok(id);
  // the single guard, at every client
  assert.equal(customerJev(env), null); assert.equal(jevRanker(env), null); assert.equal(storyRater(env, async () => { throw new Error('called'); }).available(), false);
  let classified = 0; await assert.rejects(classify(env, { title: 'T', answers: ANSWERS }, async () => { classified++; throw new Error('called'); }), e => e.code === 'AI_OFF' && e.status === 503); assert.equal(classified, 0);
  const calls = []; const hs = hindsight({ ...env, HINDSIGHT_API_KEY: 'k' }, async (u, i) => { calls.push(i.method + ' ' + String(u)); return new Response('{}', { status: 200 }); });
  for (const f of [() => hs.retain('b', []), () => hs.recall('b', 'q'), () => hs.ensureBank('b')]) await assert.rejects(f(), e => e.code === 'AI_OFF');
  assert.deepEqual(calls, [], 'no content-bearing memory call');
  await hs.forgetAll('b'); await hs.documents('b');
  assert.equal(calls.length, 2, 'but the person\'s access and erasure rights still reach the memory service');
  // the admin probe is a model call too
  const probe = []; const res = await memoryRoutes(new Request('https://x/api/memory/test', { headers: { 'x-atlas-bank': 'b', 'x-atlas-role': 'admin' } }), { storage: new FakeStorage(), hs, env, fetcher: async u => { probe.push(String(u)); return new Response('{}'); } });
  assert.equal((await res.json()).aiOff, true); assert.deepEqual(probe, []);
});

// ================= M3: READ_ONLY freezes the cron =================
test('M3: ATLAS_READ_ONLY freezes the daily cron: no retention erasure, no audit re-seal, no writes; the chain head does not move', async () => {
  let now = '2026-01-01T00:00:00.000Z';
  const { l, call } = world({ now: () => now });
  const d = await call(ALICE, 'POST', '/api/library', { localId: 'old', reference: ref('Old private draft'), draft: true });
  l.log('x', 'someone@mantu.com', 'noted', 'a row that retention would pseudonymise');
  const head = verifyChain(l.sql).head, rows = l.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  now = '2028-06-01T00:00:00.000Z'; // far past every retention period
  const cron = () => call({ email: 'atlas-cron', role: 'system' }, 'POST', '/api/library/scan-stale', {}, { env: { ATLAS_READ_ONLY: '1' } });
  const frozen = await cron();
  assert.equal(frozen.readOnly, true); assert.equal(l.row(d.id).title, 'Old private draft', 'the draft was not erased');
  assert.equal(verifyChain(l.sql).head, head, 'the audit chain was not re-sealed'); assert.equal(l.rows('SELECT COUNT(*) AS n FROM audit')[0].n, rows, 'and no row was added');
  const run = await call({ email: 'atlas-cron', role: 'system' }, 'POST', '/api/library/scan-stale', {}, { env: {} });
  assert.ok(run.retention?.draftReferences >= 1, 'with the switch off the same call does erase (the control)');
  // scheduled() says so in the security log
  const logs = []; const orig = console.log; console.log = s => logs.push(String(s));
  try { const pending = []; await scheduled({}, { LIBRARY: ns(() => new Response('{}')), ATLAS_READ_ONLY: '1' }, { waitUntil: p => pending.push(p) }); await Promise.all(pending); } finally { console.log = orig; }
  assert.ok(logs.some(s => /"event":"kill_switch"/.test(s) && /READ_ONLY/.test(s)));
});

// ================= M4: restriction and objection stop every projection =================
test('M4: a restricted or objecting owner\'s reference is not used in a one-pager, "use in bid" or slides', async () => {
  const { l, call } = world({ complete: async () => '{}' });
  const id = await publish(l, ALICE, 'M4 story');
  bids.ensure(l);
  l.sql.exec("INSERT INTO bids (id, owner, owner_mail, title, alias, prospects, brief, pseudo, requirements, customer, req_method, status, outcome, created_at, updated_at) VALUES ('b1', ?, ?, 'T', 'A', '[]', 'b', '{}', '[]', '{}', 'manual', 'open', 'pending', 'x', 'x')", CAROL.email, CAROL.email);
  for (const patch of [{ restricted: true }, { objectMatching: true }]) {
    flagged(l, ALICE.email, { restricted: false, objectMatching: false, ...patch });
    const op = await call(CAROL, 'POST', '/api/library/bids/b1/onepager', { refIds: [id] }), use = await call(CAROL, 'POST', '/api/library/bids/b1/use', { refIds: [id] }), sl = await call(CAROL, 'POST', `/api/library/${id}/slides`, { context: 'a meeting' });
    assert.deepEqual([op.http, use.http, sl.http], [409, 409, 409], JSON.stringify(patch));
  }
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM bid_references')[0].n, 0, 'nothing was recorded as used');
  flagged(l, ALICE.email, { restricted: false, objectMatching: false });
  assert.equal((await call(CAROL, 'POST', '/api/library/bids/b1/use', { refIds: [id] })).http, 200, 'the control: without a flag it is recorded');
});

// ================= M5 / M6: legal holds =================
test('M5: withdrawing a validated reference first does not get around the legal hold, whether or not a bid row exists', async () => {
  const { l, call } = world();
  const a = await publish(l, ALICE, 'M5 cited'), b = await publish(l, ALICE, 'M5 plain');
  l.log(a, CAROL.email, 'one-pager generated', 'bid b9'); // a one-pager writes an audit row but no bid_references row
  await call(ALICE, 'POST', `/api/library/${a}/withdraw`, { note: 'bye' }); await call(ALICE, 'POST', `/api/library/${b}/withdraw`, { note: 'bye' });
  assert.equal(l.row(a).status, 'withdrawn');
  const r = eraseMine(l, ALICE, SUBJ(ALICE.email));
  assert.deepEqual(r.pendingReview.filter(p => p.kind === 'reference').map(p => p.entity).sort(), [a, b].sort(), 'both were published once: held for the DPO, not erased');
  assert.equal(l.row(a).title, 'M5 cited'); assert.ok(l.row(a).state.erasure_pending_review.reason);
  assert.equal(r.counts.referencesErased, undefined);
  assert.equal((await call(ADMIN, 'GET', '/api/library/privacy/holds')).items.length >= 2, true);
});

test('M6: a held reference cannot be reinstated, edited, validated or merged away; only the DPO\'s resolution deals with it', async () => {
  const { l, call } = world();
  const id = await publish(l, ALICE, 'M6 story', { people: [{ name: 'Bob', email: BOB.email, role: 'Dev' }] });
  const r = eraseMine(l, ALICE, SUBJ(ALICE.email));
  assert.equal(r.pendingReview[0].entity, id);
  assert.equal((await call(REV, 'POST', `/api/library/${id}/reinstate`, {})).http, 409);
  assert.equal(l.row(id).status, 'withdrawn', 'still withdrawn');
  assert.equal((await call(BOB, 'POST', '/api/library', { id, reference: ref('M6 edited', { people: [{ name: 'Bob', email: BOB.email, role: 'Dev' }] }) })).http, 409, 'a listed consultant cannot rewrite it');
  assert.equal((await call(REV, 'POST', `/api/library/${id}/validate`, { decision: 'validate' })).http, 409);
  assert.equal((await call(CAROL, 'GET', '/api/library/' + id)).http, 404, 'and a stranger never sees it');
});

// ================= M7: assignee's erasure leaves the requester's request alone =================
test('M7: erasing the ASSIGNEE of a proof request does not take the REQUESTER\'s request away', async () => {
  const { l, call } = world();
  gaps.ensure(l); bids.ensure(l);
  l.sql.exec("INSERT INTO bids (id, owner, owner_mail, title, alias, prospects, brief, pseudo, requirements, customer, req_method, status, outcome, created_at, updated_at) VALUES ('b1', ?, ?, 'T', 'A', '[]', 'b', '{}', '[]', '{}', 'manual', 'open', 'pending', 'x', 'x')", CAROL.email, CAROL.email);
  l.sql.exec("INSERT INTO gap_requests (id, bid_id, requirement_ids, asks, email, assignee_name, reference_id, project_id, status, created_by, created_by_mail, created_at, results, pseudo, source) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'b1', '[]', '[]', ?, 'Mal', '', '', 'open', ?, ?, 'x', NULL, NULL, '')", 'mal2@mantu.com', CAROL.email, CAROL.email);
  assert.equal((await call(CAROL, 'GET', '/api/library/gaps/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).http, 200);
  eraseMine(l, who('mal2@mantu.com'), SUBJ('mal2@mantu.com'));
  assert.equal(l.rows("SELECT created_by FROM gap_requests WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'")[0].created_by, CAROL.email, 'the requester is still the requester');
  assert.equal((await call(CAROL, 'GET', '/api/library/gaps/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).http, 200); assert.equal((await call(CAROL, 'GET', '/api/library/gaps')).created.some(g => g.id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
  assert.equal(l.rows("SELECT email FROM gap_requests WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'")[0].email.startsWith('erased:'), true, 'but the assignee is erased');
  // and the other way round: the requester's erasure does not touch who it was assigned to
  l.sql.exec("INSERT INTO gap_requests (id, bid_id, requirement_ids, asks, email, assignee_name, reference_id, project_id, status, created_by, created_by_mail, created_at, results, pseudo, source) VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'b1', '[]', '[]', 'dan@mantu.com', 'Dan', '', '', 'open', ?, ?, 'x', NULL, NULL, '')", CAROL.email, CAROL.email);
  eraseMine(l, CAROL, SUBJ(CAROL.email));
  assert.equal(l.rows("SELECT email, created_by FROM gap_requests WHERE id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'").map(r => [r.email, r.created_by.startsWith('erased:')])[0].join(), 'dan@mantu.com,true');
});

// ================= M8: re-sealing never launders a tampered chain =================
test('M8: erasure and the retention sweep verify the audit chain first and refuse to re-seal a tampered one (a security event, the chain untouched)', async () => {
  for (const via of ['erasure', 'retention']) {
    const { l } = world();
    await l.upsert(ALICE, { localId: 'a', reference: ref('Alice story') });
    l.log('x', 'reviewer@mantu.com', 'withdrawn', 'Client complained: unapproved figures');
    l.sql.exec("UPDATE audit SET action = 'reviewed', detail = 'ok' WHERE action = 'withdrawn'"); // the direct edit
    const broken = verifyChain(l.sql);
    assert.equal(broken.ok, false); assert.equal(broken.reason, 'HASH_MISMATCH');
    const snapshot = JSON.stringify(l.rows('SELECT * FROM audit ORDER BY seq'));
    let res;
    if (via === 'erasure') { res = eraseMine(l, ALICE, SUBJ(ALICE.email)); assert.ok(res.auditRefused, 'erasure reports it'); assert.ok(res.pendingReview.some(p => p.kind === 'audit'), 'the DPO is told the audit part is pending'); assert.equal(res.auditHead, null); }
    else { res = sweep(l, { now: new Date(Date.now() + 5 * 365 * 864e5).toISOString() }); assert.ok(res.auditRefused); assert.equal(res.auditRows, undefined); }
    const after = verifyChain(l.sql);
    assert.equal(after.ok, false, via + ': still reported as broken'); assert.equal(after.brokenSeq, broken.brokenSeq);
    assert.equal(JSON.stringify(l.rows('SELECT * FROM audit WHERE action != ? ORDER BY seq', 'erasure completed').filter(r => r.id !== 'privacy')).includes('reviewed'), true, 'the tampered row is still visibly the tampered row');
    if (via === 'retention') assert.equal(JSON.stringify(l.rows('SELECT * FROM audit ORDER BY seq')), snapshot, 'retention left every audit row exactly as it was');
  }
  // the control: an intact chain is still re-sealed, and both heads are reported
  const { l } = world(); await l.upsert(ALICE, { localId: 'a', reference: ref('Alice story') });
  const r = eraseMine(l, ALICE, SUBJ(ALICE.email)); assert.equal(verifyChain(l.sql).ok, true); assert.ok(r.counts.auditRows > 0); assert.match(r.auditHead, /^[0-9a-f]{64}$/); assert.match(r.auditPreviousHead, /^[0-9a-f]{64}$/); assert.notEqual(r.auditHead, r.auditPreviousHead);
});

test('M8: the privacy route logs audit_chain_break REWRITE_REFUSED and audit_chain_ok with both heads', async () => {
  const { l, call } = world(), lines = [], orig = console.log; console.log = s => lines.push(String(s));
  try {
    await l.upsert(ALICE, { localId: 'a', reference: ref('Alice story') });
    const ok = await call(ALICE, 'POST', '/api/privacy/erase', { confirmed: true }); assert.equal(ok.http, 200);
    l.log('x', 'bob@mantu.com', 'withdrawn', 'detail'); l.sql.exec("UPDATE audit SET detail = 'changed' WHERE action = 'withdrawn'");
    const bad = await call(CAROL, 'POST', '/api/privacy/erase', { confirmed: true }); assert.equal(bad.http, 200); assert.ok(bad.auditRefused);
  } finally { console.log = orig; }
  const sec = lines.filter(s => s.startsWith('{"atlas_sec"')).map(s => JSON.parse(s));
  const sealed = sec.find(e => e.event === 'audit_chain_ok' && e.reason === 'CHAIN_RESEALED');
  assert.ok(sealed.head && sealed.prev && sealed.head !== sealed.prev, 'old and new head are both logged');
  assert.ok(sec.some(e => e.event === 'audit_chain_break' && e.reason === 'REWRITE_REFUSED'));
});

// ================= L1: persistent limits =================
test('L1: the bid one-pager has a persistent limit, and Ask and bids use storage-backed limits that survive an evicted isolate', async () => {
  const storage = new FakeStorage();
  const w1 = world();
  const op = () => w1.call(CAROL, 'POST', '/api/library/bids/b1/onepager', { refIds: [] }, { storage });
  let last; for (let i = 0; i < 31; i++) last = await op();
  assert.equal(last.http, 429, 'the 31st one-pager in an hour is refused'); assert.match(String(last.error), /Too many/);
  // "eviction": a fresh Library (fresh in-memory buckets) over the same storage still counts
  const w2 = world();
  let ask429 = 0; for (let i = 0; i < 61; i++) { const r = await w2.call(CAROL, 'POST', '/api/library/ask', { question: 'who has done claims triage?' }, { storage }); if (r.http === 429) ask429++; }
  assert.equal(ask429, 1);
  const w3 = world(); const again = await w3.call(CAROL, 'POST', '/api/library/ask', { question: 'who has done claims triage?' }, { storage });
  assert.equal(again.http, 429, 'a new object over the same storage is still limited');
  assert.equal((await w3.call(ALICE, 'POST', '/api/library/ask', { question: 'who has done claims triage?' }, { storage })).http, 200, 'another person has their own counter');
});

// ================= L2: non-default security flags are announced =================
test('L2: ATLAS_CSP=report-only, the kill switches and live adapters are announced (flag_state log, admin bootstrap); report-only no longer loosens /privacy, /confirm and the sign-in page', async () => {
  const env = { ...ENV, ATLAS_CSP: 'report-only', ATLAS_ADAPTERS: 'live', ATLAS_AI_OFF: '1', ATLAS_CSRF_BIND: 'sub', ADMIN_EMAILS: 'tony@example.com' };
  assert.deepEqual(ks.securityFlags(env), ['ATLAS_AI_OFF', 'ATLAS_CSP:report-only', 'ATLAS_CSRF_BIND:sub', 'ATLAS_ADAPTERS:live']);
  assert.deepEqual(ks.securityFlags({ ...ENV }), []);
  const me = await session(env); resetAnnounced(); me.logs.length = 0;
  const boot = await (await me.go('/api/bootstrap')).json();
  assert.deepEqual(boot.securityFlags, ['ATLAS_AI_OFF', 'ATLAS_CSP:report-only', 'ATLAS_CSRF_BIND:sub', 'ATLAS_ADAPTERS:live'], 'an admin sees them');
  const ev = me.logs.find(e => e.event === 'flag_state'); assert.ok(ev && /CSP/.test(ev.bucket) && ev.n === 4, 'and the startup security event names them (no values)');
  const user = await session({ ...env, ADMIN_EMAILS: '' }); assert.equal((await (await user.go('/api/bootstrap')).json()).securityFlags, undefined, 'a person who is not an admin does not');
  for (const path of ['/privacy', '/confirm', '/go/signed-in']) {
    const csp = (await me.go(path)).headers.get('content-security-policy');
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, path);
  }
  const page = (await me.go('/')).headers.get('content-security-policy');
  assert.match(page, /script-src[^;]*'unsafe-inline'/, 'the main page keeps the rollout behaviour while report-only');
});

// ================= L3: connector placeholders =================
test('L3: a ".." placeholder value is refused (the URL never collapses a path segment) and "/" is encoded', async () => {
  const conn = { id: 'x_in', adapter: 'x_in', direction: 'inbound', managed_by: 'http_connector', wired: true, status: 'configured_untested', sandbox: false, base_url_var: 'X_BASE',
    auth: { type: 'bearer', secret_names: ['X_TOKEN'], secret_roles: { token: 'X_TOKEN' } }, endpoints: { read: { method: 'GET', path: '/v1/consultants/{consultant_id}/profile', query: {} } },
    field_mapping: { name: 'name' }, inbound: { model_fields: [], display_only_fields: ['name'], max_string_chars: 50, max_list_items: 5 } };
  const seen = [];
  const ic = connectors.createInboundConnector('x_in', { env: { ATLAS_ADAPTERS: 'live', X_BASE: 'https://hr.example.com/api', X_TOKEN: 's' }, config: { connections: [conn], data_minimisation: { never_send_keys: [], never_to_model_keys: [] } },
    fetcher: async u => { seen.push(String(u)); return new Response('{"name":"n"}', { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
  for (const id of ['..', '.']) { const r = await ic.read({ consultant_id: id }); assert.equal(r.ok, false, id); }
  assert.deepEqual(seen, [], 'nothing was requested for a dot segment');
  await ic.read({ consultant_id: 'a/b' });
  assert.equal(seen.at(-1), 'https://hr.example.com/api/v1/consultants/a%2Fb/profile');
  for (const u of ['https://169.254.169.254/', 'https://10.0.0.5/api', 'https://192.168.1.1/', 'https://172.20.0.1/', 'https://[fe80::1]/', 'https://[fd00::1]/']) assert.equal(connectors.baseUrlProblem(u), 'BASE_URL_INVALID', u);
  for (const u of ['https://hr.example.com/api', 'https://8.8.8.8/', 'http://127.0.0.1:8787/', 'http://localhost:1/']) assert.equal(connectors.baseUrlProblem(u), null, u);
});

// ================= L4: stores without a profiles table; a failed library step stops the irreversible one =================
test('L4: export and erase work on a store that never created the profile, evidence, outreach, gap or claim tables (no throw, no partial claim)', async () => {
  const fresh = async () => { const l = new Library(memorySql(), {}); await l.upsert(ALICE, { localId: 'a', reference: ref('Alone') }); return l; };
  let out;
  const l = await fresh();
  assert.doesNotThrow(() => { out = exportMine(l, ALICE, SUBJ(ALICE.email)); });
  assert.equal(out.profile, null); assert.equal(out.references.length, 1);
  const l2 = await fresh(); let r; assert.doesNotThrow(() => { r = eraseMine(l2, ALICE, SUBJ(ALICE.email)); }); // erase alone, with no earlier export
  assert.equal(r.erased, true); assert.equal(l2.row(l2.rows('SELECT id FROM refs')[0].id).title, '[erased]');
});

test('L4: when the library part of the erasure fails, the interview part (checkpoint, memory, consent) is NOT run and the answer says it is incomplete', async () => {
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  const lib = ns(() => new Response('boom', { status: 500 })), itv = ns((req) => json({ checkpointPurged: 1, memory: { forgotten: true }, consentCleared: true, complete: true }));
  const me = await session({ ...ENV, LIBRARY: lib, INTERVIEW: itv, HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 'b' });
  const step1 = await (await me.go('/api/me/erase', { method: 'POST', body: '{}' })).json();
  itv.calls.length = 0;
  const res = await me.go('/api/me/erase', { method: 'POST', body: JSON.stringify({ confirm: step1.confirmToken }) });
  const body = await res.json();
  assert.equal(body.complete, false); assert.equal(body.interview, null);
  assert.ok(!itv.calls.some(c => new URL(c.request.url).pathname === '/api/me/erase'), 'the irreversible part never ran');
});

// ================= L5: identity on other people's records =================
test('L5: erasure pseudonymises revisions.author, refs.updated_by, data.validation.manager and state.validation.by on others\' records, and the export lists them', async () => {
  const { l } = world();
  const id = await publish(l, ALICE, 'L5 story', { people: [{ name: 'Bob', email: BOB.email, role: 'Dev' }], validation: { manager: { name: 'N One', email: 'n1@mantu.com' } } });
  await l.upsert(BOB, { id, reference: ref('L5 story (bob edit)', { people: [{ name: 'Bob', email: BOB.email, role: 'Dev' }], validation: { manager: { name: 'N One', email: 'n1@mantu.com' } } }) });
  const row = l.row(id); l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', by: 'n1@mantu.com', at: '', note: '' } }, 'n1@mantu.com', 'validated', '');
  const n1 = who('n1@mantu.com');
  const x = exportMine(l, n1, SUBJ(n1.email));
  assert.deepEqual(x.namedAsN1On.map(r => r.id), [id], 'the export lists records where the person is the N+1'); assert.deepEqual(x.validatedByMeOn.map(r => r.id), [id], 'and where they recorded the validation');
  const hold = c => JSON.stringify(l.sql.exec(`SELECT ${c} FROM refs WHERE id = ?`, id).toArray());
  eraseMine(l, BOB, SUBJ(BOB.email)); eraseMine(l, n1, SUBJ(n1.email));
  const raw = JSON.stringify([l.sql.exec('SELECT * FROM refs WHERE id = ?', id).toArray(), l.sql.exec('SELECT * FROM revisions WHERE id = ?', id).toArray()]);
  assert.doesNotMatch(raw, /bob@mantu\.com|n1@mantu\.com|N One/, 'no trace of either person on the record or in any revision');
  assert.ok(l.row(id).state.validation.by.startsWith('erased:')); assert.equal(l.row(id).data.validation.manager.email, ''); assert.ok(l.rows('SELECT author FROM revisions WHERE id = ?', id).every(r => r.author === ALICE.email || r.author.startsWith('erased:')));
  assert.equal(l.row(id).status, 'published', 'the reference itself is untouched'); void hold;
});

// ================= L6: exact audit matching =================
test('L6: an audit row naming hal@ is not al@\'s (export) and al@\'s erasure leaves it alone', async () => {
  assert.equal(sr.mentions('invited hal@mantu.com to interview', 'al@mantu.com'), false); assert.equal(sr.mentions('invited al@mantu.com.', 'al@mantu.com'), true);
  assert.equal(sr.mentions('al@mantu.com.au', 'al@mantu.com'), false); assert.equal(sr.mentions('to: al@mantu.com, cc x', 'al@mantu.com'), true); assert.equal(sr.mentions('x.al@mantu.com', 'al@mantu.com'), false);
  const { l } = world(), AL = who('al@mantu.com');
  l.log('library', 'reviewer@mantu.com', 'interview invitation', 'for hal@mantu.com on P-1');
  l.log('library', 'reviewer@mantu.com', 'interview invitation', 'for al@mantu.com on P-2');
  assert.deepEqual(exportMine(l, AL, SUBJ(AL.email)).audit.length, 1, 'only the row that names al@');
  eraseMine(l, AL, SUBJ(AL.email));
  const left = l.rows("SELECT detail FROM audit WHERE action = 'interview invitation' ORDER BY seq").map(r => r.detail);
  assert.deepEqual(left, ['for hal@mantu.com on P-1', ''], 'hal\'s row is untouched; al\'s detail is cleared');
});

// ================= L7: objection applies to a listed consultant =================
test('L7: a listed consultant who objects to matching is not named in Ask people', async () => {
  const { l, call } = world();
  await publish(l, ALICE, 'Wombat claims triage', { people: [{ name: 'Bob Objector', email: BOB.email, role: 'Dev' }, { name: 'Jo Fine', email: 'jo@mantu.com', role: 'PO' }] });
  const names = async () => (await call(CAROL, 'POST', '/api/library/ask', { question: 'Who has done wombat claims triage automation?' })).people?.map(p => p.name);
  assert.deepEqual((await names()).sort(), ['Alice', 'Bob Objector', 'Jo Fine']);
  flagged(l, BOB.email, { objectMatching: true });
  assert.deepEqual((await names()).sort(), ['Alice', 'Jo Fine']);
});

// ================= L8: a DPO-imposed restriction cannot be lifted =================
test('L8: after an erasure that held material, the person cannot lift the restriction until the DPO resolves the hold', async () => {
  const { l, call } = world();
  await publish(l, ALICE, 'L8 story');
  eraseMine(l, ALICE, SUBJ(ALICE.email));
  const lift = () => call(ALICE, 'POST', '/api/privacy/flags', { restricted: false, objectScoring: false, objectMatching: false, objectMemory: false });
  const refused = await lift(); assert.equal(refused.http, 409); assert.equal(privacy.flagsOf(l, ALICE.email).restricted, true);
  const add = await call(ALICE, 'POST', '/api/privacy/flags', { objectScoring: true }); assert.equal(add.http, 200, 'adding a flag is always fine');
  for (const h of l.rows("SELECT id FROM erasure_holds WHERE status = 'pending_dpo'")) holdRoutes({ lib: l, user: ADMIN, method: 'POST', parts: ['privacy', 'holds', h.id, 'resolve'], body: { action: 'retain', note: 'legal claim pending' } });
  assert.equal((await lift()).http, 200, 'once every hold is resolved they can');
});

// ================= L9: consent receipts are append-only =================
test('L9: consent receipts cannot be replaced or deleted, except by the retention sweep', () => {
  const l = new Library(memorySql(), {}), S = 'abcdef0123456789';
  privacy.recordReceipts(l, S, [{ purpose: 'memory', granted: true }]);
  assert.throws(() => l.sql.exec('UPDATE consent_receipts SET granted = 0'), /append-only/);
  assert.throws(() => l.sql.exec('DELETE FROM consent_receipts'), /append-only/);
  assert.throws(() => l.sql.exec('INSERT OR REPLACE INTO consent_receipts SELECT id, subject, purpose, 0, notice_version, text_sha256, at, channel FROM consent_receipts'), /append-only/);
  assert.deepEqual(privacy.receiptsOf(l, S).map(r => r.granted), [true], 'the receipt is as it was');
  sweep(l, { now: new Date(Date.now() + 10 * 365 * 864e5).toISOString() });
  assert.deepEqual(privacy.receiptsOf(l, S), [], 'the retention sweep may remove a whole person\'s old receipts');
  privacy.recordReceipts(l, S, [{ purpose: 'memory', granted: true }]);
  assert.throws(() => l.sql.exec('DELETE FROM consent_receipts'), /append-only/, 'and the gate is closed again afterwards');
});

// ================= L10: single-use erase token, server-set channel, no existence oracle =================
test('L10: an erase confirmation token works once; a replay is refused', async () => {
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  const used = new Set(), lib = ns(() => json({ erased: true, counts: {}, pendingReview: [] }));
  const itv = ns(async req => { const p = new URL(req.url).pathname; if (p === '/api/me/erase-claim') { const n = (await req.json()).nonce; if (used.has(n)) return json({ error: 'used' }, 409); used.add(n); return json({ claimed: true }); }
    return p === '/api/me/erase' ? json({ checkpointPurged: 0, memory: { forgotten: true }, consentCleared: true, complete: true }) : json({}); });
  const me = await session({ ...ENV, LIBRARY: lib, INTERVIEW: itv, HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 'b' });
  const step1 = await (await me.go('/api/me/erase', { method: 'POST', body: '{}' })).json();
  const go = () => me.go('/api/me/erase', { method: 'POST', body: JSON.stringify({ confirm: step1.confirmToken }) });
  const first = await go(); assert.equal(first.status, 200); assert.equal((await first.json()).complete, true);
  const replay = await go(); assert.equal(replay.status, 403);
  assert.equal(lib.calls.filter(c => new URL(c.request.url).pathname === '/api/privacy/erase').length, 1, 'the replay erased nothing and reached nothing');
  for (const m of ['GET', 'POST']) assert.equal((await me.go('/api/me/erase-claim', { method: m, body: m === 'POST' ? JSON.stringify({ nonce: 'ab'.repeat(8), exp: 1 }) : undefined })).status, 404, 'the browser has no route to the claim: only the Worker calls it, after checking the token');
});

test('L10: the receipt channel is the route\'s, never the body\'s; the erase-claim route in the person\'s own object records a nonce once', async () => {
  const storage = new FakeStorage(), received = [];
  const env = { LIBRARY: ns(async req => { received.push(JSON.parse(await req.text())); return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); }) };
  const H = { 'x-atlas-user': 'a@mantu.com', 'x-atlas-role': 'user', 'x-atlas-email': 'a@mantu.com', 'x-atlas-subj': 'f'.repeat(32) };
  const post = (path, body) => meRoutes(new Request('https://x' + path, { method: 'POST', headers: H, body: JSON.stringify(body) }), { storage, hs: null, env });
  assert.equal((await post('/api/consent', { purposes: { memory: true }, channel: 'consent-dialog' })).status, 200);
  assert.equal(received[0].channel, 'profile'); assert.ok(received[0].items.every(i => i.channel === 'profile'), 'a client-chosen channel is ignored');
  const n = 'ab'.repeat(8);
  assert.equal((await post('/api/me/erase-claim', { nonce: n, exp: Date.now() + 6e5 })).status, 200); assert.equal((await post('/api/me/erase-claim', { nonce: n, exp: Date.now() + 6e5 })).status, 409);
  assert.equal((await post('/api/me/erase-claim', { nonce: 'zz', exp: 1 })).status, 400);
});

test('L10: another person\'s draft id and a missing id answer the same 404 (no existence oracle on upsert)', async () => {
  const { l, call } = world();
  const d = await call(ALICE, 'POST', '/api/library', { localId: 'd', reference: ref('Alice private draft'), draft: true });
  const other = await call(BOB, 'POST', '/api/library', { id: d.id, reference: ref('x') }), missing = await call(BOB, 'POST', '/api/library', { id: 'f'.repeat(32), reference: ref('x') });
  assert.equal(other.http, 404); assert.equal(missing.http, 404); assert.equal(other.error, missing.error);
  void l;
});

// ================= earlier partials =================
test('win loop (old L1): one account\'s fake bids cannot make a proof-type statistic visible, however many stories it cites; it takes three different people', async () => {
  const { l } = world();
  const A = await publish(l, ALICE, 'Story A'), B = await publish(l, who('rival@mantu.com'), 'Story B');
  bids.ensure(l);
  let n = 0;
  const fake = (bidder, refId, outcome) => { const id = 'fb' + (++n), at = '2026-10-31T00:00:' + String(n % 60).padStart(2, '0') + '.000Z';
    l.sql.exec('INSERT INTO bids (id, owner, alias, status, outcome, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, bidder, 'a', 'decided', outcome, at, at, at);
    l.sql.exec("INSERT INTO bid_references (bid_id, ref_id, revision, proof_type, used_at, used_by) VALUES (?, ?, 1, 'qualitative+unconfirmed', ?, ?)", id, refId, at + n, bidder); };
  const shown = () => winloop.routes({ method: 'GET', parts: ['wins'], lib: l, user: REV }).then(r => r.body.proofTypes.find(p => p.proofType === 'qualitative+unconfirmed'));
  for (let i = 0; i < 3; i++) { fake('eve@mantu.com', A, 'won'); fake('eve@mantu.com', B, 'won'); }
  let cell = await shown(); assert.equal(cell.winRate, null, 'one account, six bids: nothing is shown'); assert.ok(cell.decided <= 3, 'and one account counts at most three times per proof type');
  for (let i = 0; i < 3; i++) { fake('eve2@mantu.com', A, 'won'); fake('eve2@mantu.com', B, 'won'); }
  cell = await shown(); assert.equal(cell.winRate, null, 'two accounts are still not enough'); assert.match(cell.caveat, /different people/);
  for (let i = 0; i < 2; i++) fake('eve3@mantu.com', A, 'lost');
  cell = await shown(); assert.notEqual(cell.winRate, null, 'three different people: shown'); assert.ok(winloop.MIN_N <= cell.decided);
  const g = winloop.guidance(l); assert.equal(g.hint, null, 'and the interview hint does not follow a handful of people either');
});

test('library search (old L12): POST /api/library/search returns the list with the text in the body; the page no longer puts it in a URL', async () => {
  const { l, call } = world();
  await publish(l, ALICE, 'Zebrafish routing');
  const r = await call(ALICE, 'POST', '/api/library/search', { q: 'zebrafish' });
  assert.equal(r.http, 200); assert.equal(r.items.length, 1); assert.equal((await call(ALICE, 'POST', '/api/library/search', { q: 'no-such-thing' })).items.length, 0);
  const src = readFileSync(new URL('../../../src/app.js', import.meta.url), 'utf8');
  assert.match(src, /libraryApi\('\/search',\{method:'POST'/); assert.doesNotMatch(src, /libraryApi\('\?'\s*\+/);
  void l;
});
