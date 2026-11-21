// The deploy gate hashes the built page. A length check alone must not pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = path.join(root, 'deploy/cloudflare-edge/generated/PAGE_SHA256.txt');
const VOICE = path.join(root, 'ATLAS_Voice.html');
const ALIASES = ['ATLAS_Project_Intelligence.html', 'ATLAS_Intelligence.html', 'ATLAS_Voice_Studio.html', 'ATLAS_Voice.html'];

function assertPagePin(page, pinText) {
  const fields = String(pinText).trim().split(/\s+/);
  const actual = createHash('sha256').update(page).digest('hex');
  assert.equal(actual, fields[0]);
  assert.equal(String(page.length), fields[1]);
}

function flipNibble(pinText) {
  return pinText.replace(/[0-9a-fA-F]/, (ch) => (ch === '0' ? '1' : '0'));
}

function copyRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-pin-'));
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['archive', '--format=tar', 'HEAD'], { cwd: root });
    const tar = spawn('tar', ['-x', '-C', dir]);
    let err = '';
    git.stderr.on('data', (chunk) => { err += chunk; });
    tar.stderr.on('data', (chunk) => { err += chunk; });
    git.stdout.pipe(tar.stdin);
    git.on('error', reject);
    tar.on('error', reject);
    let gitCode = null;
    let tarCode = null;
    const finish = () => {
      if (gitCode === null || tarCode === null) return;
      if (gitCode !== 0 || tarCode !== 0) {
        reject(new Error('copy failed git=' + gitCode + ' tar=' + tarCode + ' ' + err));
        return;
      }
      cpSync(path.join(root, 'scripts/verify_page_build.sh'), path.join(dir, 'scripts/verify_page_build.sh'));
      cpSync(path.join(root, 'build.py'), path.join(dir, 'build.py'));
      resolve(dir);
    };
    git.on('close', (code) => { gitCode = code; finish(); });
    tar.on('close', (code) => { tarCode = code; finish(); });
  });
}

function verifyEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST') || key === 'NODE_CHANNEL_FD' || key === 'NODE_OPTIONS') delete env[key];
  }
  delete env.ATLAS_HOME_URL;
  delete env.ATLAS_DEPLOY_STUB;
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

function runVerify(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['scripts/verify_page_build.sh'], { cwd: dir, env: verifyEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('PAGE_SHA256.txt matches the full sha256 of ATLAS_Voice.html', () => {
  assertPagePin(readFileSync(VOICE), readFileSync(PIN, 'utf8'));
});

test('tracked page aliases match the same pin', () => {
  const pin = readFileSync(PIN, 'utf8');
  for (const name of ALIASES) assertPagePin(readFileSync(path.join(root, name)), pin);
  const listed = spawn('git', ['ls-files', '--error-unmatch', 'deploy/cloudflare-edge/src/atlas.html'], { cwd: root });
  return new Promise((resolve) => {
    listed.on('close', (code) => {
      if (code === 0) assertPagePin(readFileSync(path.join(root, 'deploy/cloudflare-edge/src/atlas.html')), pin);
      resolve();
    });
  });
});

test('a same-length content change does not match the pin', () => {
  const page = Buffer.from(readFileSync(VOICE));
  const pin = readFileSync(PIN, 'utf8');
  page[32] ^= 0x01;
  assert.equal(page.length, readFileSync(VOICE).length);
  assert.throws(() => assertPagePin(page, pin));
});

test('a one-nibble pin change does not match the page', () => {
  const pin = readFileSync(PIN, 'utf8');
  const flipped = flipNibble(pin);
  assert.notEqual(flipped.slice(0, 64), pin.slice(0, 64));
  assert.equal(flipped.length, pin.length);
  assert.throws(() => assertPagePin(readFileSync(VOICE), flipped));
});

test('verify_page_build.sh exits non-zero for a wrong pin and a tampered page', async () => {
  const wrong = await copyRepo();
  const moved = await copyRepo();
  const missing = await copyRepo();
  try {
    const pinPath = path.join(wrong, 'deploy/cloudflare-edge/generated/PAGE_SHA256.txt');
    writeFileSync(pinPath, flipNibble(readFileSync(pinPath, 'utf8')));
    const wrongRun = await runVerify(wrong);
    assert.notEqual(wrongRun.status, 0, wrongRun.stdout + wrongRun.stderr);

    const pagePath = path.join(moved, 'ATLAS_Voice.html');
    const page = readFileSync(pagePath);
    page[32] ^= 0x01;
    writeFileSync(pagePath, page);
    const tampered = await runVerify(moved);
    assert.notEqual(tampered.status, 0, tampered.stdout + tampered.stderr);

    writeFileSync(path.join(missing, 'build.py'), 'raise SystemExit(0)\n');
    rmSync(path.join(missing, 'ATLAS_Voice.html'));
    const gone = await runVerify(missing);
    assert.notEqual(gone.status, 0, gone.stdout + gone.stderr);
  } finally {
    rmSync(wrong, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test('verify_page_build.sh exits non-zero when the build writes the page somewhere else', async () => {
  const dir = await copyRepo();
  try {
    const buildPath = path.join(dir, 'build.py');
    const source = readFileSync(buildPath, 'utf8');
    const moved = source.replace("write_text(ROOT/'ATLAS_Voice.html', text)", "write_text(ROOT/'ATLAS_Voice.moved.html', text)");
    assert.notEqual(moved, source);
    writeFileSync(buildPath, moved);
    const run = await runVerify(dir);
    assert.notEqual(run.status, 0, run.stdout + run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
