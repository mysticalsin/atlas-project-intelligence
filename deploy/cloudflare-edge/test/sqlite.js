// node:sqlite stand-in for Durable Object storage.sql. Application code must not send BEGIN,
// COMMIT, ROLLBACK, or SAVEPOINT: Cloudflare's SQL storage rejects those statements.
// Atomic work uses transactionSync, which is ctx.storage.transactionSync in production.
// This file emulates that method. It is not a Cloudflare Durable Object runtime.
import { DatabaseSync } from 'node:sqlite';
const CONTROL = /^(begin|commit|rollback|savepoint|release)\b/i;
export function memorySql() {
  const db = new DatabaseSync(':memory:');
  const exec = (q, ...params) => {
    const text = String(q).trim();
    if (CONTROL.test(text)) throw new Error('Durable Object SQL does not accept ' + text.split(/\s+/)[0] + '. Use storage.transactionSync.');
    const rows = db.prepare(q).all(...params.map(p => p === undefined ? null : p));
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
