// F4 zero-effort capture (WOW_SPEC §F4.8 acceptance 1-3, 5, 8; §F4.9): the trigger extension, the staffing import,
// the approval queue per channel, the daily sweep and the Teams events. A fake `services.teams` stands in for the
// connected client; nothing here reaches the network and no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as outreach from '../src/outreach.js';
import * as claims from '../src/claims.js';
import { memorySql } from './sqlite.js';

const ORIGIN = 'https://atlas.example';
const who = (email, role = 'user') => ({ email, mail: email, role });
const ALEX = who('alex@mantu.com'), REV = who('rev@mantu.com', 'reviewer'), ADMIN = who('boss@mantu.com', 'admin'), SYS = { email: 'pm-system', mail: '', role: 'system' };
const BOT = { email: 'teams-bot', mail: '', role: 'system' };
const TID = '11111111-2222-3333-4444-555555555555', OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', OTHER = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
const HEADER = 'project_id,consultant_email,manager_email,manager_name,project_title,end_date';

function setup({ teams = null } = {}) {
  const sql = memorySql(), clock = { t: Date.parse('2026-09-29T08:00:00.000Z') };
  let n = 0;
  const l = new Library(sql, { now: () => new Date(clock.t).toISOString(), newId: () => (++n).toString(16).padStart(32, '0'), services: { teams } });
  const call = async (u, method, path, body) => {
    const r = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, { method, headers: { 'x-atlas-user': u.email, 'x-atlas-role': u.role, 'x-atlas-email': u.mail, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), l, { env: { ORIGIN } });
    return { status: r.status, body: await r.json() };
  };
  return { sql, l, clock, call, day: d => { clock.t += d * 864e5; } };
}
function fakeTeams(fail) {
  const calls = [];
  return { calls, send: async (ref, activity) => { calls.push({ ref, activity }); if (fail) throw fail; return { id: 'activity-' + calls.length }; } };
}
const trigger = (s, extra = {}) => s.call(SYS, 'POST', 'trigger', { email: 'alex@mantu.com', reason: 'project_end', projectId: 'PRJ-9', title: 'Zebracorp claims triage', slot: '2026-10-01T09:30', ...extra });
const install = (s, extra = {}) => s.call(BOT, 'POST', 'teams-event', { kind: 'install', activityId: 'install-1', tenantId: TID, aadObjectId: OID, teamsUserId: '29:alex',
  conversationId: 'a:conv-alex', serviceUrl: 'https://smba.trafficmanager.net/emea/', email: 'alex@mantu.com', ...extra });
const others = async s => s.l.upsert(who('jo@mantu.com'), { localId: 'other', reference: { title: 'Card fraud rules', client: { name: 'Zebracorp' } } }); // makes "Zebracorp" a library client name

test('ensure is idempotent; daily runs on a fresh schema, runs both expiries, and says nothing on a quiet day', async () => {
  const sql = memorySql(), a = new Library(sql, {});
  assert.deepEqual(outreach.daily(a), {});
  outreach.ensure(a); outreach.ensure(new Library(sql, {}));
  const b = new Library(sql, {});
  assert.deepEqual(outreach.daily(b), {});
  for (const t of ['staffing', 'outreach', 'teams_conversations', 'teams_seen', 'claims', 'confirmation_requests'])
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", t).toArray()[0].n, 1, t);
  // An expired confirmation request is expired by the sweep (claims.expire runs even though nothing else is due).
  const s = setup(), id = (await s.l.upsert(ALEX, { localId: 'r', reference: { title: 'T', validation: { manager: { name: 'Sam', email: 'sam@mantu.com' } }, answers: ['', 'I built the routing model myself.'] } })).id;
  const [c] = (await s.call(ALEX, 'POST', 'claims', { refId: id, items: [{ topic: 1, idx: 0, text: 'I built the routing model myself.' }] })).body.claims;
  await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] });
  s.day(15);
  assert.deepEqual(outreach.daily(s.l), { claimsExpired: 1 });
  assert.deepEqual(outreach.daily(s.l), {});
  // The cron path keeps its response shape: {invited} plus only the non-zero sweep counts.
  assert.deepEqual((await s.call({ email: 'atlas-cron', mail: '', role: 'system' }, 'POST', 'scan-stale', {})).body, { invited: 0 });
});

test('trigger: the invitation is unchanged; staffing and exactly 2 pending outreach rows are added; a repeat adds nothing', async () => {
  const s = setup(); await others(s);
  const plain = await (async () => { const t = setup(); return (await t.call(SYS, 'POST', 'trigger', { email: 'alex@mantu.com', reason: 'project_end', projectId: 'PRJ-9', title: 'Zebracorp claims triage', slot: '2026-10-01T09:30' })).body; })();
  const r = await trigger(s, { managerEmail: 'Sam@Mantu.com', managerName: 'Sam', endDate: '2026-10-02' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body), Object.keys(plain), 'same invitation shape');
  assert.deepEqual([r.body.email, r.body.reason, r.body.project_id, r.body.status, r.body.source, r.body.slot], ['alex@mantu.com', 'project_end', 'PRJ-9', 'scheduled', 'pm-system', '2026-10-01T09:30']);
  assert.deepEqual(s.l.rows('SELECT project_id, consultant_email, manager_email, manager_name, end_date, source FROM staffing'),
    [{ project_id: 'PRJ-9', consultant_email: 'alex@mantu.com', manager_email: 'sam@mantu.com', manager_name: 'Sam', end_date: '2026-10-02', source: 'pm-system' }]);
  const rows = s.l.rows('SELECT * FROM outreach ORDER BY channel');
  assert.deepEqual(rows.map(o => [o.kind, o.subject_id, o.channel, o.to_email, o.status]), [['interview_invite', r.body.id, 'email_draft', 'alex@mantu.com', 'pending_approval'], ['interview_invite', r.body.id, 'teams', 'alex@mantu.com', 'pending_approval']]);
  const again = await trigger(s, { managerEmail: 'sam@mantu.com', endDate: 'not a date' });
  assert.equal(again.body.id, r.body.id, 'lib.invite dedupe unchanged');
  assert.equal(s.l.rows('SELECT COUNT(*) AS n FROM outreach')[0].n, 2, 'a repeat call adds no outreach row');
  assert.equal(s.l.rows('SELECT end_date FROM staffing')[0].end_date, '2026-10-02', 'an invalid end date never overwrites a valid one');
  const noMgr = await trigger(s, { email: 'kim@mantu.com', projectId: 'PRJ-10' });
  assert.equal(noMgr.status, 201); assert.equal(s.l.rows('SELECT COUNT(*) AS n FROM staffing')[0].n, 1, 'no manager: no staffing row');
  assert.equal(s.l.rows('SELECT COUNT(*) AS n FROM outreach')[0].n, 4);
  assert.equal((await trigger(s, { email: 'nobody' })).status, 400, 'the trigger contract still rejects a bad email');
  // Previews use the record masking: a library client name in the title never reaches the queue.
  const list = (await s.call(REV, 'GET', 'outreach')).body;
  assert.deepEqual(list.channels, { teams: 'BLOCKED_EXTERNAL', email_draft: 'available', phone: 'BLOCKED_EXTERNAL' });
  assert.ok(list.items.every(i => !JSON.stringify(i.preview).includes('Zebracorp')));
  const titled = await trigger(s, { email: 'kim@mantu.com', projectId: '', title: 'Zebracorp claims triage', reason: 'milestone' });
  assert.deepEqual((await s.call(REV, 'GET', 'outreach')).body.items.filter(i => i.subjectId === titled.body.id).map(i => i.preview.title), ['another client claims triage', 'another client claims triage']);
});

test('parseCsv: quotes, escaped quotes, commas and newlines inside quotes, CRLF, CR, BOM, blank lines, line numbers', () => {
  const p = outreach.parseCsv('﻿a,b,c\r\n1,"x, y","he said ""hi"""\r\n\r\n2,"multi\r\nline",z\n3,,\r4,"open');
  assert.deepEqual(p.header, ['a', 'b', 'c']);
  assert.deepEqual(p.rows, [{ line: 2, cells: ['1', 'x, y', 'he said "hi"'] }, { line: 4, cells: ['2', 'multi\r\nline', 'z'] }, { line: 6, cells: ['3', '', ''] }]);
  assert.deepEqual(p.rejected, [{ line: 7, error: 'Unterminated quote: this row and the rest of the file were not read.' }]);
  assert.deepEqual(outreach.parseCsv(''), { header: [], rows: [], rejected: [] });
  assert.deepEqual(outreach.parseCsv('h\nv').rows, [{ line: 2, cells: ['v'] }], 'no trailing newline');
});

test('staffing import: exact header, client columns never read or stored, bad rows with line numbers, caps, due invitations', async () => {
  const s = setup(); await others(s);
  const today = '2026-09-29';
  await s.l.upsert(ALEX, { localId: 'done', reference: { title: 'Already told', details: { projectId: 'PRJ-HAS' } } });
  const csv = [`project_id,Client Name,consultant_email,manager_email,manager_name,project_title,end_date,customer_ref,Account`,
    `PRJ-1,Zebracorp SA,alex@mantu.com,sam@mantu.com,Sam,"Claims, triage",2026-10-03,ZC-001,Key account`,
    `PRJ-2,Zebracorp SA,kim@mantu.com,sam@mantu.com,Sam,Later project,2026-12-01,ZC-002,Key account`,
    `PRJ-3,Zebracorp SA,bad-email,sam@mantu.com,Sam,Bad,2026-10-01,ZC-003,x`,
    `PRJ-4,Zebracorp SA,jo@mantu.com,sam@mantu.com,Sam,Bad date,2026-02-30,ZC-004,x`,
    `,Zebracorp SA,jo@mantu.com,sam@mantu.com,Sam,No id,2026-10-01,ZC-005,x`,
    `PRJ-5,Zebracorp SA,jo@mantu.com,jo@mantu.com,Jo,Self,2026-10-01,ZC-006,x`,
    `PRJ-6,Zebracorp SA,jo@mantu.com,not-an-email,Jo,Bad manager,2026-10-01,ZC-007,x`,
    `PRJ-HAS,Zebracorp SA,alex@mantu.com,sam@mantu.com,Sam,Has ref,2026-10-01,ZC-008,x`,
    `PRJ-OLD,Zebracorp SA,alex@mantu.com,sam@mantu.com,Sam,Long ago,2024-01-31,ZC-009,x`,
    `Zebracorp-2026,Zebracorp SA,kim@mantu.com,,,Masked id,${today},ZC-010,x`].join('\r\n');
  const r = await s.call(REV, 'POST', 'staffing/import', { csv });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.ignoredColumns, ['Client Name', 'customer_ref', 'Account']);
  assert.deepEqual(r.body.rejected, [{ line: 4, error: 'consultant_email is not a valid email.' }, { line: 5, error: 'end_date must be a real date written YYYY-MM-DD.' },
    { line: 6, error: 'project_id is required.' }, { line: 7, error: 'The N+1 cannot be the consultant.' }, { line: 8, error: 'manager_email is not a valid email.' }]);
  assert.deepEqual([r.body.rows, r.body.staffed, r.body.invited, r.body.outreachQueued], [10, 5, 2, 4]);
  const dump = JSON.stringify(s.sql.exec('SELECT * FROM staffing').toArray()) + JSON.stringify(s.sql.exec('SELECT * FROM outreach').toArray()) + JSON.stringify(s.sql.exec('SELECT * FROM audit').toArray());
  for (const secret of ['Zebracorp SA', 'ZC-00', 'Key account']) assert.ok(!dump.includes(secret), secret + ' was stored');
  assert.deepEqual(s.l.rows("SELECT email, project_id, reason, source, status FROM invitations WHERE source = 'staffing-csv' ORDER BY project_id"),
    [{ email: 'alex@mantu.com', project_id: 'PRJ-1', reason: 'project_end', source: 'staffing-csv', status: 'open' }, { email: 'kim@mantu.com', project_id: 'Zebracorp-2026', reason: 'project_end', source: 'staffing-csv', status: 'open' }]);
  const previews = (await s.call(REV, 'GET', 'outreach')).body.items.map(i => i.preview.title);
  assert.ok(previews.includes('another client-2026') && !previews.some(p => p.includes('Zebracorp')), JSON.stringify(previews));
  const staff = (await s.call(REV, 'GET', 'staffing?project=prj-1')).body.items;
  assert.deepEqual(staff, [{ projectId: 'PRJ-1', consultantEmail: 'alex@mantu.com', managerEmail: 'sam@mantu.com', managerName: 'Sam', projectTitle: 'Claims, triage', endDate: '2026-10-03', source: 'staffing-csv', updatedAt: '2026-09-29T08:00:00.000Z' }]);
  assert.equal((await s.call(ADMIN, 'GET', 'staffing')).body.items.length, 5);
  // Re-import: upserts, no second invitation, no new outreach row.
  const again = (await s.call(ADMIN, 'POST', 'staffing/import', { csv })).body;
  assert.deepEqual([again.staffed, again.invited, again.outreachQueued], [5, 0, 0]);
  // A dismissed invitation is never re-created by a later import or the daily sweep.
  s.l.sql.exec("UPDATE invitations SET status = 'dismissed' WHERE project_id = 'PRJ-1'");
  assert.equal((await s.call(ADMIN, 'POST', 'staffing/import', { csv })).body.invited, 0);
  assert.deepEqual(outreach.daily(s.l), {});
  // Header and caps.
  const bad = await s.call(REV, 'POST', 'staffing/import', { csv: 'project_id,consultant_email,manager_email,project_title,end_date\nP,a@b.co,,,' });
  assert.deepEqual([bad.status, bad.body.error], [400, `The first row must be the header ${HEADER} (missing: manager_name).`]);
  const rows2001 = [HEADER, ...Array.from({ length: 2001 }, (_, i) => `P${i},c${i}@mantu.com,,,,`)].join('\n');
  assert.equal((await s.call(REV, 'POST', 'staffing/import', { csv: rows2001 })).status, 413);
  const rows2000 = [HEADER, ...Array.from({ length: 2000 }, (_, i) => `P${i},c${i}@mantu.com,,,,`)].join('\n');
  const ok = await s.call(REV, 'POST', 'staffing/import', { csv: rows2000 });
  assert.deepEqual([ok.status, ok.body.staffed], [200, 2000]);
  assert.equal((await s.call(REV, 'POST', 'staffing/import', { csv: HEADER + '\n' + 'x'.repeat(200001) })).status, 413);
  assert.equal((await s.call(REV, 'POST', 'staffing/import', { csv: '' })).status, 400);
  for (const [method, path, body] of [['POST', 'staffing/import', { csv }], ['GET', 'staffing'], ['GET', 'outreach'], ['POST', 'outreach/x', { action: 'approve' }]])
    assert.deepEqual(await s.call(ALEX, method, path, body), { status: 403, body: { error: 'Outreach and staffing are for reviewers.' } }, path);
  const audit = s.l.rows("SELECT detail FROM audit WHERE action = 'staffing import'");
  assert.ok(audit.length >= 3 && audit.every(a => /^\d+ rows, \d+ rejected, \d+ invited$/.test(a.detail)));
});

test('the N+1 from staffing is the one F3 asks (staffing beats self-declared)', async () => {
  const s = setup();
  const id = (await s.l.upsert(ALEX, { localId: 'r', reference: { title: 'T', details: { projectId: 'PRJ-1' }, validation: { manager: { name: 'Kim', email: 'kim@mantu.com' } }, answers: ['', 'I built the routing model myself.'] } })).id;
  await s.call(REV, 'POST', 'staffing/import', { csv: `${HEADER}\nPRJ-1,alex@mantu.com,sam@mantu.com,Sam,T,2027-01-01` });
  const [c] = (await s.call(ALEX, 'POST', 'claims', { refId: id, items: [{ topic: 1, idx: 0, text: 'I built the routing model myself.' }] })).body.claims;
  const req = (await s.call(ALEX, 'POST', 'confirmations', { refId: id, claimIds: [c.id] })).body.request;
  assert.deepEqual([req.toEmail, req.managerSource], ['sam@mantu.com', 'staffing']);
});

test('approve per channel: email draft (drafted, with .ics), Teams not connected (blocked_external), phone always blocked, dismiss', async () => {
  const s = setup(); await others(s);
  const inv = (await trigger(s)).body;
  const rows = (await s.call(REV, 'GET', 'outreach?status=pending_approval')).body.items, email = rows.find(i => i.channel === 'email_draft'), teams = rows.find(i => i.channel === 'teams');
  const a = await s.call(REV, 'POST', 'outreach/' + email.id, { action: 'approve' });
  assert.deepEqual([a.status, a.body.item.status, a.body.item.approvedBy], [200, 'drafted', 'rev@mantu.com']);
  assert.deepEqual([a.body.draft.to, a.body.draft.subject], ['alex@mantu.com', "12 minutes while it's fresh?"]);
  assert.ok(a.body.draft.body.includes(`${ORIGIN}/go/invitation/${inv.id}`), 'a /go/ link that survives sign-in (WOW_ZERO_CONFIG §3.9)');
  assert.match(a.body.draft.ics, /DTSTART:20261001T093000\r\nDURATION:PT15M/);
  assert.ok(!JSON.stringify(a.body).includes('Zebracorp'), 'no client name in the draft');
  assert.equal((await s.call(REV, 'POST', 'outreach/' + email.id, { action: 'approve' })).status, 409, 'drafted is final');
  const t = await s.call(ADMIN, 'POST', 'outreach/' + teams.id, { action: 'approve' });
  assert.deepEqual([t.body.item.status, t.body.item.reason], ['blocked_external', 'Teams is not connected: tenant app, bot credentials and TEAMS_* settings are missing.']);
  // Phone is never queued; a phone row (inserted by hand) is always blocked_external.
  s.l.sql.exec("INSERT INTO outreach (id, kind, subject_id, channel, to_email, status, reason, payload, created_at) VALUES ('ph1', 'interview_invite', ?, 'phone', 'alex@mantu.com', 'pending_approval', '', '{}', 'x')", inv.id);
  const ph = await s.call(REV, 'POST', 'outreach/ph1', { action: 'approve' });
  assert.equal(ph.body.item.status, 'blocked_external'); assert.match(ph.body.item.reason, /Twilio.*Teams Phone/);
  const d = await s.call(REV, 'POST', 'outreach/' + teams.id, { action: 'dismiss' });
  assert.equal(d.body.item.status, 'dismissed', 'a blocked row can be dismissed');
  assert.equal((await s.call(REV, 'POST', 'outreach/' + teams.id, { action: 'approve' })).status, 409);
  assert.equal((await s.call(REV, 'POST', 'outreach/nope', { action: 'approve' })).status, 404);
  assert.equal((await s.call(REV, 'POST', 'outreach/ph1', { action: 'send' })).status, 400);
  // A closed subject is never sent: approving an item whose invitation was dismissed dismisses the item.
  const inv2 = (await trigger(s, { email: 'kim@mantu.com', projectId: 'PRJ-11' })).body;
  await s.l.updateInvitation(who('kim@mantu.com'), inv2.id, { action: 'dismiss' });
  const late = (await s.call(REV, 'GET', 'outreach')).body.items.find(i => i.subjectId === inv2.id && i.channel === 'email_draft');
  const closed = await s.call(REV, 'POST', 'outreach/' + late.id, { action: 'approve' });
  assert.deepEqual([closed.body.item.status, closed.body.item.reason, closed.body.draft], ['dismissed', 'The invitation or request is no longer open.', undefined]);
  // Audit: "outreach <status>" with kind and channel only.
  const audit = s.l.rows("SELECT action, detail FROM audit WHERE action LIKE 'outreach %'");
  assert.ok(audit.length >= 8);
  for (const r of audit) { assert.match(r.action, /^outreach (pending_approval|drafted|sent|failed|blocked_external|dismissed)$/); assert.match(r.detail, /^(interview_invite|gap_request|confirmation_request) (teams|email_draft|phone)$/); }
});

test('Teams connected (fake client): not installed, sent with the invitee binding, failed, MessageWritesBlocked stops the conversation', async () => {
  const fake = fakeTeams(), s = setup({ teams: fake }); await others(s);
  const inv = (await trigger(s)).body, items = () => s.call(REV, 'GET', 'outreach').then(r => r.body);
  assert.equal((await items()).channels.teams, 'connected');
  const teams = (await items()).items.find(i => i.channel === 'teams');
  const none = await s.call(REV, 'POST', 'outreach/' + teams.id, { action: 'approve' });
  assert.deepEqual([none.body.item.status, none.body.item.reason], ['blocked_external', "ATLAS is not installed in this person's Teams."]);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual((await install(s)).body, { ok: true });
  const sent = await s.call(REV, 'POST', 'outreach/' + teams.id, { action: 'approve' });
  assert.deepEqual([sent.body.item.status, sent.body.item.sentAt], ['sent', '2026-09-29T08:00:00.000Z']);
  assert.deepEqual(s.l.rows('SELECT activity_id, aad_object_id FROM outreach WHERE id = ?', teams.id), [{ activity_id: 'activity-1', aad_object_id: OID }]);
  assert.equal(fake.calls.length, 1);
  const { ref, activity } = fake.calls[0];
  assert.deepEqual(ref, { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'a:conv-alex', tenantId: TID, aadObjectId: OID });
  const card = activity.attachments[0].content, text = JSON.stringify(card);
  assert.equal(activity.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.deepEqual([card.version, card.body[0].text], ['1.5', "12 minutes while it's fresh?"]);
  assert.equal(card.actions[0].url, `${ORIGIN}/go/invitation/${inv.id}`);
  assert.deepEqual(card.actions.slice(1).map(x => [x.type, x.verb, x.data.outreachId]), [['Action.Execute', 'snooze', teams.id], ['Action.Execute', 'decline', teams.id]]);
  assert.ok(!text.includes('Zebracorp'), 'no client name on the card');
  assert.equal((await s.call(REV, 'POST', 'outreach/' + teams.id, { action: 'approve' })).status, 409, 'sent is final');
  // failed (another HTTP error) and MessageWritesBlocked.
  const failing = fakeTeams(Object.assign(new Error('Teams send: HTTP 500'), { status: 500 }));
  s.l.services = { teams: failing };
  const inv2 = (await trigger(s, { projectId: 'PRJ-12' })).body, t2 = (await items()).items.find(i => i.subjectId === inv2.id && i.channel === 'teams');
  const f = await s.call(REV, 'POST', 'outreach/' + t2.id, { action: 'approve' });
  assert.deepEqual([f.body.item.status, f.body.item.reason], ['failed', 'Teams did not accept the message (HTTP 500).']);
  s.l.services = { teams: fakeTeams(Object.assign(new Error('Teams send: HTTP 403'), { status: 403, code: 'MessageWritesBlocked' })) };
  const blocked = await s.call(REV, 'POST', 'outreach/' + t2.id, { action: 'approve' });
  assert.deepEqual([blocked.body.item.status, blocked.body.item.reason], ['failed', 'This person blocked messages from ATLAS in Teams (MessageWritesBlocked).']);
  assert.equal(s.l.rows('SELECT status FROM teams_conversations')[0].status, 'stopped');
  s.l.services = { teams: fake };
  const inv3 = (await trigger(s, { projectId: 'PRJ-13' })).body, t3 = (await items()).items.find(i => i.subjectId === inv3.id && i.channel === 'teams');
  const stopped = await s.call(REV, 'POST', 'outreach/' + t3.id, { action: 'approve' });
  assert.deepEqual([stopped.body.item.status, stopped.body.item.reason], ['blocked_external', 'This person asked ATLAS to stop Teams messages.']);
  assert.equal(fake.calls.length, 1, 'nothing more was sent');
});

test('daily: newly due staffing rows are invited once and queued (pending only); teams_seen older than 2 days is pruned', async () => {
  const s = setup();
  await s.call(REV, 'POST', 'staffing/import', { csv: `${HEADER}\nPRJ-1,alex@mantu.com,sam@mantu.com,Sam,Routing,2026-10-20` });
  assert.equal(s.l.rows('SELECT COUNT(*) AS n FROM invitations')[0].n, 0, 'not due yet at import');
  s.day(14);
  assert.deepEqual(outreach.daily(s.l), { staffingInvited: 1, outreachQueued: 2 });
  assert.deepEqual(outreach.daily(s.l), {}, 'idempotent');
  assert.deepEqual(s.l.rows('SELECT status FROM outreach').map(r => r.status), ['pending_approval', 'pending_approval'], 'the sweep never sends');
  assert.deepEqual(s.l.rows('SELECT email, reason, source FROM invitations'), [{ email: 'alex@mantu.com', reason: 'project_end', source: 'staffing-csv' }]);
  await install(s, { activityId: 'old' }); s.day(3); await install(s, { activityId: 'new' });
  assert.deepEqual(outreach.daily(s.l), { teamsSeenPruned: 1 });
  assert.deepEqual(s.l.rows('SELECT activity_id FROM teams_seen'), [{ activity_id: 'new' }]);
});

test('teams-event: install, duplicate activity, stop, uninstall, and card actions bound to the invitee only', async () => {
  const fake = fakeTeams(), s = setup({ teams: fake }); await others(s);
  assert.deepEqual((await install(s)).body, { ok: true });
  assert.deepEqual(s.l.rows('SELECT subject, aad_object_id, tenant_id, conversation_id, email, status FROM teams_conversations'),
    [{ subject: `${TID}:${OID}`, aad_object_id: OID, tenant_id: TID, conversation_id: 'a:conv-alex', email: 'alex@mantu.com', status: 'active' }]);
  assert.deepEqual((await install(s, { conversationId: 'changed' })).body, { ok: true, duplicate: true });
  assert.equal(s.l.rows('SELECT conversation_id FROM teams_conversations')[0].conversation_id, 'a:conv-alex', 'a duplicate changes nothing');
  assert.equal((await install(s, { activityId: 'bad', serviceUrl: 'http://smba.trafficmanager.net/' })).status, 400);
  assert.equal(s.l.rows("SELECT COUNT(*) AS n FROM teams_seen WHERE activity_id = 'bad'")[0].n, 0, 'a rejected event is not marked as seen');
  assert.equal((await s.call(BOT, 'POST', 'teams-event', { kind: 'install', activityId: 'x', tenantId: 'nope', aadObjectId: OID })).status, 400);
  assert.equal((await s.call(BOT, 'POST', 'teams-event', { kind: 'dance', activityId: 'y', tenantId: TID, aadObjectId: OID })).status, 400);
  // Send a card, then act on it.
  const inv = (await trigger(s)).body, card = (await s.call(REV, 'GET', 'outreach')).body.items.find(i => i.channel === 'teams');
  await s.call(REV, 'POST', 'outreach/' + card.id, { action: 'approve' });
  const act = (id, extra) => s.call(BOT, 'POST', 'teams-event', { kind: 'action', activityId: id, tenantId: TID, aadObjectId: OID, verb: 'snooze', outreachId: card.id, ...extra });
  const invitation = () => s.l.rows('SELECT slot, status FROM invitations WHERE id = ?', inv.id)[0];
  // Another Teams user who also has ATLAS installed (so has an active conversation) still cannot act on this card.
  await install(s, { activityId: 'install-kim', aadObjectId: OTHER, teamsUserId: '29:kim', conversationId: 'a:conv-kim', email: 'kim@mantu.com' });
  const before = invitation();
  for (const [id, extra] of [['o1', { aadObjectId: OTHER }], ['o2', { tenantId: '99999999-2222-3333-4444-555555555555' }], ['o3', { outreachId: 'nope' }], ['o4', { verb: 'decline', aadObjectId: OTHER }]]) {
    const r = await act(id, extra);
    assert.deepEqual([r.status, r.body.ok, r.body.card.body[0].text], [200, true, 'This card belongs to someone else.'], id);
  }
  assert.deepEqual(invitation(), before, 'nothing changed for anyone but the invitee');
  const snooze = await act('s1');
  assert.deepEqual(invitation(), { slot: '2026-10-02T09:30', status: 'scheduled' });
  assert.equal(snooze.body.card.body[0].text, "12 minutes while it's fresh?");
  assert.ok(snooze.body.card.body.some(b => /Moved to tomorrow/.test(b.text)) && !JSON.stringify(snooze.body.card).includes('Zebracorp'));
  assert.deepEqual((await act('s1')).body, { ok: true, duplicate: true });
  assert.equal(invitation().slot, '2026-10-02T09:30', 'a duplicate activity is processed once');
  const decline = await act('d1', { verb: 'decline' });
  assert.deepEqual([invitation().status, decline.body.card.body[0].text], ['dismissed', 'Understood: no interview for this project.']);
  assert.equal((await act('d2', { verb: 'snooze' })).body.card.body[0].text, 'This invitation is closed.');
  assert.deepEqual(s.l.rows("SELECT actor, action FROM audit WHERE action LIKE 'invitation %' ORDER BY seq").map(r => [r.actor, r.action]),
    [['alex@mantu.com', 'invitation schedule'], ['alex@mantu.com', 'invitation dismiss']]);
  // stop and uninstall.
  assert.deepEqual((await s.call(BOT, 'POST', 'teams-event', { kind: 'stop', activityId: 'st', tenantId: TID, aadObjectId: OID })).body, { ok: true });
  assert.equal(s.l.rows('SELECT status FROM teams_conversations')[0].status, 'stopped');
  await s.call(BOT, 'POST', 'teams-event', { kind: 'uninstall', activityId: 'un', tenantId: TID, aadObjectId: OID });
  assert.equal(s.l.rows('SELECT status FROM teams_conversations')[0].status, 'uninstalled');
  await install(s, { activityId: 'again', email: '' });
  assert.deepEqual(s.l.rows('SELECT status, email FROM teams_conversations')[0], { status: 'active', email: 'alex@mantu.com' }, 'a reinstall keeps the routing email');
  assert.equal(fake.calls.length, 1, 'the bot never sends on its own: only the one approved card');
  assert.equal((await s.call(ALEX, 'POST', 'teams-event', { kind: 'install' })).status, 404, 'users cannot post Teams events');
});

test('Z links: every queued kind points at its /go/ path (WOW_ZERO_CONFIG §3.9); a row queued before keeps its stored fragment link', async () => {
  const s = setup(); await others(s);
  for (const [kind, id, path] of [['interview_invite', 'a'.repeat(32), '/go/invitation/'], ['gap_request', 'b'.repeat(32), '/go/gap/'], ['confirmation_request', 'c'.repeat(32), '/go/confirm/']]) {
    outreach.queue(s.l, { kind, subjectId: id, toEmail: 'kim@mantu.com', preview: { title: 'T' } });
    const rows = s.l.rows('SELECT payload FROM outreach WHERE kind = ? AND subject_id = ?', kind, id);
    assert.deepEqual(rows.map(r => JSON.parse(r.payload).path), [path + id, path + id], kind);
  }
  const inv = (await trigger(s)).body, email = (await s.call(REV, 'GET', 'outreach')).body.items.find(i => i.subjectId === inv.id && i.channel === 'email_draft');
  const row = s.l.rows('SELECT payload FROM outreach WHERE id = ?', email.id)[0], old = { ...JSON.parse(row.payload), path: '/#invitation/' + inv.id };
  s.l.sql.exec('UPDATE outreach SET payload = ? WHERE id = ?', JSON.stringify(old), email.id);
  const a = await s.call(REV, 'POST', 'outreach/' + email.id, { action: 'approve' });
  assert.ok(a.body.draft.body.includes(`${ORIGIN}/#invitation/${inv.id}`), 'old fragment links keep working');
});

test('queue: deduped per subject and channel, previews masked again, bad items refused', async () => {
  const s = setup(); await others(s);
  const item = { kind: 'gap_request', subjectId: 'g1', toEmail: 'Kim@Mantu.com', preview: { title: 'Proof for [Company 1] at Zebracorp', text: 'Call Jane on +33 6 12 34 56 78' } };
  const a = outreach.queue(s.l, item), b = outreach.queue(s.l, item);
  assert.deepEqual(a.map(o => [o.channel, o.status, o.toEmail]), [['teams', 'pending_approval', 'kim@mantu.com'], ['email_draft', 'pending_approval', 'kim@mantu.com']]);
  assert.deepEqual(b.map(o => o.id), a.map(o => o.id));
  assert.deepEqual(a[0].preview, { title: 'Proof for [company] at another client', text: 'Call Jane on [phone]' });
  assert.throws(() => outreach.queue(s.l, { ...item, kind: 'spam' }), e => e.status === 400);
  assert.throws(() => outreach.queue(s.l, { ...item, toEmail: 'nope' }), e => e.status === 400);
  assert.equal(s.l.rows('SELECT COUNT(*) AS n FROM outreach')[0].n, 2);
  assert.ok(claims.READY && outreach.READY);
});
