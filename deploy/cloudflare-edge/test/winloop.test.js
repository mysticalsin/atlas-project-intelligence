// winloop.js (WOW_SPEC §F7.1-§F7.5): proof-type aggregates, Wilson intervals, per-story visibility, the bounded
// order-only boost, the cached interview hint and fetchWinHint. Bids and uses are seeded straight into the §2.4
// tables so every count is exact; one test goes through the real bids routes for the ordering effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as winloop from '../src/winloop.js';
import * as bids from '../src/bids.js';
import * as claims from '../src/claims.js';
import { splitSentences } from '../src/snippets.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const LEE = { email: 'lee@mantu.com', role: 'user' }, ALEX = { email: 'alex@mantu.com', role: 'user' }, KIM = { email: 'kim@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' };
const Q = 'quantified+unconfirmed', QL = 'qualitative+unconfirmed', QC = 'quantified+confirmed', QLC = 'qualitative+confirmed';
const ref = (title, answers, extra = {}) => ({ title, stage: 'Production', sector: 'Insurance', consultant: { name: extra.owner || 'Lee Chen', role: 'Engineer' }, client: { name: extra.client || 'Clientco', location: '', contact: '' },
  details: { projectId: '', country: 'France', consultants: [], technologies: [], deliverables: [], serviceLines: [], teamRoles: [], links: [] }, answers: [...answers, '', '', '', '', '', ''].slice(0, 6), sources: [], report: null,
  validation: { manager: { name: '', email: '' }, managerStaff: true } });
async function publish(l, owner, data) {
  const s = await l.upsert(owner, { localId: data.title, reference: data }), row = l.row(s.id);
  l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', by: 't', at: '', note: '' } }, 't', 'validated', '');
  return s.id;
}
let seq = 0;
function seed(l, outcome, uses, owner = ALEX.email) {
  bids.ensure(l);
  const id = 'bid' + (++seq), at = '2026-09-29T00:00:' + String(seq % 60).padStart(2, '0') + '.000Z', decided = outcome !== 'pending';
  l.sql.exec('INSERT INTO bids (id, owner, alias, status, outcome, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, owner, 'alias', decided ? 'decided' : 'open', outcome, decided ? at : null, at, at);
  for (const [refId, type] of uses) l.sql.exec('INSERT INTO bid_references (bid_id, ref_id, revision, proof_type, used_at, used_by) VALUES (?, ?, 1, ?, ?, ?)', id, refId, type, at + seq, owner);
  return id;
}
const lib = () => new Library(memorySql(), { now: () => '2026-09-29T12:00:00.000Z' });

test('READY: the win loop is on, and its helpers answer real values', () => {
  assert.equal(winloop.READY, true); assert.equal(winloop.MIN_N, 5);
});

test('Wilson 95%: 3 of 5 is about [0.23, 0.88]; bounds and invalid counts', () => {
  assert.deepEqual(winloop.wilson(3, 5), [0.2307, 0.8824]);
  assert.deepEqual(winloop.wilson(0, 5), [0, 0.4345]); assert.deepEqual(winloop.wilson(5, 5), [0.5655, 1]);
  const [lo, hi] = winloop.wilson(41, 60); assert.ok(lo < 41 / 60 && 41 / 60 < hi && hi - lo < 0.25, 'narrower with more data');
  for (const [w, n] of [[0, 0], [6, 5], [-1, 5], [1.5, 5], [1, '5'], [null, 5]]) assert.equal(winloop.wilson(w, n), null, `${w}/${n}`);
});

test('F7.4 #1, #4 stats: rates hidden under n = 5; per-story rows only for reviewers, admins and the story\'s own people; never per consultant', async () => {
  const l = lib(), a = await publish(l, LEE, ref('Story A', ['x'])), b = await publish(l, ALEX, ref('Story B', ['y']));
  for (let i = 0; i < 4; i++) seed(l, 'won', [[a, Q]]);
  seed(l, 'lost', [[b, QL]]); seed(l, 'pending', [[a, Q], [b, QL]]); seed(l, 'withdrawn', [[b, QL]]);
  const call = async user => (await winloop.routes({ method: 'GET', parts: ['wins'], lib: l, user })).body;
  let rev = await call(REV), q = rev.proofTypes.find(p => p.proofType === Q);
  assert.deepEqual(rev.proofTypes.map(p => p.proofType), [QC, Q, QLC, QL]); assert.equal(rev.minN, 5); assert.equal(rev.label, 'Association, not causation. Weights are uncalibrated.');
  assert.deepEqual(q, { proofType: Q, used: 5, won: 4, lost: 0, decided: 4, winRate: null, ci95: null, caveat: 'Fewer than 5 decided bids: not shown.' });
  assert.deepEqual(rev.totals, { bids: 7, decided: 5 });
  seed(l, 'lost', [[a, Q]]);
  rev = await call(REV); q = rev.proofTypes.find(p => p.proofType === Q);
  assert.deepEqual([q.decided, q.winRate, q.ci95, q.caveat], [5, 0.8, winloop.wilson(4, 5), ''], 'shown from 5 decided (the cache saw the new bid)');
  assert.deepEqual(rev.stories.map(s => [s.refId, s.title, s.used, s.won, s.lost, s.pending, s.decided, s.winRate]), [[a, 'Story A', 6, 4, 1, 1, 5, 0.8], [b, 'Story B', 3, 0, 1, 1, 1, null]]);
  assert.deepEqual((await call(LEE)).stories.map(s => s.refId), [a], 'the story\'s own people see only their own stories');
  assert.deepEqual((await call(ALEX)).stories.map(s => s.refId), [b]);
  const kim = await call(KIM);
  assert.deepEqual(kim.stories, []); assert.deepEqual(kim.proofTypes, rev.proofTypes, 'everyone sees the proof-type aggregates');
  for (const body of [rev, kim]) assert.doesNotMatch(JSON.stringify(body), /@|consultant|owner|people|"by"/, 'no per-consultant keys or emails');
  await assert.rejects(winloop.routes({ method: 'POST', parts: ['wins'], lib: l, user: REV }), e => e.status === 404);
});

test('F7.4 #3 winSignals: bounded, absent under the thresholds; visible only to reviewers, admins and full access; order only, never above the floor', async () => {
  const l = lib(), refs = [];
  for (const k of ['A', 'B', 'C', 'D']) refs.push(await publish(l, LEE, ref('Story ' + k, ['x'])));
  const [A, B, C, D] = refs;
  for (let i = 0; i < 5; i++) seed(l, 'won', [[A, Q], [C, Q]]);
  for (let i = 0; i < 4; i++) seed(l, 'lost', [[B, QL]]);
  let s = winloop.winSignals(l);
  assert.equal(s.get(A).boost, 0, '9 decided bids overall: no boost yet'); assert.equal(s.get(A).winRate, 1); assert.equal(s.get(B).winRate, null);
  seed(l, 'lost', [[B, QL], [D, QL]]);
  s = winloop.winSignals(l);
  // overall uses: 10 won (A, C) and 6 lost (B x5, D) -> 0.625; A: 0.1 x (1 - 0.625) = 0.0375; B: 0.1 x (0 - 0.625) -> clamped to -0.03.
  assert.deepEqual(s.get(A), { decided: 5, won: 5, winRate: 1, boost: 0.0375 }); assert.deepEqual(s.get(B), { decided: 5, won: 0, winRate: 0, boost: -0.03 });
  assert.equal(s.get(D).boost, 0, 'a story under 5 decided uses gets no boost'); assert.ok(!s.has('unused'));
  for (let i = 0; i < 20; i++) seed(l, 'lost', [[D, QL]]);
  assert.equal(winloop.winSignals(l).get(A).boost, 0.05, 'capped at +0.05');
  s.get(A).boost = 99; assert.equal(winloop.winSignals(l).get(A).boost, 0.05, 'callers get copies');
});

test('F7.4 #3 through a bid match: the boost reorders rows above the floor, never rescues one below, and its signal shows only to allowed viewers', async () => {
  const EMBED = async t => [/claims/i.test(t) ? 1 : 0, 0, 0, /NEARMISS/.test(t) ? 3.3 : 0.05];
  let tick = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, tick++)).toISOString(), embed: EMBED, complete: async m => m[0].content.startsWith('You extract')
    ? JSON.stringify({ requirements: [{ text: 'Claims routing proof' }], customer: {} }) : 'the ranking model is down' });
  const winner = await publish(l, LEE, ref('Claims older winner', ['Claims routing with a queue.'])), newer = await publish(l, LEE, ref('Claims newer', ['Claims routing with a queue.']));
  const near = await publish(l, LEE, ref('NEARMISS claims', ['NEARMISS claims pilot.'])), filler = await publish(l, LEE, ref('Filler', ['Unrelated.']));
  for (const id of [winner, newer, near, filler]) await l.index(id);
  const match = async user => { const b = (await bids.routes({ method: 'POST', parts: ['bids'], body: { title: 'Claims bid', alias: 'Heron', briefText: 'We need proof of claims routing for an insurer, please.' }, user: { ...user, mail: user.email }, lib: l, env: {} })).body;
    return (await bids.routes({ method: 'POST', parts: ['bids', b.id, 'match'], body: {}, user: { ...user, mail: user.email }, lib: l, env: {} })).body; };
  assert.deepEqual((await match(REV)).results.map(r => r.id), [newer, winner], 'equal similarity: newest first without win history');
  for (let i = 0; i < 5; i++) seed(l, 'won', [[winner, Q], [near, Q]]);
  for (let i = 0; i < 10; i++) seed(l, 'lost', [[filler, QL]]); // overall 10 won of 20 uses: 0.5, so a 5/5 story gets 0.1 x 0.5 = +0.05
  assert.equal(winloop.winSignals(l).get(near).boost, 0.05);
  const rev = await match(REV);
  assert.deepEqual(rev.results.map(r => r.id), [winner, newer], 'the win boost reorders rows above the floor');
  assert.deepEqual(rev.results[0].winSignal, { decided: 5, won: 5, winRate: 1, boost: 0.05 }); assert.equal(rev.results[0].relevance, null, 'never model relevance');
  assert.ok(!rev.results.some(r => r.id === near), 'raw similarity 0.34 + a +0.05 boost stays below the floor');
  const kim = await match(KIM);
  assert.deepEqual(kim.results.map(r => r.id), [winner, newer]); assert.ok(kim.results.every(r => r.winSignal === null), 'a public reader never sees win signals');
  const lee = await match(LEE);
  assert.ok(lee.results.every(r => r.winSignal !== null), 'full access to the story: the signal is shown');
});

test('proofTypeOf: quantified from the outcome or evidence answer, confirmed from a current confirmed claim, fixed at the time of use', async () => {
  const l = lib();
  const q = await publish(l, LEE, ref('Q', ['ctx', 'we', 'how', 'Triage fell by 30% in six months.']));
  const e = await publish(l, LEE, ref('E', ['ctx', 'we', 'how', 'It went well overall.', 'Dashboard shows 12 hours saved per week.']));
  const plain = await publish(l, LEE, ref('P', ['ctx', 'we', 'how', 'It went well overall for the team.']));
  assert.deepEqual([q, e, plain].map(id => winloop.proofTypeOf(l, l.row(id))), [Q, Q, QL]);
  claims.ensure(l);
  const sentence = splitSentences(l.row(q).data.answers[3])[0];
  l.sql.exec("INSERT INTO claims (id, ref_id, revision, topic, idx, text, sentence_hash, status, by_mail, at, confirmed_revision, created_by, created_at) VALUES ('c1', ?, 1, 3, 0, ?, 'h1', 'manager_confirmed', 'sam@mantu.com', 'now', 1, 'lee@mantu.com', 'now')", q, sentence);
  assert.equal(winloop.proofTypeOf(l, l.row(q)), claims.READY ? QC : Q, 'confirmed once T3 counts the claim');
  const bid = seed(l, 'won', []);
  l.sql.exec('UPDATE refs SET data = json_set(data, \'$.answers[3]\', ?) WHERE id = ?', 'No figures any more.', q);
  bids.ensure(l); await bids.routes({ method: 'POST', parts: ['bids', bid, 'use'], body: { refIds: [q] }, user: { ...ALEX, mail: ALEX.email }, lib: l, env: {} });
  assert.equal(l.rows('SELECT proof_type FROM bid_references WHERE bid_id = ?', bid)[0].proof_type, QL, 'the type is computed when the use is recorded');
});

test('F7.4 #5 guidance: null under the thresholds, quantified before confirmed, cached, from bids and bid_references only', async () => {
  const l = lib();
  l.visibleRows = () => { throw new Error('guidance must not scan visibleRows'); };
  assert.deepEqual(winloop.guidance(l), { hint: null, decided: 0, basis: 'Fewer than 10 decided bids.' });
  for (let i = 0; i < 6; i++) seed(l, 'won', [['r1', QC]]);
  for (let i = 0; i < 3; i++) seed(l, 'lost', [['r1', QC]]);
  assert.equal(winloop.guidance(l).hint, null, '9 decided bids');
  for (let i = 0; i < 5; i++) seed(l, 'lost', [['r2', QLC]]);
  let g = winloop.guidance(l);
  assert.deepEqual(g, { hint: 'quantified', decided: 14, basis: 'Quantified proof won 67% of 9 decided bids; qualitative 0% of 5.' });
  assert.doesNotMatch(JSON.stringify(g), /r1|r2|@/, 'aggregate only');
  const cached = winloop.guidance(l); assert.deepEqual(cached, g);
  l.sql.exec("UPDATE bids SET outcome = 'won' WHERE id IN (SELECT bid_id FROM bid_references WHERE ref_id = 'r2')");
  assert.equal(winloop.guidance(l).hint, null, 'an outcome change invalidates the cache (quantified 67% vs qualitative 100%)');
  const m = lib();
  for (let i = 0; i < 5; i++) seed(m, 'won', [['a', QC]]);
  for (let i = 0; i < 5; i++) seed(m, 'lost', [['b', Q]]);
  for (let i = 0; i < 5; i++) seed(m, 'won', [['c', QLC]]);
  for (let i = 0; i < 5; i++) seed(m, 'lost', [['d', QL]]);
  assert.equal(winloop.guidance(m).hint, 'confirmed', 'quantified and qualitative tie at 50%, confirmed beats unconfirmed');
  assert.deepEqual((await winloop.routes({ method: 'GET', parts: ['wins', 'guidance'], lib: m, user: KIM })).body, winloop.guidance(m));
});

test('F7.1 proof-type rates and the hint count decided bids, not uses: one bid citing five stories of a type is one decided bid', async () => {
  const l = lib();
  seed(l, 'won', [['r1', Q], ['r2', Q], ['r3', Q], ['r4', Q], ['r5', Q]]);
  const body = (await winloop.routes({ method: 'GET', parts: ['wins'], lib: l, user: REV })).body;
  assert.deepEqual(body.proofTypes.find(p => p.proofType === Q), { proofType: Q, used: 5, won: 1, lost: 0, decided: 1, winRate: null, ci95: null, caveat: 'Fewer than 5 decided bids: not shown.' });
  assert.deepEqual(body.totals, { bids: 1, decided: 1 });
  // 2 won bids with 3 quantified uses each, 8 lost qualitative bids: per use it would read 6 vs 8 and hint 'quantified'.
  const m = lib();
  for (let i = 0; i < 2; i++) seed(m, 'won', [['a', Q], ['b', Q], ['c', Q]]);
  for (let i = 0; i < 8; i++) seed(m, 'lost', [['d', QL]]);
  assert.deepEqual(winloop.guidance(m), { hint: null, decided: 10, basis: 'No proof type stands out yet.' }, 'only 2 quantified bids: under 5');
  // A bid citing a quantified+unconfirmed and a quantified+confirmed story counts once in the quantified group.
  const n = lib();
  for (let i = 0; i < 5; i++) seed(n, 'won', [['a', Q], ['b', QC]]);
  for (let i = 0; i < 5; i++) seed(n, 'lost', [['c', QL]]);
  assert.deepEqual(winloop.guidance(n), { hint: 'quantified', decided: 10, basis: 'Quantified proof won 100% of 5 decided bids; qualitative 0% of 5.' });
});

test('fetchWinHint: forwards the interviewee identity to the global LibraryStore, caps at 1.5 s, null on any failure', async () => {
  let seen = null;
  const store = reply => ({ LIBRARY: { idFromName: n => { seen = { name: n }; return n; }, get: () => ({ fetch: async r => { Object.assign(seen, { url: r.url, headers: Object.fromEntries(r.headers) }); return reply(r); } }) } });
  const id = { user: 'alex@mantu.com', role: 'reviewer', mail: 'alex@mantu.com' };
  assert.deepEqual(await winloop.fetchWinHint(store(() => Response.json({ hint: 'quantified', decided: 12, basis: 'b' })), id), { hint: 'quantified', decided: 12, basis: 'b' });
  assert.equal(seen.name, 'global'); assert.equal(seen.url, 'https://atlas.internal/api/library/wins/guidance');
  assert.deepEqual([seen.headers['x-atlas-user'], seen.headers['x-atlas-role'], seen.headers['x-atlas-email'], seen.headers['x-atlas-tenant'], seen.headers['x-atlas-tenant-enforced']], ['alex@mantu.com', 'reviewer', 'alex@mantu.com', '', '0']);
  const scoped = { ...id, tenant: '11111111-1111-4111-8111-111111111111', tenantEnforced: true };
  await winloop.fetchWinHint(store(() => Response.json({ hint: 'confirmed', decided: 10, basis: 'c' })), scoped);
  assert.equal(seen.headers['x-atlas-tenant'], scoped.tenant);
  assert.equal(seen.headers['x-atlas-tenant-enforced'], '1');
  assert.deepEqual(await winloop.fetchWinHint(store(() => Response.json({ hint: 'drop tables', decided: 'x' })), id), { hint: null, decided: 0, basis: '' });
  for (const reply of [() => new Response('{}', { status: 404 }), () => new Response('not json'), () => { throw new Error('down'); }])
    assert.equal(await winloop.fetchWinHint(store(reply), id), null);
  assert.equal(await winloop.fetchWinHint({}, id), null); assert.equal(await winloop.fetchWinHint(undefined, id), null);
  const t0 = Date.now(), hang = await winloop.fetchWinHint(store(() => new Promise(() => {})), id);
  assert.equal(hang, null); assert.ok(Date.now() - t0 >= 1400 && Date.now() - t0 < 3000, 'gives up after about 1.5 s');
  // End to end through the real routes: the guidance route answers the forwarded identity.
  const { libraryRoutes } = await import('../src/library-routes.js'), l = lib();
  const real = { LIBRARY: { idFromName: n => n, get: () => ({ fetch: r => libraryRoutes(r, l, { env: {} }) }) } };
  assert.deepEqual(await winloop.fetchWinHint(real, id), { hint: null, decided: 0, basis: 'Fewer than 10 decided bids.' });
  assert.equal(await winloop.fetchWinHint(real, { user: '', role: 'user', mail: '' }), null, 'no identity: 401, null');
});
