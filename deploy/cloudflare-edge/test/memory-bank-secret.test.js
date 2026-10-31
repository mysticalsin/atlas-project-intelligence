// B1 (6): HINDSIGHT_BANK_SECRET is required when memory is configured (fail closed), the derivation is unchanged when it is set
// (no orphaned banks), and the old CSRF-coupled derivation exists only behind an explicit bootstrap flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { bankId, bankSecretStatus, BANK_SECRET_MESSAGE } from '../src/memory.js';
import { ENV, ORIGIN, session, ns } from './security-harness.js';

const legacy = (secret, sub) => 'atlas-' + createHmac('sha256', secret).update('hindsight-bank:' + sub).digest('hex').slice(0, 40); // the pre-B1 formula, written independently

test('derivation is byte-for-byte the pre-B1 one when the secret is set (no orphaned banks), and moves with the secret only', async () => {
  const env = { HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 'stable-secret', CSRF_SECRET: 'csrf-one' };
  assert.equal(await bankId(env, 'tid:oid'), legacy('stable-secret', 'tid:oid'));
  assert.equal(await bankId({ ...env, CSRF_SECRET: 'csrf-ROTATED' }, 'tid:oid'), legacy('stable-secret', 'tid:oid'), 'rotating CSRF_SECRET no longer moves any bank');
  assert.equal(await bankId({ HINDSIGHT_API_KEY: 'k', HINDSIGHT_ALLOW_DERIVED_BANK: '1', CSRF_SECRET: 'csrf-one' }, 'tid:oid'), legacy('atlas-hindsight:csrf-one', 'tid:oid'), 'bootstrap flag: the old coupled derivation, unchanged');
  // migration without orphaning: set HINDSIGHT_BANK_SECRET to 'atlas-hindsight:' + the CSRF secret in use
  assert.equal(await bankId({ HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 'atlas-hindsight:csrf-one', CSRF_SECRET: 'x' }, 'u'), legacy('atlas-hindsight:csrf-one', 'u'));
});

test('memory configured without the secret fails closed with a clear message; memory not configured is unaffected', async () => {
  assert.equal(bankSecretStatus({}), 'unused'); assert.equal(bankSecretStatus({ HINDSIGHT_BANK_SECRET: 'x' }), 'unused');
  assert.equal(bankSecretStatus({ HINDSIGHT_API_KEY: 'k' }), 'missing'); assert.equal(bankSecretStatus({ HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 's' }), 'ok');
  assert.equal(bankSecretStatus({ HINDSIGHT_API_KEY: 'k', HINDSIGHT_ALLOW_DERIVED_BANK: 'true' }), 'derived'); assert.equal(bankSecretStatus({ HINDSIGHT_API_KEY: 'k', HINDSIGHT_ALLOW_DERIVED_BANK: '0' }), 'missing');
  await assert.rejects(() => bankId({ HINDSIGHT_API_KEY: 'k', CSRF_SECRET: 'c' }, 'u'), e => e.code === 'BANK_SECRET_REQUIRED' && /HINDSIGHT_BANK_SECRET/.test(e.message));
  assert.match(await bankId({ CSRF_SECRET: 'c' }, 'u'), /^atlas-[0-9a-f]{40}$/); // no memory configured: still derivable, nothing uses it
  assert.match(BANK_SECRET_MESSAGE, /SECURITY_RUNBOOK/);
});

test('Worker: no secret means no bank header, no memory API (503 with the reason) and bootstrap reports memory off; with it everything works', async () => {
  const itv = ns(), env = { ...ENV, INTERVIEW: itv, HINDSIGHT_API_KEY: 'k', HINDSIGHT_URL: 'https://hs.example' }, me = await session(env);
  assert.equal((await (await me.go('/api/bootstrap')).json()).memory, false);
  const r = await me.go('/api/memory'); assert.equal(r.status, 503); const j = await r.json(); assert.equal(j.code, 'BANK_SECRET_REQUIRED'); assert.match(j.error, /HINDSIGHT_BANK_SECRET/);
  assert.equal((await me.go('/api/memory/forget', { method: 'POST', body: '{"all":true}' })).status, 503);
  itv.calls.length = 0;
  await me.go('/api/voice', { headers: { Upgrade: 'websocket', Origin: ORIGIN } });
  assert.equal(itv.calls.at(-1).request.headers.get('x-atlas-bank'), '', 'the interview starts without memory');
  const ok = { ...env, HINDSIGHT_BANK_SECRET: 'stable' }, me2 = await session(ok);
  assert.equal((await (await me2.go('/api/bootstrap')).json()).memory, true);
  assert.equal((await me2.go('/api/memory')).status, 200); assert.equal(itv.calls.at(-1).request.headers.get('x-atlas-bank'), legacy('stable', 'user-abc'));
  const flagged = await session({ ...env, HINDSIGHT_ALLOW_DERIVED_BANK: '1' });
  assert.equal((await flagged.go('/api/memory')).status, 200); assert.equal(itv.calls.at(-1).request.headers.get('x-atlas-bank'), legacy('atlas-hindsight:' + ENV.CSRF_SECRET, 'user-abc'));
  const none = await session({ ...ENV, INTERVIEW: itv });
  assert.equal((await none.go('/api/memory')).status, 200, 'memory not configured: the route answers as before');
});
