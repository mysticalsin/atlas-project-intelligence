import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCanonicalPage } from '../dev/page-guard.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

test('the local runner serves the edge page and rejects a stale root alias', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-page-'));
  const edge = join(dir, 'atlas.html'), root = join(dir, 'ATLAS_Voice.html');
  writeFileSync(edge, '<html>canonical</html>');
  assert.equal(readCanonicalPage(edge, join(dir, 'missing-root.html')), '<html>canonical</html>');
  writeFileSync(root, '<html>canonical</html>');
  assert.equal(readCanonicalPage(edge, root), '<html>canonical</html>');
  writeFileSync(root, '<html>stale</html>');
  assert.throws(() => readCanonicalPage(edge, root), /does not match/);
  rmSync(edge);
  assert.throws(() => readCanonicalPage(edge, root), /is missing/);
  rmSync(dir, { recursive: true });
});

test('verify_page_build.sh rejects a corrupted first snapshot at the cmp stage and removes its temp file', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atlas-verify-'));
  const stage = join(scratch, 'stage.txt');
  const run = spawnSync('bash', ['scripts/verify_page_build.sh'], {
    cwd: repoRoot,
    env: { ...process.env, TMPDIR: scratch, ATLAS_PAGE_STAGE_LOG: stage, ATLAS_PAGE_CORRUPT_FIRST: '1', ATLAS_HOME_URL: '', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 21, run.stderr || run.stdout);
  assert.match(run.stderr || '', /differ|cmp/i);
  assert.equal(readFileSync(stage, 'utf8').trim(), 'cmp-first');
  assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith('atlas-page.')), []);
  rmSync(scratch, { recursive: true });
});

test('verify_page_build.sh exits 130 on INT and 143 on TERM and removes its temp file', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const scratch = mkdtempSync(join(tmpdir(), 'atlas-signal-'));
    const child = spawn('bash', ['scripts/verify_page_build.sh'], {
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: scratch, ATLAS_PAGE_HOLD: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    const status = new Promise(resolve => child.on('exit', (exitCode, exitSignal) => resolve({ exitCode, exitSignal })));
    await new Promise(resolve => setTimeout(resolve, 200));
    child.kill(signal);
    const result = await status;
    assert.equal(result.exitCode, code, signal);
    assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith('atlas-page.')), []);
    rmSync(scratch, { recursive: true });
  }
});

test('build.py reads quality.py; capacity, identity, kyutai and speech are cascade runtime imports', () => {
  const read = name => readFileSync(join(repoRoot, name), 'utf8');
  const page = read('build.py');
  assert.match(page, /from atlas_voice\.quality import/);
  assert.doesNotMatch(page, /atlas_voice\.(capacity|identity|kyutai|speech)/);
  const edge = read('deploy/cloudflare-edge/build_edge.py');
  for (const name of ['quality', 'analyst', 'cascade', 'gaps', 'interview', 'report']) assert.match(edge, new RegExp(`from atlas_voice\\.${name} import`));
  const cascade = read('atlas_voice/cascade.py');
  for (const name of ['capacity', 'identity', 'kyutai', 'speech']) {
    assert.match(cascade, new RegExp(`from \\.${name} import`));
    assert.ok(readFileSync(join(repoRoot, 'atlas_voice', `${name}.py`), 'utf8').length > 0, name);
  }
  assert.match(read('atlas_voice/speech.py'), /from \.kyutai import/);
});

function deployEnv(extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST') || key === 'NODE_CHANNEL_FD' || key.startsWith('ATLAS_DEPLOY_STUB') || key === 'ATLAS_DEPLOY_STAGE_LOG') delete env[key];
  }
  Object.assign(env, extra);
  for (const key of Object.keys(env)) if (key.startsWith('ATLAS_DEPLOY_STUB')) delete env[key];
  return env;
}
function deployTree() {
  const root = mkdtempSync(join(tmpdir(), 'atlas-deploy-'));
  const edge = join(root, 'deploy', 'cloudflare-edge');
  const bin = join(root, 'bin');
  mkdirSync(join(edge, 'generated'), { recursive: true });
  mkdirSync(join(edge, 'src'), { recursive: true });
  mkdirSync(join(edge, 'test'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(new URL('../deploy.sh', import.meta.url), join(edge, 'deploy.sh'));
  chmodSync(join(edge, 'deploy.sh'), 0o755);
  const mark = join(root, 'deployed.txt');
  const stage = join(root, 'stage.txt');
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${mark}"\ncase "$*" in\n  *'secret list'*) printf '%s\\n' CSRF_SECRET ;;\nesac\nexit 0\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  return { root, edge, bin, mark, stage };
}

test('deploy.sh leaves a stale page in place when the build fails and does not deploy', () => {
  const tree = deployTree();
  const stale = join(tree.edge, 'src', 'atlas.html');
  writeFileSync(stale, 'stale-page-fixture\n');
  writeFileSync(join(tree.edge, 'generated', 'PAGE_SHA256.txt'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  writeFileSync(join(tree.root, 'build.py'), 'raise SystemExit("build failed")\n');
  const failed = spawnSync('bash', ['deploy.sh'], { cwd: tree.edge, env: deployEnv({ PATH: `${tree.bin}:${process.env.PATH}`, ATLAS_DEPLOY_STAGE_LOG: tree.stage }), encoding: 'utf8' });
  assert.equal(failed.status, 11, failed.stderr || failed.stdout);
  assert.equal(readFileSync(tree.stage, 'utf8').trim(), 'build');
  assert.equal(readFileSync(stale, 'utf8'), 'stale-page-fixture\n');
  assert.equal(existsSync(tree.mark), false);
  rmSync(tree.root, { recursive: true });
});

test('deploy.sh hashes the page after the tests and refuses a page mutated during that phase', () => {
  const tree = deployTree();
  const page = 'canonical-page\n';
  const pin = spawnSync('sha256sum', { input: page, encoding: 'utf8' }).stdout.split(/\s+/)[0];
  writeFileSync(join(tree.edge, 'generated', 'PAGE_SHA256.txt'), `${pin}\n`);
  writeFileSync(join(tree.edge, 'src', 'atlas.html'), 'stale-before-build\n');
  writeFileSync(join(tree.root, 'build.py'), 'from pathlib import Path\nPath(__file__).resolve().parent.joinpath("ATLAS_Voice.html").write_bytes(b"canonical-page\\n")\n');
  writeFileSync(join(tree.edge, 'test', 'mutate.test.js'), 'import { writeFileSync } from "node:fs"; import test from "node:test"; test("mutate", () => { writeFileSync(new URL("../src/atlas.html", import.meta.url), "mutated-during-test\\n"); });\n');
  const mutated = spawnSync('bash', ['deploy.sh'], { cwd: tree.edge, env: deployEnv({ PATH: `${tree.bin}:${process.env.PATH}`, ATLAS_DEPLOY_STAGE_LOG: tree.stage }), encoding: 'utf8' });
  assert.equal(mutated.status, 14, mutated.stderr || mutated.stdout);
  assert.equal(readFileSync(tree.stage, 'utf8').trim().split('\n').at(-1), 'hash');
  assert.equal(readFileSync(join(tree.edge, 'src', 'atlas.html'), 'utf8'), 'mutated-during-test\n');
  assert.equal(existsSync(tree.mark), false);
  rmSync(tree.root, { recursive: true });
});

test('deploy.sh calls the stub exactly once after a valid build, tests, and final hash', () => {
  const tree = deployTree();
  const page = 'canonical-page\n';
  const pin = spawnSync('sha256sum', { input: page, encoding: 'utf8' }).stdout.split(/\s+/)[0];
  writeFileSync(join(tree.edge, 'generated', 'PAGE_SHA256.txt'), `${pin}\n`);
  writeFileSync(join(tree.root, 'build.py'), 'from pathlib import Path\nPath(__file__).resolve().parent.joinpath("ATLAS_Voice.html").write_bytes(b"canonical-page\\n")\n');
  writeFileSync(join(tree.edge, 'test', 'noop.test.js'), 'import test from "node:test"; test("noop", () => {});\n');
  const ok = spawnSync('bash', ['deploy.sh'], {
    cwd: tree.edge,
    env: deployEnv({ PATH: `${tree.bin}:${process.env.PATH}`, ATLAS_DEPLOY_STAGE_LOG: tree.stage }),
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  const calls = readFileSync(tree.mark, 'utf8').trim().split('\n');
  assert.deepEqual(calls.filter(line => line.includes('wrangler@4 deploy')), ['--yes wrangler@4 deploy']);
  assert.deepEqual(calls.filter(line => line.includes('secret list')), ['--yes wrangler@4 secret list']);
  assert.equal(calls.filter(line => line.includes('secret put')).length, 0);
  assert.equal(readFileSync(tree.stage, 'utf8').trim().split('\n').filter(line => line === 'deploy').length, 1);
  assert.equal(readFileSync(join(tree.edge, 'src', 'atlas.html'), 'utf8'), page);
  rmSync(tree.root, { recursive: true });
});

const STUB_ENV_KEYS = ['ATLAS_DEPLOY_STUB', 'ATLAS_DEPLOY_STUB_LOG', 'ATLAS_DEPLOY_STUB_SENTINEL', 'ATLAS_DEPLOY_STAGE_LOG'];

function withStubLeak(leak, run) {
  const previous = Object.fromEntries(STUB_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(leak)) process.env[key] = value;
  try {
    return run();
  } finally {
    for (const key of STUB_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('deployEnv drops inherited ATLAS_DEPLOY_STUB variables and a parent stage log', () => {
  withStubLeak({
    ATLAS_DEPLOY_STUB: '1',
    ATLAS_DEPLOY_STUB_LOG: '/tmp/atlas-parent-stub-log',
    ATLAS_DEPLOY_STUB_SENTINEL: 'leak',
    ATLAS_DEPLOY_STAGE_LOG: '/tmp/atlas-parent-stage-log',
  }, () => {
    const childStage = '/tmp/atlas-child-stage-log';
    const env = deployEnv({
      PATH: '/usr/bin',
      ATLAS_DEPLOY_STAGE_LOG: childStage,
      ATLAS_DEPLOY_STUB: '1',
      ATLAS_DEPLOY_STUB_LOG: '/tmp/atlas-extra-stub-log',
    });
    assert.equal(env.ATLAS_DEPLOY_STUB, undefined);
    assert.equal(env.ATLAS_DEPLOY_STUB_LOG, undefined);
    assert.equal(env.ATLAS_DEPLOY_STUB_SENTINEL, undefined);
    assert.equal(env.ATLAS_DEPLOY_STAGE_LOG, childStage);
    assert.equal(env.PATH, '/usr/bin');
    const bare = deployEnv({ PATH: '/usr/bin' });
    assert.equal(bare.ATLAS_DEPLOY_STUB, undefined);
    assert.equal(bare.ATLAS_DEPLOY_STUB_LOG, undefined);
    assert.equal(bare.ATLAS_DEPLOY_STUB_SENTINEL, undefined);
    assert.equal(bare.ATLAS_DEPLOY_STAGE_LOG, undefined);
  });
});

test('deploy.sh still reaches wrangler when the parent has ATLAS_DEPLOY_STUB=1', () => {
  const tree = deployTree();
  const leakedStub = join(tree.root, 'parent-stub.txt');
  const parentStage = join(tree.root, 'parent-stage.txt');
  writeFileSync(parentStage, 'parent\n');
  const page = 'canonical-page\n';
  const pin = spawnSync('sha256sum', { input: page, encoding: 'utf8' }).stdout.split(/\s+/)[0];
  writeFileSync(join(tree.edge, 'generated', 'PAGE_SHA256.txt'), `${pin}\n`);
  writeFileSync(join(tree.root, 'build.py'), 'from pathlib import Path\nPath(__file__).resolve().parent.joinpath("ATLAS_Voice.html").write_bytes(b"canonical-page\\n")\n');
  writeFileSync(join(tree.edge, 'test', 'noop.test.js'), 'import test from "node:test"; test("noop", () => {});\n');
  try {
    const ok = withStubLeak({
      ATLAS_DEPLOY_STUB: '1',
      ATLAS_DEPLOY_STUB_LOG: leakedStub,
      ATLAS_DEPLOY_STUB_SENTINEL: 'leak',
      ATLAS_DEPLOY_STAGE_LOG: parentStage,
    }, () => spawnSync('bash', ['deploy.sh'], {
      cwd: tree.edge,
      env: deployEnv({
        PATH: `${tree.bin}:${process.env.PATH}`,
        ATLAS_DEPLOY_STAGE_LOG: tree.stage,
        ATLAS_DEPLOY_STUB: '1',
        ATLAS_DEPLOY_STUB_LOG: leakedStub,
      }),
      encoding: 'utf8',
    }));
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.equal(existsSync(leakedStub), false);
    const calls = readFileSync(tree.mark, 'utf8').trim().split('\n');
    assert.deepEqual(calls.filter(line => line.includes('wrangler@4 deploy')), ['--yes wrangler@4 deploy']);
    assert.deepEqual(calls.filter(line => line.includes('secret list')), ['--yes wrangler@4 secret list']);
    assert.equal(readFileSync(parentStage, 'utf8'), 'parent\n');
    assert.equal(readFileSync(tree.stage, 'utf8').trim().split('\n').filter(line => line === 'deploy').length, 1);
  } finally {
    rmSync(tree.root, { recursive: true });
  }
});

test('verify_page_build.sh rejects a corrupted edge copy at the second comparison', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atlas-edge-'));
  const stage = join(scratch, 'stage.txt');
  const run = spawnSync('bash', ['scripts/verify_page_build.sh'], {
    cwd: repoRoot,
    env: { ...process.env, TMPDIR: scratch, ATLAS_PAGE_STAGE_LOG: stage, ATLAS_PAGE_CORRUPT_EDGE: '1', ATLAS_HOME_URL: '', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 22, run.stderr || run.stdout);
  assert.match(`${run.stdout}\n${run.stderr}`, /cmp-edge/);
  assert.equal(readFileSync(stage, 'utf8').trim(), 'cmp-edge');
  copyFileSync(join(repoRoot, 'ATLAS_Voice.html'), join(repoRoot, 'deploy/cloudflare-edge/src/atlas.html'));
  rmSync(scratch, { recursive: true });
});
