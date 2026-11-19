// node:sqlite stand-in for Durable Object storage.sql. Application code must not send BEGIN,
// COMMIT, ROLLBACK, or SAVEPOINT: Cloudflare's SQL storage rejects those statements.
// Atomic work uses transactionSync, which is ctx.storage.transactionSync in production.
// This file emulates that method. It is not a Cloudflare Durable Object runtime.
import { DatabaseSync } from 'node:sqlite';
import { placeholderCount, splitStatements } from '../src/sql-text.js';
const CONTROL = /^(begin|commit|rollback|savepoint|release)\b/i;
// Cloudflare Durable Object SQL rejects a statement with more than 100 bound parameters.
const BOUND_MAX = 100;
export function memorySql() {
  const db = new DatabaseSync(':memory:');
  // Durable Object sql.exec runs every statement in the string. prepare().all() does not.
  const exec = (q, ...params) => {
    if (params.length > BOUND_MAX) throw new Error('Durable Object SQL allows at most 100 bound parameters.');
    const parts = splitStatements(q);
    let rows = [];
    let offset = 0;
    for (const part of parts) {
      const text = part.trim();
      if (CONTROL.test(text)) throw new Error('Durable Object SQL does not accept ' + text.split(/\s+/)[0] + '. Use storage.transactionSync.');
      const n = placeholderCount(part);
      const slice = params.slice(offset, offset + n).map(p => p === undefined ? null : p);
      offset += n;
      rows = db.prepare(part).all(...slice);
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
