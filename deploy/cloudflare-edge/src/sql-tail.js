// The prepared-statement tail, from node:sqlite's sourceSQL (sqlite3_prepare_v2).
// Workerd 2026-10-23 SqlStorage exposes exec and returns rows. It does not expose
// the unconsumed tail. This module is the equivalent real-SQLite check. On an
// isolate where node:sqlite is absent it returns null, and Library then refuses
// a semicolon that still has SQL after it.
import { slice, textOf } from './primordials.js';
let scratch = null;
let unavailable = false;

function databaseSync() {
  try {
    const mod = globalThis.process?.getBuiltinModule?.('node:sqlite');
    return mod?.DatabaseSync || null;
  } catch {
    return null;
  }
}

export function sqliteRemainder(sql) {
  if (unavailable) return null;
  const DatabaseSync = databaseSync();
  if (!DatabaseSync) return null;
  if (!scratch) {
    try {
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE refs (id, title, begin)');
      db.exec('CREATE TABLE audit (id, seq)');
      db.exec('CREATE TABLE consent_receipts (id)');
      scratch = db;
    } catch {
      unavailable = true;
      return null;
    }
  }
  const text = textOf(sql ?? '');
  if (typeof text !== 'string') return null;
  let stmt;
  try { stmt = scratch.prepare(text); }
  catch { return null; }
  const src = stmt.sourceSQL;
  if (!text.startsWith(src)) return null;
  const tail = slice(text, src.length);
  return typeof tail === 'string' ? tail : null;
}
