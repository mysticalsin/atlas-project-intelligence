// B1 (12): CI/CD supply-chain posture is pinned by a test, so a later edit cannot quietly loosen it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../../../', import.meta.url), read = p => readFileSync(new URL(p, root), 'utf8'), code = text => text.replace(/^\s*#.*$/gm, '').replace(/\s#\s.*$/gm, ''); // comments never count
const workflows = readdirSync(new URL('.github/workflows/', root)).filter(f => /\.ya?ml$/.test(f)).map(f => [f, code(read('.github/workflows/' + f))]);

test('every GitHub Action is pinned to a 40-character commit SHA (tag only in the comment)', () => {
  assert.ok(workflows.length >= 2);
  for (const [f, text] of workflows) {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(m => m[1]);
    assert.ok(uses.length > 0, f);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${u} is not SHA-pinned`);
  }
});

test('workflows use a read-only token, never pull_request_target, never persist checkout credentials, and keep the deploy manual, main-only and behind an environment', () => {
  for (const [f, text] of workflows) {
    assert.ok(!/pull_request_target/.test(text), f + ': pull_request_target');
    assert.ok(!/workflow_run/.test(text), f + ': workflow_run (privileged follow-on)');
    assert.match(text, /^permissions:\s*\n\s+contents: read\s*$/m, f + ': top-level read-only permissions');
    assert.ok(!/:\s*write\b/.test(text.replace(/#.*$/gm, '')), f + ': a write permission');
    assert.ok(!/permissions:\s*write-all/.test(text));
    for (const m of text.matchAll(/uses:\s*actions\/checkout@[^\n]*\n([^\n]*)/g)) assert.match(m[1], /persist-credentials:\s*false/, f + ': checkout must not persist credentials');
    assert.ok(!/\$\{\{\s*github\.event\.(issue|pull_request|comment|head_commit)\b/.test(text), f + ': untrusted event text in a run step');
  }
  const deploy = code(read('.github/workflows/deploy.yml'));
  assert.match(deploy, /on:\s*\n\s+workflow_dispatch:/); assert.ok(!/\n\s+(push|pull_request|schedule):/.test(deploy.split('jobs:')[0]));
  assert.match(deploy, /github\.ref == 'refs\/heads\/main'/); assert.match(deploy, /environment: production/);
  const ci = code(read('.github/workflows/ci.yml'));
  assert.ok(!/secrets\./.test(ci), 'the test workflow uses no secrets');
});

test('wrangler is pinned to an exact version and never floats (deploy.sh and the workflows)', () => {
  const sh = code(read('deploy/cloudflare-edge/deploy.sh'));
  assert.match(sh, /wrangler@\d+\.\d+\.\d+"/); assert.ok(!/wrangler@(latest|\d+)(?![.\d])/.test(sh), 'no floating wrangler tag');
  for (const [f, text] of workflows) assert.ok(!/wrangler@(latest|\d+)(?![.\d])/.test(text) && !/npm (i|install) .*wrangler(?!@\d+\.\d+\.\d+)/.test(text), f);
});

test('Dependabot watches the pinned actions', () => {
  assert.ok(existsSync(new URL('.github/dependabot.yml', root)));
  assert.match(read('.github/dependabot.yml'), /package-ecosystem: github-actions/);
});
