// Sweep 01 setup findings. Each test encodes the behaviour main should have.
// They fail on main. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('E1 every rollback switch named in the runbook is read by product code', () => {
  const runbook = read('handoff/SECURITY_RUNBOOK.md');
  const line = runbook.split('\n').find(row => /rollback switches/.test(row)) || '';
  const names = [...line.matchAll(/ATLAS_[A-Z0-9_]+/g)].map(match => match[0]);
  assert.ok(names.length >= 1);
  const skip = new Set(['kill-switches.js', 'security-log.js']);
  const roots = ['deploy/cloudflare-edge/src', 'atlas_voice', 'src'];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|py)$/.test(entry.name) && !skip.has(entry.name)) files.push(rel);
    }
  };
  for (const dir of roots) walk(dir);
  const reads = (name) => files.some(file => new RegExp('(?:env\\??\\.|environ(?:\\[[\'"]|\\.get\\([\'"])|process\\.env\\.)' + name).test(read(file)) || new RegExp("['\"]" + name + "['\"]").test(read(file)) && /os\.environ|process\.env|env\??\./.test(read(file)));
  for (const name of names) assert.equal(reads(name), true, name);
  if (/ATLAS_CSRF_BIND/.test(runbook) && /CONFIGURATION\.md/.test(runbook)) {
    assert.match(read('handoff/CONFIGURATION.md'), /ATLAS_CSRF_BIND/);
  }
});

test('E2 continuous integration and the UI target run every browser suite on disk', () => {
  const disk = readdirSync(join(root, 'tests')).filter(name => name.endsWith('_browser.py')).map(name => name.slice(0, -'_browser.py'.length));
  const ci = /for t in ([^\n]+)/.exec(read('.github/workflows/ci.yml'));
  assert.ok(ci, 'browser loop');
  const listed = ci[1].trim().split(/\s+/);
  const ui = read('Makefile').split('test-ui:')[1].split('\n\n')[0];
  for (const name of disk) {
    assert.ok(listed.includes(name), name);
    assert.ok(ui.includes(name + '_browser.py'), name);
  }
});

test('E3 a missing workerd binary fails the tail tests when CI is set', () => {
  const result = spawnSync(process.execPath, ['--test', 'test/write-sql-tail.test.js'], {
    cwd: join(root, 'deploy/cloudflare-edge'),
    env: { ...process.env, CI: '1', ATLAS_WORKERD_ROOT: '', ATLAS_WORKERD_BIN: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
});

test('E4 documented setup commands use this repository and python3', () => {
  const readme = read('README.md');
  for (const match of readme.matchAll(/^cd\s+(\S+)/gm)) assert.equal(existsSync(join(root, match[1])), true, match[1]);
  const commands = [readme, read('handoff/CONFIGURATION.md')].join('\n').split('\n');
  const bare = commands.filter(line => /^\s*python\s/.test(line));
  assert.deepEqual(bare, []);
});

test('E5 a missing Natural Earth source fails the basemap check', () => {
  const result = spawnSync(process.execPath, ['tests/geo-ne-check.js'], {
    cwd: root,
    env: { ...process.env, ATLAS_NE_SRC: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
});

test('E6 local voice scripts do not bake an account id, and the voice error names the configured model', () => {
  for (const path of ['scripts/run_local_voice.sh', 'scripts/check_workers_speech.py', 'scripts/runpod_bakeoff.sh']) {
    const text = read(path);
    const baked = /WORKERS_AI_ACCOUNT:-([0-9a-f]{32})/.test(text);
    assert.equal(baked, false, path);
  }
  assert.equal(/aura-1 speakers/.test(read('atlas_voice/config.py')), false);
});

test('E6 the operator docs name the Workers voice settings', () => {
  const docs = read('.env.example') + '\n' + read('handoff/CONFIGURATION.md');
  for (const name of ['WORKERS_AI_ACCOUNT', 'WORKERS_TTS_VOICE', 'ATLAS_SPEAKING_SECONDS', 'ENTRA_ADMIN_ROLE']) {
    assert.equal(docs.includes(name), true, name);
  }
});

test('E7 the shell and the status note match the selected voice and the rerun count', () => {
  const shell = read('src/shell.html');
  assert.equal(shell.includes('v11.0'), false);
  assert.match(shell, /[Kk]yutai/);
  assert.equal(/NVIDIA PersonaPlex or OpenAI Realtime/.test(shell), false);
  const status = read('handoff/CURRENT_STATUS.md');
  assert.equal(/375 in total/.test(status), false);
  const line = status.split('\n').find(row => /one interview/i.test(row)) || '';
  assert.match(line, /PersonaPlex|personaplex/);
  assert.equal(/either route/.test(line), false);
});

test('E8 the integration lock covers every direct dependency, and CI installs only those the tests import', () => {
  const install = read('.github/workflows/ci.yml').split('\n').filter(line => line.includes('pip install')).join('\n');
  assert.equal(/\bpyjwt\b/i.test(install), false);
  assert.equal(/\bcryptography\b/i.test(install), false);
  assert.match(read('constraints-tested.txt'), /^msgpack==/m);
});

test('E9 the Teams client bundle is checked without a deploy', () => {
  assert.equal(/has not been run/.test(read('deploy/cloudflare-edge/README.md')), false);
  const harness = read('Makefile') + '\n' + read('.github/workflows/ci.yml');
  assert.match(harness, /teams-js|wrangler[^\n]*dry-run|bundle/);
});
