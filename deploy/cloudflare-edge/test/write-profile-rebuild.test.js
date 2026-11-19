// A profile rebuild writes nothing, and a damaged chain stops the daily sweep before retention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';
import * as profile from '../src/profile.js';
import { libraryRoutes } from '../src/library-routes.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-17T05:00:00.000Z';

function open(sql = memorySql()) {
  return new Library(sql, { now: () => STAMP, auditKey: SALT });
}
function tamper(lib) {
  sqlOf(lib).exec("UPDATE audit SET detail = detail || ' tampered' WHERE action != 'chain-start'");
}

test('rebuilding an old profiles table writes one metadata line and moves the anchor', () => {
  const sql = memorySql();
  sql.exec('CREATE TABLE profiles (subject TEXT PRIMARY KEY, email TEXT, edits TEXT, signin TEXT, consents TEXT, created_at TEXT, updated_at TEXT, seen_at TEXT)');
  sql.exec("INSERT INTO profiles (subject, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES ('ada@example.test', 'ada@example.test', '{}', '{}', '{}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '')");
  const lib = open(sql);
  profile.ensure(lib);
  const lines = lib.rows("SELECT action, detail FROM audit WHERE action = 'profile rebuild'");
  assert.equal(lines.length, 1);
  assert.equal(String(lines[0].detail).includes('SELECT'), false);
  assert.equal(String(lines[0].detail).includes('DROP'), false);
  const anchor = sql.exec('SELECT n FROM audit_anchor WHERE id = 1').toArray()[0];
  assert.equal(anchor.n > 1, true);
  assert.equal(lib.rows('SELECT subject, tenant FROM profiles')[0].tenant, '');
});

test('a second ensure on a current profile writes nothing, including on a damaged chain', () => {
  const lib = open();
  profile.ensure(lib);
  lib.log('library', 'ada@example.test', 'saved', 'seed');
  assert.equal(lib.rows("SELECT COUNT(*) AS n FROM audit WHERE action = 'profile rebuild'")[0].n, 0);
  const before = lib.rows('SELECT COUNT(*) AS n FROM audit')[0].n;
  tamper(lib);
  const again = open(sqlOf(lib));
  let err;
  try { profile.ensure(again); }
  catch (error) { err = error; }
  assert.equal(err, undefined);
  assert.equal(again.rows('SELECT COUNT(*) AS n FROM audit')[0].n, before);
});

test('the daily sweep still erases an old draft when the profile rebuild cannot write', async () => {
  const sql = memorySql();
  sql.exec('CREATE TABLE profiles (subject TEXT PRIMARY KEY, email TEXT, edits TEXT, signin TEXT, consents TEXT, created_at TEXT, updated_at TEXT, seen_at TEXT)');
  const lib = open(sql);
  lib.recorded(() => {
    lib.exec("INSERT INTO refs (id, owner, title, status, revision, data, state, updated_at, tenant) VALUES ('draft-1', 'ada@example.test', 'old draft', 'in_review', 1, '{}', '{\"draft\":true}', '2020-01-01T00:00:00.000Z', '')");
    lib.log('draft-1', 'ada@example.test', 'saved', 'draft');
  });
  tamper(lib);
  const res = await libraryRoutes(new Request('https://atlas.internal/api/library/scan-stale', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-atlas-user': 'atlas-cron', 'x-atlas-role': 'system' },
  }), lib, { env: { ATLAS_TENANT_ISOLATION: 'local-synthetic' } });
  assert.equal(lib.rows("SELECT merged_into FROM refs WHERE id = 'draft-1'")[0].merged_into, 'erased');
  assert.equal(res.status === 200 || res.status === 409, true);
});
