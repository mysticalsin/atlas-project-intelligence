import test from 'node:test';
import assert from 'node:assert/strict';
import { bankId, hindsight, projectDocument, retainItems, memoryNote, jevRelevant, recallQuery, scrub } from '../src/memory.js';
import { memoryRoutes } from '../src/memory-routes.js';
import { Session, talkerMessages } from '../src/session.js';

const ENV = { HINDSIGHT_URL: 'https://hs.example/', HINDSIGHT_API_KEY: 'hs-key', HINDSIGHT_OPT_IN: '1', CSRF_SECRET: 'csrf', ATLAS_TENANT_ISOLATION: 'local-synthetic' };
function fakeHS(reply = {}) {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const path = new URL(url).pathname;
    const out = path.endsWith('/recall') ? (reply.recall || { results: [] }) : path.endsWith('/documents') ? (reply.documents || { items: [] }) : {};
    return new Response(JSON.stringify(out), { status: reply.status || 200 }); };
  return { calls, fetcher };
}
const P = { localId: 'p-123', title: 'Claims triage alias', stage: 'Pilot', sector: 'Insurance', consultant: { role: 'Data engineer' }, client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', technologies: ['Python'], deliverables: [] }, answers: ['Zebracorp in Lyon had slow claims.', 'I built the model.', '', 'Triage fell from 40 to 12 minutes.', '', ''],
  report: { headline: 'Claims triage rebuilt', summary: 'The consultant rebuilt triage.', gaps: ['No named source'], follow_ups: ['Who owns the dashboard?'] }, conversation: 'I told the Head of Claims at Zebracorp we would ship.' };

test('bank id: server-derived per verified subject, stable, never guessable from the subject alone', async () => {
  const a = await bankId(ENV, 'user-a'), b = await bankId(ENV, 'user-b');
  assert.equal(a, await bankId(ENV, 'user-a')); assert.notEqual(a, b); assert.match(a, /^atlas-[0-9a-f]{40}$/);
  assert.notEqual(a, await bankId({ ...ENV, HINDSIGHT_BANK_SECRET: 'other' }, 'user-a'));
  const tid = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  const enforced = { ...ENV, ATLAS_TENANT_ISOLATION: 'enforced', DATA_MODE: 'production' };
  const scoped = await bankId(enforced, 'user-a', tid);
  assert.notEqual(scoped, a, 'a verified tenant does not open the subject-only bank');
  assert.notEqual(scoped, await bankId(enforced, 'user-a', other));
  await assert.rejects(bankId(enforced, 'user-a', ''), /verified tenant/);
});

test('project document: complete, labelled self-reported, client details scrubbed everywhere', () => {
  const d = projectDocument(P);
  assert.match(d, /Self-reported by the consultant/); assert.match(d, /Still missing or unverified: No named source/); assert.match(d, /Open follow-up questions: Who owns the dashboard\?/);
  assert.doesNotMatch(d, /Zebracorp|Lyon|Head of Claims/); assert.match(d, /the client in the client had slow claims/);
  const items = retainItems(P, '2026-09-27T10:00:00.000Z');
  assert.equal(items[0].document_id, 'project-p-123'); assert.deepEqual(items[0].tags, ['atlas', 'project:p-123']); assert.equal(items[0].update_mode, 'replace');
  assert.doesNotMatch(JSON.stringify(items), /Zebracorp|Head of Claims/); assert.match(items[1].document_id, /^conversation-p-123-20260927100000000$/);
  assert.throws(() => retainItems({ ...P, localId: '' }), /project id/);
  assert.equal(scrub('ab', { name: 'ab' }), 'the client', 'a name of 2 characters is masked in its stored spelling');
  assert.equal(scrub('AB', { name: 'ab' }), 'the client', 'and in its upper-case spelling');
  assert.equal(scrub('ab', { name: 'AB' }), 'ab', 'the lower-case spelling of a stored upper-case pair stays');
});

test('Hindsight client: verified endpoints, Bearer key, bank configured once, async retain, tag-scoped recall', async () => {
  const { calls, fetcher } = fakeHS({ recall: { results: [{ text: 'Baseline was not measured yet.', tags: ['atlas', 'project:p-123'], mentioned_at: '2026-09-01' }, { text: '' }] } });
  const hs = hindsight(ENV, fetcher);
  await hs.retain('atlas-x', retainItems(P)); await hs.retain('atlas-x', retainItems(P));
  const got = await hs.recall('atlas-x', recallQuery({ id: 'p-123', title: 'Claims' }), { tags: ['project:p-123'] });
  assert.deepEqual(calls.map(c => c.method + ' ' + new URL(c.url).pathname), ['PUT /v1/default/banks/atlas-x', 'POST /v1/default/banks/atlas-x/memories', 'POST /v1/default/banks/atlas-x/memories', 'POST /v1/default/banks/atlas-x/memories/recall']);
  assert.ok(calls.every(c => c.auth === 'Bearer hs-key')); assert.match(calls[0].body.retain_mission, /Never extract client company names/);
  assert.equal(calls[1].body.async, true); assert.equal(calls[1].body.items.length, 2);
  assert.deepEqual([calls[3].body.tags, calls[3].body.tags_match, calls[3].body.budget], [['project:p-123'], 'any', 'low']);
  assert.deepEqual(got.map(g => g.text), ['Baseline was not measured yet.']);
  assert.equal(hindsight({ ...ENV, HINDSIGHT_API_KEY: '' }, fetcher), null);
  assert.equal(hindsight({ HINDSIGHT_API_KEY: 'k', HINDSIGHT_OPT_IN: '1' }, async () => new Response('{}')), null, 'no URL and the public host is not implied');
  const cloud = []; await hindsight({ HINDSIGHT_API_KEY: 'k', HINDSIGHT_OPT_IN: '1', HINDSIGHT_URL: 'https://api.hindsight.vectorize.io', HINDSIGHT_ALLOW_CLOUD: '1' }, async u => { cloud.push(String(u)); return new Response('{}'); }).stats('b');
  assert.equal(cloud[0], 'https://api.hindsight.vectorize.io/v1/default/banks/b/stats');
});

test('memory note is bounded and labelled; JEV keeps this project\'s memories and filters the others', async () => {
  assert.equal(memoryNote([]), ''); assert.match(memoryNote([{ text: 'Prefers short questions.' }]), /^PRIVATE MEMORY \(what this consultant told you in earlier conversations; self-reported, not evidence\)/);
  const mem = [{ text: 'Own project: baseline missing.', tags: ['project:p-1'] }, { text: 'Prefers short questions.', tags: [] }, { text: 'Other project: SAP rollout in Belgium.', tags: ['project:p-9'] }];
  assert.equal((await jevRelevant({}, mem, { id: 'p-1' })).memories.length, 3, 'no key: unchanged');
  let body = null;
  const fetcher = async (url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ answers: { m0: { noul: 0.9 }, m1: { noul: 0.1 } } })); };
  const r = await jevRelevant({ TYPESAFE_API_KEY: 'k' }, mem, { id: 'p-1', title: 'Claims' }, fetcher);
  assert.deepEqual(r.memories.map(m => m.text), ['Own project: baseline missing.', 'Prefers short questions.']); assert.equal(r.checked, 2);
  assert.deepEqual(Object.values(body.questions).map(q => q.type), ['noul', 'noul']); assert.deepEqual(body.state.memories, ['Prefers short questions.', 'Other project: SAP rollout in Belgium.']);
});

function store() { const m = new Map(); return { get: async k => m.get(k), put: async (k, v) => m.set(k, v) }; }
const req = (method, path, body, headers = {}) => new Request('https://atlas.test' + path, { method, headers: { 'x-atlas-bank': 'atlas-x', 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

test('memory routes: remember, list, forget one or all, switch off; bank header required; admin connection test', async () => {
  const { calls, fetcher } = fakeHS({ documents: { items: [{ id: 'project-p-123', updated_at: '2026-09-27', memory_unit_count: 5 }] } });
  const ctx = { storage: store(), hs: hindsight(ENV, fetcher), env: { ...ENV, TYPESAFE_API_KEY: 'k' }, fetcher: async (u, i) => String(u).includes('typesafe') ? new Response(JSON.stringify({ answers: { ok: { noul: 0.97 } } })) : fetcher(u, i) };
  assert.equal((await memoryRoutes(new Request('https://atlas.test/api/memory'), ctx)).status, 401);
  assert.equal((await (await memoryRoutes(req('POST', '/api/memory/remember', P), ctx)).json()).stored, true);
  const list = await (await memoryRoutes(req('GET', '/api/memory'), ctx)).json();
  assert.deepEqual(list.documents, [{ id: 'project-p-123', updatedAt: '2026-09-27', memories: 5, tags: [] }]);
  await memoryRoutes(req('POST', '/api/memory/forget', { documentId: 'project-p-123' }), ctx);
  await memoryRoutes(req('POST', '/api/memory/forget', { all: true }), ctx);
  assert.deepEqual(calls.slice(-2).map(c => c.method + ' ' + new URL(c.url).pathname), ['DELETE /v1/default/banks/atlas-x/documents/project-p-123', 'DELETE /v1/default/banks/atlas-x']);
  await memoryRoutes(req('POST', '/api/memory/settings', { off: true }), ctx);
  assert.equal((await (await memoryRoutes(req('POST', '/api/memory/remember', P), ctx)).json()).reason, 'Memory is switched off.');
  assert.equal((await memoryRoutes(req('GET', '/api/memory/test'), ctx)).status, 403);
  const t = await (await memoryRoutes(req('GET', '/api/memory/test', null, { 'x-atlas-role': 'admin' }), ctx)).json();
  assert.deepEqual([t.hindsight.ok, t.jev.ok], [true, true]);
  const none = await (await memoryRoutes(req('GET', '/api/memory'), { storage: store(), hs: null, env: {} })).json();
  assert.equal(none.enabled, false);
});

test('session: recalled memory reaches the talker as a private note on every turn; a failing recall never blocks the interview', async () => {
  const run = async memory => {
    const talker = [], events = [];
    const s = new Session({ io: { send: e => events.push(e), sendBytes: () => {}, close: () => {} }, csrf: 'tok', voice: 'atlas', memory, sleep: () => new Promise(r => setImmediate(r)),
      ai: { async *chatStream(m) { talker.push(m); yield 'Hi. '; }, async synthesize() { return new Uint8Array(960); }, async transcribe() { return ''; }, async analyst() { return []; } } });
    await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: { id: 'p-1', title: 'Claims', stage: 'Pilot', answers: [] }, voice: 'atlas', capture: true, memory: false }));
    for (let i = 0; i < 50 && !talker.length; i++) await new Promise(r => setImmediate(r));
    await s.end(false); return { talker, events };
  };
  let asked = null;
  const ok = await run(async project => { asked = project; return 'PRIVATE MEMORY (x):\n- Baseline was not measured yet.'; });
  assert.equal(asked.id, 'p-1'); assert.ok(ok.talker[0].some(m => m.role === 'system' && m.content.includes('Baseline was not measured yet.')));
  assert.equal(ok.events.find(e => e.type === 'memory').status, 'recalled');
  const bad = await run(async () => { throw new Error('down'); });
  assert.ok(bad.talker.length, 'the opening still happens'); assert.ok(!bad.talker[0].some(m => m.content.startsWith('PRIVATE MEMORY')));
  const msgs = talkerMessages({ title: 'x' }, null, [], 'go', ['', 'PRIVATE MEMORY: y', 'pace']);
  assert.deepEqual(msgs.filter(m => m.role === 'system').slice(1).map(m => m.content), ['PRIVATE MEMORY: y', 'pace']);
});

test('connection test explains Hindsight credit and key problems plainly', async () => {
  for (const [status, text] of [[402, /no credits/], [401, /key rejected/]]) {
    const hs = hindsight(ENV, async () => new Response('{}', { status }));
    const r = await memoryRoutes(req('GET', '/api/memory/test', null, { 'x-atlas-role': 'admin' }), { storage: store(), hs, env: {} });
    assert.match((await r.json()).hindsight.error, text);
  }
});

// ---- Track Z (WOW_ZERO_CONFIG §3.4, §5.9, §9) ----
test('Z GET /api/memory/settings: the switch alone, from DO storage, never a Hindsight call', async () => {
  const calls = [], hs = new Proxy({}, { get: (_, k) => async () => { calls.push(String(k)); throw new Error('Hindsight must not be called'); } });
  const ctx = { storage: store(), hs, env: ENV }, get = async c => (await memoryRoutes(req('GET', '/api/memory/settings'), c)).json();
  assert.deepEqual(await get(ctx), { off: false }, 'on by default (inside the consented sentence)');
  await memoryRoutes(req('POST', '/api/memory/settings', { off: true }), ctx); assert.deepEqual(await get(ctx), { off: true });
  await memoryRoutes(req('POST', '/api/memory/settings', { off: false }), ctx); assert.deepEqual(await get(ctx), { off: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(await get({ storage: store(), hs: null, env: {} }), { off: false }, 'answers without Hindsight configured too');
  assert.equal((await memoryRoutes(new Request('https://atlas.test/api/memory/settings'), ctx)).status, 401, 'the Worker-set bank header is required');
});

test('Z Hindsight leak: a model-safe project (name blanked, profile-prefilled role blanked, client kept) retains no name or title; the client is still scrubbed', () => {
  // The browser builds this payload with profile-core.js modelProject (Z-S1); this is the server-side half of that contract.
  const full = { ...P, consultant: { name: 'Zelda Quintero', role: 'Principal Zebra' } }, modelSafe = { ...full, consultant: { name: '', role: '' } };
  const items = JSON.stringify(retainItems(modelSafe, '2026-09-29T10:00:00.000Z'));
  assert.doesNotMatch(items, /Zelda|Quintero|Principal Zebra/);
  assert.doesNotMatch(items, /Zebracorp|Head of Claims/, 'the client is still scrubbed: modelProject keeps `client` for exactly this');
  assert.match(JSON.stringify(retainItems(full)), /Consultant role: Principal Zebra\./, 'why the browser blanks a profile role: it would otherwise be retained');
  assert.match(JSON.stringify(retainItems({ ...full, consultant: { name: '', role: 'Data engineer' } })), /Consultant role: Data engineer\./, 'a role the consultant typed stays');
  assert.doesNotMatch(JSON.stringify(retainItems(full)), /Zelda|Quintero/, 'the name itself was never retained');
});
