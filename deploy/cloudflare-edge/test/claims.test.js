// F3 claim-level confirmation (WOW_SPEC §F3.5 acceptance 1-10, §F3.6). Real Library on node:sqlite, real masking and
// the one raw sentence split (snippets.js). No model is ever called: the Library has no `complete` and no `embed`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as claims from '../src/claims.js';
import * as outreach from '../src/outreach.js';
import * as profile from '../src/profile.js';
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
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), l, { env: { ORIGIN, ATLAS_TENANT_ISOLATION: 'local-synthetic', ...env, ...extra } });
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
  const id = (await s.l.upsert(ALEX, { localId: 'r1', reference: ref })).id;
  const mgr = ref.validation?.manager?.email;
  if (mgr) s.l.bindTrust({ email: 'directory', role: 'system' }, { owner: ALEX.email, email: mgr, source: 'directory', sandbox: true });
  return id;
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

// WOW_ZERO_CONFIG §5.8: staffing, then the stored DNA directory (dna or dna_export row for the owner), then self-declared.
test('Z N+1 from the directory: staffing, then a stored dna/dna_export row, then self-declared; the owner\'s own profile edits never count', async () => {
  const s = setup(), id = await withReference(s), [c] = await proposed(s, id, T1), at = '2026-09-29T08:00:00.000Z';
  const ask = async () => { const r = await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] }); return [r.status, r.body.request?.toEmail || r.body.error, r.body.request?.managerSource || null]; };
  profile.ensure(s.l);
  // The owner typed an N+1 in their own profile: that is self-declared data, never the directory.
  s.l.sql.exec('INSERT INTO profiles (subject, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'alex@mantu.com', 'alex@mantu.com',
    JSON.stringify({ managerEmail: { value: 'lee@mantu.com', at, basis: '' }, managerName: { value: 'Lee', at, basis: '' } }), '{}', '{}', at, at, at);
  assert.deepEqual(await ask(), [201, 'sam@mantu.com', 'self_declared'], 'profile edits are not a directory source');
  const row = (source, manager) => s.l.sql.exec('INSERT OR REPLACE INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'alex@mantu.com', source, 'Alex Martin', 'Alex', 'Data engineer', 'Max', manager, 'b1', at);
  row('dna_export', 'max@mantu.com');
  if (!profile.READY) { assert.deepEqual(await ask(), [201, 'sam@mantu.com', 'self_declared'], 'a stub while the profile module is not READY'); return; }
  assert.deepEqual(await ask(), [201, 'max@mantu.com', 'directory'], 'the DNA export row outranks the N+1 named on the reference');
  row('dna', 'jo@mantu.com');
  assert.deepEqual(await ask(), [201, 'jo@mantu.com', 'directory'], 'dna before dna_export');
  row('dna', 'kim@mantu.com');
  assert.deepEqual((await ask()).slice(0, 1), [409], 'a directory N+1 must still be independent (kim is on the team)');
  outreach.ensure(s.l);
  s.l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('PRJ-1', 'alex@mantu.com', 'bea@mantu.com', 'Bea', '', '', 'staffing-csv', 'x')");
  assert.deepEqual(await ask(), [201, 'bea@mantu.com', 'staffing'], 'staffing outranks the directory');
  // A decision on a directory request carries its source (the badge reads "N+1 from DNA").
  s.l.sql.exec("DELETE FROM staffing"); row('dna', 'max@mantu.com');
  const [, , source] = await ask(), open = s.l.rows("SELECT id FROM confirmation_requests WHERE manager_source = 'directory' AND to_email = 'max@mantu.com' ORDER BY created_at DESC, rowid DESC")[0];
  assert.equal(source, 'directory');
  const done = await s.call(MAX, 'POST', 'confirmations/' + open.id, { decisions: [{ claimId: c.id, decision: 'confirm' }] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.claims[0].source, undefined);
  assert.equal(done.body.request.refId, undefined);
  assert.match(s.l.rows("SELECT detail FROM audit WHERE action = 'claim confirm' ORDER BY seq DESC")[0].detail, /\(manager, directory\)/);
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
  assert.equal(draft.body, `${ORIGIN}/go/confirm/${request.id}`, 'a /go/ link that survives sign-in (WOW_ZERO_CONFIG §3.9)'); assert.equal(draft.link, draft.body);
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
  assert.equal(masked.request.refId, undefined);
  assert.equal(masked.reference.handle, req2.id);
  assert.equal(masked.reference.title, undefined);
  assert.equal(masked.reference.consultant, undefined);
  assert.deepEqual(masked.claims.map(c => c.text), ['I built the routing model for the client myself.', 'We reused the another client playbook.']);
  assert.ok(!JSON.stringify(masked).includes('Zebracorp') && !JSON.stringify(masked).includes('Acme'));
  assert.ok(!JSON.stringify(masked).includes('Alex Martin') && !JSON.stringify(masked).includes('Data engineer'));
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
  assert.deepEqual(view.requests.map(r => [r.id, r.status]), [[req2.id, 'stale'], [req.id, 'done']], 'req2 asks points already answered: not waiting any more');
  // The staffing N+1's open request can no longer overwrite those decisions (F3.1 step 6), and it left the inbox.
  assert.deepEqual(await inbox(MAX), []);
  const byMax = await decide(MAX, { decisions: [{ claimId: cs[0].id, decision: 'confirm' }, { claimId: cs[1].id, decision: 'confirm' }] }, req2.id);
  assert.deepEqual([byMax.status, byMax.body.error], [409, 'These points were already answered in another request.']);
  assert.deepEqual((await s.call(ALEX, 'GET', 'claims/' + id)).body.claims.map(c => c.status), ['manager_confirmed', 'corrected', 'cant_say']);
  // Expired (410) and cancelled (409), on a fourth sentence that is still unverified.
  const [c4] = await proposed(s, id, 'We compared rules against a model and kept a manual fallback.');
  const req3 = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c4.id] })).body.request;
  const req4 = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c4.id] })).body.request;
  assert.equal((await s.call(JO, 'POST', `confirmations/${req4.id}/cancel`)).status, 403);
  assert.equal((await s.call(ALEX, 'POST', `confirmations/${req4.id}/cancel`)).body.request.status, 'cancelled');
  assert.equal((await s.call(ALEX, 'POST', `confirmations/${req4.id}/cancel`)).status, 409);
  assert.equal((await decide(MAX, { decisions: [{ claimId: c4.id, decision: 'confirm' }] }, req4.id)).status, 409, 'cancelled');
  assert.deepEqual((await inbox(MAX)).map(i => i.request.id), [req3.id]);
  s.day(15);
  assert.deepEqual(await inbox(MAX), [], 'expired requests leave the inbox before the sweep');
  assert.equal((await decide(MAX, { decisions: [{ claimId: c4.id, decision: 'confirm' }] }, req3.id)).status, 410);
  assert.equal(claims.expire(s.l, s.l.now()), 2, 'req2 and req3'); assert.equal(claims.expire(s.l, s.l.now()), 0);
  assert.equal((await decide(MAX, { decisions: [{ claimId: c4.id, decision: 'confirm' }] }, req3.id)).status, 410, 'still 410 after the sweep');
  assert.equal(s.l.rows("SELECT COUNT(*) AS n FROM audit WHERE action = 'confirmations expired'")[0].n, 1);
  assert.equal((await s.call(REV, 'POST', `confirmations/nope/cancel`)).status, 404);
});

test('masked views (inbox, decision, outreach preview): PII is masked before the own-client scrub, so an email or link naming the client never leaks in part', async () => {
  const s = setup(), ref = REF(), S = 'Jane (jane.doe@zebracorp.com) signed off; see https://portal.zebracorp.com/q3-report for the figures.';
  ref.title = 'Sign-off from ops@zebracorp.com'; ref.answers[3] = S;
  const id = await withReference(s, ref), [c] = await proposed(s, id, S);
  outreach.ensure(s.l);
  s.l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('PRJ-1', 'alex@mantu.com', 'max@mantu.com', 'Max', '', '', 'staffing-csv', 'x')");
  const req = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] })).body.request;
  assert.equal(req.toEmail, 'max@mantu.com', 'a staffing N+1 without access to the record');
  const want = 'Jane ([email]) signed off; see [link] for the figures.';
  const [item] = (await s.call(MAX, 'GET', 'confirmations/inbox')).body.items;
  assert.equal(item.reference.handle, req.id);
  assert.equal(item.reference.title, undefined);
  assert.equal(item.reference.consultant, undefined);
  assert.deepEqual(item.claims.map(x => x.text), [want]);
  const previews = s.l.rows('SELECT payload FROM outreach WHERE subject_id = ?', req.id).map(o => JSON.parse(o.payload).preview.title);
  assert.deepEqual(previews, ['Sign-off from [email]', 'Sign-off from [email]']);
  const done = await s.call(MAX, 'POST', 'confirmations/' + req.id, { decisions: [{ claimId: c.id, decision: 'confirm' }] });
  assert.equal(done.status, 200);
  assert.equal(done.body.request.refId, undefined);
  assert.equal(done.body.reference.handle, req.id);
  assert.equal(done.body.claims[0].source, undefined);
  assert.deepEqual(done.body.claims.map(x => [x.id, x.text, x.status]), [[c.id, want, 'manager_confirmed']]);
  for (const body of [item, done.body, previews]) assert.doesNotMatch(JSON.stringify(body), /jane\.doe|ops@|q3-report|portal|zebracorp/i);
});

test('a decided claim stays decided while its sentence is current: never asked again, never overwritten by another open request (F3.1 step 6)', async () => {
  const s = setup(), id = await withReference(s), [c] = await proposed(s, id, T3);
  // Two open requests for the same unverified claim: the declared N+1, then a staffing N+1.
  const first = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] })).body.request;
  outreach.ensure(s.l);
  s.l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at) VALUES ('PRJ-1', 'alex@mantu.com', 'max@mantu.com', 'Max', '', '', 'staffing-csv', 'x')");
  const second = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] })).body.request;
  assert.equal(second.toEmail, 'max@mantu.com');
  const corrected = await s.call(SAM, 'POST', 'confirmations/' + first.id, { decisions: [{ claimId: c.id, decision: 'correct', note: 'It was 15, not 12.' }] });
  assert.equal(corrected.status, 200);
  // The other open request can no longer overwrite the correction, and it leaves the inbox.
  assert.deepEqual((await s.call(MAX, 'GET', 'confirmations/inbox')).body.items, []);
  const late = await s.call(MAX, 'POST', 'confirmations/' + second.id, { decisions: [{ claimId: c.id, decision: 'confirm' }] });
  assert.deepEqual([late.status, late.body.error], [409, 'These points were already answered in another request.']);
  // A details-only edit that changes the N+1 keeps the sentence: asking again is refused (the probe's path).
  s.l.sql.exec('DELETE FROM staffing');
  const edit = REF(); edit.validation.manager = { name: 'Pal', email: 'pal@mantu.com' };
  await s.l.upsert(ALEX, { localId: 'r1', reference: edit });
  const again = await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] });
  assert.deepEqual([again.status, again.body.error], [409, 'Already answered: edit the sentence to ask again.']);
  const view = (await s.call(ALEX, 'GET', 'claims/' + id)).body;
  assert.deepEqual(view.claims.map(x => [x.status, x.note, x.byMail, x.current]), [['corrected', 'It was 15, not 12.', 'sam@mantu.com', true]]);
  assert.deepEqual(view.requests.map(r => [r.id, r.status]), [[second.id, 'stale'], [first.id, 'done']], 'the superseded request is not shown as waiting');
  assert.deepEqual(claims.claimSummary(s.l, s.l.row(id)), { confirmed: 0, total: 1, current: 1 });
  assert.equal(s.l.rows('SELECT COUNT(*) AS n FROM confirmation_requests')[0].n, 2, 'no third request was stored');
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
  // A current decision is never asked again: only a changed sentence (a new claim) can be (F3.1 step 6).
  const reask = await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[0].id] });
  assert.deepEqual([reask.status, reask.body.error], [409, 'Already answered: edit the sentence to ask again.']);
  // An open request stays answerable across a details-only revision.
  const [t2] = await proposed(s, id, T2);
  const open = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [t2.id] })).body.request;
  await s.l.upsert(ALEX, { localId: 'r1', reference: { ...edit, details: { ...edit.details, country: 'Spain' } } });
  assert.equal((await s.call(SAM, 'GET', 'confirmations/inbox')).body.items.length, 1);
  // Changing the outcome sentence makes that claim stale (claims API, summary, inbox 409, footnote map).
  const changed = REF(); changed.answers[3] = 'Triage fell from 40 to 15 minutes per claim.';
  await s.l.upsert(ALEX, { localId: 'r1', reference: changed });
  view = (await s.call(ALEX, 'GET', 'claims/' + id)).body;
  assert.deepEqual(view.claims.map(c => [c.text, c.current]), [[T1, true], [T2, true], [T3, false]]);
  assert.deepEqual(claims.claimSummary(s.l, s.l.row(id)), { confirmed: 1, total: 3, current: 2 });
  assert.deepEqual([...claims.confirmationStatus(s.l, s.l.row(id))], [[claimKey(1, T1), 'manager_confirmed'], [claimKey(1, T2), 'unverified']]);
  const stale = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [cs[1].id] }));
  assert.equal(stale.status, 409, 'a stale claim cannot be requested again; the new sentence is a new claim');
  const second = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [t2.id] })).body.request;
  await s.l.upsert(ALEX, { localId: 'r1', reference: { ...changed, answers: changed.answers.map((a, i) => i === 1 ? 'I built the routing model myself.' : a) } });
  assert.deepEqual((await s.call(SAM, 'GET', 'confirmations/inbox')).body.items, [], 'the inbox drops requests whose sentence changed');
  assert.equal((await s.call(SAM, 'POST', 'confirmations/' + second.id, { decisions: [{ claimId: t2.id, decision: 'confirm' }] })).status, 409);
  assert.equal((await s.call(SAM, 'POST', 'confirmations/' + open.id, { decisions: [{ claimId: t2.id, decision: 'confirm' }] })).status, 409);
  assert.deepEqual((await s.call(ALEX, 'GET', 'claims/' + id)).body.requests.filter(r => r.status === 'stale').map(r => r.id).sort(), [open.id, second.id].sort());
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
    s.l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } }, 'test', 'published', '');
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
  assert.deepEqual([done.status, done.body.claims[0].status, done.body.request.kind], [200, 'client_confirmed', 'client']);
  assert.equal(done.body.claims[0].kind, undefined);
  assert.equal(done.body.request.refId, undefined);
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
  assert.deepEqual((await s.call(EXT, 'GET', 'confirmations/inbox')).body, { items: [], truncated: false, limit: 50, next: null });
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
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), l, { env: { ORIGIN, ATLAS_TENANT_ISOLATION: 'local-synthetic' } }).then(r => r.json());
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

test('a replaced staffing manager cannot use the confirmation handle opened for the old assignment', async () => {
  const s = setup();
  const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
  const person = (email, role = 'user') => ({ email, mail: email, role, tenant: A, tenantEnforced: true });
  const alex = person('alex@mantu.com'), max = person('max@mantu.com'), noor = person('noor@mantu.com'), sam = person('sam@mantu.com'), rev = person('rev@mantu.com', 'reviewer');
  const call = async (u, method, path, body) => {
    const r = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, { method, headers: { 'x-atlas-user': u.email, 'x-atlas-role': u.role, 'x-atlas-email': u.mail, 'x-atlas-tenant': A, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), s.l, { env: { ORIGIN, DATA_MODE: 'test' } });
    return { status: r.status, body: await r.json() };
  };
  const story = (await s.l.upsert(alex, { localId: 'r1', reference: REF() })).id;
  const second = structuredClone(REF());
  second.details.projectId = 'PRJ-2';
  second.answers[1] = 'I rebuilt the second queue myself.';
  const other = (await s.l.upsert(alex, { localId: 'r2', reference: second })).id;
  const directoryRef = structuredClone(REF());
  directoryRef.details.projectId = 'PRJ-DIR';
  directoryRef.answers[4] = 'The directory note stayed on the dashboard export.';
  const directoryId = (await s.l.upsert(alex, { localId: 'r3', reference: directoryRef })).id;
  profile.ensure(s.l);
  s.l.sql.exec("INSERT INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant) VALUES ('alex@mantu.com', 'dna', '', '', '', 'Sam', 'sam@mantu.com', 't', ?, ?)", s.l.now(), A);
  s.l.bindTrust({ email: 'directory', role: 'system', tenant: A, tenantEnforced: true }, { owner: alex.email, email: sam.email, source: 'directory', tenant: A, tenantEnforced: true });
  outreach.ensure(s.l);
  for (const project of ['PRJ-1', 'PRJ-2']) s.l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at, tenant) VALUES (?, 'alex@mantu.com', 'max@mantu.com', 'Max', '', '', 'staffing-csv', ?, ?)", project, s.l.now(), A);
  s.l.bindTrust({ email: 'staffing-csv', role: 'system', tenant: A, tenantEnforced: true }, { owner: alex.email, email: max.email, source: 'staffing', tenant: A, tenantEnforced: true });
  const propose = async (id, text) => {
    const candidates = (await call(alex, 'GET', 'claims/' + id)).body.candidates;
    const sent = await call(alex, 'POST', 'claims', { refId: id, items: pick(candidates, text) });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    return sent.body.claims[0];
  };
  const c1 = await propose(story, T1);
  const cOther = await propose(other, 'I rebuilt the second queue myself.');
  const cDir = await propose(directoryId, 'The directory note stayed on the dashboard export.');
  const staffingReq = (await call(alex, 'POST', 'confirmations', { refId: story, claimIds: [c1.id] })).body.request;
  const otherReq = (await call(alex, 'POST', 'confirmations', { refId: other, claimIds: [cOther.id] })).body.request;
  const directoryReq = (await call(alex, 'POST', 'confirmations', { refId: directoryId, claimIds: [cDir.id] })).body.request;
  assert.deepEqual([staffingReq.toEmail, staffingReq.managerSource], ['max@mantu.com', 'staffing']);
  assert.equal(otherReq.managerSource, 'staffing');
  assert.deepEqual([directoryReq.toEmail, directoryReq.managerSource], ['sam@mantu.com', 'directory']);
  const header = 'project_id,consultant_email,manager_email,manager_name,project_title,end_date\n';
  const replaced = await call(rev, 'POST', 'staffing/import', { csv: header + 'PRJ-1,alex@mantu.com,noor@mantu.com,Noor,Pilot,2026-12-01\n' });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(replaced.body.staffed, 1);
  const beforeClaims = s.l.rows('SELECT id, status FROM claims ORDER BY id');
  const beforeValidation = JSON.stringify(s.l.row(story).state.validation);
  const denied = await call(max, 'POST', 'confirmations/' + staffingReq.id, { decisions: [{ claimId: c1.id, decision: 'confirm' }] });
  assert.equal(denied.status, 403);
  assert.deepEqual(s.l.rows('SELECT id, status FROM claims ORDER BY id'), beforeClaims);
  assert.equal(s.l.rows('SELECT status FROM confirmation_requests WHERE id = ?', staffingReq.id)[0].status, 'open');
  assert.equal(JSON.stringify(s.l.row(story).state.validation), beforeValidation);
  assert.deepEqual((await call(max, 'GET', 'confirmations/inbox')).body.items.map(item => item.request.id), [otherReq.id]);
  assert.equal((await call(noor, 'POST', 'confirmations/' + staffingReq.id, { decisions: [{ claimId: c1.id, decision: 'confirm' }] })).status, 403);
  const fresh = await propose(story, T3);
  const next = (await call(alex, 'POST', 'confirmations', { refId: story, claimIds: [fresh.id] })).body.request;
  assert.deepEqual([next.toEmail, next.managerSource], ['noor@mantu.com', 'staffing']);
  assert.equal((await call(noor, 'POST', 'confirmations/' + next.id, { decisions: [{ claimId: fresh.id, decision: 'confirm' }] })).status, 200);
  assert.equal(s.l.rows('SELECT status FROM claims WHERE id = ?', c1.id)[0].status, 'unverified');
  assert.equal((await call(max, 'POST', 'confirmations/' + otherReq.id, { decisions: [{ claimId: cOther.id, decision: 'confirm' }] })).status, 200);
  assert.equal((await call(sam, 'POST', 'confirmations/' + directoryReq.id, { decisions: [{ claimId: cDir.id, decision: 'confirm' }] })).status, 200);
  assert.equal(s.l.canPresalesApprove(s.l.row(story), person('pre@mantu.com', 'presales')), true);
  assert.equal(s.l.canManagerApprove(s.l.row(story), max), false);
  assert.equal(s.l.canManagerApprove(s.l.row(story), noor), true);
  assert.equal(s.l.canManagerApprove(s.l.row(story), sam), true);
  const { isVerifiedAdmin } = await import('../src/authz.js');
  assert.equal(isVerifiedAdmin({ ATLAS_ADMIN_ROLES: 'ATLAS.Admin' }, { roles: ['ATLAS.Admin'], sub: 'admin-1' }), true);
  assert.equal(isVerifiedAdmin({}, { email: 'noor@mantu.com', roles: ['ATLAS.Admin'] }), false);
});

test('a blank-manager case variant is an ambiguous staffing assignment and does not confirm a claim', async () => {
  const s = setup();
  const A = 'abcdefab-cdef-4abc-8def-0123456789ab';
  const upperA = A.toUpperCase();
  const B = 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111';
  assert.notEqual(upperA, A);
  const person = (email, role = 'user', tenant = A) => ({ email, mail: email, role, tenant, tenantEnforced: true });
  const alex = person('alex@mantu.com'), max = person('max@mantu.com'), noor = person('noor@mantu.com'), sam = person('sam@mantu.com');
  const alexB = person('bea@example.test', 'user', B), samB = person('sam-b@example.test', 'user', B);
  const call = async (u, method, path, body) => {
    const r = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, { method, headers: { 'x-atlas-user': u.email, 'x-atlas-role': u.role, 'x-atlas-email': u.mail, 'x-atlas-tenant': u.tenant, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), s.l, { env: { ORIGIN, DATA_MODE: 'test' } });
    return { status: r.status, body: await r.json() };
  };
  const storyFor = async (user, localId, projectId, sentence) => {
    const reference = structuredClone(REF());
    reference.details.projectId = projectId;
    reference.answers[1] = sentence;
    return (await s.l.upsert(user, { localId, reference })).id;
  };
  const plant = (project, consultant, tenant, manager) => s.l.sql.exec("INSERT INTO staffing (project_id, consultant_email, manager_email, manager_name, project_title, end_date, source, updated_at, tenant) VALUES (?, ?, ?, '', '', '', 'legacy', ?, ?)", project, consultant, manager, s.l.now(), tenant);
  const rows = () => s.l.rows('SELECT * FROM staffing ORDER BY project_id, consultant_email, tenant');
  outreach.ensure(s.l);
  profile.ensure(s.l);
  s.l.sql.exec("INSERT INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant) VALUES ('alex@mantu.com', 'dna', '', '', '', 'Sam', 'sam@mantu.com', 't', ?, ?)", s.l.now(), A);
  s.l.bindTrust({ email: 'directory', role: 'system', tenant: A, tenantEnforced: true }, { owner: alex.email, email: sam.email, source: 'directory', tenant: A, tenantEnforced: true });
  s.l.bindTrust({ email: 'staffing-csv', role: 'system', tenant: A, tenantEnforced: true }, { owner: alex.email, email: max.email, source: 'staffing', tenant: A, tenantEnforced: true });
  s.l.bindTrust({ email: 'staffing-csv', role: 'system', tenant: A, tenantEnforced: true }, { owner: alex.email, email: noor.email, source: 'staffing', tenant: A, tenantEnforced: true });
  const projectStory = await storyFor(alex, 'proj', 'PRJ-CASE', T1);
  const mailStory = await storyFor(alex, 'mail', 'PRJ-MAIL', 'I rebuilt the mail-case queue myself.');
  const tenantStory = await storyFor(alex, 'ten', 'PRJ-TEN', 'I rebuilt the tenant-case queue myself.');
  const reverseStory = await storyFor(alex, 'rev', 'PRJ-REV', 'I rebuilt the reverse-order queue myself.');
  const blankStory = await storyFor(alex, 'blank', 'PRJ-BLANK', 'I kept the blank assignment unchanged.');
  const cleanStory = await storyFor(alex, 'clean', 'PRJ-CLEAN', 'I kept one current manager.');
  const otherStory = await storyFor(alex, 'other', 'PRJ-OTHER', 'I kept the other project manager.');
  const foreignStory = await storyFor(alexB, 'foreign', 'PRJ-FOREIGN', 'I kept the other tenant manager.');
  plant('PRJ-CASE', 'alex@mantu.com', A, 'max@mantu.com');
  const [opened] = (await call(alex, 'POST', 'claims', { refId: projectStory, items: pick((await call(alex, 'GET', 'claims/' + projectStory)).body.candidates, T1) })).body.claims;
  const openedReq = (await call(alex, 'POST', 'confirmations', { refId: projectStory, claimIds: [opened.id] })).body.request;
  assert.deepEqual([openedReq.toEmail, openedReq.managerSource], ['max@mantu.com', 'staffing']);
  plant('prj-case', 'Alex@mantu.com', upperA, '');
  const before = rows();
  const denied = await call(max, 'POST', 'confirmations/' + openedReq.id, { decisions: [{ claimId: opened.id, decision: 'confirm' }] });
  assert.equal(denied.status, 403);
  assert.equal(s.l.rows('SELECT status FROM claims WHERE id = ?', opened.id)[0].status, 'unverified');
  assert.equal(s.l.rows('SELECT status FROM confirmation_requests WHERE id = ?', openedReq.id)[0].status, 'open');
  assert.deepEqual((await call(max, 'GET', 'confirmations/inbox')).body.items.map(item => item.request.id).includes(openedReq.id), false);
  assert.deepEqual(rows(), before);
  plant('PRJ-MAIL', 'Alex@mantu.com', A, '');
  plant('prj-mail', 'alex@mantu.com', A, 'max@mantu.com');
  const mailClaim = (await call(alex, 'POST', 'claims', { refId: mailStory, items: pick((await call(alex, 'GET', 'claims/' + mailStory)).body.candidates, 'I rebuilt the mail-case queue myself.') })).body;
  const mailAsk = await call(alex, 'POST', 'confirmations', { refId: mailStory, claimIds: [mailClaim.claims[0].id] });
  assert.equal(mailAsk.status, 409);
  assert.equal(s.l.rows("SELECT COUNT(*) AS n FROM staffing WHERE lower(project_id) = 'prj-mail'")[0].n, 2);
  plant('PRJ-TEN', 'alex@mantu.com', A, 'max@mantu.com');
  plant('prj-ten', 'alex@mantu.com', upperA, '');
  const tenantAsk = await call(alex, 'POST', 'confirmations', { refId: tenantStory, claimIds: [(await call(alex, 'POST', 'claims', { refId: tenantStory, items: pick((await call(alex, 'GET', 'claims/' + tenantStory)).body.candidates, 'I rebuilt the tenant-case queue myself.') })).body.claims[0].id] });
  assert.equal(tenantAsk.status, 409);
  plant('prj-rev', 'alex@mantu.com', upperA, '');
  plant('PRJ-REV', 'alex@mantu.com', A, 'max@mantu.com');
  const reverseAsk = await call(alex, 'POST', 'confirmations', { refId: reverseStory, claimIds: [(await call(alex, 'POST', 'claims', { refId: reverseStory, items: pick((await call(alex, 'GET', 'claims/' + reverseStory)).body.candidates, 'I rebuilt the reverse-order queue myself.') })).body.claims[0].id] });
  assert.equal(reverseAsk.status, 409);
  assert.deepEqual(rows().filter(row => String(row.project_id).toLowerCase() === 'prj-rev').map(row => row.manager_email).sort(), ['', 'max@mantu.com']);
  plant('PRJ-BLANK', 'alex@mantu.com', A, '');
  const blankClaim = (await call(alex, 'POST', 'claims', { refId: blankStory, items: pick((await call(alex, 'GET', 'claims/' + blankStory)).body.candidates, 'I kept the blank assignment unchanged.') })).body.claims[0];
  const blankReq = (await call(alex, 'POST', 'confirmations', { refId: blankStory, claimIds: [blankClaim.id] })).body.request;
  assert.deepEqual([blankReq.toEmail, blankReq.managerSource], ['sam@mantu.com', 'directory']);
  assert.equal((await call(sam, 'POST', 'confirmations/' + blankReq.id, { decisions: [{ claimId: blankClaim.id, decision: 'confirm' }] })).status, 200);
  assert.equal(s.l.rows("SELECT manager_email FROM staffing WHERE project_id = 'PRJ-BLANK'")[0].manager_email, '');
  plant('PRJ-CLEAN', 'alex@mantu.com', A, 'noor@mantu.com');
  const cleanClaim = (await call(alex, 'POST', 'claims', { refId: cleanStory, items: pick((await call(alex, 'GET', 'claims/' + cleanStory)).body.candidates, 'I kept one current manager.') })).body.claims[0];
  const cleanReq = (await call(alex, 'POST', 'confirmations', { refId: cleanStory, claimIds: [cleanClaim.id] })).body.request;
  assert.deepEqual([cleanReq.toEmail, cleanReq.managerSource], ['noor@mantu.com', 'staffing']);
  assert.equal((await call(noor, 'POST', 'confirmations/' + cleanReq.id, { decisions: [{ claimId: cleanClaim.id, decision: 'confirm' }] })).status, 200);
  plant('PRJ-OTHER', 'alex@mantu.com', A, 'max@mantu.com');
  const otherClaim = (await call(alex, 'POST', 'claims', { refId: otherStory, items: pick((await call(alex, 'GET', 'claims/' + otherStory)).body.candidates, 'I kept the other project manager.') })).body.claims[0];
  const otherReq = (await call(alex, 'POST', 'confirmations', { refId: otherStory, claimIds: [otherClaim.id] })).body.request;
  assert.equal((await call(max, 'POST', 'confirmations/' + otherReq.id, { decisions: [{ claimId: otherClaim.id, decision: 'confirm' }] })).status, 200);
  s.l.bindTrust({ email: 'staffing-csv', role: 'system', tenant: B, tenantEnforced: true }, { owner: alexB.email, email: samB.email, source: 'staffing', tenant: B, tenantEnforced: true });
  plant('PRJ-FOREIGN', 'bea@example.test', B, 'sam-b@example.test');
  const foreignClaim = (await call(alexB, 'POST', 'claims', { refId: foreignStory, items: pick((await call(alexB, 'GET', 'claims/' + foreignStory)).body.candidates, 'I kept the other tenant manager.') })).body.claims[0];
  const foreignReq = (await call(alexB, 'POST', 'confirmations', { refId: foreignStory, claimIds: [foreignClaim.id] })).body.request;
  assert.equal((await call(samB, 'POST', 'confirmations/' + foreignReq.id, { decisions: [{ claimId: foreignClaim.id, decision: 'confirm' }] })).status, 200);
  assert.equal(s.l.canManagerApprove(s.l.row(projectStory), max), false);
  assert.equal(s.l.canManagerApprove(s.l.row(cleanStory), noor), true);
  assert.equal(s.l.canManagerApprove(s.l.row(projectStory), sam), true);
  assert.equal(s.l.canPresalesApprove(s.l.row(projectStory), person('pre@mantu.com', 'presales')), true);
  const { isVerifiedAdmin } = await import('../src/authz.js');
  assert.equal(isVerifiedAdmin({ ATLAS_ADMIN_ROLES: 'ATLAS.Admin' }, { roles: ['ATLAS.Admin'], sub: 'admin-1' }), true);
  assert.equal(isVerifiedAdmin({}, { email: 'max@mantu.com', roles: ['ATLAS.Admin'] }), false);
});
