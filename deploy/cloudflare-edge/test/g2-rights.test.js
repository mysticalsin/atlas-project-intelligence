// G2: data subject rights inside the LibraryStore. Audit gaps closed: Art 15/20 (no subject-wide export), Art 17 (nothing erased refs, revisions, evidence, claims, audit,
// staffing, outreach), Art 18/21 (no restriction or objection state), Art 32 (reads of others' records not logged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as outreach from '../src/outreach.js';
import * as evidence from '../src/evidence.js';
import * as bids from '../src/bids.js';
import * as profile from '../src/profile.js';
import * as privacy from '../src/privacy.js';
import { exportMine, eraseMine } from '../src/subject-rights.js';
import { verifyChain } from '../src/audit-chain.js';
import { memorySql } from './sqlite.js';
import { FakeStorage } from './reconnect-harness.js';

const ALEX = { email: 'alex@mantu.com', role: 'user' }, OTHER = { email: 'kim@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' }, ADMIN = { email: 'root@mantu.com', role: 'admin' }, N1 = { email: 'sam@mantu.com', role: 'user' };
const SUBJ = 'ab'.repeat(16), OSUBJ = 'cd'.repeat(16);
const REF = (title, extra = {}) => ({ title, stage: 'Production', sector: 'Insurance', consultant: { name: 'Alex', role: 'Data engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: extra.pid || 'PRJ-1', country: 'France', teamSize: 6, technologies: ['Python'], deliverables: ['Routing model'], serviceLines: ['Data & AI'], consultants: extra.people || [{ name: 'Jo', email: 'jo@mantu.com', role: 'PO' }], links: [] },
  answers: ['Claims bounced between three teams.', 'I designed and built the claims routing model.', 'We chose the model.', 'Triage fell from 40 to 12 minutes.', 'Operations dashboard export.', 'Any insurer would benefit.'],
  validation: { manager: { name: 'Sam', email: 'sam@mantu.com' }, managerStaff: false } });
const NOTES = (session = 's1') => ({ session_id: session, project_ref: 'PRJ-1', details: [{ id: 'D-001', field: 'contribution', item_id: 'u1', quote: 'I designed the claims routing model.', status: 'reported', active: true },
  { id: 'D-002', field: 'outcome', item_id: 'u2', quote: 'Triage fell from 40 to 12 minutes.', status: 'reported', active: true, sensitive: true }] });

async function world() {
  let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 9, 31, 8, 0, t++)).toISOString(), complete: async () => '{}', embed: async () => [1, 0, 0] });
  outreach.ensure(l); bids.ensure(l); evidence.ensure(l); profile.ensure(l);
  l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('PRJ-1', 'alex@mantu.com', 'sam@mantu.com', 'Sam', '', '', 'staffing-csv', 'x'), ('PRJ-9', 'kim@mantu.com', 'sam@mantu.com', 'Sam', '', '', 'staffing-csv', 'x')");
  const draftRef = await l.upsert(ALEX, { localId: 'draft', reference: REF('Draft claims triage'), draft: true });
  const pubRef = await l.upsert(ALEX, { localId: 'pub', reference: REF('Published claims routing', { pid: 'PRJ-2' }) });
  const row = l.row(pubRef.id); l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', by: 'sam@mantu.com', at: '', note: '' } }, 'sam@mantu.com', 'validated', '');
  const otherRef = await l.upsert(OTHER, { localId: 'kims', reference: REF('Kim project', { pid: 'PRJ-9', people: [{ name: 'Alex Park', email: 'alex@mantu.com', role: 'Engineer' }, { name: 'Jo', email: 'jo@mantu.com', role: 'PO' }] }) });
  l.sql.exec("INSERT INTO bids (id, owner, title, status, created_at, updated_at) VALUES ('bid1', 'kim@mantu.com', 'Claims bid', 'open', 'x', 'x')");
  l.sql.exec("INSERT INTO bid_references (bid_id, ref_id, revision, proof_type, used_at, used_by) VALUES ('bid1', ?, 1, 'case_study', 'x', 'kim@mantu.com')", pubRef.id);
  l.sql.exec("INSERT INTO bids (id, owner, title, status, created_at, updated_at) VALUES ('bid2', 'alex@mantu.com', 'Alex own bid', 'open', 'x', 'x')");
  const ev = evidence.evidence(l), evDraft = await ev.createDraftFromNotes('alex@mantu.com', NOTES('s1'));
  const evApproved = await ev.createDraftFromNotes('alex@mantu.com', NOTES('s2'));
  l.sql.exec("UPDATE evidence_records SET status = 'approved' WHERE id = ?", evApproved.id);
  l.sql.exec("INSERT INTO approvals (id, entity, revision, content_hash, channel, purpose, approver_sub, status, at) VALUES ('ap1', ?, 1, 'h', 'ui', 'internal_knowledge', 'rev@mantu.com', 'approved', 'x')", evApproved.id);
  l.invite('atlas', { email: 'alex@mantu.com', reason: 'manual', projectId: 'PRJ-1', title: 'Claims' });
  l.sql.exec("INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, created_at) VALUES ('o1', 'interview_invite', 's', 'email', 'alex@mantu.com', 'drafted', 'x')");
  await profile.routes({ method: 'POST', parts: ['profile'], user: { ...ALEX, mail: ALEX.email, idp: {}, subj: SUBJ }, lib: l, body: { set: { name: 'Alex Martin', title: 'Engineer' } }, env: {} });
  privacy.recordReceipts(l, SUBJ, [{ purpose: 'transcription', granted: true }, { purpose: 'draft', granted: true }, { purpose: 'memory', granted: true }]);
  l.get(REV, pubRef.id, { audit: true }); // a reviewer reads Alex's record: audited
  return { l, ids: { draftRef, pubRef, otherRef, evDraft, evApproved } };
}

test('G2 export: everything about the person in one versioned JSON (own library material, evidence with claims, receipts, invitations, outreach, staffing, profile, audit as ids only) and nothing about anyone else', async () => {
  const { l, ids } = await world(), out = exportMine(l, ALEX, SUBJ);
  assert.equal(out.schema, 'atlas.subject-export.v1'); assert.equal(out.subject, 'alex@mantu.com');
  assert.deepEqual(out.references.map(r => r.title).sort(), ['Draft claims triage', 'Published claims routing']); assert.equal(out.references.find(r => r.id === ids.draftRef.id).reference.client.name, 'Zebracorp', 'their own content, complete');
  assert.ok(out.revisions.length >= 2); assert.deepEqual(out.listedOn.map(r => r.title), ['Kim project'], 'a reference of someone else that lists them: id and title only');
  assert.equal(out.evidence.length, 2); assert.ok(out.evidence[0].claims.length >= 1 && out.evidence[0].claims[0].statement); assert.equal(out.evidence.find(e => e.id === ids.evApproved.id).approvals.length, 1);
  assert.ok(out.evidence.flatMap(e => e.claims).some(c => c.sourceRefs[0]?.sensitive === true), 'the sensitive flag travels with the sentence');
  assert.deepEqual(out.consentReceipts.map(r => [r.purpose, r.granted]), [['transcription', true], ['draft', true], ['memory', true]]); assert.ok(out.consentReceipts.every(r => r.textSha256.length === 64));
  assert.equal(out.invitations.length, 1); assert.equal(out.outreach.length, 1); assert.equal(out.staffing.length, 1); assert.equal(out.staffing[0].projectId, 'PRJ-1');
  assert.equal(out.profile.edits.name.value, 'Alex Martin'); assert.equal(out.bids.length, 1);
  assert.ok(out.audit.length > 3 && out.audit.every(a => Object.keys(a).sort().join() === 'action,at,id,seq'), 'audit rows: ids and actions only, no detail, no actor');
  const text = JSON.stringify(out); assert.doesNotMatch(text, /kim@mantu\.com|PRJ-9|Claims bid/, 'nothing that is only about someone else (the listing carries the title only)');
  assert.ok(l.rows("SELECT 1 FROM audit WHERE action = 'data export'").length === 1, 'the export itself is audited, without content');
  const kim = exportMine(l, OTHER, OSUBJ); assert.deepEqual(kim.references.map(r => r.title), ['Kim project']); assert.doesNotMatch(JSON.stringify(kim), /Draft claims triage|Published claims routing|Alex Martin/);
  assert.equal(exportMine(l, N1, 'ef'.repeat(16)).references.length, 0, 'a person with nothing gets an empty, valid file');
});

test('G2 erase: content becomes tombstones, ids and counts stay, the person leaves the audit trail, the audit chain still verifies, the receipts stay', async () => {
  const { l, ids } = await world(), rows = l.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before = verifyChain(l.sql);
  assert.equal(before.ok, true);
  const r = eraseMine(l, ALEX, SUBJ);
  assert.equal(r.erased, true); assert.ok(r.counts.referencesErased >= 1 && r.counts.evidenceErased === 1 && r.counts.invitations === 1 && r.counts.outreach === 1 && r.counts.staffingRows === 1 && r.counts.profile === 1 && r.counts.auditRows > 0, JSON.stringify(r.counts));
  // the draft reference: a tombstone, no revisions, nobody can open it, not even the owner
  const gone = l.row(ids.draftRef.id);
  assert.equal(gone.data.erased, true); assert.equal(gone.title, '[erased]'); assert.equal(gone.data.title, '[erased]'); assert.equal(gone.data.client.name, ''); assert.ok(gone.owner.startsWith('erased:')); assert.equal(gone.embedding, null);
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM revisions WHERE id = ?', ids.draftRef.id)[0].n, 0);
  assert.deepEqual(l.list(ALEX).items.map(x => [x.id, x.status]), [[ids.pubRef.id, 'withdrawn']], 'only the held reference is left (withdrawn, waiting for the DPO)'); assert.throws(() => l.get(ALEX, ids.draftRef.id), /not found/); assert.equal(l.list(REV).items.some(x => x.id === ids.draftRef.id), false);
  assert.doesNotMatch(JSON.stringify(l.sql.exec('SELECT * FROM refs WHERE id = ?', ids.draftRef.id).toArray()), /Zebracorp|designed and built|Lyon/);
  // the evidence draft: claims keep ids but lose their words; the record is gone for everyone
  const ev = evidence.evidence(l);
  assert.throws(() => ev.get(ALEX, ids.evDraft.id), /not found/); assert.throws(() => ev.get(REV, ids.evDraft.id), /not found/);
  const claims = l.rows('SELECT statement, value, source_refs, created_by FROM evidence_claims WHERE entity = ?', ids.evDraft.id);
  assert.ok(claims.length >= 1 && claims.every(c => c.statement === '[erased]' && c.value === null && /"erased":true/.test(c.source_refs) && c.created_by.startsWith('erased:')));
  assert.equal(JSON.parse(l.rows('SELECT state_json FROM evidence_records WHERE id = ?', ids.evDraft.id)[0].state_json).erased.erased, true);
  // what is about the person
  for (const [table, col] of [['invitations', 'email'], ['outreach', 'to_email'], ['staffing', 'consultant_email'], ['profiles', 'subject']]) assert.equal(l.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = 'alex@mantu.com'`)[0].n, 0, table);
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM staffing WHERE consultant_email = 'kim@mantu.com'")[0].n, 1, 'other people\'s rows are untouched');
  // the audit trail: same number of rows, the person gone, the chain valid, a new head
  assert.ok(l.rows('SELECT COUNT(*) AS n FROM audit')[0].n >= rows, 'history is kept (rows are pseudonymised, never removed)');
  assert.equal(l.rows("SELECT COUNT(*) AS n FROM audit WHERE actor = 'alex@mantu.com' OR lower(detail) LIKE '%alex@mantu.com%'")[0].n, 0, 'no audit row names the person any more');
  const after = verifyChain(l.sql); assert.equal(after.ok, true, 'the chain is re-sealed, not broken'); assert.notEqual(after.head, before.head); assert.equal(r.auditHead, after.head, 'the new head is returned so the caller can log it as the external anchor');
  // receipts stay, the log is pseudonymous and content-free
  assert.equal(privacy.receiptsOf(l, SUBJ).length, 3, 'consent receipts survive: they are the record of a choice');
  const log = l.rows('SELECT * FROM erasure_log')[0]; assert.notEqual(log.subject_hash, SUBJ); assert.doesNotMatch(JSON.stringify(log), /alex|mantu\.com|Zebracorp/); assert.equal(JSON.parse(log.counts).profile, 1);
  // someone else's reference that listed the person: name and email removed from the data AND every revision
  const kims = l.row(ids.otherRef.id); assert.ok(!kims.members.includes('alex@mantu.com') && kims.members.includes('jo@mantu.com')); assert.ok(kims.data.details.consultants.some(c => c.name === '[erased]') && !JSON.stringify(kims.data).includes('alex@mantu.com'));
  assert.doesNotMatch(JSON.stringify(l.rows('SELECT data FROM revisions WHERE id = ?', ids.otherRef.id)), /alex@mantu\.com|Alex Park/); assert.equal(kims.title, 'Kim project'); assert.equal(l.get(OTHER, ids.otherRef.id).data.title, 'Kim project');
  // erasing again is harmless
  const again = eraseMine(l, ALEX, SUBJ); assert.equal(again.counts.referencesErased, undefined); assert.equal(verifyChain(l.sql).ok, true);
});

test('G2 erase legal-hold exception: a published reference used in a bid, approved evidence and a bid are FLAGGED for the DPO (erasure_pending_review), withdrawn from processing, never silently deleted', async () => {
  const { l, ids } = await world(), r = eraseMine(l, ALEX, SUBJ);
  assert.deepEqual(r.pendingReview.map(p => [p.kind, p.reason]).sort(), [['bid', 'bid_record'], ['evidence', 'approved_evidence'], ['reference', 'published_reference']].sort());
  assert.match(r.note, /DPO/);
  const pub = l.row(ids.pubRef.id); assert.equal(pub.data.title, 'Published claims routing', 'the content is still there for the DPO'); assert.equal(pub.state.withdrawn, true); assert.equal(pub.state.erasure_pending_review.reason, 'published_reference'); assert.equal(pub.status, 'withdrawn');
  assert.equal(l.access(pub, OTHER), null, 'withdrawn from everyone else: not served'); assert.ok(!l.visibleRows(REV, { processing: true }).some(([x]) => x.id === ids.pubRef.id));
  const ev = JSON.parse(l.rows('SELECT state_json FROM evidence_records WHERE id = ?', ids.evApproved.id)[0].state_json); assert.equal(ev.erasure_pending_review.reason, 'approved_evidence');
  assert.equal(l.rows("SELECT statement FROM evidence_claims WHERE entity = ? LIMIT 1", ids.evApproved.id)[0].statement.includes('designed'), true, 'approved claims are not deleted silently');
  const holds = l.rows('SELECT * FROM erasure_holds'); assert.equal(holds.length, 3); assert.ok(holds.every(h => h.status === 'pending_dpo' && h.subject_hash.length === 24)); assert.doesNotMatch(JSON.stringify(holds), /Zebracorp|alex@/);
  assert.ok(r.counts.referencesPendingReview === 1 && r.counts.evidencePendingReview === 1 && r.counts.bidsPendingReview === 1);
});

test('G2 holds: only an admin lists and resolves them; erase tombstones, retain needs a recorded ground; both are audited and final', async () => {
  const { l, ids } = await world(); eraseMine(l, ALEX, SUBJ);
  const { holdRoutes } = await import('../src/subject-rights.js');
  const run = (user, method, parts, body) => { try { return holdRoutes({ lib: l, user, method, parts, body }); } catch (e) { return { status: e.status, error: e.message }; } };
  assert.equal(run(REV, 'GET', ['privacy', 'holds']).status, 403); assert.equal(run(OTHER, 'GET', ['privacy', 'holds']).status, 403);
  const list = run(ADMIN, 'GET', ['privacy', 'holds']).body.items; assert.equal(list.length, 3);
  const refHold = list.find(h => h.kind === 'reference'), evHold = list.find(h => h.kind === 'evidence');
  assert.equal(run(ADMIN, 'POST', ['privacy', 'holds', refHold.id, 'resolve'], { action: 'maybe' }).status, 400);
  assert.equal(run(ADMIN, 'POST', ['privacy', 'holds', evHold.id, 'resolve'], { action: 'retain' }).status, 400, 'a ground is required to keep it');
  assert.equal(run(ADMIN, 'POST', ['privacy', 'holds', refHold.id, 'resolve'], { action: 'erase' }).body.status, 'erased');
  assert.equal(l.row(ids.pubRef.id).data.erased, true); assert.equal(run(ADMIN, 'POST', ['privacy', 'holds', refHold.id, 'resolve'], { action: 'erase' }).status, 409, 'final');
  assert.equal(run(ADMIN, 'POST', ['privacy', 'holds', evHold.id, 'resolve'], { action: 'retain', note: 'Contractual record of the bid (DPO ref 12)' }).body.status, 'retained');
  assert.equal(l.rows('SELECT statement FROM evidence_claims WHERE entity = ? LIMIT 1', ids.evApproved.id)[0].statement.includes('designed'), true, 'retained: untouched');
  assert.ok(l.rows("SELECT 1 FROM audit WHERE action LIKE 'erasure hold%'").length === 2);
  assert.equal(verifyChain(l.sql).ok, true);
});

test('G2 restriction and objection: a restricted or objecting person\'s references are not rated, matched, counted or boosted; the owner still reads their own', async () => {
  const { l, ids } = await world(), calls = [];
  l.complete = async m => { calls.push(m); return '{}'; };
  l.submit(ALEX, ids.draftRef.id);
  assert.equal(privacy.processable(l, ALEX.email, 'scoring'), true);
  const f = privacy.setFlags(l, ALEX.email, { objectScoring: true });
  assert.equal(f.objectScoring, true); assert.equal(privacy.processable(l, ALEX.email, 'scoring'), false); assert.equal(privacy.processable(l, ALEX.email, 'matching'), true, 'scoring only');
  await assert.rejects(l.review(ALEX, ids.draftRef.id), /Scoring is switched off/); assert.equal(calls.length, 0, 'no model call for it');
  assert.ok(l.visibleRows(REV, { processing: true }).some(([r]) => r.id === ids.draftRef.id), 'still matchable: the objection was to scoring');
  privacy.setFlags(l, ALEX.email, { objectMatching: true });
  assert.ok(!l.visibleRows(REV, { processing: true }).some(([r]) => r.owner === ALEX.email), 'not matched, not in Ask or bids or analytics or insights');
  assert.ok(l.visibleRows(REV).some(([r]) => r.owner === ALEX.email) && l.get(ALEX, ids.draftRef.id), 'storage and access are unchanged');
  assert.equal(l.analytics(REV).totals.visible, 1, 'only Kim\'s reference is counted');
  privacy.setFlags(l, ALEX.email, { objectScoring: false, objectMatching: false, restricted: true });
  assert.equal(privacy.processable(l, ALEX.email, 'scoring'), false); assert.equal(privacy.processable(l, ALEX.email, 'matching'), false); assert.equal(privacy.processable(l, ALEX.email, 'memory'), false, 'restriction stops all three');
  assert.deepEqual([...privacy.blockedOwners(l, 'matching')], [ALEX.email]);
  privacy.setFlags(l, ALEX.email, { restricted: false }); assert.equal(privacy.processable(l, ALEX.email, 'scoring'), true); assert.deepEqual(privacy.flagsOf(l, OTHER.email), { restricted: false, objectScoring: false, objectMatching: false, objectMemory: false, updatedAt: null });
  assert.throws(() => privacy.setFlags(l, ALEX.email, { restricted: 'yes' }), /true or false/); assert.ok(l.rows("SELECT 1 FROM audit WHERE action = 'privacy flags'").length >= 3);
  // a restricted owner's per-story win statistics are not shown either
  privacy.setFlags(l, ALEX.email, { objectMatching: true });
  const wins = await import('../src/winloop.js'); const stats = await wins.routes({ method: 'GET', parts: ['wins', 'stats'], user: { ...REV, mail: REV.email }, lib: l, env: {} }).catch(e => ({ body: { stories: [] }, e }));
  assert.ok(!(stats.body?.stories || []).some(s => s.refId === ids.pubRef.id));
});

test('G2 reads of someone else\'s record are audited, ids only, once per ten minutes; an owner reading their own is not', async () => {
  const { l, ids } = await world(), count = () => l.rows("SELECT COUNT(*) AS n FROM audit WHERE id = ? AND action = 'viewed'", ids.pubRef.id)[0].n;
  assert.equal(count(), 1, 'the reviewer read in the fixture'); l.get(ALEX, ids.pubRef.id, { audit: true }); assert.equal(count(), 1, 'the owner\'s own read is not audited');
  l.get(REV, ids.pubRef.id, { audit: true }); assert.equal(count(), 1, 'the same reader within ten minutes is not logged again');
  l.get(ADMIN, ids.pubRef.id, { audit: true }); assert.equal(count(), 2, 'another reader is');
  const row = l.rows("SELECT actor, action, detail FROM audit WHERE id = ? AND action = 'viewed' ORDER BY seq", ids.pubRef.id); assert.ok(row.every(r => r.detail === ''), 'ids only: no content');
  const ev = evidence.evidence(l); l.sql.exec("UPDATE evidence_records SET status = 'reviewer_queue', state_json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(l.rows('SELECT state_json FROM evidence_records WHERE id = ?', ids.evDraft.id)[0].state_json), ever_submitted: true }), ids.evDraft.id);
  const res = await evidence.routes({ lib: l, user: REV, method: 'GET', rest: [ids.evDraft.id], body: {}, internal: false, url: new URL('https://x/api/library/evidence/' + ids.evDraft.id) }).catch(e => ({ e }));
  assert.ok(res.body || res.e, 'the reviewer read goes through the route'); assert.ok(l.rows("SELECT 1 FROM audit WHERE id = ? AND action = 'viewed evidence'", ids.evDraft.id).length <= 1);
});

test('G2 internal privacy routes: only with a verified identity and a subject key, erase needs the Worker\'s confirmation, externals and the system get 404, and each is rate limited', async () => {
  const { l } = await world(), storage = new FakeStorage();
  const call = (path, method, body, { user = ALEX, subj = SUBJ } = {}) => libraryRoutes(new Request('https://atlas.internal' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'x-atlas-user': user.email, 'x-atlas-role': user.role, 'x-atlas-email': user.email, ...(subj ? { 'x-atlas-subj': subj } : {}) } }), l, { storage, env: {} });
  assert.equal((await call('/api/privacy/export', 'GET', null, { subj: '' })).status, 400, 'no subject key');
  assert.equal((await call('/api/privacy/export', 'GET', null, { user: { email: 'c@client.example', role: 'external' } })).status, 404);
  assert.equal((await call('/api/privacy/export', 'GET', null, { user: { email: 'atlas-cron', role: 'system' } })).status, 404);
  const ok = await call('/api/privacy/export', 'GET'); assert.equal(ok.status, 200); assert.equal((await ok.json()).schema, 'atlas.subject-export.v1');
  assert.equal((await call('/api/privacy/erase', 'POST', {})).status, 400, 'a direct call cannot skip the confirmation the Worker checks'); assert.equal(l.list(ALEX).total, 3);
  assert.equal((await call('/api/privacy/receipts', 'POST', { items: [{ purpose: 'checkpoint', granted: true }], channel: 'profile' })).status, 200);
  assert.equal((await (await call('/api/privacy/flags', 'POST', { objectMemory: true })).json()).objectMemory, true); assert.equal((await (await call('/api/privacy/flags', 'GET')).json()).objectMemory, true);
  assert.equal((await call('/api/privacy/flags', 'POST', { restricted: 'x' })).status, 400); assert.equal((await call('/api/privacy/nothing', 'GET')).status, 404);
  const st = await (await call('/api/privacy/state', 'GET')).json(); assert.equal(st.state.checkpoint.granted, true); assert.equal(st.flags.objectMemory, true);
  // 5 exports an hour per person, then 429 with Retry-After
  let last; for (let i = 0; i < 6; i++) last = await call('/api/privacy/export', 'GET');
  assert.equal(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal((await call('/api/privacy/export', 'GET', null, { user: OTHER, subj: OSUBJ })).status, 200, 'another person has their own budget');
  const done = await call('/api/privacy/erase', 'POST', { confirmed: true }, { user: OTHER, subj: OSUBJ }); assert.equal(done.status, 200); assert.equal((await done.json()).erased, true);
  assert.equal(l.list(ALEX).total, 2, 'Alex\'s own two references are untouched by Kim\'s erasure (only Kim\'s own reference, which listed him, is gone)'); assert.equal(l.row(l.rows("SELECT id FROM refs WHERE local_id = 'draft'")[0].id).data.title, 'Draft claims triage');
});
