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

const VOICES = ['Kyutai', 'PersonaPlex', 'OpenAI Realtime'];
const namedVoices = text => VOICES.filter(name => text.includes(name));

test('the page description names Kyutai', () => {
  const shell = read('src/shell.html');
  const meta = /<meta content="([^"]*)" name="description"\/>/.exec(shell);
  assert.ok(meta, 'meta description');
  assert.match(meta[1], /Kyutai/);
  assert.equal(/NVIDIA PersonaPlex/.test(meta[1]), false);
  const built = /<meta content="([^"]*)" name="description"\/>/.exec(read('ATLAS_Voice.html'));
  assert.ok(built, 'built meta description');
  assert.equal(built[1], meta[1]);
});

test('the how-dialog lead and the architecture diagram name the same voice engine', () => {
  const shell = read('src/shell.html');
  const lead = /id="howDialog"[\s\S]*?<p class="muted">([^<]*)<\/p>/.exec(shell);
  assert.ok(lead, 'how-dialog lead');
  assert.match(lead[1], /Kyutai, the selected speech route/);
  assert.match(lead[1], /PersonaPlex and OpenAI Realtime remain explicit alternatives/);
  assert.deepEqual(namedVoices(lead[1]), VOICES);
  const svg = read('docs/architecture.svg');
  assert.equal(svg.includes('Hosted Realtime OR PersonaPlex'), false);
  assert.match(svg, /Kyutai voice engine/);
  assert.match(svg, /PersonaPlex and OpenAI Realtime/);
  assert.deepEqual(namedVoices(svg), VOICES);
  const built = /id="architecture">([\s\S]*?)<\/div>/.exec(read('ATLAS_Voice.html'));
  assert.ok(built, 'built diagram');
  assert.equal(built[1].includes('Hosted Realtime OR PersonaPlex'), false);
  assert.match(built[1], /Kyutai voice engine/);
  assert.deepEqual(namedVoices(built[1]), namedVoices(lead[1]));
});
