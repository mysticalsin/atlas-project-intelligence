// F3 claim-level confirmation (WOW_SPEC §F3.5 acceptance 1-10, §F3.6). Real Library on node:sqlite, real masking and
// the one raw sentence split (snippets.js). No model is ever called: the Library has no `complete` and no `embed`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as claims from '../src/claims.js';
import * as outreach from '../src/outreach.js';
import { snippetsOf, claimKey, splitSentences } from '../src/snippets.js';
import { memorySql } from './sqlite.js';

const ORIGIN = 'https://atlas.example';
const who = (email, role = 'user') => ({ email, mail: email, role });
const ALEX = who('alex@mantu.com'), SAM = who('sam@mantu.com'), MAX = who('max@mantu.com'), KIM = who('kim@mantu.com'), JO = who('jo@mantu.com');
const REV = who('rev@mantu.com', 'reviewer'), EXT = who('ann@client.example', 'external');
const REF = () => ({ title: 'Claims triage for Zebracorp', consultant: { name: 'Alex Martin', role: 'Data engineer' },
  client: { name: 'Zebracorp', location: 'Lyon', contact: 'Jane Doe' },
  details: { projectId: 'PRJ-1', country: 'France', consultants: [{ name: 'Kim', email: 'kim@mantu.com', role: 'Analyst' }] },
  validation: { manager: { name: 'Sam', email: 'sam@mantu.com' } },
  answers: ['Zebracorp had slow claims across regions.', 'I built the routing model for Zebracorp myself. We reused the Acme Bank playbook.',
    'We compared rules against a model and kept a manual fallback.', 'Triage fell from 40 to 12 minutes per claim.', 'Operations dashboard export v3 shows it.', ''] });

function setup(env = {}) {
  const sql = memorySql(), clock = { t: Date.parse('2026-09-29T08:00:00.000Z') };
  let n = 0;
  const l = new Library(sql, { now: () => new Date(clock.t).toISOString(), newId: () => (++n).toString(16).padStart(32, '0') });
  const call = async (u, method, path, body, extra = {}) => {
    const r = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, { method, headers: { 'x-atlas-user': u.email, 'x-atlas-role': u.role, 'x-atlas-email': u.mail, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), l, { env: { ORIGIN, ...env, ...extra } });
    return { status: r.status, body: await r.json() };
  };
  // Direct handler call, for the strict currency mode (ctx.currency is a test-only seam; library-routes never sets it).
  const direct = (u, method, path, body, currency) => {
    const url = new URL(ORIGIN + '/api/library/' + path);
    return claims.routes({ url, method, parts: url.pathname.replace(/^\/api\/library\//, '').split('/').filter(Boolean), body: body ?? {}, user: u, lib: l, env: { ORIGIN, ...env }, currency })
      .catch(e => { if (!e.status) throw e; return { status: e.status, body: { error: e.message } }; });
  };
  return { sql, l, clock, call, direct, day: d => { clock.t += d * 864e5; } };
}
async function withReference(s, ref = REF()) {
  // Another reference makes "Acme Bank" a library client name, so the record masking has something to mask.
  await s.l.upsert(JO, { localId: 'other', reference: { title: 'Card fraud rules', client: { name: 'Acme Bank' }, answers: ['Acme Bank wanted faster fraud rules.'] } });
  return (await s.l.upsert(ALEX, { localId: 'r1', reference: ref })).id;
}
const pick = (cands, ...texts) => texts.map(t => { const c = cands.find(x => x.text === t); assert.ok(c, t); return c; });
async function proposed(s, id, ...texts) {
  const cands = (await s.call(ALEX, 'GET', 'claims/' + id)).body.candidates;
  const r = await s.call(ALEX, 'POST', 'claims', { refId: id, items: pick(cands, ...texts) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.claims;
}
const T1 = 'I built the routing model for Zebracorp myself.', T2 = 'We reused the Acme Bank playbook.', T3 = 'Triage fell from 40 to 12 minutes per claim.';

test('ensure is idempotent on a second Library over the same SQL; expire and the helpers run on a fresh schema', async () => {
  const sql = memorySql(), a = new Library(sql, {});
  assert.equal(claims.expire(a, a.now()), 0);
  claims.ensure(a); claims.ensure(new Library(sql, {}));
  const b = new Library(sql, {});
  assert.equal(claims.expire(b, b.now()), 0);
  for (const t of ['claims', 'confirmation_requests']) assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", t).toArray()[0].n, 1, t);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'claims_sentence'").toArray()[0].n, 1, 'unique (ref_id, sentence_hash)');
  assert.deepEqual(claims.claimSummary(b, { id: 'none', revision: 1, data: { answers: [] } }), { confirmed: 0, total: 0, current: 0 });
  assert.equal(claims.confirmationStatus(b, { id: 'none', revision: 1, data: {} }).size, 0);
  assert.equal(claims.CURRENCY, 'sentence', 'the code default pending Q12');
});

test('candidates: the raw split of answers[1..4] at the current revision (<= 30); proposals must match exactly (else 409)', async () => {
  const s = setup(), id = await withReference(s);
  const got = (await s.call(ALEX, 'GET', 'claims/' + id)).body;
  assert.deepEqual([got.refId, got.revision, got.currency, got.claims, got.requests], [id, 1, 'sentence', [], []]);
  const expected = [1, 2, 3, 4].flatMap(t => splitSentences(REF().answers[t]).map((text, idx) => ({ topic: t, idx, text })));
  assert.deepEqual(got.candidates, expected, 'topic 0 (context) and 5 are never candidates');
  const bad = async (items, status) => { const r = await s.call(ALEX, 'POST', 'claims', { refId: id, items }); assert.equal(r.status, status, JSON.stringify(items)); return r.body; };
  await bad([{ topic: 1, idx: 0, text: T1 + ' ' }], 409);
  await bad([{ topic: 1, idx: 1, text: T1 }], 409);
  await bad([{ topic: 2, idx: 0, text: T1 }], 409);
  await bad([{ topic: 0, idx: 0, text: 'Zebracorp had slow claims across regions.' }], 400);
  await bad([{ topic: 5, idx: 0, text: 'x' }], 400);
  await bad([], 400);
  await bad(Array.from({ length: 9 }, () => ({ topic: 1, idx: 0, text: T1 })), 400);
  const first = await proposed(s, id, T1, T3);
  assert.deepEqual(first.map(c => [c.topic, c.idx, c.text, c.status, c.current, c.revision]), [[1, 0, T1, 'unverified', true, 1], [3, 0, T3, 'unverified', true, 1]]);
  const again = await proposed(s, id, T3, T1);
  assert.deepEqual(again.map(c => c.id).sort(), first.map(c => c.id).sort(), 're-proposing returns the existing rows (unique sentence)');
  assert.equal(s.l.rows('SELECT COUNT(*) AS n FROM claims')[0].n, 2);
  assert.equal((await s.call(JO, 'GET', 'claims/' + id)).status, 404, 'no access: 404');
  assert.equal((await s.call(SAM, 'POST', 'claims', { refId: id, items: [{ topic: 1, idx: 0, text: T1 }] })).status, 403, 'the N+1 can read but not edit');
  assert.equal((await s.call(SAM, 'GET', 'claims/' + id)).status, 200, 'the N+1 has full access');
  assert.equal((await s.call(REV, 'POST', 'claims', { refId: id, items: [{ topic: 1, idx: 0, text: T1 }] })).status, 201, 'a reviewer can edit');
  // 30 candidates at most, across topics, in order.
  const long = REF(); long.answers[1] = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} about routing.`).join(' '); long.answers[2] = long.answers[1].replace(/routing/g, 'approach');
  const big = (await s.l.upsert(ALEX, { localId: 'big', reference: long })).id;
  const many = (await s.call(ALEX, 'GET', 'claims/' + big)).body.candidates;
  assert.equal(many.length, 30); assert.deepEqual([many[0].topic, many[19].topic, many[20].topic, many[29].idx], [1, 1, 2, 9]);
});

test('N+1 resolution: a staffing row (projectId + refs.owner) beats the self-declared N+1; none gives 400', async () => {
  const s = setup(), id = await withReference(s), [c] = await proposed(s, id, T1);
  const declared = await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id], kind: 'manager' });
  assert.equal(declared.status, 201);
  assert.deepEqual([declared.body.request.toEmail, declared.body.request.managerSource], ['sam@mantu.com', 'self_declared']);
  outreach.ensure(s.l);
  s.l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('prj-1', 'alex@mantu.com', 'max@mantu.com', 'Max', '', '', 'staffing-csv', 'x')");
  const staffed = await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] });
  assert.equal(staffed.status, 201);
  assert.deepEqual([staffed.body.request.toEmail, staffed.body.request.managerSource, staffed.body.request.kind], ['max@mantu.com', 'staffing', 'manager']);
  // Another consultant's staffing row on the same project does not count: the key is (projectId, refs.owner).
  const none = REF(); none.validation = { manager: { name: '', email: '' } }; none.details.projectId = 'PRJ-2';
  const id2 = (await s.l.upsert(ALEX, { localId: 'r2', reference: none })).id, [c2] = await proposed(s, id2, T1);
  s.l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('PRJ-2', 'kim@mantu.com', 'max@mantu.com', 'Max', '', '', 'staffing-csv', 'x')");
  const r = await s.call(ALEX, 'POST', 'confirmations', { refId: id2, claimIds: [c2.id] });
  assert.deepEqual([r.status, r.body.error], [400, 'Name the N+1 on the reference first.']);
});

test('independence: the owner, a member or the requester can never be the confirmer (409)', async () => {
  const s = setup();
  const own = REF(); own.validation.manager.email = 'alex@mantu.com';
  const mem = REF(); mem.validation.manager.email = 'kim@mantu.com';
  const rev = REF(); rev.validation.manager.email = 'rev@mantu.com';
  for (const [ref, u, local] of [[own, ALEX, 'o'], [mem, ALEX, 'm'], [rev, REV, 'r']]) {
    const id = (await s.l.upsert(ALEX, { localId: local, reference: ref })).id;
    const [c] = await proposed(s, id, T1);
    const r = await s.call(u, 'POST', 'confirmations', { refId: id, claimIds: [c.id] });
    assert.equal(r.status, 409, local); assert.match(r.body.error, /independent/);
  }
  assert.equal(s.l.rows('SELECT COUNT(*) AS n FROM confirmation_requests')[0].n, 0);
});

test('request: draft without claim text or client name, two pending outreach rows, nothing sent', async () => {
  let sent = 0;
  const s = setup(); s.l.services = { teams: { send: async () => { sent++; return { id: 'x' }; } } };
  const id = await withReference(s), cs = await proposed(s, id, T1, T2, T3);
  const r = await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: cs.map(c => c.id), kind: 'manager' });
  assert.equal(r.status, 201);
  const { request, draft, outreach: rows } = r.body;
  assert.deepEqual([request.status, request.revision, request.claimIds, request.expiresAt], ['open', 1, cs.map(c => c.id), '2026-10-13T08:00:00.000Z']);
  assert.equal(draft.to, 'sam@mantu.com');
  assert.equal(draft.subject, "Can you confirm 3 points from Alex Martin's project? (about 60 seconds)");
  assert.equal(draft.body, `${ORIGIN}/confirm#${request.id}`); assert.equal(draft.link, draft.body);
  assert.ok(draft.mailto.startsWith('mailto:sam%40mantu.com?subject='));
  const text = JSON.stringify(draft);
  for (const secret of ['Zebracorp', 'Acme', 'routing model', 'Triage', 'Lyon', 'Jane']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(rows.map(o => [o.channel, o.status]), [['teams', 'pending_approval'], ['email_draft', 'pending_approval']]);
  const stored = s.l.rows('SELECT * FROM outreach');
  assert.equal(stored.length, 2); assert.ok(stored.every(o => o.kind === 'confirmation_request' && o.subject_id === request.id));
  for (const o of stored) for (const secret of ['Zebracorp', 'Acme Bank', 'routing model']) assert.ok(!o.payload.includes(secret), secret + ' in outreach payload');
  assert.equal(sent, 0, 'nothing is sent by a request');
  const n = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[0].id] })).body.draft.subject;
  assert.equal(n, "Can you confirm 1 point from Alex Martin's project? (about 60 seconds)");
  for (const [body, status] of [[{ refId: id, claimIds: [] }, 400], [{ refId: id, claimIds: ['nope'] }, 404], [{ refId: id, claimIds: [cs[0].id], kind: 'boss' }, 400], [{ refId: 'nope', claimIds: [cs[0].id] }, 404]])
    assert.equal((await s.call(ALEX, 'POST', 'confirmations', body)).status, status, JSON.stringify(body));
  assert.equal((await s.call(SAM, 'POST', 'confirmations', { refId: id, claimIds: [cs[0].id] })).status, 403, 'the N+1 cannot request');
});

test('inbox: by verified mail only; raw text with full access, record masking without; decisions, notes and 403/409/410', async () => {
  const s = setup(), id = await withReference(s), cs = await proposed(s, id, T1, T2, T3);
  const req = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: cs.map(c => c.id) })).body.request;
  const inbox = async u => (await s.call(u, 'GET', 'confirmations/inbox')).body.items;
  assert.deepEqual(await inbox(JO), []); assert.deepEqual(await inbox(ALEX), []);
  const [item] = await inbox(SAM);
  assert.deepEqual([item.request.id, item.reference.title, item.reference.consultant, item.reference.revision], [req.id, 'Claims triage for Zebracorp', { name: 'Alex Martin', role: 'Data engineer' }, 1]);
  assert.deepEqual(item.claims.map(c => c.text), [T1, T2, T3], 'the declared N+1 has full access: raw sentences');
  // A staffing N+1 without access to the record sees the record masking only.
  outreach.ensure(s.l);
  s.l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('PRJ-1', 'alex@mantu.com', 'max@mantu.com', 'Max', '', '', 'staffing-csv', 'x')");
  const req2 = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[0].id, cs[1].id] })).body.request;
  const [masked] = await inbox(MAX);
  assert.equal(masked.request.id, req2.id);
  assert.deepEqual(masked.claims.map(c => c.text), ['I built the routing model for the client myself.', 'We reused the another client playbook.']);
  assert.equal(masked.reference.title, 'Claims triage for the client');
  assert.ok(!JSON.stringify(masked).includes('Zebracorp') && !JSON.stringify(masked).includes('Acme'));
  // Decisions.
  const decide = (u, body, rid = req.id) => s.call(u, 'POST', 'confirmations/' + rid, body);
  const all = (d, note) => ({ decisions: cs.map((c, i) => ({ claimId: c.id, decision: d[i], note: note?.[i] })) });
  assert.equal((await decide(JO, all(['confirm', 'confirm', 'confirm']))).status, 403, 'wrong person');
  assert.equal((await decide(MAX, all(['confirm', 'confirm', 'confirm']))).status, 403, 'another N+1 is still the wrong person');
  assert.match((await decide(SAM, all(['confirm', 'correct', 'cant_say']))).body.error, /Say what should be corrected/);
  assert.match((await decide(SAM, { decisions: [{ claimId: cs[0].id, decision: 'confirm' }] })).body.error, /Decide every point/);
  assert.equal((await decide(SAM, all(['confirm', 'maybe', 'cant_say']))).status, 400);
  assert.equal((await decide(SAM, all(['confirm', 'correct', 'cant_say'], ['', 'x'.repeat(501), '']))).status, 400, 'note <= 500');
  assert.equal((await decide(SAM, { decisions: [...all(['confirm', 'confirm', 'confirm']).decisions, { claimId: cs[0].id, decision: 'confirm' }] })).status, 400, 'one decision per point');
  const before = s.l.row(id);
  const ok = await decide(SAM, all(['confirm', 'correct', 'cant_say'], ['', 'It was the Lyon team playbook.', '']));
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.request.status, ok.body.claims.map(c => c.status)], ['done', ['manager_confirmed', 'corrected', 'cant_say']]);
  assert.deepEqual(ok.body.claims.map(c => [c.byMail, c.confirmedRevision, c.kind, c.source]), Array(3).fill(['sam@mantu.com', 1, 'manager', 'self_declared']));
  assert.equal(ok.body.claims[1].note, 'It was the Lyon team playbook.');
  const after = s.l.row(id);
  assert.deepEqual([after.status, after.state.validation, after.revision], [before.status, before.state.validation, before.revision], 'confirmations never touch validation or status (acceptance 7)');
  assert.equal((await decide(SAM, all(['confirm', 'confirm', 'confirm']))).status, 409, 'already answered');
  assert.deepEqual(await inbox(SAM), [], 'a done request leaves the inbox');
  // The claims API shows the statuses with their source.
  const view = (await s.call(ALEX, 'GET', 'claims/' + id)).body;
  assert.deepEqual(view.claims.map(c => [c.text, c.status, c.current, c.source]), [[T1, 'manager_confirmed', true, 'self_declared'], [T2, 'corrected', true, 'self_declared'], [T3, 'cant_say', true, 'self_declared']]);
  assert.deepEqual(view.requests.map(r => [r.id, r.status]), [[req2.id, 'open'], [req.id, 'done']]);
  // The staffing N+1 confirms the open request: the newest decision wins, and the source says "staffing".
  const byMax = await decide(MAX, { decisions: [{ claimId: cs[0].id, decision: 'confirm' }, { claimId: cs[1].id, decision: 'confirm' }] }, req2.id);
  assert.deepEqual(byMax.body.claims.map(c => [c.text, c.status, c.source]), [['I built the routing model for the client myself.', 'manager_confirmed', 'staffing'], ['We reused the another client playbook.', 'manager_confirmed', 'staffing']], 'masked text back to a confirmer without full access');
  // Expired (410) and cancelled (409).
  const req3 = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[2].id] })).body.request;
  const req4 = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[2].id] })).body.request;
  assert.equal((await s.call(JO, 'POST', `confirmations/${req4.id}/cancel`)).status, 403);
  assert.equal((await s.call(ALEX, 'POST', `confirmations/${req4.id}/cancel`)).body.request.status, 'cancelled');
  assert.equal((await s.call(ALEX, 'POST', `confirmations/${req4.id}/cancel`)).status, 409);
  assert.equal((await decide(MAX, { decisions: [{ claimId: cs[2].id, decision: 'confirm' }] }, req4.id)).status, 409, 'cancelled');
  assert.deepEqual((await inbox(MAX)).map(i => i.request.id), [req3.id]);
  s.day(15);
  assert.deepEqual(await inbox(MAX), [], 'expired requests leave the inbox before the sweep');
  assert.equal((await decide(MAX, { decisions: [{ claimId: cs[2].id, decision: 'confirm' }] }, req3.id)).status, 410);
  assert.equal(claims.expire(s.l, s.l.now()), 1); assert.equal(claims.expire(s.l, s.l.now()), 0);
  assert.equal((await decide(MAX, { decisions: [{ claimId: cs[2].id, decision: 'confirm' }] }, req3.id)).status, 410, 'still 410 after the sweep');
  assert.equal(s.l.rows("SELECT COUNT(*) AS n FROM audit WHERE action = 'confirmations expired'")[0].n, 1);
  assert.equal((await s.call(REV, 'POST', `confirmations/nope/cancel`)).status, 404);
});

test('audit: one row per decision with rev N and the source; no row ever holds claim text or a client name', async () => {
  const s = setup(), id = await withReference(s), cs = await proposed(s, id, T1, T2);
  const req = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: cs.map(c => c.id) })).body.request;
  await s.call(SAM, 'POST', 'confirmations/' + req.id, { decisions: [{ claimId: cs[0].id, decision: 'confirm' }, { claimId: cs[1].id, decision: 'correct', note: 'Zebracorp asked for it.' }] });
  const rows = s.l.rows("SELECT actor, action, detail FROM audit WHERE action LIKE 'claim %' ORDER BY seq");
  assert.deepEqual(rows, [{ actor: 'sam@mantu.com', action: 'claim confirm', detail: `rev 1 claim ${cs[0].id} (manager, self_declared)` },
    { actor: 'sam@mantu.com', action: 'claim correct', detail: `rev 1 claim ${cs[1].id} (manager, self_declared)` }]);
  const trail = JSON.stringify(s.l.rows('SELECT * FROM audit'));
  for (const secret of ['Zebracorp', 'Acme', 'routing model', 'playbook', 'Lyon']) assert.ok(!trail.includes(secret), secret);
  assert.deepEqual(s.l.rows("SELECT action FROM audit WHERE id = ? AND action IN ('claims proposed', 'confirmation requested') ORDER BY seq", id).map(r => r.action), ['claims proposed', 'confirmation requested']);
});

test('currency (sentence mode): a details-only revision keeps confirmations current; a changed sentence goes stale everywhere', async () => {
  const s = setup(), id = await withReference(s), cs = await proposed(s, id, T1, T3);
  const req = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: cs.map(c => c.id) })).body.request;
  await s.call(SAM, 'POST', 'confirmations/' + req.id, { decisions: cs.map(c => ({ claimId: c.id, decision: 'confirm' })) });
  const edit = REF(); edit.details.country = 'Belgium';
  await s.l.upsert(ALEX, { localId: 'r1', reference: edit });
  let view = (await s.call(ALEX, 'GET', 'claims/' + id)).body;
  assert.equal(view.revision, 2);
  assert.deepEqual(view.claims.map(c => [c.status, c.current, c.confirmedRevision]), [['manager_confirmed', true, 1], ['manager_confirmed', true, 1]], '"Confirmed on r1; sentence unchanged"');
  assert.deepEqual(claims.claimSummary(s.l, s.l.row(id)), { confirmed: 2, total: 2, current: 2 });
  // An open request stays answerable across a details-only revision.
  const open = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[0].id] })).body.request;
  await s.l.upsert(ALEX, { localId: 'r1', reference: { ...edit, details: { ...edit.details, country: 'Spain' } } });
  assert.equal((await s.call(SAM, 'GET', 'confirmations/inbox')).body.items.length, 1);
  // Changing the outcome sentence makes that claim stale (claims API, summary, inbox 409, footnote map).
  const changed = REF(); changed.answers[3] = 'Triage fell from 40 to 15 minutes per claim.';
  await s.l.upsert(ALEX, { localId: 'r1', reference: changed });
  view = (await s.call(ALEX, 'GET', 'claims/' + id)).body;
  assert.deepEqual(view.claims.map(c => [c.text, c.current]), [[T1, true], [T3, false]]);
  assert.deepEqual(claims.claimSummary(s.l, s.l.row(id)), { confirmed: 1, total: 2, current: 1 });
  assert.deepEqual([...claims.confirmationStatus(s.l, s.l.row(id)).keys()], [claimKey(1, T1)]);
  const stale = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[1].id] }));
  assert.equal(stale.status, 409, 'a stale claim cannot be requested again; the new sentence is a new claim');
  const withT3 = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[0].id] })).body.request;
  await s.l.upsert(ALEX, { localId: 'r1', reference: { ...changed, answers: changed.answers.map((a, i) => i === 1 ? 'I built the routing model myself.' : a) } });
  assert.deepEqual((await s.call(SAM, 'GET', 'confirmations/inbox')).body.items, [], 'the inbox drops requests whose sentence changed');
  assert.equal((await s.call(SAM, 'POST', 'confirmations/' + withT3.id, { decisions: [{ claimId: cs[0].id, decision: 'confirm' }] })).status, 409);
  assert.equal((await s.call(SAM, 'POST', 'confirmations/' + open.id, { decisions: [{ claimId: cs[0].id, decision: 'confirm' }] })).status, 409);
  assert.deepEqual((await s.call(ALEX, 'GET', 'claims/' + id)).body.requests.filter(r => r.status === 'stale').map(r => r.id).sort(), [open.id, withT3.id].sort());
});

test('currency (revision mode, strict R4): any new revision makes decided claims and open requests stale', async () => {
  const s = setup(), id = await withReference(s), cs = await proposed(s, id, T1, T3);
  const req = (await s.direct(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[0].id] }, 'revision')).body.request;
  const open = (await s.direct(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[1].id] }, 'revision')).body.request;
  assert.equal((await s.direct(SAM, 'POST', 'confirmations/' + req.id, { decisions: [{ claimId: cs[0].id, decision: 'confirm' }] }, 'revision')).body.request.status, 'done');
  const opts = { currency: 'revision' };
  assert.deepEqual(claims.claimSummary(s.l, s.l.row(id), opts), { confirmed: 1, total: 2, current: 2 });
  const edit = REF(); edit.details.country = 'Belgium';
  await s.l.upsert(ALEX, { localId: 'r1', reference: edit });
  const view = (await s.direct(ALEX, 'GET', 'claims/' + id, null, 'revision')).body;
  assert.deepEqual([view.currency, ...view.claims.map(c => [c.status, c.current])], ['revision', ['manager_confirmed', false], ['unverified', true]]);
  assert.deepEqual(claims.claimSummary(s.l, s.l.row(id), opts), { confirmed: 0, total: 2, current: 1 });
  assert.equal(claims.confirmationStatus(s.l, s.l.row(id), opts).has(claimKey(1, T1)), false);
  assert.deepEqual((await s.direct(SAM, 'GET', 'confirmations/inbox', null, 'revision')).body.items, []);
  assert.equal((await s.direct(SAM, 'POST', 'confirmations/' + open.id, { decisions: [{ claimId: cs[1].id, decision: 'confirm' }] }, 'revision')).status, 409);
  // Sentence mode on the same data: still current.
  assert.deepEqual(claims.claimSummary(s.l, s.l.row(id)), { confirmed: 1, total: 2, current: 2 });
  // Re-request in one click: the owner asks again at the new revision.
  const again = await s.direct(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[0].id] }, 'revision');
  assert.equal(again.status, 201); assert.equal(again.body.request.revision, 2);
  await s.direct(SAM, 'POST', 'confirmations/' + again.body.request.id, { decisions: [{ claimId: cs[0].id, decision: 'confirm' }] }, 'revision');
  assert.deepEqual(claims.claimSummary(s.l, s.l.row(id), opts), { confirmed: 1, total: 2, current: 2 });
});

test('acceptance 10: confirmationStatus keys equal the claimKey of the one-pager snippet with the same raw sentence (§F1.6 fixtures)', async () => {
  const s = setup();
  const fixtures = [
    { client: 'BNP', answers: ['', 'BNP agreed. Costs fell 20% after launch.', '', '', '', ''] },
    { client: 'Acme Inc.', answers: ['', '', 'Acme Inc. hired us to rebuild intake.', 'Intake time halved for Acme Inc. within a quarter.', '', ''] },
    { client: 'Air', answers: ['', 'We did the repair of the queue.', '', '', 'The Air ops log for 2024 shows the backlog cleared.', ''] },
  ];
  for (const [k, f] of fixtures.entries()) {
    const ref = { ...REF(), title: 'Fixture ' + k, client: { name: f.client }, answers: f.answers };
    const id = (await s.l.upsert(ALEX, { localId: 'f' + k, reference: ref })).id;
    const row = s.l.row(id);
    s.l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated' } }, 'test', 'published', '');
    assert.equal(s.l.row(id).status, 'published');
    const cands = (await s.call(ALEX, 'GET', 'claims/' + id)).body.candidates;
    const cs = (await s.call(ALEX, 'POST', 'claims', { refId: id, items: cands })).body.claims;
    const req = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: cs.map(c => c.id) })).body.request;
    await s.call(SAM, 'POST', 'confirmations/' + req.id, { decisions: cs.map(c => ({ claimId: c.id, decision: 'confirm' })) });
    const map = claims.confirmationStatus(s.l, s.l.row(id)), snips = snippetsOf(s.l, s.l.row(id).data).filter(x => x.kind === 'consultant_words' && x.topic >= 1 && x.topic <= 4);
    assert.equal(map.size, cs.length); assert.equal(snips.length, cs.length, 'one snippet per claim');
    for (const sn of snips) assert.equal(map.get(claimKey(sn.topic, sn.raw)), 'manager_confirmed', sn.id);
    assert.deepEqual([...map.keys()].sort(), snips.map(sn => claimKey(sn.topic, sn.raw)).sort());
  }
  const bnp = s.l.rows("SELECT text FROM claims WHERE text LIKE '%Costs%'").map(r => r.text);
  assert.deepEqual(bnp, ['Costs fell 20% after launch.'], 'the 11-character "BNP agreed." is filtered on the raw text');
  assert.ok(s.l.rows('SELECT text FROM claims').some(r => r.text === 'We did the repair of the queue.'), 'client "Air" never corrupts "repair"');
});

test('client contact: BLOCKED_EXTERNAL unless CLIENT_CONFIRM=1 and the email is in EXTERNAL_EMAILS; the enabled path works end to end', async () => {
  const s = setup(), id = await withReference(s), [c] = await proposed(s, id, T1);
  const ask = extra => s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id], kind: 'client', toEmail: 'Ann@Client.example' }, extra);
  for (const env of [{}, { CLIENT_CONFIRM: '1' }, { EXTERNAL_EMAILS: 'ann@client.example' }, { CLIENT_CONFIRM: 'true', EXTERNAL_EMAILS: 'ann@client.example' }, { CLIENT_CONFIRM: '1', EXTERNAL_EMAILS: 'bob@client.example' }]) {
    const r = await ask(env);
    assert.equal(r.status, 503, JSON.stringify(env)); assert.equal(r.body.status, 'BLOCKED_EXTERNAL');
    assert.deepEqual(r.body.needs, ['CLIENT_CONFIRM=1', "the contact's email in EXTERNAL_EMAILS", 'a Cloudflare Access policy admitting that email (for example One-time PIN)', "Tony's business and legal decision (Q3)"]);
  }
  assert.equal(s.l.rows('SELECT COUNT(*) AS n FROM confirmation_requests')[0].n, 0);
  const on = { CLIENT_CONFIRM: '1', EXTERNAL_EMAILS: 'ann@client.example' };
  const r = await ask(on);
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.request.kind, r.body.request.toEmail, r.body.request.managerSource, r.body.draft.to], ['client', 'ann@client.example', null, 'ann@client.example']);
  const items = (await s.call(EXT, 'GET', 'confirmations/inbox', null, on)).body.items;
  assert.deepEqual(items[0].claims.map(x => x.text), ['I built the routing model for the client myself.'], 'a client contact never has full access: masked');
  const done = await s.call(EXT, 'POST', 'confirmations/' + r.body.request.id, { decisions: [{ claimId: c.id, decision: 'confirm' }] }, on);
  assert.deepEqual([done.status, done.body.claims[0].status, done.body.claims[0].kind], [200, 'client_confirmed', 'client']);
  assert.equal(s.l.rows("SELECT detail FROM audit WHERE action = 'claim confirm'")[0].detail, `rev 1 claim ${c.id} (client, none)`);
});

test('external role: 403 on claims, on create and on cancel; only the inbox and the decision are reachable', async () => {
  const s = setup(), id = await withReference(s), [c] = await proposed(s, id, T1);
  const req = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] })).body.request;
  for (const [method, path, body] of [['GET', 'claims/' + id], ['POST', 'claims', { refId: id, items: [{ topic: 1, idx: 0, text: T1 }] }], ['POST', 'confirmations', { refId: id, claimIds: [c.id] }],
    ['POST', `confirmations/${req.id}/cancel`], ['GET', 'confirmations'], ['GET', 'confirmations/' + req.id]]) {
    const r = await s.call(EXT, method, path, body);
    assert.deepEqual([r.status, r.body], [403, { error: 'Not available to external confirmers.' }], method + ' ' + path);
  }
  assert.deepEqual((await s.call(EXT, 'GET', 'confirmations/inbox')).body, { items: [] });
  assert.equal((await s.call(EXT, 'POST', 'confirmations/' + req.id, { decisions: [{ claimId: c.id, decision: 'confirm' }] })).status, 403, 'reachable, but addressed to someone else');
  assert.equal(s.l.rows("SELECT status FROM confirmation_requests WHERE id = ?", req.id)[0].status, 'open');
});

test('Entra mode: the claims and confirmations words answer 404, whatever READY says (Q6)', async () => {
  const s = setup({ IDENTITY_SOURCE: 'entra' }), id = await withReference(s);
  for (const [method, path] of [['GET', 'claims/' + id], ['GET', 'confirmations/inbox'], ['POST', 'confirmations']]) {
    const r = await s.call(ALEX, method, path, {});
    assert.deepEqual([r.status, r.body.error], [404, 'This feature is not available in this deployment.'], path);
  }
});

test('unknown sub-paths inside the words answer 404 and never fall through to the generic reference routes', async () => {
  const s = setup(); await withReference(s);
  for (const [method, path] of [['GET', 'claims'], ['GET', 'confirmations'], ['POST', 'claims/x'], ['GET', 'claims/x/y'], ['POST', 'confirmations/x/cancel/y']])
    assert.deepEqual(await s.call(ALEX, method, path, {}), { status: 404, body: { error: 'Not found.' } }, path);
});

test('F3 and F4 never call a model: complete and embed stay untouched through the whole flow', async () => {
  const calls = [], sql = memorySql();
  const l = new Library(sql, { complete: async (...a) => { calls.push(['complete', a]); return '{}'; }, embed: async (...a) => { calls.push(['embed', a]); return null; } });
  const call = (u, method, path, body) => libraryRoutes(new Request(ORIGIN + '/api/library/' + path, { method, headers: { 'x-atlas-user': u.email, 'x-atlas-role': u.role, 'x-atlas-email': u.mail, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), l, { env: { ORIGIN } }).then(r => r.json());
  const id = (await l.upsert(ALEX, { localId: 'r1', reference: REF() })).id;
  const cands = (await call(ALEX, 'GET', 'claims/' + id)).candidates;
  const [c] = (await call(ALEX, 'POST', 'claims', { refId: id, items: [cands[0]] })).claims;
  const req = (await call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] })).request;
  await call(SAM, 'GET', 'confirmations/inbox');
  await call(SAM, 'POST', 'confirmations/' + req.id, { decisions: [{ claimId: c.id, decision: 'confirm' }] });
  await call(REV, 'POST', 'staffing/import', { csv: 'project_id,consultant_email,manager_email,manager_name,project_title,end_date\nPRJ-1,alex@mantu.com,sam@mantu.com,Sam,T,2026-09-30' });
  for (const o of (await call(REV, 'GET', 'outreach')).items) await call(REV, 'POST', 'outreach/' + o.id, { action: 'approve' });
  await call({ email: 'atlas-cron', mail: '', role: 'system' }, 'POST', 'scan-stale', {});
  claims.claimSummary(l, l.row(id)); claims.confirmationStatus(l, l.row(id));
  assert.deepEqual(calls, []);
});
