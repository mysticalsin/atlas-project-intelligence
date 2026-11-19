// A bare identifier begin/end/case/trigger must not swallow the next statement.
// The memory driver and workerd 2026-10-23 both run that tail. The gate has to reject it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Library } from '../src/library.js';
import { splitStatements } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';
import { ensure as ensurePrivacy } from '../src/privacy.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const WORKERD_ROOT = '/tmp/atlas-workerd-20261023';
const WORKERD_BIN = WORKERD_ROOT + '/node_modules/workerd/bin/workerd';
const WORDS = ['begin', 'BEGIN', 'Begin', 'end', 'END', 'End', 'case', 'CASE', 'trigger', 'TRIGGER'];

function open() {
  return new Library(memorySql(), { now: () => STAMP, auditKey: SALT });
}
function refused(statement) {
  const lib = open();
  const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  let err;
  try { lib.exec(statement); }
  catch (error) { err = error; }
  assert.equal(err && err.code, 'SQL_MULTI', statement);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before, statement);
  assert.equal(lib.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit'").length, 1, statement);
}

for (const word of WORDS) {
  test('alias ' + word + ' does not hide a following DELETE or DROP', () => {
    refused('SELECT 1 AS ' + word + '; DELETE FROM audit');
    refused('SELECT 1 AS ' + word + '; DROP TABLE audit');
  });
  test('column ' + word + ' does not hide a following DELETE or DROP', () => {
    refused('CREATE TABLE IF NOT EXISTS tail_' + word + ' (' + word + ' INTEGER); DELETE FROM audit');
    refused('CREATE TABLE IF NOT EXISTS tail_' + word + '_b (' + word + ' INTEGER); DROP TABLE audit');
  });
}

test('CASE END does not hide a following DELETE', () => {
  refused('SELECT CASE WHEN 1 THEN 1 END; DELETE FROM audit');
  refused('SELECT CASE WHEN 1 THEN 1 END; DROP TABLE audit');
});

test('a consent receipt insert followed by DELETE does not run the delete', () => {
  const lib = open();
  ensurePrivacy(lib);
  lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
  const statement = "INSERT INTO consent_receipts (id, subject, purpose, granted, at) SELECT '1', 'a@example.test', 'memory', 1, '2026-11-17T05:00:00.000Z' FROM (SELECT 1 AS begin); DELETE FROM refs";
  const before = lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n;
  let err;
  try { lib.exec(statement); }
  catch (error) { err = error; }
  assert.equal(err && err.code, 'SQL_MULTI', statement);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, before);
});

test('workerd 2026-10-23 runs an alias-begin tail and the gate rejects that family', async () => {
  assert.equal(existsSync(WORKERD_BIN), true, 'workerd 2026-10-23 is on this box');
  const version = spawnSync(WORKERD_BIN, ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.match(version.stdout + version.stderr, /2026-10-23/);
  const require = createRequire(import.meta.url);
  const { Miniflare } = require(WORKERD_ROOT + '/node_modules/miniflare/dist/src/index.js');
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
    const storage = await mf.unsafeGetDurableObjectStorage('probe', 'Box', { name: 'tail' });
    const probes = [
      'SELECT 1 AS begin; DELETE FROM audit',
      'SELECT 1 AS BEGIN; DROP TABLE audit',
      'SELECT 1 AS end; DELETE FROM audit',
      'SELECT 1 AS case; DELETE FROM audit',
      'SELECT 1 AS trigger; DELETE FROM audit',
      'CREATE TABLE col_begin (begin INTEGER); DROP TABLE audit',
      'CREATE TABLE col_end (end INTEGER); DELETE FROM audit',
      'CREATE TABLE col_case ("case" INTEGER); DROP TABLE audit',
      'CREATE TABLE col_trigger (trigger INTEGER); DELETE FROM audit',
      'SELECT CASE WHEN 1 THEN 1 END; DELETE FROM audit',
    ];
    for (const statement of probes) {
      await storage.exec('CREATE TABLE IF NOT EXISTS audit (id INTEGER)');
      await storage.exec('DELETE FROM audit');
      await storage.exec('INSERT INTO audit (id) VALUES (1)');
      const parts = splitStatements(statement);
      if (parts.length === 1) await storage.exec(statement);
      const rows = await storage.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit'");
      const left = rows[0].n;
      let data = 0;
      if (left === 1) data = (await storage.exec('SELECT COUNT(*) AS n FROM audit'))[0].n;
      assert.equal(left === 1 && data === 1, true, 'workerd executed the tail: ' + statement);
      assert.equal(parts.length, 2, statement);
    }
  } finally {
    await mf.dispose();
  }
});
