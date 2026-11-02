// POST /api/translate (D-L2) and GET /api/connections/michat/health (X2) through the real Worker handle. Synthetic text; the AI binding is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV, session } from './security-harness.js';

const AI = { run: async (model, input) => ({ response: 'Nous avons construit le service de tri pour [[G0]] en 6 semaines.' }) };
const post = (me, body, opts = {}) => me.go('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...opts });

test('translate: signed in and CSRF checked; any target language; the answer carries confidence and flags; bad input is refused', async () => {
  const me = await session({ ...ENV, AI });
  const res = await post(me, { text: 'We built the triage service for ATLAS in 6 weeks.', target: 'fr' });
  assert.equal(res.status, 200); const v = await res.json();
  assert.equal(v.translated, true); assert.equal(v.target, 'fr'); assert.match(v.text, /ATLAS/); assert.ok(['high', 'medium', 'low'].includes(v.confidence)); assert.ok(Array.isArray(v.flags));
  assert.equal((await post(me, { text: 'x', target: 'fr' }, { csrf: 'wrong' })).status, 403);
  assert.equal((await post(me, { text: 'x', target: 'fr' }, { signed: false })).status, 401);
  assert.equal((await post(me, { text: '   ', target: 'fr' })).status, 400);
  assert.equal((await post(me, { text: 'hello there', target: 'not a language!' })).status, 400);
  assert.equal((await post(me, { text: 'a'.repeat(5000), target: 'fr' })).status, 413);
  const off = await session({ ...ENV, AI, ATLAS_AI_OFF: 'true' });
  assert.equal((await post(off, { text: 'We built it.', target: 'fr' })).status, 503);
});

test('MiChat health: admins only; with nothing configured it answers the reason codes and makes no request', async () => {
  const user = await session({ ...ENV, ADMIN_EMAILS: 'someone-else@example.com' });
  assert.equal((await user.go('/api/connections/michat/health')).status, 403);
  const admin = await session({ ...ENV, ADMIN_EMAILS: 'tony@example.com', MICHAT_CV_CONTRACT: 'assumed' });
  const res = await admin.go('/api/connections/michat/health');
  assert.equal(res.status, 200); const v = await res.json();
  assert.deepEqual([v.connection, v.ok, v.error], ['michat_cv', false, 'CONNECTION_NOT_READY']); assert.ok(v.reasons.includes('BASE_URL_MISSING'));
});
