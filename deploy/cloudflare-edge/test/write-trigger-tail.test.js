// A word begin inside a trigger must not hide the statement after END.
// EXPLAIN in front of a mutation is not a read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { locateWorkerd, SKIP_REASON, skipWithoutWorkerd } from './workerd-bin.js';

const SALT = 'synthetic-log-salt';
const TAILS = [
  ['alias begin', "CREATE TRIGGER t BEFORE INSERT ON refs BEGIN SELECT 1 AS begin; END; DELETE FROM audit"],
  ['trigger named begin', "CREATE TRIGGER begin BEFORE INSERT ON refs BEGIN SELECT 1; END; DELETE FROM audit"],
  ['UPDATE OF begin', "CREATE TRIGGER t BEFORE UPDATE OF begin ON refs BEGIN SELECT 1; END; DELETE FROM audit"],
  ['WHEN begin', "CREATE TRIGGER t BEFORE INSERT ON refs WHEN begin = 1 BEGIN SELECT 1; END; DELETE FROM audit"],
  // EXPLAIN is allowed only as the first word of one statement, so the tail is SQL_DOOR.
  ['EXPLAIN QUERY PLAN', "EXPLAIN QUERY PLAN CREATE TRIGGER t BEFORE INSERT ON refs BEGIN SELECT 1 AS begin; END; DROP TABLE audit"],
];

function expectCode(name) {
  return name === 'EXPLAIN QUERY PLAN' ? 'SQL_DOOR' : 'SQL_MULTI';
}

function open() {
  return new Library(memorySql(), { auditKey: SALT });
}

function auditLeft(lib) {
  const table = lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit'")[0].n;
  if (!table) return { table: 0, rows: 0 };
  return { table, rows: lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n };
}

for (const [name, sql] of TAILS) {
  test(name + ' does not run the statement after the trigger', () => {
    const lib = open();
    const before = auditLeft(lib);
    let err;
    try { lib.recorded(() => lib.exec(sql)); }
    catch (error) { err = error; }
    const after = auditLeft(lib);
    assert.equal(after.table, 1, name);
    assert.equal(after.rows, before.rows, name);
    assert.equal(err && err.code, expectCode(name), name);
  });
}

test('EXPLAIN of a mutation is not a read', () => {
  const lib = open();
  const before = auditLeft(lib).rows;
  let err;
  try { lib.exec('EXPLAIN DELETE FROM audit'); }
  catch (error) { err = error; }
  assert.equal(auditLeft(lib).rows, before);
  assert.equal(err && err.code, 'SQL_DOOR');
});

test('workerd 2026-10-23 runs a trigger-body tail until the gate rejects it', async (t) => {
  const found = locateWorkerd();
  if (!found) {
    skipWithoutWorkerd(t, SKIP_REASON);
    return;
  }
  const version = spawnSync(found.bin, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || !/2026-10-23/.test((version.stdout || '') + (version.stderr || ''))) {
    skipWithoutWorkerd(t, 'workerd binary is not 2026-10-23; set ATLAS_WORKERD_ROOT');
    return;
  }
  const require = createRequire(import.meta.url);
  const { Miniflare } = require(found.root + '/node_modules/miniflare/dist/src/index.js');
  const script = [
    'import { DurableObject } from "cloudflare:workers";',
    'export class Box extends DurableObject {}',
    'export default { fetch() { return new Response("ok"); } }',
  ].join('\n');
  const mf = new Miniflare({
    unsafeInspectDurableObjects: true,
    workers: [{
      config: {
        name: 'probe',
        compatibilityDate: '2026-10-23',
        manifest: {
          mainModule: 'worker.js',
          modules: { 'worker.js': { type: 'esm', contents: script } },
        },
        exports: { Box: { type: 'durable-object', storage: 'sqlite' } },
      },
    }],
  });
  try {
    const storage = await mf.unsafeGetDurableObjectStorage('probe', 'Box', { name: 'trigger-tail' });
    for (const [name, statement] of TAILS) {
      await storage.exec('CREATE TABLE IF NOT EXISTS refs (id INTEGER, begin INTEGER)');
      await storage.exec('CREATE TABLE IF NOT EXISTS audit (id INTEGER)');
      await storage.exec('DELETE FROM audit');
      await storage.exec('INSERT INTO audit (id) VALUES (1)');
      const lib = open();
      let err;
      try { lib.recorded(() => lib.exec(statement)); }
      catch (error) { err = error; }
      if (!(err && err.code === expectCode(name))) await storage.exec(statement);
      const tables = await storage.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit'");
      const left = tables[0].n;
      let rows = 0;
      if (left === 1) rows = (await storage.exec('SELECT COUNT(*) AS n FROM audit'))[0].n;
      assert.equal(left === 1 && rows === 1, true, 'workerd executed the tail: ' + name);
      assert.equal(err && err.code, expectCode(name), name);
    }
  } finally {
    await mf.dispose();
  }
});
