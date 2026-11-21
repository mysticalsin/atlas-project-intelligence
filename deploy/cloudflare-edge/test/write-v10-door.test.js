// Cursor bc-0baf72cc on 4c11808c. A parenthesized pragma setter must not
// swallow a tail, a comma eval must be visible, a patched some must not
// clear a tampered chain, and a shut door must refuse ANALYZE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, MIGRATIONS } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { lintSource } from './write-lint.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const MIGRATION = 'outreach-idempotency';

class Door extends Library {
  constructor(sql, opts, attack) {
    super(sql, opts);
    this.attack = attack;
  }
  exec(statement, ...params) {
    if (statement === MIGRATIONS[MIGRATION]) return super.exec(this.attack, ...params);
    return super.exec(statement, ...params);
  }
}

function native(attack) {
  const driver = memorySql();
  const lib = new Door(driver, { auditKey: SALT, now: () => STAMP }, attack);
  lib.recorded(() => lib.log('library', 'atlas', 'note', 'seed'));
  return { lib, driver };
}

function fallback(attack) {
  const raw = memorySql();
  const lib = new Door({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP }, attack);
  lib.recorded(() => lib.log('library', 'atlas', 'note', 'seed'));
  return { lib, driver: raw };
}

function hide(run) {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  try { return run(); }
  finally { process.getBuiltinModule = orig; }
}

function codeOf(fn) {
  try { fn(); return 'ALLOW'; }
  catch (error) { return error.code || 'ERR'; }
}

function foreignKeys(driver) {
  return driver.exec('PRAGMA foreign_keys').toArray()[0].foreign_keys;
}

test('a pragma setter with a tail is refused before prepare on both paths', () => {
  const forms = ['PRAGMA foreign_keys = OFF; SELECT 1', 'PRAGMA foreign_keys(OFF); SELECT 1'];
  for (const sql of forms) {
    for (const door of ['schema', 'registered']) {
      for (const make of [native, fallback]) {
        const { lib, driver } = make(sql);
        driver.exec('PRAGMA foreign_keys = ON');
        const before = foreignKeys(driver);
        const code = hide(() => codeOf(() => {
          if (door === 'schema') lib.schema(() => lib.exec(sql));
          else Library.migrate(lib, MIGRATION);
        }));
        const where = sql + ' ' + door + ' ' + (make === native ? 'native' : 'fallback');
        assert.equal(code, 'SQL_DOOR', where);
        assert.equal(foreignKeys(driver), before, where);
      }
    }
  }
  const { lib, driver } = native('PRAGMA foreign_keys(OFF)');
  driver.exec('PRAGMA foreign_keys = ON');
  assert.equal(codeOf(() => lib.schema(() => lib.exec('PRAGMA foreign_keys(OFF)'))), 'ALLOW');
  assert.equal(foreignKeys(driver), 0);
});

test('a comma eval binding is a violation', () => {
  const plants = [
    "const e = (0, eval); e('1');\n",
    "let e; e = (0, eval); e('1');\n",
    "const e = (0, globalThis.eval); e('1');\n",
    "const [e] = [(0, eval)]; e('1');\n",
  ];
  for (const source of plants) assert.equal(lintSource('plant.js', source).exec.length >= 1, true, source);
});

test('a patched some cannot make a tampered chain ok', () => {
  const { lib, driver } = native('');
  assert.equal(lib.chainVerdict().ok, true);
  driver.exec("INSERT INTO audit (seq, id, actor, action, at, detail, prev_hash, hash, \"commit\", tombstone) VALUES (0, 'audit', 'x', 'note', '2026-11-17T05:00:00.000Z', 'x', '0000000000000000000000000000000000000000000000000000000000000000', 'abababababababababababababababababababababababababababababababab', 'deadbeef', '')");
  assert.equal(lib.chainVerdict().ok, false);
  const orig = Array.prototype.some;
  Array.prototype.some = () => false;
  try {
    const verdict = lib.chainVerdict();
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'TAMPERED');
  } finally {
    Array.prototype.some = orig;
  }
});

test('a shut door refuses ANALYZE and transaction control on both paths', () => {
  const forms = ['ANALYZE', 'ANALYZE refs', 'SAVEPOINT s', 'BEGIN', 'RELEASE s', 'COMMIT', 'ROLLBACK'];
  for (const sql of forms) {
    for (const make of [native, fallback]) {
      const { lib, driver } = make('');
      const code = hide(() => codeOf(() => lib.exec(sql)));
      const where = sql + ' ' + (make === native ? 'native' : 'fallback');
      assert.equal(code, 'SQL_DOOR', where);
      assert.equal(driver.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").toArray()[0].n, 0, where);
      assert.equal(driver.exec('SELECT 1 AS n').toArray()[0].n, 1, where);
    }
  }
});
