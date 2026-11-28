// The local runner must stop when the edge page and the root alias differ.
// A text compare turns different invalid bytes into the same character.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCanonicalPage } from '../dev/page-guard.mjs';

test('different page bytes are not treated as the same page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-page-bytes-'));
  const edge = join(dir, 'atlas.html');
  const root = join(dir, 'ATLAS_Voice.html');
  try {
    writeFileSync(edge, Buffer.from([0xff]));
    writeFileSync(root, Buffer.from([0xfe]));
    assert.throws(() => readCanonicalPage(edge, root), /does not match/);
    writeFileSync(root, Buffer.from([0xff]));
    assert.equal(readCanonicalPage(edge, root), '\uFFFD');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
