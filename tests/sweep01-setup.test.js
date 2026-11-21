// Sweep 01 group 13. E1 only. The other setup checks belong to group 15 and are not copied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
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
  // The flag_state paragraph still names ATLAS_CSRF_BIND and the runbook still points at
  // CONFIGURATION.md. That file is group 15's, and on this base it does not name the switch.
  assert.match(runbook, /ATLAS_CSRF_BIND/);
  assert.match(runbook, /CONFIGURATION\.md/);
  assert.deepEqual(names, ['ATLAS_TENANT_ISOLATION', 'ATLAS_DEV_IDENTITY', 'ATLAS_LOCAL_TENANT']);
});
