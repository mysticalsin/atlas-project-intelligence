// Sweep 01 CI/setup/docs findings (E2–E9 and HAM-01).
// Copied from cursor/atlas-sweep01-red-tests 96712474b59d6b058ef00479f2bb2d4eb065801e.
// E1 is the Worker auth group. HAM-05 is the Entra bootstrap group.
// E7's shell footer and how-dialog are the UI group; this file checks the status paragraph only.
// They fail on main. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
  const env = { ...process.env, CI: '1', ATLAS_WORKERD_ROOT: '', ATLAS_WORKERD_BIN: '' };
  // A nested `node --test` inherits the parent runner channel and reports exit 0.
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_TEST_CONTEXT;
  const files = ['write-sql-tail', 'write-trigger-tail', 'write-consent-trigger', 'write-fallback-read'];
  for (const name of files) {
    const result = spawnSync(process.execPath, ['--test', `test/${name}.test.js`], {
      cwd: join(root, 'deploy/cloudflare-edge'),
      env,
      encoding: 'utf8',
    });
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, name);
    assert.equal(/# SKIP/.test(out), false, out);
    assert.match(out, /^# skipped 0$/m, name);
  }
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

function activeLines(name) {
  return read(name).split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean);
}

test('ARTEX-01 CI installs the integrations lock with --require-hashes for the workflow Python', () => {
  const ci = read('.github/workflows/ci.yml');
  const version = /python-version:\s*['"]?(\d+\.\d+)/.exec(ci);
  assert.ok(version, 'workflow Python');
  assert.match(ci, /pip install --require-hashes -r requirements-integrations\.lock/);
  const header = read('requirements-integrations.lock').split('\n').slice(0, 15).join('\n');
  assert.match(header, new RegExp('Python ' + version[1].replace('.', '\\.')));
});

test('L-1 CI installs a Python 3.13 hash lock for msgpack, playwright, and python-docx', () => {
  const ci = read('.github/workflows/ci.yml');
  const version = /python-version:\s*['"]?(\d+\.\d+)/.exec(ci);
  assert.ok(version, 'workflow Python');
  assert.equal(version[1], '3.13');
  assert.match(ci, /pip install --require-hashes -r requirements-ci\.lock/);
  assert.equal(/pip install -r requirements\.txt/.test(ci), false);
  assert.equal(existsSync(join(root, 'requirements-ci.lock')), true);
  const text = read('requirements-ci.lock');
  assert.match(text.split('\n').slice(0, 15).join('\n'), /Python 3\.13/);
  for (const name of ['msgpack==', 'playwright==', 'python-docx==']) {
    assert.match(text, new RegExp('^' + name, 'm'), name);
  }
});

function pins(path) {
  const out = new Map();
  for (const line of read(path).split('\n')) {
    const match = /^([A-Za-z0-9_.-]+)==([^\s\\]+)/.exec(line);
    if (match) out.set(match[1], match[2]);
  }
  return out;
}

test('HAM-01 requirements.txt and every requirements-*.txt with third-party packages is exact-pinned and hashed', () => {
  const names = readdirSync(root).filter(name => name === 'requirements.txt' || /^requirements-.*\.txt$/.test(name)).sort();
  for (const required of ['requirements.txt', 'requirements-entra.txt', 'requirements-hindsight.txt', 'requirements-riva.txt', 'requirements-integrations.txt', 'requirements-test.txt']) {
    assert.ok(names.includes(required), required);
  }
  for (const name of names) {
    const lines = activeLines(name);
    const packages = lines.filter(line => !line.startsWith('-r ') && !line.startsWith('-c ') && !line.startsWith('--'));
    if (packages.length === 0) {
      assert.ok(lines.some(line => /^-r requirements-.+\.lock$/.test(line)), name);
      continue;
    }
    for (const line of packages) {
      assert.match(line, /^[A-Za-z0-9_.-]+==[^\s]+/, `${name}: ${line}`);
      assert.match(line, /--hash=sha256:[a-f0-9]{64}/, `${name}: ${line}`);
    }
  }
});

test('requirements-ci.lock names a compile input that exists', () => {
  const header = read('requirements-ci.lock').split('\n').slice(0, 12).join('\n');
  const names = [...header.matchAll(/\b(requirements[\w.-]*\.in)\b/g)].map(match => match[1]);
  assert.ok(names.length >= 1, header);
  for (const name of new Set(names)) assert.equal(existsSync(join(root, name)), true, name);
});

test('requirements-ci.lock pins playwright and greenlet', () => {
  const text = read('requirements-ci.lock');
  assert.match(text, /^playwright==/m);
  assert.match(text, /^greenlet==/m);
});

test('a package pinned in both locks has the same version in both', () => {
  const ci = pins('requirements-ci.lock');
  const integrations = pins('requirements-integrations.lock');
  let shared = 0;
  for (const [name, version] of ci) {
    if (!integrations.has(name)) continue;
    shared += 1;
    assert.equal(integrations.get(name), version, name);
  }
  assert.ok(shared >= 1);
});

test('setup docs do not pip install the unhashed requirements.txt', () => {
  const files = ['README.md', 'handoff/CONFIGURATION.md', 'deploy/cloudflare/README.md'];
  for (const name of readdirSync(join(root, 'docs'))) {
    if (name.endsWith('.md')) files.push(join('docs', name));
  }
  for (const file of files) assert.equal(/pip install -r requirements\.txt/.test(read(file)), false, file);
});

test('CI installs the locked workerd, runs the tail, and still fails when the binary is missing', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm ci/);
  assert.match(ci, /ATLAS_WORKERD_ROOT/);
  const edge = join(root, 'deploy/cloudflare-edge');
  const lockPath = join(edge, 'package-lock.json');
  assert.equal(existsSync(lockPath), true);
  const lock = read('deploy/cloudflare-edge/package-lock.json');
  assert.match(lock, /node_modules\/workerd/);
  assert.match(lock, /sha512-[A-Za-z0-9+/]+=/);
  const bin = join(edge, 'node_modules/workerd/bin/workerd');
  assert.equal(existsSync(bin), true);
  function runTail(env) {
    delete env.NODE_CHANNEL_FD;
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--test', 'test/write-sql-tail.test.js'], {
      cwd: edge,
      env,
      encoding: 'utf8',
      timeout: 180000,
    });
  }
  const missing = runTail({ ...process.env, CI: '1', ATLAS_WORKERD_ROOT: '/no/such/atlas-workerd', ATLAS_WORKERD_BIN: '' });
  assert.notEqual(missing.status, 0);
  const present = runTail({ ...process.env, CI: '1', ATLAS_WORKERD_ROOT: edge, ATLAS_WORKERD_BIN: '' });
  assert.equal(present.status, 0, present.stdout + present.stderr);
});

test('make build writes the gitignored edge page a fresh tree does not have', () => {
  const dest = mkdtempSync(join(tmpdir(), 'atlas-fresh-'));
  const archive = join(dest, 'src.tar');
  const archived = spawnSync('git', ['archive', '--format=tar', '-o', archive, 'HEAD'], { cwd: root });
  assert.equal(archived.status, 0, archived.stderr);
  const clone = join(dest, 'clone');
  mkdirSync(clone);
  assert.equal(spawnSync('tar', ['-xf', archive, '-C', clone]).status, 0);
  copyFileSync(join(root, 'Makefile'), join(clone, 'Makefile'));
  copyFileSync(join(root, 'build.py'), join(clone, 'build.py'));
  const page = join(clone, 'deploy/cloudflare-edge/src/atlas.html');
  assert.equal(existsSync(page), false);
  assert.match(read('Makefile'), /^test-ui:.*\bbuild\b/m);
  const built = spawnSync('make', ['build'], { cwd: clone, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.equal(existsSync(page), true);
  assert.equal(readFileSync(page), readFileSync(join(clone, 'ATLAS_Voice.html')));
});

test('setup docs name the Ubuntu python3.12-venv package', () => {
  for (const file of ['README.md', 'handoff/CONFIGURATION.md']) {
    assert.match(read(file), /python3\.12-venv/, file);
  }
});

test('library browser fails clearly when node is not on PATH', () => {
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  const env = { ...process.env, PATH: '/tmp', ATLAS_NODE: '' };
  const result = spawnSync(python.stdout.trim(), ['tests/library_browser.py'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
  const out = result.stdout + result.stderr;
  assert.notEqual(result.status, 0);
  assert.equal(result.error, undefined);
  assert.match(out, /ATLAS_NODE/);
  assert.equal(/Traceback/.test(out), false, out);
});

test('jev rating exits non-zero in CI when the contract mock is missing', () => {
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  const env = { ...process.env, CI: '1', JEV_BROWSER_MOCK: '' };
  const result = spawnSync(python.stdout.trim(), ['tests/jev_rating_browser.py'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  const out = result.stdout + result.stderr;
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.notEqual(result.status, 0);
  assert.match(out, /JEV_BROWSER_MOCK/);
  assert.equal(/INFO 14 skipped/.test(out), false, out);
});
