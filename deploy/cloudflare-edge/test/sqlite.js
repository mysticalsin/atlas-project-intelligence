// node:sqlite stand-in for Durable Object storage.sql. Application code must not send BEGIN,
// COMMIT, ROLLBACK, or SAVEPOINT: Cloudflare's SQL storage rejects those statements.
// Atomic work uses transactionSync, which is ctx.storage.transactionSync in production.
// This file emulates that method. It is not a Cloudflare Durable Object runtime.
import { DatabaseSync } from 'node:sqlite';
import { placeholderCount } from '../src/sql-text.js';
const CONTROL = /^(begin|commit|rollback|savepoint|release)\b/i;
// sqlite3_prepare_v2 consumes one statement and leaves a comment as no statement.
// node:sqlite throws when that leftover is prepared on its own.
function lead(text) {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === ';') { i++; continue; }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      if (i > text.length) i = text.length;
      continue;
    }
    break;
  }
  return text.slice(i);
}
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
      rest = lead(rest);
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
  // SQLite's own boundary: sourceSQL is the text sqlite3_prepare_v2 consumed.
  // A throw means this string did not prepare; the caller does not treat that as a tail.
  const statementTail = (q) => {
    const text = String(q ?? '');
    let stmt;
    try { stmt = db.prepare(text); }
    catch { return null; }
    const src = stmt.sourceSQL;
    if (!text.startsWith(src)) return null;
    return text.slice(src.length);
  };
  return { exec, transactionSync, statementTail };
}
