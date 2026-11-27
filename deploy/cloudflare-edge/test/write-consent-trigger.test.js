// Without node:sqlite the fallback must still install the append-only triggers.
// A throwing DatabaseSync must not escape as an uncaught constructor error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { locateWorkerd, SKIP_REASON } from './workerd-bin.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const TRIGGERS = ['consent_receipts_no_update', 'consent_receipts_no_delete', 'consent_receipts_no_replace'];
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function bareDriver() {
  const db = new DatabaseSync(':memory:');
  const exec = (q, ...params) => {
    let rest = String(q ?? '');
    let rows = [];
    let offset = 0;
    while (rest.trim()) {
      rest = rest.replace(/^(\s*;)+/, '');
      if (!rest.trim()) break;
      const stmt = db.prepare(rest);
      const src = stmt.sourceSQL;
      const marks = (src.match(/\?/g) || []).length;
      const slice = params.slice(offset, offset + marks);
      offset += marks;
      rows = stmt.all(...slice);
      rest = rest.slice(src.length);
    }
    return { toArray: () => rows.map((row) => ({ ...row })) };
  };
  const transactionSync = (fn) => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already closed */ }
      throw error;
    }
  };
  return { exec, transactionSync, db };
}

function hideSqlite(factory) {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? factory() : orig(name));
  return () => { process.getBuiltinModule = orig; };
}

test('a driver with only exec and transactionSync still installs the consent triggers', async () => {
  const restore = hideSqlite(() => undefined);
  let names = [];
  let err;
  let left;
  try {
    const { Library } = await import('../src/library.js');
    const { ensure } = await import('../src/privacy.js');
    const driver = bareDriver();
    const lib = new Library(driver, { auditKey: SALT, now: () => STAMP });
    try { ensure(lib); }
    catch (error) { err = error; }
    names = driver.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name);
    lib.recorded(() => lib.exec("INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES ('r1', 'abababababababab', 'memory', 1, 'n', 'h', '2026-11-17T05:00:00.000Z', 'api')"));
    let deleted;
    try { lib.recorded(() => lib.exec('DELETE FROM consent_receipts')); deleted = 'ran'; }
    catch (error) { deleted = error; }
    left = lib.rows('SELECT COUNT(*) AS n FROM consent_receipts')[0].n;
    assert.equal(err, undefined);
    for (const name of TRIGGERS) assert.equal(names.includes(name), true, name);
    assert.equal(left, 1);
    assert.notEqual(deleted, 'ran');
  } finally {
    restore();
  }
});

test('an Illegal constructor from node:sqlite does not escape Library', async () => {
  const restore = hideSqlite(() => ({
    DatabaseSync: class {
      constructor() { throw new TypeError('Illegal constructor'); }
    },
  }));
  let err;
  try {
    const { Library } = await import('../src/library.js');
    const driver = bareDriver();
    try { new Library(driver, { auditKey: SALT, now: () => STAMP }); }
    catch (error) { err = error; }
  } finally {
    restore();
  }
  assert.equal(err && err.message, undefined);
});

function workerModules() {
  const modules = {};
  const seen = new Set();
  const add = (rel) => {
    const key = rel.replace(/\\/g, '/');
    const abs = resolve(SRC, rel);
    if (seen.has(abs)) return;
    seen.add(abs);
    const text = readFileSync(abs, 'utf8');
    for (const spec of text.matchAll(/from '(\.[^']+)'/g)) {
      let next = join(dirname(rel), spec[1]);
      if (!next.endsWith('.js')) next += '.js';
      add(next);
    }
    modules['src/' + key] = { type: 'esm', contents: text };
  };
  add('library.js');
  const script = [
    'import { Library } from "./src/library.js";',
    'export default { fetch() {',
    '  try {',
    '    const exec = () => ({ toArray() { return []; } });',
    '    const transactionSync = (fn) => fn();',
    '    new Library({ exec, transactionSync }, { auditKey: "synthetic-log-salt", now: () => "2026-11-17T05:00:00.000Z" });',
    '    return new Response("constructed");',
    '  } catch (error) {',
    '    return new Response("error:" + (error && error.message));',
    '  }',
    '} };',
  ].join('\n');
  modules['worker.js'] = { type: 'esm', contents: script };
  return modules;
}

test('workerd constructs Library at compat 2025-09-01 and 2026-09-01', async (t) => {
  const found = locateWorkerd();
  if (!found) {
    t.skip(SKIP_REASON);
    return;
  }
  const version = spawnSync(found.bin, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || !/2026-10-23/.test((version.stdout || '') + (version.stderr || ''))) {
    t.skip('workerd binary is not 2026-10-23; set ATLAS_WORKERD_ROOT');
    return;
  }
  const require = createRequire(import.meta.url);
  const { Miniflare } = require(found.root + '/node_modules/miniflare/dist/src/index.js');
  const modules = workerModules();
  for (const date of ['2025-09-01', '2026-09-01']) {
    const mf = new Miniflare({
      workers: [{
        config: {
          name: 'probe',
          compatibilityDate: date,
          manifest: { mainModule: 'worker.js', modules },
        },
      }],
    });
    try {
      const response = await mf.dispatchFetch('http://atlas.test/');
      const body = await response.text();
      assert.equal(/Illegal constructor/.test(body), false, date + ' ' + body);
      assert.equal(body === 'constructed' || body.startsWith('error:'), true, date + ' ' + body);
    } finally {
      await mf.dispose();
    }
  }
});
