// Red on 02a83b32: product modules still call sql.exec, and Library has no guarded exec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from '../src/library.js';
import { eraseRefContent } from '../src/subject-rights.js';
import { memorySql } from './sqlite.js';
import { lintDir, lintSource } from './write-lint.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const SALT = 'synthetic-log-salt';

test('raw handle use stays inside audit-chain.js and the one Library exec', () => {
  const found = lintDir(SRC);
  assert.deepEqual(found.exec, []);
});

test('a planted mutating sql.exec is a lint violation', () => {
  const found = lintSource('plant.js', "lib.sql.exec('INSERT INTO door_probe (id) VALUES (1)')\n");
  assert.ok(found.exec.length >= 1);
  assert.equal(found.exec[0].file, 'plant.js');
  assert.equal(found.exec[0].line, 1);
});

test('the placeholder census is the helper plus the two bounded lists', () => {
  const found = lintDir(SRC);
  assert.equal(found.helper.length, 1);
  assert.deepEqual(found.census.sort(), ['library.js:3', 'operate.js:3']);
  assert.deepEqual(found.unbound, []);
});

test('exec outside a door is refused', () => {
  const lib = new Library(memorySql(), { auditKey: SALT });
  assert.throws(
    () => lib.exec("CREATE TABLE door_probe (id INTEGER)"),
    err => err.code === 'SQL_DOOR' && err.status === 500,
  );
});

test('schema and housekeeping write without an audit line', () => {
  const lib = new Library(memorySql(), { auditKey: SALT });
  const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  lib.schema(() => lib.exec('CREATE TABLE teams_seen (activity_id TEXT PRIMARY KEY, at TEXT)'));
  lib.housekeeping('teams-seen', () => lib.exec('DELETE FROM teams_seen WHERE at < ?', '2020-01-01T00:00:00.000Z'));
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM teams_seen')[0].n, 0);
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before);
});

test('schema refuses DML', () => {
  const lib = new Library(memorySql(), { auditKey: SALT });
  lib.schema(() => lib.exec('CREATE TABLE teams_seen (activity_id TEXT PRIMARY KEY, at TEXT)'));
  assert.throws(
    () => lib.schema(() => lib.exec("INSERT INTO teams_seen (activity_id, at) VALUES ('a', 'b')")),
    err => err.status === 500 && err.code === 'SCHEMA_DML',
  );
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM teams_seen')[0].n, 0);
});

test('housekeeping refuses a statement that is not on its list', () => {
  const lib = new Library(memorySql(), { auditKey: SALT });
  lib.schema(() => lib.exec('CREATE TABLE teams_seen (activity_id TEXT PRIMARY KEY, at TEXT)'));
  assert.throws(
    () => lib.housekeeping('retention', () => lib.exec("INSERT INTO teams_seen (activity_id, at) VALUES ('a', 'b')")),
    err => err.status === 500 && err.code === 'HOUSEKEEPING_SQL',
  );
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM teams_seen')[0].n, 0);
});

test('story erasure is audited', async () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-17T05:00:00.000Z', auditKey: SALT });
  const owner = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant: '11111111-1111-4111-8111-111111111111', tenantEnforced: true };
  const saved = await lib.upsert(owner, { localId: 'p1', reference: { title: 'Claims triage alias' } });
  eraseRefContent(lib, saved.id, 'erased:abcd', '2026-11-17T05:00:00.000Z');
  assert.equal(lib.rows("SELECT action FROM audit WHERE action = 'story erased'").length, 1);
});

test('a missing LOG_SALT still throws JSON-shaped 503 before schema', () => {
  assert.throws(
    () => new Library(memorySql(), { auditKey: null }),
    err => err.status === 503 && err.code === 'LOG_SALT' && err.message === 'LOG_SALT is not set.',
  );
});
