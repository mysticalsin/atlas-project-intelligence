// Durable Object SQL allows 100 bound parameters. A negative fixed count must not
// widen the chunk past that ceiling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readChunks } from '../src/sql-bound.js';

test('a negative fixed count cannot build a statement over 100 parameters', () => {
  const calls = [];
  const lib = {
    rows(sql, ...params) {
      calls.push({ marks: (sql.match(/\?/g) || []).length, params: params.length });
      return [];
    },
  };
  const values = Array.from({ length: 101 }, (_, i) => 'k' + i);
  assert.throws(() => readChunks(lib, values, {
    fixed: -1,
    sql: chunk => 'SELECT ' + chunk.map(() => '?').join(','),
    params: chunk => chunk.slice(0, -1),
  }), /100 bound parameters/);
  assert.equal(calls.length, 0);
});

test('one hundred bound values still fit in one statement', () => {
  const calls = [];
  const lib = {
    rows(sql, ...params) {
      calls.push((sql.match(/\?/g) || []).length);
      assert.equal(params.length, calls.at(-1));
      return [{ n: 1 }];
    },
  };
  const values = Array.from({ length: 100 }, (_, i) => i);
  const rows = readChunks(lib, values, {
    sql: chunk => 'SELECT ' + chunk.map(() => '?').join(','),
    params: chunk => chunk,
  });
  assert.deepEqual(calls, [100]);
  assert.equal(rows.length, 1);
});
