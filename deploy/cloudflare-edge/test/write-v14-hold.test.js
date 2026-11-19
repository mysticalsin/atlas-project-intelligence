// Sentinel pins and Devin A4 for the verbs the classifier already refuses.
// A token that starts with $ : @ # or ? is takeVariable. REPLACE( is the
// function. INSERT OR REPLACE at the shipped call sites stays inside its door.
// EXPLAIN QUERY PLAN of one delete stays allowed on the primary door only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { bareSemicolon, namedVariable, placeholderCount, provenRead, sqlTokens } from '../src/sql-text.js';
import { ensure as ensurePrivacy, retentionGate, setFlags } from '../src/privacy.js';
import { ensure as ensureProfile } from '../src/profile.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';
const REFS_SEED = "INSERT INTO refs (id, owner, title, status, revision, data, state) VALUES ('r1', 'ada@example.test', 'kept', 'in_review', 1, '{}', '{}')";
const SIGILS = ['$', ':', '@', '#'];
const WRITES = [
  'SELECT 1 INSERT INTO refs (id) VALUES (\'x\')',
  'SELECT 1 UPDATE refs SET title = \'x\'',
  'SELECT 1 DELETE FROM refs',
  'SELECT 1 REPLACE INTO refs (id) VALUES (\'x\')',
  'SELECT 1 dElEtE FROM refs',
];
const PULL = `INSERT OR REPLACE INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant)
      VALUES (?, 'dna', ?, ?, ?, ?, ?, 'pull', ?, ?)`;
const IMPORT = 'INSERT OR REPLACE INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const FLAGS = 'INSERT OR REPLACE INTO privacy_flags (subject, restricted, object_scoring, object_matching, object_memory, updated_at) VALUES (?, ?, ?, ?, ?, ?)';
const GATE_OPEN = "INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 1)";
const GATE_SHUT = "INSERT OR REPLACE INTO privacy_gate (name, open) VALUES ('receipts', 0)";

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
function auditCount(raw) {
  return Number(raw.exec('SELECT COUNT(*) AS n FROM audit').toArray()[0].n);
}
function chainOf(raw) {
  return raw.exec('SELECT seq, action, "commit" FROM audit ORDER BY seq').toArray()
    .map((row) => row.seq + ' ' + row.action + ' ' + row.commit).join('\n');
}
function snap(raw) {
  return { refs: refsCount(raw), audit: auditCount(raw), chain: chainOf(raw) };
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
function doors(cases, expectCode) {
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  for (const sql of cases) {
    assert.equal(codeOf(() => lib.exec(sql)), expectCode, sql);
    assert.deepEqual(snap(raw), before, sql);
  }
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    for (const sql of cases) {
      assert.equal(codeOf(() => door.exec(sql)), expectCode, 'fallback ' + sql);
      assert.deepEqual(snap(inner), innerBefore, sql);
    }
  });
}
function shipped(lib) {
  ensurePrivacy(lib);
  ensureProfile(lib);
  assert.equal(setFlags(lib, 'ada@example.test', { restricted: true }).restricted, true);
  assert.equal(codeOf(() => lib.recorded(() => lib.exec(FLAGS, 'ada@example.test', 0, 0, 0, 0, STAMP))), 'ALLOW', FLAGS);
  assert.equal(retentionGate(lib, () => 1), 1);
  assert.equal(codeOf(() => lib.housekeeping('consent-retention', () => lib.exec(GATE_OPEN))), 'ALLOW', GATE_OPEN);
  assert.equal(codeOf(() => lib.housekeeping('consent-retention', () => lib.exec(GATE_SHUT))), 'ALLOW', GATE_SHUT);
  assert.equal(codeOf(() => lib.housekeeping('dna-cache', () => lib.exec(PULL, 'k', 'N', 'N', 'T', 'M', 'm@example.test', STAMP, ''))), 'ALLOW', 'pull');
  assert.equal(codeOf(() => lib.recorded(() => lib.exec(IMPORT, 'k2', 'staged', 'N', 'N', 'T', 'M', 'm@example.test', 'b', STAMP, ''))), 'ALLOW', 'import');
}

test('a sigil at the start of a token is still a variable', () => {
  for (const sigil of SIGILS) {
    const sql = `WITH x AS (SELECT ${sigil}b(') ) DELETE FROM refs`;
    const token = sqlTokens(sql).find((t) => t.kind === 'var');
    assert.ok(token && token.text.startsWith(sigil), sql);
    assert.equal(namedVariable(sql), true, sql);
    assert.equal(provenRead(sql), false, sql);
  }
  const q = "WITH x AS (SELECT ?1(') ) DELETE FROM refs";
  const variable = sqlTokens(q).find((t) => t.kind === 'var');
  assert.equal(variable && variable.text, '?1');
  assert.equal(variable.named, false);
  assert.equal(placeholderCount('SELECT ?'), 1);
  assert.equal(placeholderCount(q), 1);
  doors(["WITH x AS (SELECT $b(') ) DELETE FROM refs", q], 'SQL_DOOR');
});

test('a dollar at the end of a name, a leading name, and a quoted semicolon stay put', () => {
  assert.equal(namedVariable('SELECT a$'), false);
  assert.equal(provenRead('SELECT a$'), true);
  assert.equal(sqlTokens('SELECT a$').some((t) => t.kind === 'var'), false);
  assert.equal(namedVariable('SELECT $name FROM refs'), true);
  assert.equal(sqlTokens('SELECT $name FROM refs').some((t) => t.kind === 'var' && t.text === '$name'), true);
  doors(['SELECT $name FROM refs'], 'SQL_DOOR');
  for (const sql of ['SELECT "a$;" FROM refs', 'SELECT [a$;] FROM refs', 'SELECT `a$;` FROM refs']) {
    assert.equal(bareSemicolon(sql), false, sql);
    assert.equal(namedVariable(sql), false, sql);
    assert.equal(provenRead(sql), true, sql);
    assert.equal(sqlTokens(sql).some((t) => t.text === 'a$;'), true, sql);
  }
  // The semicolon is inside the identifier, so the door does not split or refuse it.
  // SQLite then reports the missing column. That is the read, not SQL_DOOR.
  doors(['SELECT "a$;"', 'SELECT [a$;]', 'SELECT `a$;`'], 'ERR_SQLITE_ERROR');
});

test('REPLACE( stays a read and a second write verb does not', () => {
  const fn = "SELECT REPLACE(title, 'a', 'b') FROM refs";
  assert.equal(provenRead(fn), true);
  doors([fn], 'ALLOW');
  for (const sql of WRITES) assert.equal(provenRead(sql), false, sql);
  doors(WRITES, 'SQL_DOOR');
});

test('the shipped INSERT OR REPLACE statements pass both doors', () => {
  const raw = memorySql();
  shipped(open(raw));
  hide(() => {
    const inner = memorySql();
    shipped(shut(inner));
  });
});

test('EXPLAIN is allowed on the primary door only as one bare plan', () => {
  const one = 'EXPLAIN QUERY PLAN DELETE FROM refs';
  const read = 'EXPLAIN QUERY PLAN SELECT 1';
  const ahead = '$a EXPLAIN QUERY PLAN DELETE FROM refs';
  assert.equal(provenRead(one), false);
  assert.equal(provenRead(read), true);
  doors([ahead], 'SQL_DOOR');
  doors([read], 'ALLOW');
  const raw = memorySql();
  const lib = open(raw);
  seed(lib);
  const before = snap(raw);
  assert.equal(codeOf(() => lib.exec(one)), 'ALLOW');
  assert.deepEqual(snap(raw), before);
  hide(() => {
    const inner = memorySql();
    const door = shut(inner);
    seed(door);
    const innerBefore = snap(inner);
    assert.equal(codeOf(() => door.exec(one)), 'SQL_DOOR');
    assert.deepEqual(snap(inner), innerBefore);
  });
});
