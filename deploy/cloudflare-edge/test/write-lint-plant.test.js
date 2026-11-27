// These shapes still reach a handle or a private door. Each one must be a violation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintSource } from './write-lint.js';

const PLANTS = [
  ['computed identifier', "const k = 'sql'; lib[k].exec('INSERT INTO t (id) VALUES (1)')\n"],
  ['template key', "lib[`${'sql'}`].exec('INSERT INTO t (id) VALUES (1)')\n"],
  ['fromCharCode key', "lib[String.fromCharCode(115, 113, 108)].exec('INSERT INTO t (id) VALUES (1)')\n"],
  ['computed destructure', "const {[k]: sql} = lib; sql.exec('INSERT INTO t (id) VALUES (1)')\n"],
  ['assign', "Object.assign({}, lib).sql.exec('INSERT INTO t (id) VALUES (1)')\n"],
  ['descriptor', "Object.getOwnPropertyDescriptor(lib, 'sql').value.exec('INSERT INTO t (id) VALUES (1)')\n"],
  ['sequence', "(0, _sql.exec)('INSERT INTO t (id) VALUES (1)')\n"],
  ['rawSql exec', "rawSql(this).exec('INSERT INTO t (id) VALUES (1)')\n"],
  ['handles get', "HANDLES.get(this).exec('INSERT INTO t (id) VALUES (1)')\n"],
  ['aliased reflect', "const g = Reflect.get; g(lib, 'sql').exec('INSERT INTO t (id) VALUES (1)')\n"],
  ['_enter', "lib._enter(() => lib.exec('DELETE FROM refs'), 'recorded')\n"],
  ['registered', "lib.registered('drop-manager-trust')\n"],
  ['rewriteAudit', "lib.rewriteAudit(row => null)\n"],
];

for (const [name, source] of PLANTS) {
  test(`planted write is flagged: ${name}`, () => {
    const found = lintSource('plant.js', source);
    assert.ok(found.exec.length >= 1, name);
  });
}
