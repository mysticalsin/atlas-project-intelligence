// Atlas core flow, end to end (Tony, 2026-10-31): the consultant starts from a Project ID, Atlas interviews them, and what they gave reaches the four
// outputs as context: skills (DNA), resume upgrades (MiChat CV), projects (the Project Review hand-off, and IMP's capability signal for staffing) and
// success stories (Spotlight CMS). Real code throughout: the Session (turn handling, ledger, summary read-back), the real postDraftFromInterview into a
// real Library over its HTTP routes (node:sqlite), the evidence store, the policy gate, the branch fan-out and the job queue. Mocked: speech
// recognition, voice, the conversation model and the evidence analyst (reconnect-harness.js), the Durable Object storage, and the destinations
// (adapters.js mocks, mock:true on every acknowledgement). Each destination payload is checked against its request contract
// (atlas_voice/config/contracts/<id>/request.schema.json) and the never-send list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { evidence, postDraftFromInterview } from '../src/evidence.js';
import * as B from '../src/branches.js';
import { registry } from '../src/adapters.js';
import { GATES } from '../src/spotlight.js';
import { findForbidden } from '../src/connectors.js';
import { validate } from '../src/schema-lite.js';
import { CONNECTIONS_CONFIG } from '../src/policy.generated.js';
import { projectContext, talkerMessages } from '../src/session.js';
import { memorySql } from './sqlite.js';
import { rig, opened, talked, send, until, cleanup } from './reconnect-harness.js';

test.afterEach(cleanup);

const CONTRACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../atlas_voice/config/contracts');
const schema = id => JSON.parse(readFileSync(resolve(CONTRACTS_DIR, id, 'request.schema.json'), 'utf8'));
const NEVER = [...CONNECTIONS_CONFIG.data_minimisation.never_send_keys];
const conformant = (id, payload) => {
  const r = validate(schema(id), payload);
  assert.deepEqual(r.errors, [], `${id} payload matches its request contract`);
  const conn = CONNECTIONS_CONFIG.connections.find(c => c.id === id);
  assert.equal(findForbidden(payload, [...NEVER, ...(conn?.never_send_extra || [])]), null, `${id} payload holds no never-send key`);
};

const CONSULTANT = 'alex@mantu.com', REVIEWER = 'rev@mantu.com';
const PROJECT_ID = 'PRJ-2026-0042';
// What the page sends: its local project id, the business Project ID the consultant entered, and the prefill. No name reaches the server's model.
const PROJECT = { id: 'p-local-7', projectId: PROJECT_ID, title: 'Claims triage (synthetic)', consultant: 'Alex', role: 'Data engineer', sector: 'Insurance', stage: 'Production', answers: [] };
const A1 = 'I designed and built the routing model for the claims triage queue, and we shipped the triage queue to every adjuster.';
const A2 = 'Median triage time fell from forty minutes to twelve minutes over six weeks, according to the operations dashboard.';
const DONE = 'That is everything, I am done.';
// The scripted analyst files exact quotes from each turn (field -> ledger -> claim type: contribution=responsibility, intervention=deliverable, measurement=metric).
const FILED = {
  'user-1': [{ field: 'contribution', quote: 'I designed and built the routing model' }, { field: 'intervention', quote: 'we shipped the triage queue to every adjuster' }],
  'user-2': [{ field: 'measurement', quote: 'Median triage time fell from forty minutes to twelve minutes over six weeks' }],
};
const analyst = async messages => {
  const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment, details = (FILED[seg.item_id] || []).map(x => ({ ...x, item_id: seg.item_id }));
  return details.length ? [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details }) }] : [];
};

// A real Library behind the Worker's LIBRARY binding, reached over HTTP like the Interview DO and the browser reach it.
function library() {
  let t = 0, n = 0;
  const lib = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') });
  const env = { ATLAS_ADAPTERS: 'mock' };
  const binding = { LIBRARY: { idFromName: x => x, get: () => ({ fetch: req => libraryRoutes(req, lib, { env }) }) } };
  const http = async (who, role, method, path, body) => {
    const res = await libraryRoutes(new Request('https://atlas.test' + path, { method, headers: { 'Content-Type': 'application/json', 'x-atlas-user': who, 'x-atlas-role': role, 'x-atlas-email': who },
      ...(body ? { body: JSON.stringify(body) } : {}) }), lib, { env });
    const json = await res.json();
    if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  return { lib, ev: evidence(lib), hook: notes => postDraftFromInterview(binding, { user: CONSULTANT, role: 'user', mail: CONSULTANT }, notes), http };
}

async function interview(L) {
  const h = rig({ owner: CONSULTANT, said: [A1, A2, DONE], session: { evidence: L.hook },
    talk: n => n === 0 ? ['Right. ', 'What did you own on this project?'] : n === 1 ? ['Thanks. ', 'What changed, and how was it measured?'] : n === 2 ? ['Thanks. ', 'Anything else?'] : ['I heard that you built the routing model. ', 'What have I missed?'] });
  h.s.ai.analyst = analyst;
  await opened(h, { project: PROJECT });
  for (let turn = 1; turn <= 3 && !h.events.some(e => e.type === 'summary'); turn++) { talked(h); await until(() => h.calls.talker.length === turn + 1 && !h.s.busy()); }
  await until(() => h.events.some(e => e.type === 'summary') && !h.s.busy());
  await send(h, { type: 'confirm_summary' });
  await until(() => h.events.some(e => e.type === 'evidence_draft' || e.type === 'evidence_draft_unavailable'));
  return h;
}

test('E2E-0 the Project ID is accepted, bounded, kept out of every model prompt and becomes the evidence record\'s project reference', () => {
  const ctx = projectContext(PROJECT);
  assert.equal(ctx.projectId, PROJECT_ID);
  assert.equal(projectContext({ ...PROJECT, projectId: 'X'.repeat(500) }).projectId.length, 60);
  assert.ok(!('projectId' in projectContext({ ...PROJECT, projectId: '' })));
  const prompt = JSON.stringify(talkerMessages(ctx, null, [], null));
  assert.ok(!prompt.includes(PROJECT_ID), 'routing data, not model context');
  assert.ok(!prompt.includes('Alex'), 'and still no consultant name');
});

test('E2E-1 project ID -> scripted interview -> confirmed summary -> review -> well-formed context in skills, resume, projects and success stories', async () => {
  const L = library(), h = await interview(L);

  // 1. Start from the Project ID: the interview's notes, and so the owner-only draft, are filed under it.
  const saved = h.events.find(e => e.type === 'evidence_draft');
  assert.ok(saved, 'the confirmed summary was saved: ' + JSON.stringify(h.events.filter(e => e.type === 'evidence_draft_unavailable')));
  const talkerSaw = JSON.stringify(h.calls.talker);
  assert.ok(!talkerSaw.includes(PROJECT_ID) && !talkerSaw.includes('"Alex"'), 'the model never saw the Project ID or the name');
  const id = saved.id ?? saved.draft?.id ?? L.ev.list({ email: CONSULTANT, role: 'user' })[0].id;
  let rec = await L.http(CONSULTANT, 'user', 'GET', `/api/library/evidence/${id}`);
  assert.equal(rec.project_ref, PROJECT_ID);
  assert.equal(rec.state, 'evidence_draft');

  // 2. What the consultant gave became typed claims, each traced to its exact quote.
  const byType = Object.fromEntries(rec.claims.map(c => [c.claim_type, c]));
  assert.deepEqual(Object.keys(byType).sort(), ['deliverable', 'metric', 'responsibility']);
  assert.equal(byType.responsibility.statement, 'I designed and built the routing model');
  assert.ok(rec.claims.every(c => c.source_refs.some(r => r.kind === 'interview' && r.quote === c.statement)));
  assert.ok(rec.claims.every(c => c.subject_type === 'person' || c.subject_id === PROJECT_ID), 'project claims are about this project');

  // The owner puts their contribution in their own words (a CV only carries reviewed wording) and records the metric's fields.
  const OWN = 'Designed and built the claims routing model behind the triage queue.';
  rec = await L.http(CONSULTANT, 'user', 'POST', `/api/library/evidence/${id}/review`, { action: 'amend', expected_revision: rec.revision,
    claims: [{ claim_id: byType.responsibility.claim_id, statement: OWN }, { claim_id: byType.metric.claim_id, value: '12', unit: 'minutes', baseline: '40 minutes', after_state: '12 minutes', period: '6 weeks' }] });
  // Purpose grants for the four outputs, bound to this revision; then submit; then a reviewer (never the author) approves the exact revision and hash.
  for (const purpose of ['skills_profile', 'cv', 'matching', 'public_spotlight'])
    await L.http(CONSULTANT, 'user', 'POST', `/api/library/evidence/${id}/permissions`, { expected_revision: rec.revision, purpose });
  rec = await L.http(CONSULTANT, 'user', 'POST', `/api/library/evidence/${id}/submit`, { expected_revision: rec.revision });
  await assert.rejects(L.http(CONSULTANT, 'user', 'POST', `/api/library/evidence/${id}/review`, { action: 'approve', expected_revision: rec.revision, content_hash: rec.content_hash }), /40[34]/, 'the author cannot approve');
  rec = await L.http(REVIEWER, 'reviewer', 'POST', `/api/library/evidence/${id}/review`, { action: 'approve', expected_revision: rec.revision, content_hash: rec.content_hash });
  assert.equal(rec.state, 'approved');

  // 3. The fan-out: each output got exactly one well-formed payload, from the approved revision only.
  const ad = registry(L.lib), sent = name => { assert.equal(ad[name].calls.length, 1, `${name} called once`); return ad[name].calls[0]; };
  const leak = p => { const t = JSON.stringify(p); for (const s of [A1, A2, DONE, h.events.find(e => e.type === 'ready').sessionId]) assert.ok(!t.includes(s), 'no transcript or session id: ' + s.slice(0, 20)); };

  // Skills -> DNA: proposals only, no invented taxonomy or level, the consultant's own contribution claims.
  const dna = sent('DNA_SKILLS_WRITEBACK');
  conformant('dna_skills', dna.payload); leak(dna.payload);
  assert.equal(dna.payload.consultant_id, CONSULTANT); assert.equal(dna.payload.source_revision, rec.revision); assert.equal(dna.payload.content_hash, rec.content_hash);
  assert.deepEqual(dna.payload.assertions.map(a => [a.claim_type, a.status, a.skill_taxonomy_id, a.level]).sort(), [['deliverable', 'proposed', null, null], ['responsibility', 'proposed', null, null]]);
  assert.equal(dna.payload.reviewer, REVIEWER);

  // Resume upgrades -> MiChat CV: the reviewed wording; the metric as structured fields only (no client text).
  const cv = sent('MICHAT_CV');
  conformant('michat_cv', cv.payload); leak(cv.payload);
  const cvBy = Object.fromEntries(cv.payload.claims.map(c => [c.claim_type, c]));
  assert.equal(cvBy.responsibility.statement, OWN);
  assert.equal(cvBy.metric.statement, null); assert.equal(cvBy.metric.statement_withheld, 'CLIENT_PERMISSION_UNKNOWN');
  assert.deepEqual([cvBy.metric.value, cvBy.metric.unit, cvBy.metric.baseline, cvBy.metric.after_state, cvBy.metric.period], ['12', 'minutes', '40 minutes', '12 minutes', '6 weeks']);
  assert.equal(cvBy.deliverable.statement_withheld, 'VERBATIM_ASR_NOT_REVIEWED', 'a raw speech-recognition quote never lands on a CV');
  assert.deepEqual(cv.payload.permissions.map(p => p.purpose), ['cv']);

  // Projects -> IMP capability signal (staffing for future projects): signals only; availability is IMP's.
  const imp = sent('IMP_CAPABILITY');
  conformant('imp_capability', imp.payload); leak(imp.payload);
  assert.equal(imp.payload.availability, null);
  assert.deepEqual(imp.payload.signals.map(s => s.claim_type).sort(), ['deliverable', 'responsibility']);
  assert.deepEqual(imp.payload.permissions.map(p => p.purpose), ['matching']);

  // Projects -> Project Review hand-off: the Project ID and the approved evidence reference; no rubric is invented, rating and closing stay refused.
  const pr = sent('PROJECT_REVIEW');
  conformant('project_review', pr.payload); leak(pr.payload);
  assert.equal(pr.payload.project_id, PROJECT_ID); assert.equal(pr.payload.rubric_version, null);
  assert.deepEqual(pr.payload.evidence_refs, [{ entity_id: id, revision: rec.revision }]);
  assert.deepEqual(ad.PROJECT_REVIEW.rate(), { allow: false, reason: 'PROJECT_REVIEW_NOT_CONFIGURED' });

  let view = await L.http(CONSULTANT, 'user', 'GET', `/api/library/evidence/${id}/status`);
  const card = b => view.cards.find(c => c.branch === b);
  assert.deepEqual(['dna', 'michat', 'imp'].map(b => card(b).display_status), ['mock_acknowledged', 'mock_acknowledged', 'mock_acknowledged'], 'a mock acknowledgement is never "synced"');
  assert.equal(card('project_review').display_status, 'pending');
  assert.equal(card('spotlight').display_status, 'draft', 'a success story is nominated, not published');

  // Success stories -> Spotlight CMS: every gate, then the exact revision goes out as the public projection, held by the mock CMS.
  const at = { expected_revision: rec.revision, content_hash: rec.content_hash }, CHANNEL = 'spotlight-web';
  const roleFor = { claim_level_evidence: 'reviewer', project_owner_approval: 'project_owner', customer_permission_if_required: 'customer_liaison', confidentiality_review: 'confidentiality_reviewer',
    privacy_legal_review_if_required: 'legal_reviewer', brand_approval: 'brand_approver', exact_revision_publication_authorization: 'spotlight_approver' };
  const as = g => ({ sub: g === 'claim_level_evidence' ? REVIEWER : `${roleFor[g]}@mantu.com`, roles: [roleFor[g]] });
  B.requestSpotlightApproval(L.ev, as('claim_level_evidence'), id, at);
  for (const g of GATES) B.approveSpotlightGate(L.ev, as(g), id, g, { ...at, channel: CHANNEL, ...(g === 'privacy_legal_review_if_required' ? { decision: 'not_required', reason: 'No legal check needed.' } : {}) });
  assert.equal((await B.publishSpotlight(L.ev, as('exact_revision_publication_authorization'), id, { ...at, channel: CHANNEL })).allow, true);
  const cms = sent('SPOTLIGHT_CMS');
  conformant('spotlight_cms', cms.payload); leak(cms.payload);
  assert.equal(cms.payload.audience, 'public'); assert.equal(cms.payload.channel, CHANNEL); assert.equal(cms.payload.content_hash, rec.content_hash);
  assert.ok(!JSON.stringify(cms.payload).includes(CONSULTANT), 'no consultant email in a public story');
  view = await L.http(CONSULTANT, 'user', 'GET', `/api/library/evidence/${id}/status`);
  assert.equal(card('spotlight').display_status, 'held', 'the furthest a mock CMS can go: held, never published');
  assert.equal(view.overall.complete, false, 'nothing claims to be done while every destination is a mock');
});

test('E2E-2 no Project ID: the page\'s own project id is still the reference (older pages), and a brand-new project files no fake one', async () => {
  for (const [project, expected] of [[{ ...PROJECT, projectId: undefined }, 'p-local-7'], [{ ...PROJECT, id: 'new', projectId: undefined }, null]]) {
    const L = library(), h = rig({ owner: CONSULTANT, said: [A1, DONE], session: { evidence: L.hook }, talk: n => n === 0 ? ['Right. ', 'What did you own?'] : n === 1 ? ['Thanks. ', 'Anything else?'] : ['I heard you built the routing model. ', 'What have I missed?'] });
    h.s.ai.analyst = analyst;
    const { projectId, ...p } = project;
    await opened(h, { project: p });
    for (let turn = 1; turn <= 2 && !h.events.some(e => e.type === 'summary'); turn++) { talked(h); await until(() => h.calls.talker.length === turn + 1 && !h.s.busy()); }
    await until(() => h.events.some(e => e.type === 'summary') && !h.s.busy());
    await send(h, { type: 'confirm_summary' }); await until(() => h.events.some(e => e.type === 'evidence_draft'));
    assert.equal(L.ev.list({ email: CONSULTANT, role: 'user' })[0].project_ref, expected);
    await cleanup();
  }
});

test('E2E-3 a destination failing never blocks the others, and the failed one can be retried to the same well-formed payload', async () => {
  const L = library(), ad = registry(L.lib);
  ad.MICHAT_CV.failNext(1, { retryable: false, error: 'MOCK_DOWN' });
  const h = await interview(L), id = h.events.find(e => e.type === 'evidence_draft').id ?? L.ev.list({ email: CONSULTANT, role: 'user' })[0].id;
  let rec = await L.http(CONSULTANT, 'user', 'GET', `/api/library/evidence/${id}`);
  for (const purpose of ['skills_profile', 'cv', 'matching']) await L.http(CONSULTANT, 'user', 'POST', `/api/library/evidence/${id}/permissions`, { expected_revision: rec.revision, purpose });
  rec = await L.http(CONSULTANT, 'user', 'POST', `/api/library/evidence/${id}/submit`, { expected_revision: rec.revision });
  rec = await L.http(REVIEWER, 'reviewer', 'POST', `/api/library/evidence/${id}/review`, { action: 'approve', expected_revision: rec.revision, content_hash: rec.content_hash });
  let view = await L.http(CONSULTANT, 'user', 'GET', `/api/library/evidence/${id}/status`);
  const card = b => view.cards.find(c => c.branch === b);
  assert.equal(card('dna').display_status, 'mock_acknowledged'); assert.equal(card('imp').display_status, 'mock_acknowledged');
  assert.ok(['failed', 'needs_reconciliation'].includes(card('michat').display_status), card('michat').display_status);
  assert.equal(card('spotlight').display_status, 'draft', 'nominated; without a public_spotlight grant it can never be published');
  const job = L.lib.rows("SELECT job_id FROM jobs WHERE destination = 'MiChat'")[0];
  view = await L.http(REVIEWER, 'reviewer', 'POST', `/api/library/evidence/${id}/sync`, { recover_job: job.job_id });
  view = await L.http(CONSULTANT, 'user', 'GET', `/api/library/evidence/${id}/status`);
  assert.equal(card('michat').display_status, 'mock_acknowledged');
  assert.equal(ad.MICHAT_CV.calls.length, 2); assert.deepEqual(ad.MICHAT_CV.calls[1].payload, ad.MICHAT_CV.calls[0].payload, 'the retry sends the same payload');
  conformant('michat_cv', ad.MICHAT_CV.calls[1].payload);
});
