// Group 12 shell half of sweep 01 E7.
// The handoff/CURRENT_STATUS.md half (the 375 count and the one-interview
// sentence) is group 15 and is not asserted here.
// C-3 is group 13. This file does not read src/voice-client.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('E7 the shell matches the selected voice', () => {
  const shell = read('src/shell.html');
  assert.equal(shell.includes('v11.0'), false);
  assert.match(shell, /[Kk]yutai/);
  assert.equal(/NVIDIA PersonaPlex or OpenAI Realtime/.test(shell), false);
});
