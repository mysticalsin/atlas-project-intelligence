// The default gate must not skip the geo suite. A missing Natural Earth folder is not a waiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('the geo suite skips nothing in the default gate', () => {
  const env = { ...process.env };
  delete env.ATLAS_NE_SRC;
  delete env.PYTHONPATH;
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', 'tests/geo.test.js'], { encoding: 'utf8', env });
  const output = String(result.stdout) + String(result.stderr);
  const skipped = output.match(/^# skipped (\d+)/m);
  assert.ok(skipped, output.slice(-500));
  assert.equal(Number(skipped[1]), 0, output.slice(-500));
  assert.equal(result.status, 0, output.slice(-500));
});
