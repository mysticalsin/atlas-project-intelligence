// The default gate must not skip the geo suite. A missing Natural Earth folder is not a waiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function skippedCount(output) {
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.trim().match(/skipped\s+(\d+)\s*$/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function runGeo(reporter) {
  const env = { ...process.env };
  delete env.ATLAS_NE_SRC;
  delete env.PYTHONPATH;
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, 'tests/geo.test.js'], { encoding: 'utf8', env });
}

for (const reporter of ['tap', 'spec']) {
  test(`the geo suite skips nothing under the ${reporter} reporter`, () => {
    const result = runGeo(reporter);
    const output = String(result.stdout) + String(result.stderr);
    assert.equal(skippedCount(output), 0, output.slice(-500));
    assert.equal(result.status, 0, output.slice(-500));
  });
}

test('a spec report and a tap report both yield a skipped count', () => {
  assert.equal(skippedCount('# skipped 0\n# tests 1\n'), 0);
  assert.equal(skippedCount('ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ skipped 0\n'), 0);
});

test('the Natural Earth check is opt-in and outside the default gate', () => {
  const file = path.join(DIR, 'geo-ne-check.js');
  assert.equal(path.basename(file).endsWith('.test.js'), false);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /ATLAS_NE_SRC/);
  assert.match(text, /build_world_map\.py/);
  assert.match(text, /--check/);
  assert.match(text, /regeneration from the pinned sources is byte-identical to the committed asset/);
  const env = { ...process.env };
  delete env.ATLAS_NE_SRC;
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', env });
  assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
});
