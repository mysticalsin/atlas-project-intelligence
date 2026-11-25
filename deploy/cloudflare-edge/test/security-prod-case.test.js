// DATA_MODE=production refuses a leftover demo switch. The audit key treats any
// letter case of that word as production, so the refusal has to follow the same spelling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { productionDemoConflict } from '../src/authz.js';

test('a capitalised production data mode still refuses a demo switch', () => {
  const local = productionDemoConflict({ DATA_MODE: 'Production', ATLAS_TENANT_ISOLATION: 'local-synthetic' });
  assert.equal(local && local.ok, false);
  assert.match(local.error, /local-synthetic/);

  const demo = productionDemoConflict({ DATA_MODE: 'PRODUCTION', ATLAS_DEV_IDENTITY: '1' });
  assert.equal(demo && demo.ok, false);
  assert.match(demo.error, /ATLAS_DEV_IDENTITY/);

  const tenant = productionDemoConflict({ DATA_MODE: 'Production', ATLAS_LOCAL_TENANT: '11111111-1111-4111-8111-111111111111' });
  assert.equal(tenant && tenant.ok, false);
  assert.match(tenant.error, /ATLAS_LOCAL_TENANT/);

  // A leading space is not production for the audit key, so this stays a local demo.
  assert.equal(productionDemoConflict({ DATA_MODE: ' production', ATLAS_TENANT_ISOLATION: 'local-synthetic' }), null);
  assert.equal(productionDemoConflict({ DATA_MODE: 'production', ATLAS_DEV_IDENTITY: '0' }), null);
  assert.equal(productionDemoConflict({ DATA_MODE: 'test', ATLAS_TENANT_ISOLATION: 'local-synthetic' }), null);
});
