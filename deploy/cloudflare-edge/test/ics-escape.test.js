// Calendar text must escape the four characters RFC 5545 names. A semicolon in a
// summary is not a new property, and a newline in that summary is not a new event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';

const ORIGIN = 'https://atlas.example';
const REV = { email: 'rev@mantu.com', mail: 'rev@mantu.com', role: 'reviewer' };
const SYS = { email: 'pm-system', mail: '', role: 'system' };

function setup() {
  const sql = memorySql();
  const clock = { t: Date.parse('2026-09-29T08:00:00.000Z') };
  let n = 0;
  const l = new Library(sql, {
    now: () => new Date(clock.t).toISOString(),
    newId: () => (++n).toString(16).padStart(32, '0'),
  });
  const call = async (u, method, path, body) => {
    const r = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, {
      method,
      headers: {
        'x-atlas-user': u.email,
        'x-atlas-role': u.role,
        'x-atlas-email': u.mail,
        'Content-Type': 'application/json',
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    }), l, { env: { ORIGIN, ATLAS_TENANT_ISOLATION: 'local-synthetic' } });
    return { status: r.status, body: await r.json() };
  };
  return { l, call };
}

test('an interview calendar escapes semicolon, comma, backslash and newline in the summary', async () => {
  const s = setup();
  const created = await s.call(SYS, 'POST', 'trigger', {
    email: 'alex@mantu.com', reason: 'project_end', projectId: 'PRJ-9', title: 'Pilot', slot: '2026-10-01T09:30',
  });
  assert.equal(created.status, 201);
  const email = (await s.call(REV, 'GET', 'outreach?status=pending_approval')).body.items
    .find(i => i.subjectId === created.body.id && i.channel === 'email_draft');
  const row = s.l.rows('SELECT payload FROM outreach WHERE id = ?', email.id)[0];
  const payload = JSON.parse(row.payload);
  payload.subject = 'Meet; now, please\\next\nBEGIN:VEVENT';
  sqlOf(s.l).exec('UPDATE outreach SET payload = ? WHERE id = ?', JSON.stringify(payload), email.id);
  const approved = await s.call(REV, 'POST', 'outreach/' + email.id, { action: 'approve' });
  assert.equal(approved.status, 200);
  const lines = approved.body.draft.ics.split('\r\n');
  assert.equal(lines.filter(line => line === 'BEGIN:VEVENT').length, 1);
  assert.equal(
    lines.find(line => line.startsWith('SUMMARY:')),
    'SUMMARY:Meet\\; now\\, please\\\\next\\nBEGIN:VEVENT',
  );
});
