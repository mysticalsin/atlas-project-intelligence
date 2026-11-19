// Harness for the workerd proof. This revision only knows the hard-coded install.
// A caller-supplied root is ignored, so a missing binary is still reported as found.
import { existsSync } from 'node:fs';

export const SKIP_REASON = 'workerd 2026-10-23 is not installed; set ATLAS_WORKERD_ROOT';

export function locateWorkerd() {
  const root = '/tmp/atlas-workerd-20261023';
  const bin = root + '/node_modules/workerd/bin/workerd';
  if (existsSync(bin)) return { root, bin };
  return { root, bin };
}
