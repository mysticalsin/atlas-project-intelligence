// deploy.sh must refuse the committed placeholders and must deploy the operator's three values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'atlas-deploy-config-'));
  const edge = join(root, 'deploy', 'cloudflare-edge');
  const bin = join(root, 'bin');
  mkdirSync(join(edge, 'generated'), { recursive: true });
  mkdirSync(join(edge, 'src'), { recursive: true });
  mkdirSync(join(edge, 'test'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(new URL('../deploy.sh', import.meta.url), join(edge, 'deploy.sh'));
  chmodSync(join(edge, 'deploy.sh'), 0o755);
  writeFileSync(join(edge, 'wrangler.jsonc'), JSON.stringify({
    name: 'atlas',
    main: 'src/worker.js',
    vars: { ORIGIN: 'https://atlas.example.test', ACCESS_TEAM_DOMAIN: 'team.example.test', ACCESS_AUD: 'replace-me', TALKER_MODEL: 'talker' },
  }, null, 2));
  writeFileSync(join(root, 'build.py'), [
    'import os',
    'from pathlib import Path',
    'root = Path(__file__).resolve().parent',
    "home = os.environ.get('ATLAS_HOME_URL', '')",
    "text = 'canonical-page\\n' if not home else 'operator-page ' + home + '\\n'",
    "for name in ('ATLAS_Voice.html', 'ATLAS_Project_Intelligence.html', 'ATLAS_Intelligence.html', 'ATLAS_Voice_Studio.html'):",
    '    (root / name).write_text(text)',
    '',
  ].join('\n'));
  writeFileSync(join(edge, 'test', 'noop.test.js'), 'import test from "node:test"; test("noop", () => {});\n');
  const page = 'canonical-page\n';
  const pin = spawnSync('sha256sum', { input: page, encoding: 'utf8' }).stdout.split(/\s+/)[0];
  writeFileSync(join(edge, 'generated', 'PAGE_SHA256.txt'), `${pin}\n`);
  const mark = join(root, 'deployed.txt');
  const stage = join(root, 'stage.txt');
  writeFileSync(join(bin, 'npx'), `#!/bin/sh
printf '%s\\n' "$*" >> "${mark}"
case "$*" in
  *deploy*)
    prev=""
    cfg=""
    for arg in "$@"; do
      if [ "$prev" = "--config" ]; then cfg="$arg"; fi
      prev="$arg"
    done
    if [ -n "$cfg" ]; then cp "$cfg" "${mark}.config"; fi
    cp src/atlas.html "${mark}.page"
    ;;
  *'secret list'*) printf '%s\\n' CSRF_SECRET ;;
esac
exit 0
`);
  chmodSync(join(bin, 'npx'), 0o755);
  return { root, edge, bin, mark, stage };
}
function run(built, extra = {}) {
  const env = { ...process.env, PATH: `${built.bin}:${process.env.PATH}`, ATLAS_DEPLOY_STAGE_LOG: built.stage, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith('NODE_TEST') || key === 'NODE_CHANNEL_FD') delete env[key];
  return spawnSync('bash', ['deploy.sh'], { cwd: built.edge, env, encoding: 'utf8' });
}

test('deploy.sh refuses a missing or placeholder operator config before wrangler', () => {
  const missing = tree();
  const missed = run(missing);
  assert.equal(missed.status, 15, missed.stderr || missed.stdout);
  assert.equal(readFileSync(missing.stage, 'utf8').trim().split('\n').at(-1), 'config');
  assert.equal(existsSync(missing.mark), false);
  rmSync(missing.root, { recursive: true });

  const placeholder = tree();
  const held = run(placeholder, {
    ATLAS_ORIGIN: 'https://atlas.example.test',
    ATLAS_ACCESS_TEAM_DOMAIN: 'team.live.example',
    ATLAS_ACCESS_AUD: 'ab'.repeat(32),
  });
  assert.equal(held.status, 15, held.stderr || held.stdout);
  assert.equal(existsSync(placeholder.mark), false);
  rmSync(placeholder.root, { recursive: true });
});

test('deploy.sh deploys the operator values and leaves the pinned page in the repo root', () => {
  const built = tree();
  const aud = 'ab'.repeat(32);
  writeFileSync(join(built.edge, 'deploy.local.env'), `ATLAS_ORIGIN=https://from.file.example\nATLAS_ACCESS_TEAM_DOMAIN=team.live.example\nATLAS_ACCESS_AUD=${aud}\n`);
  const ran = run(built, { ATLAS_ORIGIN: 'https://from.env.example' });
  assert.equal(ran.status, 0, ran.stderr || ran.stdout);
  const calls = readFileSync(built.mark, 'utf8').trim().split('\n');
  assert.equal(calls.filter(line => line.includes('wrangler@4 deploy')).length, 1);
  assert.match(calls.find(line => line.includes('wrangler@4 deploy')), /--config /);
  const config = JSON.parse(readFileSync(`${built.mark}.config`, 'utf8'));
  assert.equal(config.vars.ORIGIN, 'https://from.env.example');
  assert.equal(config.vars.ACCESS_TEAM_DOMAIN, 'team.live.example');
  assert.equal(config.vars.ACCESS_AUD, aud);
  assert.equal(config.vars.TALKER_MODEL, 'talker');
  assert.equal(readFileSync(`${built.mark}.page`, 'utf8'), 'operator-page https://from.env.example\n');
  assert.equal(readFileSync(join(built.root, 'ATLAS_Voice.html'), 'utf8'), 'canonical-page\n');
  assert.equal(readFileSync(join(built.edge, 'src', 'atlas.html'), 'utf8'), 'canonical-page\n');
  assert.equal(existsSync(join(built.edge, 'deploy.local.env')), true);
  rmSync(built.root, { recursive: true });
});
