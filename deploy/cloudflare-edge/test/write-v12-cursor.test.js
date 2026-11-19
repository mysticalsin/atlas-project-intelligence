// Cursor bc-1a397a61. A parenthesis inside the CTE name must not hide the
// statement that follows the CTE list. Both doors refuse it, and the audit
// chain-start row stays. EXPLAIN of that shape is a mutation again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const VERBS = ['DELETE FROM audit', 'UPDATE audit SET id = id', 'INSERT INTO audit (id) VALUES (1)', 'REPLACE INTO audit (id) VALUES (1)'];
const NAMES = ['`x(y`', '[x(y]'];

function hide(run) {
  const orig = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => (name === 'node:sqlite' ? undefined : orig(name));
  try { return run(); }
  finally { process.getBuiltinModule = orig; }
}
function codeOf(run) {
  try { run(); return 'ALLOW'; }
  catch (err) { return err.code || 'ERR'; }
}
function countOf(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n);
}
function chainOf(raw) {
  const rows = raw.exec('SELECT seq, action, "commit" FROM audit ORDER BY seq').toArray();
  return rows.map((row) => row.seq + ' ' + row.action + ' ' + row.commit).join('\n');
}
function open(raw) {
  return new Library(raw, { auditKey: SALT, now: () => STAMP });
}
function shut(raw) {
  return new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
}
function stays(sql) {
  const raw = memorySql();
  const lib = open(raw);
  const count = countOf(raw);
  const chain = chainOf(raw);
  assert.equal(count, 1, sql);
  assert.equal(codeOf(() => lib.exec(sql)), 'SQL_DOOR', 'native ' + sql);
  assert.equal(countOf(raw), count, 'native count ' + sql);
  assert.equal(chainOf(raw), chain, 'native chain ' + sql);
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    const innerCount = countOf(inner);
    const innerChain = chainOf(inner);
    assert.equal(innerCount, 1, sql);
    assert.equal(codeOf(() => door.exec(sql)), 'SQL_DOOR', 'fallback ' + sql);
    assert.equal(countOf(inner), innerCount, 'fallback count ' + sql);
    assert.equal(chainOf(inner), innerChain, 'fallback chain ' + sql);
  });
}

for (const name of NAMES) {
  for (const verb of VERBS) {
    const sql = 'WITH ' + name + ' AS (SELECT 1) ' + verb;
    test(sql + ' is SQL_DOOR on both doors and the audit row stays', () => stays(sql));
  }
}

test('EXPLAIN WITH x AS (SELECT 1) DELETE FROM audit is a mutation on both doors', () => {
  stays('EXPLAIN WITH x AS (SELECT 1) DELETE FROM audit');
});

test('END TRANSACTION is SQL_DOOR on both doors and the audit row stays', () => {
  stays('END TRANSACTION');
});

test('WITH x AS (SELECT 1) SELECT 1 stays a read on both doors', () => {
  const sql = 'WITH x AS (SELECT 1) SELECT 1';
  const raw = memorySql();
  const lib = open(raw);
  assert.equal(codeOf(() => lib.exec(sql)), 'ALLOW', 'native');
  assert.equal(countOf(raw), 1);
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    assert.equal(codeOf(() => door.exec(sql)), 'ALLOW', 'fallback');
    assert.equal(countOf(inner), 1);
  });
});
