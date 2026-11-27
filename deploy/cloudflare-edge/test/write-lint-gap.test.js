// These plants are still clean. Each one has to be a violation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintSource } from './write-lint.js';

const PLANTS = [
  ['reflect-apply', "const _sql = rawSql(this);\nReflect.apply(_sql.exec, _sql, ['DELETE FROM refs']);\n"],
  ['comma-eval', '(0, eval)(\'1\');\n'],
  ['global-eval', 'globalThis.eval(\'1\');\n'],
  ['proto-default', 'let proto;\nproto = WeakMap.prototype;\nfunction leak({exec} = rawSql(this)) { exec(\'DELETE FROM refs\'); }\n'],
];

for (const [name, source] of PLANTS) {
  test('planted lint gap is flagged: ' + name, () => {
    const found = lintSource('plant.js', source);
    assert.ok(found.exec.length >= 1, name);
  });
}
