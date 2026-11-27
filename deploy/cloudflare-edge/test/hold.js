// Test seam. Product code never imports this file. The Library class does not
// expose its SQL handle; tests that seed or tamper keep the handle they passed in.
import { Library as RealLibrary } from '../src/library.js';

const HANDLES = new WeakMap();

export function Library(sql, opts) {
  const lib = new RealLibrary(sql, opts);
  HANDLES.set(lib, sql);
  return lib;
}

export function sqlOf(lib) {
  const sql = HANDLES.get(lib);
  if (!sql) throw new Error('This test has no raw handle for that Library.');
  return sql;
}
