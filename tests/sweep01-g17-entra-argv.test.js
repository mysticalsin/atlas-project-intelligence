// Sweep 01 group 17 (HAM-05, ARTEX-05). Static checks plus a local curl/python stub.
// Dummy values only. The stub records argv and never execs network curl. Nothing here
// calls Azure, Entra, or Cloudflare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'deploy/cloudflare-edge/entra/enable_entra.sh';
const TOKEN = 'cf-test-token';
const SECRET = 'entra-test-secret';
const REFUSAL = 'Refusing: the API token or client secret has a character this script will not write.';
const API_REFUSAL = 'Cloudflare refused the identity provider request.';

const read = (path) => readFileSync(join(root, path), 'utf8');
const strip = (text) => text.split(/\r?\n/).map(line => line.split('#')[0]).join('\n');
const scriptText = () => strip(read(SCRIPT));

function hamProblems(code) {
  const problems = [];
  const carried = new Set();
  for (const line of code.split('\n')) {
    const assign = line.match(/(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (assign && /\$\{?(?:CLOUDFLARE_API_TOKEN|ENTRA_CLIENT_SECRET)\}?/.test(assign[2])) carried.add(assign[1]);
    if (/CLOUDFLARE_API_TOKEN/.test(line) && /\bcurl\b|-H\b/.test(line)) problems.push('CLOUDFLARE_API_TOKEN is passed to curl as a header argument');
    if (/\b(echo|printf)\b/.test(line) && /\$\{?(?:CLOUDFLARE_API_TOKEN|ENTRA_CLIENT_SECRET)\}?/.test(line)) problems.push('a secret variable is echoed');
    if (/-H\b|--header\b/.test(line)) {
      for (const name of carried) {
        if (new RegExp('\\$\\{?' + name + '\\}?').test(line)) problems.push('a header variable carries a secret');
      }
    }
  }
  if (/--data\s+["']\$\{?idp\}?["']/.test(code) && /ENTRA_CLIENT_SECRET/.test(code)) problems.push('ENTRA_CLIENT_SECRET reaches curl through --data');
  if (!/--config\b/.test(code) && !/--data(?:-binary)?\s+["']?@-/.test(code)) problems.push('curl does not take the secrets from --config or stdin');
  return problems;
}

test('HAM-05 the Entra bootstrap script does not put the client secret or API token on curl argv', () => {
  const code = read(SCRIPT).split(/\r?\n/).map(line => line.split('#')[0]).join('\n');
  assert.deepEqual(hamProblems(code), []);
});

test('HAM-05 a header built in a variable and passed as -H "$cf_auth" is caught', () => {
  const mutant = [
    'cf_auth="Authorization: Bearer $CLOUDFLARE_API_TOKEN"',
    'curl -H "$cf_auth" --url https://example.invalid',
  ].join('\n');
  const problems = hamProblems(mutant);
  assert.equal(problems.includes('a header variable carries a secret'), true);
});

test('the bootstrap script keeps secrets off arguments and tracing off', () => {
  const code = scriptText();
  const problems = [];
  for (const line of code.split('\n')) {
    if (/CLOUDFLARE_API_TOKEN/.test(line) && /curl|-H\b|--header/.test(line)) problems.push('token shares a line with curl or a header flag');
    if (/\b(echo|printf)\b/.test(line) && /(?:CLOUDFLARE_API_TOKEN|ENTRA_CLIENT_SECRET)/.test(line)) problems.push('a secret name is echoed');
  }
  for (const match of code.matchAll(/--data(?:-binary|-raw)?\s+(\S+)/g)) {
    const arg = match[1];
    if (!arg.startsWith('@') && !arg.startsWith('"@') && !arg.startsWith("'@")) problems.push('curl data is not a file or stdin');
  }
  if (!/--config\b/.test(code) || !/--data-binary\s+@/.test(code)) problems.push('config and data-binary file are both required');
  if (/\bcurl\s+-v\b|--trace\b/.test(code)) problems.push('tracing is enabled');
  const quiet = code.indexOf('set +x');
  const expand = code.indexOf('${!');
  const restore = code.indexOf('set -x');
  if (!(quiet >= 0 && expand > quiet && restore > expand)) problems.push('secret expansion is not wrapped in set +x');
  if (/\berrors\b/.test(code)) problems.push('a response error body can be printed');
  if (!code.includes('--i-have-it-approval') || !code.includes('exit 2')) problems.push('approval gate missing');
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CF_ACCOUNT_ID', 'ACCESS_APP_ID', 'ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET']) {
    if (!code.includes(name)) problems.push('missing ' + name);
  }
  assert.deepEqual(problems, []);
});

test('the old argv invocation is deleted rather than commented', () => {
  const raw = read(SCRIPT);
  assert.equal(raw.includes('Bearer $CLOUDFLARE_API_TOKEN'), false);
  assert.equal(raw.includes('--data "$idp"'), false);
  assert.equal(raw.includes("--data '${idp}'"), false);
});

test('L1 secret files are opened with mode 0o600', () => {
  const code = scriptText();
  const opens = code.split('\n').filter(line => line.includes('os.open('));
  const flags = code.match(/os\.O_CREAT\s*\|\s*os\.O_WRONLY\s*\|\s*os\.O_EXCL,\s*0o600/g) || [];
  assert.ok(opens.length >= 1);
  assert.equal(flags.length, opens.length);
  for (const line of opens) assert.match(line, /0o600/);
});

test('L2 a token with a newline or a quote is refused before the curl config is written', () => {
  const code = scriptText();
  const openAt = code.indexOf('os.open(');
  assert.ok(openAt > 0);
  const before = code.slice(0, openAt);
  assert.match(before, /CLOUDFLARE_API_TOKEN/);
  assert.match(before, /ENTRA_CLIENT_SECRET/);
  assert.match(before, /accepted\(token\)/);
  assert.match(before, /accepted\(secret\)/);
  assert.match(before, /\\n/);
  assert.match(before, /\\"/);
  assert.match(before, /SystemExit|sys\.exit/);
});

test('L3 curl writes stdout and stderr to temp files', () => {
  const code = scriptText();
  const commands = code.split('\n').filter(line => /\bcurl\s/.test(line));
  assert.ok(commands.length >= 1);
  for (const line of commands) {
    assert.match(line, /--output\s+"\$dir\//);
    assert.match(line, /--stderr\s+"\$dir\//);
  }
  assert.doesNotMatch(code, /\b(cat|echo|printf)\b[^\n]*(post\.body|patch\.body|\.err)\b/);
});

test('L4 the EXIT trap is installed after mktemp', () => {
  const code = scriptText();
  const mk = code.indexOf('mktemp -d');
  const trap = code.search(/trap\s+'/);
  const curl = code.search(/\bcurl\s/);
  assert.ok(mk >= 0 && trap > mk && curl > trap);
  const line = code.slice(trap).split('\n')[0];
  assert.match(line, /\bEXIT\b/);
  assert.match(line, /\bINT\b/);
  assert.match(line, /\bTERM\b/);
  assert.match(line, /\bHUP\b/);
  assert.match(line, /\[ -n /);
  assert.match(line, /\[ -d /);
  assert.match(line, /rm -rf "\$dir"/);
});

test('I-4 the refused set names CR, TAB, backslash, and a dollar sign before the file is opened', () => {
  const code = scriptText();
  const fn = code.slice(code.indexOf('def accepted'), code.indexOf('os.open('));
  assert.ok(fn.length > 0);
  assert.match(fn, /\\r/);
  assert.match(fn, /\\t/);
  assert.match(fn, /\\\\/);
  assert.match(fn, /\$/);
});

function assertCodePointGuard(codePoint) {
  const code = scriptText();
  const fn = code.slice(code.indexOf('def accepted'), code.indexOf('os.open('));
  assert.match(fn, new RegExp('if ord\\(ch\\) == ' + codePoint + ':\\n\\s+return False'));
}

test('the hash guard is code point 35 before any secret file is opened', () => {
  assertCodePointGuard(35);
});

test('the backtick guard is code point 96 before any secret file is opened', () => {
  assertCodePointGuard(96);
});

test('the exclamation guard is code point 33 before any secret file is opened', () => {
  assertCodePointGuard(33);
});

test('curl disables curlrc first and refuses a non-https URL', () => {
  const commands = scriptText().split('\n').filter(line => /\bcurl\s/.test(line));
  assert.ok(commands.length >= 1);
  for (const line of commands) {
    assert.match(line, /\bcurl\s+-q\b/);
    assert.match(line, /--fail\b/);
    assert.match(line, /--proto '=https'/);
  }
});

test('the Entra README warns not to run the bootstrap under bash -x', () => {
  const readme = read('deploy/cloudflare-edge/entra/README.md');
  assert.match(readme, /bash -x/);
  assert.match(readme, /set -x/);
  assert.match(readme, /Do not run/);
});

function tool(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('missing local tool ' + name);
}

function runBootstrap(token, secret, body, options = {}) {
  const work = mkdtempSync(join(tmpdir(), 'atlas-g17-'));
  const bin = join(work, 'bin');
  const scratch = join(work, 'scratch');
  const argvLog = join(work, 'argv.log');
  const fileLog = join(work, 'files.log');
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(scratch, { mode: 0o700 });
  writeFileSync(argvLog, '', { mode: 0o600 });
  writeFileSync(fileLog, '', { mode: 0o600 });
  symlinkSync(tool('mktemp'), join(bin, 'mktemp'));
  symlinkSync(tool('rm'), join(bin, 'rm'));
  writeFileSync(join(bin, 'python3'), `#!/bin/bash
set -u
{
  printf '%s' python3
  for arg in "$@"; do
    printf '\\t%s' "$arg"
  done
  printf '\\n'
} >> "$ATLAS_ARGV_LOG"
set +e
/usr/bin/python3 "$@"
status=$?
if [ -n "\${TMPDIR:-}" ] && [ -d "$TMPDIR" ]; then
  /usr/bin/find "$TMPDIR" -type f -printf '%f %m\\n' >> "$ATLAS_FILE_LOG"
fi
exit "$status"
`, { mode: 0o700 });
  writeFileSync(join(bin, 'curl'), `#!/bin/bash
set -u
{
  printf '%s' curl
  for arg in "$@"; do
    printf '\\t%s' "$arg"
  done
  printf '\\n'
} >> "$ATLAS_ARGV_LOG"
output=
args=("$@")
i=0
while [ "$i" -lt "\${#args[@]}" ]; do
  if [ "\${args[$i]}" = "--output" ]; then
    i=$((i + 1))
    output=\${args[$i]}
  fi
  i=$((i + 1))
done
if [ -n "$output" ]; then
  printf '%s' "$ATLAS_CURL_BODY" > "$output"
else
  printf '%s' "$ATLAS_CURL_BODY"
fi
exit 0
`, { mode: 0o700 });
  chmodSync(join(bin, 'python3'), 0o700);
  chmodSync(join(bin, 'curl'), 0o700);
  try {
    const bashArgs = options.trace
      ? ['-x', join(root, SCRIPT), '--i-have-it-approval']
      : [join(root, SCRIPT), '--i-have-it-approval'];
    const result = spawnSync('/bin/bash', bashArgs, {
      cwd: work,
      encoding: 'utf8',
      timeout: 10000,
      killSignal: 'SIGKILL',
      env: {
        PATH: bin,
        HOME: work,
        TMPDIR: scratch,
        LANG: 'C',
        LC_ALL: 'C',
        ATLAS_ARGV_LOG: argvLog,
        ATLAS_FILE_LOG: fileLog,
        ATLAS_CURL_BODY: body,
        CLOUDFLARE_API_TOKEN: token,
        ENTRA_CLIENT_SECRET: secret,
        CF_ACCOUNT_ID: 'account-dummy',
        ACCESS_APP_ID: 'app-dummy',
        ENTRA_TENANT_ID: 'tenant-dummy',
        ENTRA_CLIENT_ID: 'client-dummy',
      },
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      argv: readFileSync(argvLog, 'utf8'),
      files: readFileSync(fileLog, 'utf8'),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function leaked(run, needles) {
  const text = run.argv + run.stdout + run.stderr;
  return needles.some(needle => needle && text.includes(needle));
}

function refusedCharacter(codePoint, marker) {
  const token = marker + String.fromCharCode(codePoint) + 'rest';
  const run = runBootstrap(token, SECRET, '{"success":true,"result":{"id":"idp-dummy"}}');
  assert.equal(leaked(run, [token, SECRET, marker]), false, 'dummy secret appeared in argv, stdout, or stderr');
  assert.equal(run.stderr.includes(REFUSAL), true, 'the script did not refuse the character');
  assert.equal(run.argv.includes('\ncurl\t') || run.argv.startsWith('curl\t'), false, 'curl ran');
  assert.equal(run.files.includes('curl.cfg'), false, 'curl config was written');
  assert.notEqual(run.status, 0, 'a bad token was accepted');
}

test('dummy secrets do not appear on argv, stdout, or stderr', () => {
  const run = runBootstrap(TOKEN, SECRET, '{"success":true,"result":{"id":"idp-dummy"}}');
  assert.equal(leaked(run, [TOKEN, SECRET]), false, 'dummy secret appeared in argv, stdout, or stderr');
  assert.equal(run.status, 0, 'bootstrap stub run failed');
  assert.equal(run.stdout.includes('Entra connector created: idp-dummy'), true);
  assert.equal(run.stdout.includes('ATLAS Access app now uses Entra ID.'), true);
  assert.equal(run.argv.includes('--config'), true);
  assert.equal(run.argv.includes('--output'), true);
  assert.equal(run.argv.includes('--stderr'), true);
  assert.equal(run.argv.includes('--data-binary'), true);
  assert.equal(run.files.includes('curl.cfg 600'), true);
  assert.equal(run.files.includes('idp.json 600'), true);
});

test('a newline or a quote in a dummy token is refused before curl runs', () => {
  const cases = [
    { token: 'newline-dummy-token\nrest', secret: SECRET },
    { token: TOKEN, secret: 'quote-dummy"secret' },
  ];
  for (const item of cases) {
    const run = runBootstrap(item.token, item.secret, '{"success":true,"result":{"id":"idp-dummy"}}');
    const marker = item.token.includes('\n') ? 'newline-dummy-token' : 'quote-dummy';
    assert.equal(leaked(run, [item.token, item.secret, marker]), false, 'dummy secret appeared in argv, stdout, or stderr');
    assert.equal(run.stderr.includes(REFUSAL), true, 'the script did not refuse the character');
    assert.equal(run.argv.includes('\ncurl\t') || run.argv.startsWith('curl\t'), false, 'curl ran');
    assert.equal(run.files.includes('curl.cfg'), false, 'curl config was written');
    assert.notEqual(run.status, 0, 'a bad token was accepted');
  }
});

test('bash -x does not print the dummy secrets', () => {
  const run = runBootstrap(TOKEN, SECRET, '{"success":true,"result":{"id":"idp-dummy"}}', { trace: true });
  assert.equal(run.stderr.includes(TOKEN) || run.stderr.includes(SECRET), false, 'dummy secret appeared in the bash -x trace');
  assert.equal(run.status, 0, 'traced bootstrap stub run failed');
});

test('CR, TAB, backslash, and shell metacharacters are refused before curl runs', () => {
  const cases = [
    { token: 'cr-dummy\rrest', secret: SECRET, marker: 'cr-dummy' },
    { token: 'tab-dummy\trest', secret: SECRET, marker: 'tab-dummy' },
    { token: 'bs-dummy\\rest', secret: SECRET, marker: 'bs-dummy' },
    { token: TOKEN, secret: 'dollar-dummy$rest', marker: 'dollar-dummy' },
    { token: TOKEN, secret: 'semi-dummy;rest', marker: 'semi-dummy' },
  ];
  for (const item of cases) {
    const run = runBootstrap(item.token, item.secret, '{"success":true,"result":{"id":"idp-dummy"}}');
    assert.equal(leaked(run, [item.token, item.secret, item.marker]), false, 'dummy secret appeared in argv, stdout, or stderr');
    assert.equal(run.stderr.includes(REFUSAL), true, 'the script did not refuse the character');
    assert.equal(run.argv.includes('\ncurl\t') || run.argv.startsWith('curl\t'), false, 'curl ran');
    assert.notEqual(run.status, 0, 'a bad token was accepted');
  }
});

test('a hash in a dummy token is refused before curl runs', () => {
  refusedCharacter(35, 'hash-dummy');
});

test('a backtick in a dummy token is refused before curl runs', () => {
  refusedCharacter(96, 'tick-dummy');
});

test('an exclamation mark in a dummy token is refused before curl runs', () => {
  refusedCharacter(33, 'bang-dummy');
});

test('tilde, plus, slash, and equals in a dummy token are still accepted', () => {
  const token = 'tilde~plus+slash/equals=';
  const run = runBootstrap(token, 'ok~+/=', '{"success":true,"result":{"id":"idp-dummy"}}');
  assert.equal(leaked(run, [token, 'ok~+/=']), false, 'dummy secret appeared in argv, stdout, or stderr');
  assert.equal(run.status, 0, 'an allowed character was refused');
});

test('a curl response that repeats a dummy secret is not printed', () => {
  const body = '{"success":false,"errors":[{"message":"' + SECRET + '"}]}';
  const run = runBootstrap(TOKEN, SECRET, body);
  assert.equal(leaked(run, [TOKEN, SECRET]), false, 'dummy secret appeared in argv, stdout, or stderr');
  assert.equal((run.stdout + run.stderr).includes(API_REFUSAL), true, 'fixed refusal was not printed');
  assert.equal(/\berrors\b/.test(run.stdout + run.stderr), false, 'curl response details were printed');
});
