// The Teams card treats a closed invitation by its error code. Any other 409,
// including a tampered audit chain, is the same error the caller threw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import * as outreach from '../src/outreach.js';
import { INVITATION_REFUSAL } from '../src/invitation.js';
import { memorySql } from './sqlite.js';

const ORIGIN = 'https://atlas.example';
const ATLAS = 'abcdefab-cdef-4abc-8def-0123456789ab';
const ALEX = { email: 'alex@mantu.com', mail: 'alex@mantu.com', role: 'user' };
const REV = { email: 'rev@mantu.com', mail: 'rev@mantu.com', role: 'reviewer', tenant: ATLAS };
const SYS = { email: 'pm-system', mail: '', role: 'system', tenant: ATLAS };
const BOT = { email: 'teams-bot', mail: '', role: 'system', tenant: ATLAS };
const TID = '11111111-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function setup() {
  const sql = memorySql(), clock = { t: Date.parse('2026-09-29T08:00:00.000Z') };
  let n = 0;
  const teams = { calls: [], send: async (ref, activity) => { teams.calls.push({ ref, activity }); return { id: 'activity-' + teams.calls.length }; } };
  const l = new Library(sql, { now: () => new Date(clock.t).toISOString(), newId: () => (++n).toString(16).padStart(32, '0'), services: { teams } });
  const call = async (u, method, path, body) => {
    const r = await libraryRoutes(new Request(ORIGIN + '/api/library/' + path, {
      method,
      headers: { 'x-atlas-user': u.email, 'x-atlas-role': u.role, 'x-atlas-email': u.mail, 'Content-Type': 'application/json', 'x-atlas-tenant': ATLAS },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    }), l, { env: { ORIGIN, ATLAS_TENANT_ISOLATION: 'local-synthetic' } });
    return { status: r.status, body: await r.json() };
  };
  return { l, call };
}

async function sentCard() {
  const s = setup();
  const installed = await s.call(BOT, 'POST', 'teams-event', {
    kind: 'install', activityId: 'install-1', tenantId: TID, aadObjectId: OID, teamsUserId: '29:alex',
    conversationId: 'a:conv-alex', serviceUrl: 'https://smba.trafficmanager.net/emea/', email: 'alex@mantu.com',
  });
  assert.equal(installed.status, 200);
  const invited = await s.call(SYS, 'POST', 'trigger', {
    email: 'alex@mantu.com', reason: 'project_end', projectId: 'PRJ-9', title: 'Claims triage alias', slot: '2026-10-01T09:30',
  });
  assert.equal(invited.status, 201);
  const card = (await s.call(REV, 'GET', 'outreach')).body.items.find(item => item.channel === 'teams');
  const approved = await s.call(REV, 'POST', 'outreach/' + card.id, { action: 'approve' });
  assert.equal(approved.status, 200);
  return { lib: s.l, outreachId: card.id };
}

function throwOnInvitationWrite(lib, error) {
  const inner = sqlOf(lib).exec.bind(sqlOf(lib));
  sqlOf(lib).exec = (query, ...params) => {
    if (String(query).includes('UPDATE invitations') && String(query).includes("status IN ('open', 'scheduled')")) throw error;
    return inner(query, ...params);
  };
}

function action(lib, outreachId, activityId) {
  return outreach.system({
    lib, user: BOT, env: { ORIGIN },
    body: { kind: 'action', activityId, tenantId: TID, aadObjectId: OID, conversationId: 'a:conv-alex', verb: 'decline', outreachId },
  });
}

test('a closed invitation coded INVITATION_CLOSED produces the closed card', async () => {
  const { lib, outreachId } = await sentCard();
  const closed = Object.assign(new Error('coded close'), { status: 409, code: 'INVITATION_CLOSED' });
  throwOnInvitationWrite(lib, closed);
  const result = await action(lib, outreachId, 'coded-close');
  assert.equal(result.body.card.body[0].text, 'This invitation is closed.');
  assert.equal(result.body.card.body[1].text, 'Nothing was changed.');
});

test('any other 409 and any other error are rethrown unchanged', async () => {
  const tampered = Object.assign(new Error('The audit chain is tampered.'), { status: 409, code: 'TAMPERED' });
  const sameWords = Object.assign(new Error(INVITATION_REFUSAL), { status: 409, code: 'TAMPERED' });
  const other = Object.assign(new Error('disk'), { status: 500 });
  for (const [name, error] of [['tampered chain', tampered], ['closed words with another code', sameWords], ['other error', other]]) {
    const { lib, outreachId } = await sentCard();
    throwOnInvitationWrite(lib, error);
    await assert.rejects(action(lib, outreachId, 'rethrow-' + name), err => err === error && err.status === error.status && err.code === error.code && err.message === error.message, name);
  }
});
