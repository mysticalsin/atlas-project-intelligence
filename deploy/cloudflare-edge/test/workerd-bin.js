// Finds the workerd 2026-10-23 binary for the tail proof.
// An explicit root, ATLAS_WORKERD_BIN, or ATLAS_WORKERD_ROOT wins.
// Outside CI, the local proof install is the last candidate.
// A missing binary is null. Outside CI the caller skips. When CI is set,
// skipWithoutWorkerd throws: a missing required binary is not a passing skip.
import { existsSync } from 'node:fs';

export const SKIP_REASON = 'workerd 2026-10-23 is not installed; set ATLAS_WORKERD_ROOT';

const BIN_SUFFIX = '/node_modules/workerd/bin/workerd';

function fromRoot(root) {
  if (!root) return null;
  const cleaned = String(root).replace(/\/$/, '');
  const bin = cleaned + BIN_SUFFIX;
  return existsSync(bin) ? { root: cleaned, bin } : null;
}

export function locateWorkerd(options = {}) {
  if (Object.hasOwn(options, 'root')) return fromRoot(options.root);
  if (process.env.ATLAS_WORKERD_BIN) {
    const bin = process.env.ATLAS_WORKERD_BIN;
    if (!existsSync(bin) || !bin.endsWith(BIN_SUFFIX)) return null;
    return { root: bin.slice(0, -BIN_SUFFIX.length), bin };
  }
  if (process.env.ATLAS_WORKERD_ROOT) return fromRoot(process.env.ATLAS_WORKERD_ROOT);
  if (process.env.CI) return null;
  return fromRoot('/tmp/atlas-workerd-20261023');
}

export function skipWithoutWorkerd(t, reason) {
  if (process.env.CI) throw new Error(reason);
  t.skip(reason);
}
