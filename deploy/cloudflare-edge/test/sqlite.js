// node:sqlite stand-in for Durable Object storage.sql. Application code must not send BEGIN,
// COMMIT, ROLLBACK, or SAVEPOINT: Cloudflare's SQL storage rejects those statements.
// Atomic work uses transactionSync, which is ctx.storage.transactionSync in production.
// This file emulates that method. It is not a Cloudflare Durable Object runtime.
import { DatabaseSync } from 'node:sqlite';
import { placeholderCount } from '../src/sql-text.js';
const CONTROL = /^(begin|commit|rollback|savepoint|release)\b/i;
// Cloudflare Durable Object SQL rejects a statement with more than 100 bound parameters.
const BOUND_MAX = 100;
export function memorySql() {
  const db = new DatabaseSync(':memory:');
  // Durable Object sql.exec runs every statement in the string. prepare().all() does not.
  // Cloudflare sql.exec prepares one statement with sqlite3_prepare_v2 and runs the tail.
  // The product splitter is not used here: a tail it fails to see still runs.
  const exec = (q, ...params) => {
    if (params.length > BOUND_MAX) throw new Error('Durable Object SQL allows at most 100 bound parameters.');
    let rest = String(q ?? '');
    let rows = [];
    let offset = 0;
    while (rest.trim()) {
      rest = rest.replace(/^(\s*;)+/, '');
      if (!rest.trim()) break;
      const stmt = db.prepare(rest);
      const src = stmt.sourceSQL;
      if (!rest.startsWith(src)) throw new Error('SQLite prepared a statement that was not a prefix of the input.');
      const text = src.trim();
      if (CONTROL.test(text)) throw new Error('Durable Object SQL does not accept ' + text.split(/\s+/)[0] + '. Use storage.transactionSync.');
      const n = placeholderCount(src);
      const slice = params.slice(offset, offset + n).map(p => p === undefined ? null : p);
      offset += n;
      rows = stmt.all(...slice);
      rest = rest.slice(src.length);
    }
    return { toArray: () => rows.map(r => ({ ...r })) };
  };
  const transactionSync = fn => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction is already closed */ }
      throw error;
    }
  };
  return { exec, transactionSync };
}
