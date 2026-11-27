// An alias or a parameter can carry the raw handle. Each of these is a violation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintSource } from './write-lint.js';

const PLANTS = [
  ['aliased rawSql', "const f = rawSql; f(this).exec('DELETE FROM refs')\n"],
  ['passed rawSql', "leak(rawSql(this));\n"],
  ['parameter', "function leak(sql) { sql.exec('DELETE FROM refs'); }\nleak(rawSql(this));\n"],
  ['aliased HANDLES.get', "const H = HANDLES; const get = HANDLES.get; get.call(H, this).exec('DELETE FROM refs')\n"],
  ['WeakMap.prototype.get.call', "WeakMap.prototype.get.call(HANDLES, this).exec('DELETE FROM refs')\n"],
  ['aliased WeakMap.prototype.get', "const get = WeakMap.prototype.get; get.call(HANDLES, this).exec('DELETE FROM refs')\n"],
];

for (const [name, source] of PLANTS) {
  test('planted handle alias is flagged: ' + name, () => {
    const found = lintSource('plant.js', source);
    assert.ok(found.exec.length >= 1, name);
  });
}
