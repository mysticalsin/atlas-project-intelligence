// The prepared-statement tail, from node:sqlite's sourceSQL (sqlite3_prepare_v2).
// Workerd 2026-10-23 SqlStorage exposes exec and returns rows. It does not expose
// the unconsumed tail. This module is the equivalent real-SQLite check. On an
// isolate where node:sqlite is absent it returns null, and Library then refuses
// a semicolon that still has SQL after it.
let scratch = null;

function databaseSync() {
  const mod = globalThis.process?.getBuiltinModule?.('node:sqlite');
  return mod?.DatabaseSync || null;
}

export function sqliteRemainder(sql) {
  const DatabaseSync = databaseSync();
  if (!DatabaseSync) return null;
  if (!scratch) {
    scratch = new DatabaseSync(':memory:');
    scratch.exec('CREATE TABLE refs (id, title, begin)');
    scratch.exec('CREATE TABLE audit (id, seq)');
    scratch.exec('CREATE TABLE consent_receipts (id)');
  }
  const text = String(sql ?? '');
  let stmt;
  try { stmt = scratch.prepare(text); }
  catch { return null; }
  const src = stmt.sourceSQL;
  if (!text.startsWith(src)) return null;
  return text.slice(src.length);
}
