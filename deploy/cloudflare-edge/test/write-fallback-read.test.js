// On the fallback path the door may run a string only when it is provably one read.
// EXPLAIN of a trigger, a DROP, or any other DDL or DML is not that read.
// An alias or a column named begin does not make the tail one statement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Library } from '../src/library.js';
import { locateWorkerd, SKIP_REASON, skipWithoutWorkerd } from './workerd-bin.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

const BODIES = [
  'SELECT 1 AS begin',
  'SELECT begin FROM refs',
  'SELECT 1 AS end',
  'SELECT refs.begin FROM refs',
];
const EVENTS = ['BEFORE INSERT', 'AFTER INSERT', 'BEFORE UPDATE', 'AFTER UPDATE', 'BEFORE DELETE', 'AFTER DELETE'];
const WRAPS = ['EXPLAIN ', 'EXPLAIN QUERY PLAN '];
const TAILS = ['DELETE FROM audit', 'DROP TABLE audit', 'DELETE FROM refs', 'DROP TABLE refs'];
const WHENS = ['', 'WHEN begin = 1 '];

function forms() {
  const out = [
    "EXPLAIN QUERY PLAN CREATE TRIGGER t BEFORE INSERT ON refs BEGIN SELECT 1 AS begin; END; DELETE FROM audit",
    "EXPLAIN QUERY PLAN CREATE TRIGGER t BEFORE INSERT ON refs BEGIN SELECT begin FROM refs; END; DROP TABLE audit",
    'EXPLAIN QUERY PLAN DROP TABLE audit',
    'EXPLAIN DROP TABLE audit',
    'EXPLAIN QUERY PLAN DELETE FROM audit',
    'EXPLAIN QUERY PLAN DELETE FROM refs',
    'EXPLAIN QUERY PLAN CREATE TABLE pwn (id INTEGER)',
    'EXPLAIN QUERY PLAN CREATE TRIGGER t BEFORE INSERT ON refs BEGIN SELECT 1; END',
    'EXPLAIN CREATE TRIGGER t BEFORE INSERT ON refs BEGIN SELECT 1; END',
  ];
  for (const body of BODIES) {
    for (const event of EVENTS) {
      for (const when of WHENS) {
        for (const wrap of WRAPS) {
          for (const tail of TAILS) {
            out.push(`${wrap}CREATE TRIGGER t ${event} ON refs ${when}BEGIN ${body}; END; ${tail}`);
          }
        }
      }
    }
  }
  return out;
}

function fallbackLibrary() {
  const db = new DatabaseSync(':memory:');
  const sent = [];
  const exec = (q, ...params) => {
    sent.push(String(q));
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
  const lib = new Library({ exec, transactionSync }, { auditKey: SALT, now: () => STAMP });
  return { lib, sent };
}

function intact(lib) {
  try {
    const audit = lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit'")[0].n;
    const refs = lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n;
    return audit === 1 && refs === 1;
  } catch {
    return false;
  }
}

test('fallback refuses explain of ddl or dml and every alias or drop tail', () => {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  const list = forms();
  try {
    const { lib, sent } = fallbackLibrary();
    lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
    assert.equal(list.length > 96, true);
    for (const sql of list) {
      const mark = sent.length;
      let err;
      try { lib.exec(sql); }
      catch (error) { err = error; }
      assert.equal(sent.length, mark, sql);
      assert.equal(intact(lib), true, sql);
      assert.equal(err && (err.code === 'SQL_MULTI' || err.code === 'SQL_DOOR'), true, sql + ' ' + (err && err.code));
    }
  } finally {
    process.getBuiltinModule = orig;
  }
});

test('workerd is not asked to run an unproven explain tail', async (t) => {
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
        manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
        exports: { Box: { type: 'durable-object', storage: 'sqlite' } },
      },
    }],
  });
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  try {
    const storage = await mf.unsafeGetDurableObjectStorage('probe', 'Box', { name: 'fallback-read' });
    await storage.exec('CREATE TABLE refs (id INTEGER)');
    await storage.exec('INSERT INTO refs (id) VALUES (1)');
    await storage.exec('CREATE TABLE audit (id INTEGER)');
    await storage.exec('INSERT INTO audit (id) VALUES (1)');
    const { lib } = fallbackLibrary();
    const sample = [
      "EXPLAIN QUERY PLAN CREATE TRIGGER t BEFORE INSERT ON refs BEGIN SELECT 1 AS begin; END; DELETE FROM audit",
      "EXPLAIN QUERY PLAN CREATE TRIGGER t BEFORE INSERT ON refs BEGIN SELECT begin FROM refs; END; DROP TABLE audit",
      'EXPLAIN QUERY PLAN DROP TABLE audit',
      'EXPLAIN QUERY PLAN DELETE FROM refs',
      'EXPLAIN CREATE TRIGGER t BEFORE DELETE ON refs BEGIN SELECT 1 AS end; END; DROP TABLE refs',
    ];
    for (const sql of sample) {
      let err;
      try { lib.exec(sql); }
      catch (error) { err = error; }
      if (!(err && (err.code === 'SQL_MULTI' || err.code === 'SQL_DOOR'))) {
        try { await storage.exec(sql); }
        catch { /* a crash here is still not a refusal */ }
      }
      const refs = (await storage.exec('SELECT COUNT(*) AS n FROM refs'))[0].n;
      const audit = (await storage.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'audit'"))[0].n;
      assert.equal(refs, 1, sql);
      assert.equal(audit, 1, sql);
      assert.equal(err && (err.code === 'SQL_MULTI' || err.code === 'SQL_DOOR'), true, sql);
    }
  } finally {
    process.getBuiltinModule = orig;
    await mf.dispose();
  }
});
