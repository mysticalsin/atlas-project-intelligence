// v2.2 F2: GET /api/connections/status, the admin Connections panel's read-only source. Admins only; one of three words per connection; names and yes/no only, never a secret, URL or token value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV, session } from './security-harness.js';
import { connectionsView } from '../src/connectors.js';
import { CONNECTIONS_CONFIG } from '../src/policy.generated.js';

const SECRET = 'sk-live-TOPSECRET-7f3a', HOST = 'https://private-host.example.internal', admin = { ...ENV, ADMIN_EMAILS: 'tony@example.com' };

test('F2 connections: a signed-in person who is not an admin is refused, and nothing is listed', async () => {
  const me = await session({ ...ENV, ADMIN_EMAILS: 'someone-else@example.com' });
  const res = await me.go('/api/connections/status');
  assert.equal(res.status, 403); const body = await res.text(); assert.doesNotMatch(body, /connections"|dna_skills|michat/);
  assert.ok(me.logs.some(l => l.event === 'access_denied' && l.reason === 'ADMIN_ONLY'), 'the refusal is in the security log, as a code');
  assert.equal((await me.go('/api/connections/status', { signed: false })).status, 401);
  assert.equal((await me.go('/api/connections/status', { method: 'POST', body: '{}' })).status, 404, 'read-only: no write verb');
});

test('F2 connections: an admin sees every connection of the framework with one of three states; no secret, URL or token value anywhere in the answer', async () => {
  const env = { ...admin, ATLAS_ADAPTERS: 'live', DNA_SKILLS_TOKEN: SECRET, DNA_SKILLS_BASE_URL: HOST, MICHAT_CV_TOKEN: SECRET + '-2' };
  const me = await session(env), res = await me.go('/api/connections/status');
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text(), v = JSON.parse(text);
  assert.ok(!text.includes(SECRET) && !text.includes('TOPSECRET') && !text.includes('private-host') && !text.includes(HOST), 'no value leaks');
  assert.deepEqual(v.connections.map(c => c.id), CONNECTIONS_CONFIG.connections.map(c => c.id), 'every connection of the framework, in its order');
  for (const c of v.connections) assert.ok(['ready', 'mock', 'not_configured'].includes(c.state), c.id + ' ' + c.state);
  assert.equal(v.adapters, 'live');
  const by = Object.fromEntries(v.connections.map(c => [c.id, c]));
  assert.equal(by.dna_skills.secrets_present.DNA_SKILLS_TOKEN, true, 'a yes/no for the credential, not its value'); assert.equal(by.dna_skills.base_url_set, true);
  assert.equal(by.michat_cv.base_url_set, false); assert.equal(by.michat_cv.state, 'not_configured', 'live mode with the address missing is not ready');
  assert.equal(by.maap_review.state, 'not_configured'); assert.equal(by.maap_review.wired, false); assert.match(by.maap_review.note, /rubric/i);
  assert.equal(by.identity.state, 'ready'); assert.equal(by.identity.built_in, true); assert.equal(by.identity.status, 'configured_untested', 'ready is not proof of live use: the evidence level stays visible');
});

test('F2 connections: in mock mode a wired outbound step is "mock", an inbound read with nothing set is not configured, and ready needs a live, complete connection', () => {
  const v = connectionsView({}); assert.equal(v.adapters, 'mock');
  const by = Object.fromEntries(v.connections.map(c => [c.id, c]));
  assert.equal(by.dna_skills.state, 'mock'); assert.equal(by.spotlight_cms.state, 'mock'); assert.equal(by.prefill_profile.state, 'not_configured'); assert.equal(by.staffing.state, 'ready');
  assert.equal(by.maap_review.state, 'not_configured', 'not wired: mock would pretend a step exists');
  assert.ok(v.connections.every(c => c.state !== 'ready' || c.built_in), 'nothing outside is "ready" with an empty environment');
  const json = JSON.stringify(v); assert.doesNotMatch(json, /https?:\/\//, 'no address in the view');
});
