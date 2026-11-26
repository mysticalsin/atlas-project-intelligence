// A personal Teams activity is an event only when the tenant and the object id
// are dashed UUIDs. The library refuses anything else, and forwarding it makes
// the bot answer 502. Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventOf } from '../src/teams-routes.js';

const ENV = {
  TEAMS_APP_ID: '33333333-4444-5555-6666-777777777777',
  TEAMS_BOT_APP_ID: '22222222-3333-4444-5555-666666666666',
};
const TID = '11111111-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function activity(extra = {}) {
  return {
    type: 'message',
    id: 'act-1',
    text: 'stop',
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    from: { id: '29:alex', aadObjectId: OID },
    conversation: { id: 'a:conv', conversationType: 'personal', tenantId: TID },
    channelData: { tenant: { id: TID } },
    ...extra,
  };
}

test('a personal stop with dashed ids is still an event', () => {
  const event = eventOf(activity(), ENV);
  assert.equal(event.kind, 'stop');
  assert.equal(event.tenantId, TID);
  assert.equal(event.aadObjectId, OID);
  assert.equal(event.subject, TID + ':' + OID);
});

test('a dashed object id keeps its letter case', () => {
  const upper = OID.toUpperCase();
  const event = eventOf(activity({ from: { id: '29:alex', aadObjectId: upper } }), ENV);
  assert.equal(event.kind, 'stop');
  assert.equal(event.aadObjectId, upper);
});

test('a personal stop without an object id is not forwarded', () => {
  assert.equal(eventOf(activity({ from: { id: '29:alex' } }), ENV), null);
});

test('a personal install with a bare object id is not forwarded', () => {
  const event = eventOf(activity({
    type: 'installationUpdate',
    action: 'add',
    text: undefined,
    from: { id: '29:alex', aadObjectId: 'not-a-guid' },
  }), ENV);
  assert.equal(event, null);
});

test('an object id without hyphens is not forwarded', () => {
  const packed = OID.replace(/-/g, '');
  assert.equal(eventOf(activity({ from: { id: '29:alex', aadObjectId: packed } }), ENV), null);
});

test('a personal stop without a dashed tenant id is not forwarded', () => {
  assert.equal(eventOf(activity({
    channelData: { tenant: { id: 'contoso' } },
    conversation: { id: 'a:conv', conversationType: 'personal', tenantId: 'contoso' },
  }), ENV), null);
});
