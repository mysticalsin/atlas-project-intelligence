// The deploy gate hashes the built page. This test is that comparison inside the app suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('PAGE_SHA256.txt matches the built ATLAS_Voice.html', () => {
  const page = readFileSync(path.join(root, 'ATLAS_Voice.html'));
  const fields = readFileSync(path.join(root, 'deploy/cloudflare-edge/generated/PAGE_SHA256.txt'), 'utf8').trim().split(/\s+/);
  const actual = createHash('sha256').update(page).digest('hex');
  assert.equal(actual, fields[0]);
  assert.equal(String(page.length), fields[1]);
});
