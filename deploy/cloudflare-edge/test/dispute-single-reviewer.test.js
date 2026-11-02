// D-DSR (Tony, 2026-11-02 13:15 BRT): "Let the same reviewer settle the dispute when there's only one reviewer." When a record has exactly one eligible
// reviewer (the listed reviewers and admins, and the resolved N+1, never the owner), the reviewer who rejected it may adjudicate the dispute, and the
// decision is recorded as a single-reviewer adjudication (the record, workflow_transitions and the hash-chained audit). With two or more, or when the
// count is unknown (Entra, no env), the four-eyes rule stays (ADJUDICATOR_IS_REJECTER). Unit (the store) and API (libraryRoutes) level. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { evidence, SINGLE_REVIEWER_AUDIT } from '../src/evidence.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' }, SOLO = { email: 'solo@mantu.com', role: 'admin' }, REV = { email: 'rev@mantu.com', role: 'reviewer' };
const NOTES = session => ({ session_id: session, project_ref: 'PRJ-9', details: [
  { id: 'D-001', field: 'problem', item_id: 'item-1', quote: 'Claims were bouncing between three teams.', status: 'reported' },
  { id: 'D-002', field: 'contribution', item_id: 'item-2', quote: 'I designed and built the routing model.', status: 'reported' }] });
const ONE = { ADMIN_EMAILS: 'solo@mantu.com', REVIEWER_EMAILS: '' }, TWO = { ADMIN_EMAILS: 'solo@mantu.com', REVIEWER_EMAILS: 'rev@mantu.com' };
function setup(env) {
  let t = 0, n = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 2, 16, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') });
  const ev = evidence(l); ev.env = env;
  return { l, ev };
}
async function disputed(ev, rejecter, session = 's1') {
  const d = await ev.createDraftFromNotes(OWNER.email, NOTES(session)), s = ev.submit(OWNER.email, d.id, d.revision);
  await ev.review(rejecter, s.id, 'reject', { expected_revision: 1, content_hash: s.content_hash, reason: 'The figure has no source.' });
  return ev.review(OWNER, s.id, 'dispute', { expected_revision: 1, rationale: 'The dashboard export is the source.' });
}
const refused = (p, reason) => assert.rejects(p, e => e.status === 403 && e.reason === reason);
const trail = (l, id) => l.rows('SELECT event, actor, reason FROM workflow_transitions WHERE entity = ? ORDER BY seq', id);

test('D-DSR one eligible reviewer: the rejecter upholds the rejection, recorded as a single-reviewer adjudication', async () => {
  const { l, ev } = setup(ONE), v = await disputed(ev, SOLO);
  const seen = ev.get(SOLO, v.id);
  assert.deepEqual(['uphold_rejection', 'reopen_review'].filter(a => seen.actions.includes(a)), ['uphold_rejection', 'reopen_review'], 'offered to the only reviewer');
  assert.deepEqual(seen.adjudication_policy, { reviewers: 1, you_rejected: true, may_adjudicate: true, rule: 'single_reviewer' });
  await assert.rejects(ev.review(SOLO, v.id, 'uphold_rejection', { expected_revision: 1 }), e => e.status === 400, 'a reason is still required');
  const up = await ev.review(SOLO, v.id, 'uphold_rejection', { expected_revision: 1, reason: 'The export covers another line.' });
  assert.equal(up.state, 'closed_rejected');
  assert.deepEqual([up.adjudication.outcome, up.adjudication.by, up.adjudication.rule, up.adjudication.single_reviewer, up.adjudication.reason], ['upheld', SOLO.email, 'single_reviewer', true, 'The export covers another line.']);
  const last = trail(l, v.id).at(-1);
  assert.deepEqual([last.event, last.actor, last.reason], ['close_rejected', SOLO.email, 'text_recorded,' + SINGLE_REVIEWER_AUDIT], 'workflow_transitions carries the code, never the text');
  const audit = l.rows('SELECT actor, action, detail FROM audit WHERE id = ? AND action = ?', v.id, SINGLE_REVIEWER_AUDIT);
  assert.deepEqual(audit.map(a => [a.actor, a.detail]), [[SOLO.email, 'uphold_rejection']], 'the hash-chained audit records it too');
});

test('D-DSR one eligible reviewer: the rejecter may overturn (reopen) and the record is reviewed again', async () => {
  const { l, ev } = setup(ONE), v = await disputed(ev, SOLO);
  const re = await ev.review(SOLO, v.id, 'reopen_review', { expected_revision: 1, reason: 'The export does support it.' });
  assert.equal(re.state, 'reviewer_queue');
  assert.deepEqual([re.adjudication.outcome, re.adjudication.single_reviewer], ['reopened', true]);
  assert.equal(trail(l, v.id).at(-1).reason, 'text_recorded,' + SINGLE_REVIEWER_AUDIT);
  assert.ok(ev.get(SOLO, v.id).actions.includes('approve'), 'back in the queue for the same reviewer');
});

test('D-DSR two eligible reviewers: the four-eyes rule stays; the other reviewer adjudicates, not as single-reviewer', async () => {
  const { l, ev } = setup(TWO), v = await disputed(ev, REV);
  const mine = ev.get(REV, v.id);
  assert.ok(!mine.actions.includes('uphold_rejection') && !mine.actions.includes('reopen_review'));
  assert.deepEqual(mine.adjudication_policy, { reviewers: 2, you_rejected: true, may_adjudicate: false, rule: 'refused' });
  await refused(ev.review(REV, v.id, 'uphold_rejection', { expected_revision: 1, reason: 'Stands.' }), 'ADJUDICATOR_IS_REJECTER');
  await refused(ev.review(REV, v.id, 'reopen_review', { expected_revision: 1 }), 'ADJUDICATOR_IS_REJECTER');
  assert.deepEqual(ev.get(SOLO, v.id).adjudication_policy, { reviewers: 2, you_rejected: false, may_adjudicate: true, rule: 'four_eyes' });
  const up = await ev.review(SOLO, v.id, 'uphold_rejection', { expected_revision: 1, reason: 'Stands.' });
  assert.deepEqual([up.adjudication.rule, up.adjudication.single_reviewer], ['four_eyes', false]);
  assert.equal(trail(l, v.id).at(-1).reason, 'text_recorded');
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM audit WHERE action = ?', SINGLE_REVIEWER_AUDIT)[0].n, 0);
});

test('D-DSR the resolved N+1 counts as a reviewer, the owner never does, and an unknown count is never one', async () => {
  // the owner listed as a reviewer does not make a second reviewer: SOLO stays the only one
  let { ev } = setup({ ADMIN_EMAILS: 'solo@mantu.com,alex@mantu.com' }), v = await disputed(ev, SOLO);
  assert.equal(ev.adjudicationRule(ev.load(v.id), SOLO.email), 'single_reviewer');
  // Entra: the app-role holders cannot be counted here, so the rejecter is refused
  ({ ev } = setup({ ...ONE, IDENTITY_SOURCE: 'entra' })); v = await disputed(ev, SOLO);
  await refused(ev.review(SOLO, v.id, 'uphold_rejection', { expected_revision: 1, reason: 'Stands.' }), 'ADJUDICATOR_IS_REJECTER');
  // no Worker env at all: the same
  ({ ev } = setup(undefined)); v = await disputed(ev, SOLO);
  assert.equal(ev.adjudicationRule(ev.load(v.id), SOLO.email), '');
  // a resolved N+1 makes two
  ({ ev } = setup(ONE)); v = await disputed(ev, SOLO); ev.n1 = () => 'sam@mantu.com';
  assert.equal(ev.adjudicationRule(ev.load(v.id), SOLO.email), '');
  assert.equal(ev.adjudicationRule(ev.load(v.id), 'sam@mantu.com'), 'four_eyes');
});

test('D-DSR the owner still cannot adjudicate, even as the only listed admin', async () => {
  const { ev } = setup({ ADMIN_EMAILS: 'alex@mantu.com,solo@mantu.com' }), v = await disputed(ev, SOLO);
  await assert.rejects(ev.review({ ...OWNER, role: 'admin' }, v.id, 'reopen_review', { expected_revision: 1 }), e => e.status === 403);
});

test('D-DSR the review queue lists a dispute with whether this reviewer can settle it', async () => {
  let { ev } = setup(ONE), v = await disputed(ev, SOLO);
  assert.deepEqual(ev.queue(SOLO).map(r => [r.id, r.state, r.can_adjudicate]), [[v.id, 'disputed', true]]);
  ({ ev } = setup(TWO)); v = await disputed(ev, REV);
  assert.deepEqual(ev.queue(REV).map(r => [r.state, r.can_adjudicate]), [['disputed', false]]);
  assert.deepEqual(ev.queue(SOLO).map(r => [r.state, r.can_adjudicate]), [['disputed', true]]);
});

test('D-DSR API: the Worker env reaches the rule through the review route', async () => {
  const call = (l, env, method, path, who, body) => libraryRoutes(new Request('https://atlas.test' + path, { method, headers: { 'x-atlas-user': who.email, 'x-atlas-role': who.role, 'x-atlas-email': who.email }, ...(body ? { body: JSON.stringify(body) } : {}) }), l, { env })
    .then(async r => ({ status: r.status, body: await r.json() }));
  for (const [env, who, status, rule] of [[ONE, SOLO, 200, 'single_reviewer'], [TWO, REV, 403, null]]) {
    const { l, ev } = setup(undefined), v = await disputed(ev, who, 'api-' + status);
    const got = await call(l, env, 'GET', '/api/library/evidence/' + v.id, who);
    assert.equal(got.body.adjudication_policy.may_adjudicate, status === 200);
    const r = await call(l, env, 'POST', '/api/library/evidence/' + v.id + '/review', who, { action: 'uphold_rejection', expected_revision: 1, reason: 'Stands.' });
    assert.equal(r.status, status, JSON.stringify(r.body));
    if (rule) assert.deepEqual([r.body.state, r.body.adjudication.rule, r.body.adjudication.single_reviewer], ['closed_rejected', rule, true]);
    else assert.match(r.body.error, /ADJUDICATOR_IS_REJECTER/);
  }
});
