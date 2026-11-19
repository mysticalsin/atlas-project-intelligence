// Cursor bc-fcb6e581. depth++ only at depth 0 survives the CTE tests and
// the depth tests. A doubly nested parenthesis closes once, and the DELETE
// after that close is still inside the outer parenthesis. It is not depth 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { provenRead, sqlTokens } from '../src/sql-text.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";
const INSIDE = 'SELECT ((1) DELETE FROM refs)';
const AFTER = 'WITH x AS ((SELECT 1)) DELETE FROM refs';

function deleteDepth(sql) {
  const token = sqlTokens(sql).find((t) => t.kind === 'word' && t.text === 'delete');
  return token ? token.depth : -1;
}
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
function refsCount(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM refs').toArray()[0].n);
}
function refsTitle(raw) {
  return raw.exec("SELECT title FROM refs WHERE id = 'r1'").toArray()[0].title;
}
function auditCount(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n);
}
function chainOf(raw) {
  return raw.exec('SELECT seq, action, "commit" FROM audit ORDER BY seq').toArray()
    .map((row) => row.seq + ' ' + row.action + ' ' + row.commit).join('\n');
}
function snap(raw) {
  return { refs: refsCount(raw), title: refsTitle(raw), audit: auditCount(raw), chain: chainOf(raw) };
}
function unchanged(raw, before, sql) {
  const after = snap(raw);
  assert.equal(after.refs, before.refs, sql);
  assert.equal(after.title, before.title, sql);
  assert.equal(after.audit, before.audit, sql);
  assert.equal(after.chain, before.chain, sql);
}
function open(raw) {
  return new Library(raw, { auditKey: SALT, now: () => STAMP });
}
function shut(raw) {
  return new Library({ exec: raw.exec.bind(raw), transactionSync: raw.transactionSync.bind(raw) }, { auditKey: SALT, now: () => STAMP });
}
function seed(lib) {
  lib.recorded(() => lib.exec(REFS_SEED));
}
function doors(cases) {
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  for (const sql of cases) {
    assert.equal(codeOf(() => lib.exec(sql)), 'SQL_DOOR', sql);
    unchanged(raw, before, sql);
  }
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    for (const sql of cases) {
      assert.equal(codeOf(() => door.exec(sql)), 'SQL_DOOR', 'fallback ' + sql);
      unchanged(inner, innerBefore, sql);
    }
  });
}

test('a doubly nested parenthesis does not hide a delete after the inner close', () => {
  for (const table of ['refs', 'audit']) {
    const inside = INSIDE.replace('refs', table);
    const after = AFTER.replace('refs', table);
    assert.equal(deleteDepth(inside), 1, inside);
    assert.equal(provenRead(inside), false, inside);
    assert.equal(deleteDepth(after), 0, after);
    assert.equal(provenRead(after), false, after);
  }
  doors([INSIDE, INSIDE.replace('refs', 'audit'), AFTER, AFTER.replace('refs', 'audit')]);
});
