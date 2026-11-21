'use strict';
// Opt-in, outside the default gate. This file is not named *.test.js, so
// `node --test tests/*.test.js` does not load it and does not record a skip.
// The one opt-in check: regeneration from the pinned sources is byte-identical
// to the committed asset. Set ATLAS_NE_SRC to the folder that holds the two
// pinned Natural Earth v5.1.2 files, then run: node tests/geo-ne-check.js
// A missing ATLAS_NE_SRC exits 2. It does not report success.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const src = process.env.ATLAS_NE_SRC;
if (!src) {
  console.error('ATLAS_NE_SRC is unset. regeneration from the pinned sources is byte-identical to the committed asset was not run.');
  process.exit(2);
}
const script = path.join(__dirname, '..', 'scripts', 'build_world_map.py');
const result = spawnSync('python3', [script, '--src', src, '--check'], { encoding: 'utf8' });
const output = String(result.stdout || '') + String(result.stderr || '');
if (result.status !== 0 || !/identical/.test(String(result.stdout || ''))) {
  console.error(output);
  process.exit(result.status || 1);
}
process.stdout.write(String(result.stdout || ''));
