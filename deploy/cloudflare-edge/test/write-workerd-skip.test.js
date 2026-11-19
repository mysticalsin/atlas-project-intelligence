// A missing workerd install must be a skip, not a failed existsSync assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { locateWorkerd, SKIP_REASON } from './workerd-bin.js';

test('a missing workerd root is absent, with a skip reason that names the env var', () => {
  const found = locateWorkerd({ root: '/no/such/atlas-workerd' });
  assert.equal(found, null);
  assert.match(SKIP_REASON, /ATLAS_WORKERD_ROOT/);
});
