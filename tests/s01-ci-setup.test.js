// Sweep 01 CI/setup/docs findings (E2–E9 and HAM-01).
// Copied from cursor/atlas-sweep01-red-tests 96712474b59d6b058ef00479f2bb2d4eb065801e.
// E1 is the Worker auth group. HAM-05 is the Entra bootstrap group.
// E7's shell footer and how-dialog are the UI group; this file checks the status paragraph only.
// They fail on main. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

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

test('E7 the status note matches the selected voice cap and does not quote the inherited total', () => {
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

function installSources() {
  const paths = ['.github/workflows/ci.yml', 'Makefile', 'constraints-tested.txt'];
  const scripts = join(root, 'scripts');
  if (existsSync(scripts)) {
    for (const name of readdirSync(scripts)) {
      if (name.endsWith('.sh') || name.endsWith('.py')) paths.push(join('scripts', name));
    }
  }
  return paths.filter(path => existsSync(join(root, path))).map(read);
}

test('HAM-01 every integration requirement is pinned and hashed, or the file is installed with --require-hashes', () => {
  const file = 'requirements-integrations.txt';
  const sources = installSources();
  const covered = sources.some(src => src.includes(file) && src.includes('--require-hashes'));
  if (covered) return;
  const packages = read(file).split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(line => line && !line.startsWith('-r ') && !line.startsWith('-c ') && !line.startsWith('--hash'));
  assert.ok(packages.length >= 1);
  for (const line of packages) {
    assert.match(line, /^[A-Za-z0-9_.-]+==[^\s]+/);
    assert.match(line, /--hash=sha256:[a-f0-9]{64}/);
  }
});
