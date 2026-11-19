// v8 reds. Qualified audit writes, writable_schema, ATTACH, a trailing
// semicolon read, the production clock, auditReady, and an eval alias.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { ensure } from '../src/privacy.js';
import { splitStatements } from '../src/sql-text.js';
import { lintSource } from './write-lint.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const REFS = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 't', 'in_review', 1, '{}', '{}')";
const DELETE_SQL = 'DELETE FROM consent_receipts WHERE subject IN (SELECT subject FROM consent_receipts GROUP BY subject HAVING MAX(at) < ?)';

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

function auditCount(lib) {
  return lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
}

test('recorded refuses qualified, quoted, OR, insert, and index writes', () => {
  const cases = [
    ['DROP TABLE main.audit', (lib) => lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit'")[0].n, 1],
    ['DROP TABLE "main".audit', (lib) => lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit'")[0].n, 1],
    ['DELETE FROM main.audit', auditCount, 2],
    ['DELETE FROM "main"."audit"', auditCount, 2],
    ['DELETE FROM temp.audit', auditCount, 2],
    ['DELETE FROM extra.audit', auditCount, 2],
    ["UPDATE main.audit SET detail = 'y'", (lib) => lib.rows("SELECT COUNT(*) AS n FROM audit WHERE detail = 'y'")[0].n, 0],
    ["UPDATE OR IGNORE audit SET detail = 'y'", (lib) => lib.rows("SELECT COUNT(*) AS n FROM audit WHERE detail = 'y'")[0].n, 0],
    ["UPDATE OR REPLACE audit SET detail = 'y'", (lib) => lib.rows("SELECT COUNT(*) AS n FROM audit WHERE detail = 'y'")[0].n, 0],
    ["UPDATE OR REPLACE main.audit SET detail = 'y'", (lib) => lib.rows("SELECT COUNT(*) AS n FROM audit WHERE detail = 'y'")[0].n, 0],
    ["INSERT INTO audit (id, actor, action, at, detail) VALUES ('forged','a','b','c','d')", (lib) => lib.rows("SELECT COUNT(*) AS n FROM audit WHERE id = 'forged'")[0].n, 0],
    ["INSERT OR REPLACE INTO audit (id, actor, action, at, detail) VALUES ('forged','a','b','c','d')", (lib) => lib.rows("SELECT COUNT(*) AS n FROM audit WHERE id = 'forged'")[0].n, 0],
    ["INSERT OR REPLACE INTO audit_anchor (id, n, head) VALUES (1, 9, 'forged')", (lib) => lib.rows("SELECT head FROM audit_anchor")[0].head === 'forged' ? 1 : 0, 0],
    ["REPLACE INTO audit (id, actor, action, at, detail) VALUES ('forged','a','b','c','d')", (lib) => lib.rows("SELECT COUNT(*) AS n FROM audit WHERE id = 'forged'")[0].n, 0],
    ['DROP INDEX IF EXISTS audit_one_chain_start', (lib) => lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'audit_one_chain_start'")[0].n, 1],
    ['DROP INDEX IF EXISTS main.audit_one_chain_start', (lib) => lib.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'audit_one_chain_start'")[0].n, 1],
  ];
  for (const [sql, read, expect] of cases) {
    const { lib } = native();
    const code = run(lib, sql, 'recorded');
    assert.equal(code, 'SQL_DOOR', sql);
    assert.equal(read(lib), expect, sql);
  }
});

test('recorded refuses insert-or-replace of consent receipts and the privacy gate', () => {
  const { lib } = native();
  ensure(lib);
  const before = lib.rows('SELECT COUNT(*) AS n FROM consent_receipts')[0].n;
  const open = lib.rows('SELECT open FROM privacy_gate')[0].open;
  const consent = "INSERT OR REPLACE INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES ('z','abababababababab','memory',1,'n','h','2020-01-01T00:00:00.000Z','api')";
  assert.equal(run(lib, consent, 'recorded'), 'SQL_DOOR');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts')[0].n, before);
  const gate = "INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)";
  assert.equal(run(lib, gate, 'recorded'), 'SQL_DOOR');
  assert.equal(lib.rows('SELECT open FROM privacy_gate')[0].open, open);
});

test('recorded refuses a temp table or view over a protected name', () => {
  const cases = [
    'CREATE TEMP TABLE audit (id INTEGER)',
    'CREATE TEMPORARY TABLE audit_anchor (id INTEGER)',
    'CREATE TEMP VIEW consent_receipts AS SELECT 1 AS id',
    'CREATE TEMPORARY VIEW privacy_gate AS SELECT 1 AS name',
  ];
  for (const sql of cases) {
    const { lib } = native();
    const code = run(lib, sql, 'recorded');
    const names = lib.rows('SELECT name FROM sqlite_temp_master').map((row) => row.name);
    assert.equal(code, 'SQL_DOOR', sql);
    assert.equal(names.includes(sql.includes('audit_anchor') ? 'audit_anchor' : sql.includes('consent') ? 'consent_receipts' : sql.includes('privacy') ? 'privacy_gate' : 'audit'), false, sql);
  }
});

test('a missed audit write inside recorded rolls back', () => {
  const { lib, driver } = native();
  lib.recorded(() => lib.exec(REFS));
  let err;
  try {
    lib.recorded(() => {
      driver.exec("UPDATE audit SET detail = 'belt'");
      lib.exec('DELETE FROM refs');
    });
  } catch (error) { err = error; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM audit WHERE detail = 'belt'")[0].n, 0);
  assert.equal(err && err.code, 'CHAIN_DAMAGED');
});

const MATRIX = [
  ['SELECT 1', 'direct', 'ALLOW'],
  ['SELECT 1;', 'direct', 'ALLOW'],
  ['SELECT 1; -- tail', 'direct', 'ALLOW'],
  ['EXPLAIN QUERY PLAN SELECT 1;', 'direct', 'ALLOW'],
  ['SELECT 1; DELETE FROM refs', 'direct', 'SQL_MULTI'],
  ['SELECT 1;;', 'direct', 'SQL_MULTI'],
  ['PRAGMA user_version', 'direct', 'ALLOW'],
  ['PRAGMA writable_schema = ON', 'direct', 'SQL_DOOR'],
  ['PRAGMA writable_schema = ON', 'recorded', 'SQL_DOOR'],
  ['PRAGMA writable_schema = ON', 'schema', 'SQL_DOOR'],
  ['PRAGMA writable_schema = ON', 'house', 'SQL_DOOR'],
  ["ATTACH DATABASE ':memory:' AS extra", 'direct', 'SQL_DOOR'],
  ["ATTACH DATABASE ':memory:' AS extra", 'recorded', 'SQL_DOOR'],
  ['DETACH DATABASE extra', 'direct', 'SQL_DOOR'],
  ['DELETE FROM main.audit', 'recorded', 'SQL_DOOR'],
  ["UPDATE OR REPLACE audit SET detail = 'y'", 'recorded', 'SQL_DOOR'],
  ["INSERT INTO audit (id, actor, action, at, detail) VALUES ('forged','a','b','c','d')", 'recorded', 'SQL_DOOR'],
  ['EXPLAIN QUERY PLAN SELECT 1', 'direct', 'ALLOW'],
  ['EXPLAIN SELECT 1', 'direct', 'ALLOW'],
];

test('native and fallback agree on the statement matrix', () => {
  for (const [sql, door, expect] of MATRIX) {
    const left = run(native().lib, sql, door);
    const right = hide(() => run(fallback().lib, sql, door));
    assert.equal(left, right, sql + ' ' + door);
    assert.equal(left, expect, sql + ' ' + door);
    if (sql.includes('writable_schema')) {
      const { lib } = native();
      run(lib, sql, door);
      assert.equal(lib.rows('PRAGMA writable_schema')[0].writable_schema, 0, door);
    }
    if (sql.startsWith('ATTACH')) {
      const { lib } = native();
      run(lib, sql, door);
      const names = lib.rows('PRAGMA database_list').map((row) => row.name);
      assert.equal(names.includes('extra'), false);
    }
  }
});

test('the production clock ignores a patched toISOString', () => {
  const lib = new Library(memorySql(), { auditKey: SALT });
  const orig = Date.prototype.toISOString;
  Date.prototype.toISOString = () => '9999-01-01T00:00:00.000Z';
  let err;
  try { lib.recorded(() => lib.log('library', 'atlas', 'note', 'clock')); }
  catch (error) { err = error; }
  finally { Date.prototype.toISOString = orig; }
  const at = lib.rows("SELECT at FROM audit WHERE detail = 'clock'")[0].at;
  assert.equal(at === '9999-01-01T00:00:00.000Z', false);
  assert.equal(err, undefined);
});

test('a patched some does not commit a delete on a damaged chain', () => {
  const driver = memorySql();
  const lib = new Library(driver, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec(REFS));
  driver.exec("UPDATE audit SET hash = 'broken'");
  const orig = Array.prototype.some;
  Array.prototype.some = () => false;
  let err;
  try { lib.recorded(() => lib.exec('DELETE FROM refs')); }
  catch (error) { err = error; }
  finally { Array.prototype.some = orig; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
  assert.equal(err && err.code, 'CHAIN_DAMAGED');
});

test('a selective Date.parse does not sweep a current receipt', () => {
  const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
  ensure(lib);
  lib.recorded(() => lib.exec("INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES ('r1','abababababababab','memory',1,'n','h',?,'api')", STAMP));
  const real = Date.parse;
  Date.parse = (value) => (value === STAMP ? real('9999-01-01T00:00:00.000Z') : real(value));
  let err;
  try {
    lib.housekeeping('consent-retention', () => {
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)");
      lib.exec(DELETE_SQL);
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)");
    });
  } catch (error) { err = error; }
  finally { Date.parse = real; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts')[0].n, 1);
  assert.equal(err, undefined);
});

test('a selective find does not sweep a current receipt', () => {
  const orig = Array.prototype.find;
  Array.prototype.find = function (fn, arg) {
    if (this.length && this[0] && this[0].id === 'drafts') return { id: 'consent_receipts', hours: -24 };
    return orig.call(this, fn, arg);
  };
  const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
  ensure(lib);
  lib.recorded(() => lib.exec("INSERT INTO consent_receipts (id, subject, purpose, granted, notice_version, text_sha256, at, channel) VALUES ('r1','cdcdcdcdcdcdcdcd','memory',1,'n','h',?,'api')", STAMP));
  let err;
  try {
    lib.housekeeping('consent-retention', () => {
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)");
      lib.exec(DELETE_SQL);
      lib.exec("INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)");
    });
  } catch (error) { err = error; }
  finally { Array.prototype.find = orig; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM consent_receipts')[0].n, 1);
  assert.equal(err, undefined);
});

test('a patched Math.min does not hide a delete in a comment', () => {
  const lib = new Library(memorySql(), { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec(REFS));
  const orig = Math.min;
  Math.min = (a) => a;
  let err;
  try { lib.exec('/*c*/ DELETE FROM refs'); }
  catch (error) { err = error; }
  finally { Math.min = orig; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
  assert.equal(err && (err.code === 'SQL_DOOR' || err.code === 'SQL_MULTI'), true);
});

test('a patched String does not classify a delete as a read', () => {
  const orig = globalThis.String;
  const driver = memorySql();
  const realTail = driver.statementTail.bind(driver);
  driver.statementTail = (query) => {
    const live = globalThis.String;
    globalThis.String = orig;
    try { return realTail(query); }
    finally { globalThis.String = live; }
  };
  const lib = new Library(driver, { auditKey: SALT, now: () => STAMP });
  lib.recorded(() => lib.exec(REFS));
  globalThis.String = function (value) {
    if (value === 'DELETE FROM refs' || value === '/*c*/ DELETE FROM refs') return 'select 1';
    return typeof value === 'string' ? value : orig(value);
  };
  let err;
  try { lib.exec('DELETE FROM refs'); }
  catch (error) { err = error; }
  finally { globalThis.String = orig; }
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM refs')[0].n, 1);
  assert.equal(err && (err.code === 'SQL_DOOR' || err.code === 'SQL_MULTI'), true);
});

test('WHEN NEW.begin BEGIN does not swallow the next statement', () => {
  const sql = 'CREATE TRIGGER t BEFORE INSERT ON refs WHEN NEW.begin BEGIN SELECT 1; END; DELETE FROM audit';
  assert.equal(splitStatements(sql).length, 2);
});

test('an eval alias is a lint violation', () => {
  const found = lintSource('plant.js', "const e = eval;\ne('1');\n");
  assert.equal(found.exec.length >= 1, true);
});
