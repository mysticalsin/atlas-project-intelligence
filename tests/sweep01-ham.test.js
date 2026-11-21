// Sweep 01 external review (HAM-01, HAM-05). Each test encodes the behaviour main should have.
// They fail on main. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

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

test('HAM-05 the Entra bootstrap script does not put the client secret or API token on curl argv', () => {
  const code = read('deploy/cloudflare-edge/entra/enable_entra.sh').split(/\r?\n/).map(line => line.split('#')[0]).join('\n');
  const problems = [];
  for (const line of code.split('\n')) {
    if (/CLOUDFLARE_API_TOKEN/.test(line) && /\bcurl\b|-H\b/.test(line)) problems.push('CLOUDFLARE_API_TOKEN is passed to curl as a header argument');
    if (/\b(echo|printf)\b/.test(line) && /\$\{?(?:CLOUDFLARE_API_TOKEN|ENTRA_CLIENT_SECRET)\}?/.test(line)) problems.push('a secret variable is echoed');
  }
  if (/--data\s+["']\$\{?idp\}?["']/.test(code) && /ENTRA_CLIENT_SECRET/.test(code)) problems.push('ENTRA_CLIENT_SECRET reaches curl through --data');
  if (!/--config\b/.test(code) && !/--data(?:-binary)?\s+["']?@-/.test(code)) problems.push('curl does not take the secrets from --config or stdin');
  assert.deepEqual(problems, []);
});
