// The line lint misses these. Each one must be a violation, and the handle
// must not be readable off a Library instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { lintSource } from './write-lint.js';

const SALT = 'synthetic-log-salt';

const PLANTS = [
  ['alias', "const h = lib.sql; h.exec('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['bracket', "lib.sql['exec']('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['underscore', "lib._sql.exec('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['template', 'lib.sql.exec(`\nINSERT INTO door_probe (id) VALUES (1)`)\n'],
  ['concat', "lib.sql.exec('IN' + 'SERT INTO door_probe (id) VALUES (1)')\n"],
  ['bind', "const run = lib.sql.exec.bind(lib.sql); run('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['comment', 'lib.sql.exec(`--\nINSERT INTO door_probe (id) VALUES (1)`)\n'],
  ['storage', "ctx.storage.sql.exec('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['destructure', "const {sql}=lib; sql.exec('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['reflect', "Reflect.get(lib, 'sql').exec('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['computed', "lib['s'+'ql'].exec('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['values', "Object.values(lib)[0].exec('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['prototype', "Library.prototype.exec.call(lib, 'INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['bind-local', "const _sql = rawSql(this); _sql.exec.bind(_sql)('INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['call', "const _sql = rawSql(this); _sql.exec.call(_sql, 'INSERT INTO door_probe (id) VALUES (1)')\n"],
  ['apply', "const _sql = rawSql(this); _sql.exec.apply(_sql, ['INSERT INTO door_probe (id) VALUES (1)'])\n"],
];

for (const [name, source] of PLANTS) {
  test(`planted raw-handle evasion is flagged: ${name}`, () => {
    const found = lintSource('plant.js', source);
    assert.ok(found.exec.length >= 1, name);
  });
}

test('call and apply beside the allowed exec are flagged', () => {
  const source = [
    'function exec(q){',
    '  const _sql = rawSql(this);',
    '  _sql.exec(q);',
    '  _sql.exec.call(_sql, q);',
    '  _sql.exec.apply(_sql, [q]);',
    '  _sql.exec.bind(_sql)(q);',
    '}',
    '',
  ].join('\n');
  const found = lintSource('library.js', source);
  assert.ok(found.exec.length >= 3);
});

test('the raw handle is not a property of Library', () => {
  const lib = new Library(memorySql(), { auditKey: SALT });
  assert.equal(lib.sql, undefined);
  assert.equal(lib._sql, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(lib, 'sql'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(lib, '_sql'), false);
});
