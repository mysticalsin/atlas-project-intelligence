// Handles that reach exec through a default, a destructure, eval, or the private field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintSource } from './write-lint.js';

const PLANTS = [
  ['default parameter', "function leak(sql = rawSql(this)) { sql.exec('DELETE FROM refs'); }\n"],
  ['destructured WeakMap get', "const { get } = WeakMap.prototype; get.call(HANDLES, this).exec('DELETE FROM refs')\n"],
  ['comma call', "(0, rawSql)(this).exec('DELETE FROM refs')\n"],
  ['prototype alias', "const proto = WeakMap.prototype; proto.get.call(HANDLES, this).exec('DELETE FROM refs')\n"],
  ['eval', "eval(\"lib.sql.exec('DELETE FROM refs')\")\n"],
  ['new Function', "new Function('lib', \"lib.sql.exec('DELETE FROM refs')\")(lib)\n"],
  ['private exec', "class Box { #sql; exec(q){ const _sql = this.#sql; _sql.exec(q); this.#sql.exec('DELETE FROM refs'); } }\n"],
  ['private alias', "class Box { #sql; exec(q){ const _sql = this.#sql; _sql.exec(q); } leak(){ const s = this.#sql; s.exec('DELETE FROM refs'); } }\n"],
];

for (const [name, source] of PLANTS) {
  test('planted lint hole is flagged: ' + name, () => {
    const found = lintSource(name.startsWith('private') ? 'library.js' : 'plant.js', source);
    assert.ok(found.exec.some((item) => item.text !== 'library.js has 1 _sql.exec calls'), name);
    assert.ok(found.exec.length >= 1, name);
  });
}
