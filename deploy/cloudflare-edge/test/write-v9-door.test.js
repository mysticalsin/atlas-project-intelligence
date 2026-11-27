// v9 reds. One token stream, pragmas refused before prepare, guarded creates,
// the insights role check, and the eval plants Devin, Cursor, Sentinel, and
// Inspector named.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { libraryRoutes } from '../src/library-routes.js';
import { lintSource } from './write-lint.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const READS = ['user_version', 'table_info', 'table_xinfo', 'index_list', 'index_info', 'database_list', 'foreign_key_list', 'schema_version', 'integrity_check', 'quick_check', 'compile_options', 'writable_schema'];
const GUARDS = ['audit', 'audit_anchor', 'consent_receipts', 'privacy_gate'];

function native() {
  const driver = memorySql();
  const lib = new Library(driver, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.log('library', 'atlas', 'note', 'seed'));
  return { lib, driver };
}

function fallback() {
  const raw = memorySql();
  const lib = new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.log('library', 'atlas', 'note', 'seed'));
  return { lib, driver: raw };
}

function hide(run) {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  try { return run(); }
  finally { process.getBuiltinModule = orig; }
}

function run(lib, sql, door) {
  let err;
  try {
    if (door === 'recorded') lib.recorded(() => lib.exec(sql));
    else if (door === 'schema') lib.schema(() => lib.exec(sql));
    else if (door === 'house') lib.housekeeping('teams-seen', () => lib.exec(sql));
    else lib.exec(sql);
  } catch (error) { err = error; }
  return err ? (err.code || 'ERR') : 'ALLOW';
}

function flag(driver) {
  return driver.exec('PRAGMA writable_schema').toArray()[0].writable_schema;
}

function both(sql, door) {
  const left = native();
  const right = fallback();
  const a = run(left.lib, sql, door);
  const b = hide(() => run(right.lib, sql, door));
  assert.equal(a, b, sql + ' ' + door);
  assert.equal(a, 'SQL_DOOR', sql + ' ' + door);
  assert.equal(flag(left.driver), 0, sql + ' ' + door);
  assert.equal(flag(right.driver), 0, sql + ' ' + door);
}

test('CREATE TABLE temp.audit AS SELECT does not shadow main.audit', () => {
  const forms = [
    'CREATE TABLE temp.audit AS SELECT * FROM main.audit',
    'CREATE TABLE temp.consent_receipts AS SELECT * FROM main.consent_receipts',
    'CREATE TABLE temp.privacy_gate AS SELECT * FROM main.privacy_gate',
    'CREATE TABLE temp.audit_anchor AS SELECT * FROM main.audit_anchor',
  ];
  for (const sql of forms) {
    for (const make of [native, fallback]) {
      const { lib } = make();
      const code = hide(() => run(lib, sql, 'recorded'));
      assert.equal(code, 'SQL_DOOR', sql);
      assert.equal(lib.rows("SELECT name FROM sqlite_temp_master WHERE name = 'audit' OR name = 'consent_receipts' OR name = 'privacy_gate' OR name = 'audit_anchor'").length, 0, sql);
    }
  }
});

test('quoted and commented writable_schema assignments leave the flag at 0', () => {
  const forms = [
    'PRAGMA writable_schema /* c */ = ON',
    'PRAGMA "main"."writable_schema" = ON',
  ];
  for (const sql of forms) {
    for (const door of ['direct', 'recorded', 'house', 'schema']) both(sql, door);
  }
});

test('an equals sign is an assignment even when the value is an allowlisted name', () => {
  const { lib, driver } = native();
  const before = driver.exec('PRAGMA foreign_keys').toArray()[0].foreign_keys;
  assert.equal(run(lib, 'PRAGMA foreign_keys = table_info', 'direct'), 'SQL_DOOR');
  assert.equal(driver.exec('PRAGMA foreign_keys').toArray()[0].foreign_keys, before);
  const trusted = native();
  const prior = trusted.driver.exec('PRAGMA trusted_schema').toArray()[0].trusted_schema;
  assert.equal(run(trusted.lib, 'PRAGMA trusted_schema = writable_schema', 'direct'), 'SQL_DOOR');
  assert.equal(trusted.driver.exec('PRAGMA trusted_schema').toArray()[0].trusted_schema, prior);
  for (const name of READS) {
    both('PRAGMA writable_schema = ' + name, 'direct');
    both('PRAGMA ' + name + ' = writable_schema', 'direct');
  }
});

test('Devin writable_schema forms agree on both paths and do not prepare', () => {
  const forms = [
    'PRAGMA writable_schema = ON',
    'PRAGMA writable_schema = 1',
    'PRAGMA writable_schema = true',
    "PRAGMA writable_schema = 'on'",
    'PRAGMA writable_schema = yes',
    'PRAGMA Writable_Schema = ON',
    'PRAGMA main.writable_schema = ON',
    'PRAGMA writable_schema(1)',
    'PRAGMA writable_schema = RESET',
    'PRAGMA writable_schema = ON; SELECT 1',
    'SELECT 1; PRAGMA writable_schema = ON',
    'PRAGMA writable_schema /* c */ = ON',
    'PRAGMA "main"."writable_schema" = ON',
  ];
  for (const sql of forms) both(sql, 'direct');
});

test('one trailing semicolon on a pragma read is allowed and an empty statement is not', () => {
  assert.equal(run(native().lib, 'PRAGMA user_version;', 'direct'), 'ALLOW');
  assert.equal(run(native().lib, 'PRAGMA table_info(refs);', 'direct'), 'ALLOW');
  assert.equal(hide(() => run(fallback().lib, 'PRAGMA user_version;', 'direct')), 'ALLOW');
  assert.equal(run(native().lib, 'SELECT 1;;', 'direct'), 'SQL_MULTI');
  assert.equal(hide(() => run(fallback().lib, 'SELECT 1;;', 'direct')), 'SQL_MULTI');
  assert.equal(run(native().lib, 'PRAGMA user_version; DELETE FROM refs', 'direct'), 'SQL_MULTI');
  assert.equal(run(native().lib, 'SELECT 1; DELETE FROM refs', 'direct'), 'SQL_MULTI');
});

test('a patched Math.max cannot hide a delete after a parenthesis', () => {
  const orig = Math.max;
  Math.max = (a, b) => (a === 0 ? 99 : orig(a, b));
  try {
    const { lib } = native();
    lib.recorded(() => lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')"));
    run(lib, 'WITH c AS (SELECT 1) DELETE FROM refs', 'direct');
    assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
  } finally {
    Math.max = orig;
  }
});

test('recorded refuses RENAME TO a protected name and an index on consent or the privacy gate', () => {
  const { lib } = native();
  assert.equal(run(lib, 'ALTER TABLE refs RENAME TO consent_receipts', 'recorded'), 'SQL_DOOR');
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'refs'")[0].n, 1);
  assert.equal(run(native().lib, 'CREATE INDEX consent_idx ON consent_receipts(subject)', 'recorded'), 'SQL_DOOR');
  assert.equal(run(native().lib, 'CREATE INDEX gate_idx ON privacy_gate(name)', 'recorded'), 'SQL_DOOR');
});

test('schema may set only user_version and foreign_keys', () => {
  const { lib } = native();
  assert.equal(run(lib, 'PRAGMA journal_mode = WAL', 'schema'), 'SQL_DOOR');
  assert.equal(run(lib, 'PRAGMA user_version = 7', 'schema'), 'ALLOW');
  assert.equal(lib.rows('PRAGMA user_version')[0].user_version, 7);
  assert.equal(run(lib, 'PRAGMA foreign_keys = ON', 'schema'), 'ALLOW');
});

test('quoting and comments do not hide a create of a guarded name', () => {
  const quotes = [
    (name) => name,
    (name) => '"' + name + '"',
    (name) => '[' + name + ']',
    (name) => '`' + name + '`',
  ];
  const schemas = ['', 'temp.', 'main.', '"temp".'];
  const gaps = [' ', ' /*c*/ '];
  for (const guard of GUARDS) {
    for (const quote of quotes) {
      for (const schema of schemas) {
        for (const gap of gaps) {
          const target = schema + quote(guard);
          const sqls = [
            'CREATE' + gap + 'TABLE' + gap + target + ' (id TEXT)',
            'CREATE TABLE ' + target + ' AS SELECT * FROM main.audit',
            'CREATE VIEW ' + target + ' AS SELECT 1 AS id',
            'CREATE INDEX ' + target + ' ON refs(owner)',
          ];
          for (const sql of sqls) {
            const code = run(native().lib, sql, 'recorded');
            assert.equal(code, 'SQL_DOOR', sql);
            assert.equal(hide(() => run(fallback().lib, sql, 'recorded')), 'SQL_DOOR', sql);
          }
        }
      }
    }
  }
});

test('eval plants are lint violations', () => {
  const plants = [
    "const { eval: e } = globalThis;\ne('1');\n",
    "const k = 'eval';\nglobalThis[k]();\n",
    "(0, eval)('1');\n",
    "const [e] = [eval];\ne('1');\n",
  ];
  for (const source of plants) {
    assert.ok(lintSource('plant.js', source).exec.length >= 1, source);
  }
});

test('a insights POST with no body uses the same role result as an empty object', async () => {
  async function post(role, body) {
    const init = { method: 'POST', headers: { 'x-atlas-user': 'ada@example.test', 'x-atlas-role': role } };
    if (body !== undefined) init.body = body;
    const res = await libraryRoutes(new Request('https://atlas.test/api/library/insights', init), native().lib);
    return res.status;
  }
  assert.equal(await post('user', undefined), await post('user', '{}'));
  assert.equal(await post('user', undefined), 403);
  assert.equal(await post('reviewer', undefined), await post('reviewer', '{}'));
});
