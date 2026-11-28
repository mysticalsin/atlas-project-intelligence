// An interview slot that is only a digit pattern is not a calendar day.
// Synthetic addresses only. No provider, Entra, Hindsight, or Teams call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';

const ORIGIN = 'https://atlas.example';
const SYS = { email: 'pm-system', mail: '', role: 'system' };
const REV = { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer' };

function setup() {
  const sql = memorySql();
  const clock = { t: Date.parse('2026-09-29T08:00:00.000Z') };
  let n = 0;
  const lib = new Library(sql, { now: () => new Date(clock.t).toISOString(), newId: () => (++n).toString(16).padStart(32, '0') });
  const call = async (user, method, path, body) => {
    const response = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, {
      method,
      headers: { 'x-atlas-user': user.email, 'x-atlas-role': user.role, 'x-atlas-email': user.mail, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    }), lib, { env: { ORIGIN, ATLAS_TENANT_ISOLATION: 'local-synthetic' } });
    return { status: response.status, body: await response.json() };
  };
  return { call };
}

async function draftFor(call, slot, projectId) {
  const created = await call(SYS, 'POST', 'trigger', {
    email: 'ada@example.test', reason: 'milestone', projectId, title: 'Synthetic queue pilot', slot,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const listed = await call(REV, 'GET', 'outreach');
  const email = listed.body.items.find(item => item.subjectId === created.body.id && item.channel === 'email_draft');
  const approved = await call(REV, 'POST', 'outreach/' + email.id, { action: 'approve' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.item.status, 'drafted');
  assert.equal(approved.body.draft.to, 'ada@example.test');
  assert.ok(approved.body.draft.body.includes(ORIGIN + '/go/invitation/' + created.body.id));
  return approved.body.draft;
}

test('a real interview slot is still a 15 minute calendar event', async () => {
  const { call } = setup();
  const draft = await draftFor(call, '2026-10-01T09:30', 'PRJ-REAL');
  assert.match(draft.ics, /DTSTART:20261001T093000\r\nDURATION:PT15M/);
  const leap = await draftFor(call, '2024-02-29T00:00', 'PRJ-LEAP');
  assert.match(leap.ics, /DTSTART:20240229T000000\r\nDURATION:PT15M/);
  const end = await draftFor(call, '2026-12-31T23:59', 'PRJ-END');
  assert.match(end.ics, /DTSTART:20261231T235900\r\nDURATION:PT15M/);
});

test('a slot that is not a real day or clock does not become a calendar event', async () => {
  const { call } = setup();
  const slots = [
    ['2026-02-31T09:30', 'PRJ-FEB31'],
    ['2026-02-29T09:30', 'PRJ-FEB29'],
    ['2026-04-31T09:30', 'PRJ-APR31'],
    ['2026-13-01T09:30', 'PRJ-MONTH'],
    ['2026-10-00T09:30', 'PRJ-DAY0'],
    ['2026-10-01T24:00', 'PRJ-HOUR'],
    ['2026-10-01T09:60', 'PRJ-MINUTE'],
  ];
  for (const [slot, projectId] of slots) {
    const draft = await draftFor(call, slot, projectId);
    assert.equal(draft.ics, undefined, slot);
    assert.equal(JSON.stringify(draft).includes('DTSTART'), false, slot);
  }
});
