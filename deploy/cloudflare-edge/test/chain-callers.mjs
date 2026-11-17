// One caller in the eight-way migration race. The parent owns the database file.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { ensureChain, verifyDaily } from '../src/audit-chain.js';

const locked = e => /locked|busy/i.test(String(e?.message || e));
function open() {
  const db = new DatabaseSync(workerData.file);
  db.exec('PRAGMA busy_timeout = 5000');
  let depth = 0;
  const exec = (q, ...params) => {
    const rows = db.prepare(q).all(...params.map(p => p === undefined ? null : p));
    return { toArray: () => rows.map(r => ({ ...r })) };
  };
  // Same rollback rule as test/sqlite.js. BEGIN IMMEDIATE takes the write lock first,
  // so a waiting caller starts after the peer's migration has committed.
  const transactionSync = fn => {
    if (depth > 0) return fn();
    depth += 1;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction is already closed */ }
      throw error;
    } finally { depth -= 1; }
  };
  return { db, exec, transactionSync };
}
try {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { db, exec, transactionSync } = open();
    try {
      const sql = { exec, transactionSync };
      ensureChain(sql, workerData.key ?? '', transactionSync);
      const daily = verifyDaily(sql, workerData.key ?? '');
      let signed = [];
      try { signed = exec('SELECT actor, "commit" FROM audit').toArray().filter(r => r.commit).map(r => r.actor); } catch { signed = []; }
      last = { ok: daily.ok === true, reason: String(daily.reason || ''), legacyUnverified: Number(daily.legacyUnverified || 0), signed };
      break;
    } catch (e) {
      last = { error: String(e?.message || e), ok: false, reason: '', legacyUnverified: 0, signed: [] };
      if (!locked(e) || attempt === 7) break;
    } finally { try { db.close(); } catch { /* already closed */ } }
  }
  parentPort.postMessage(last);
} catch (e) {
  parentPort.postMessage({ error: String(e?.message || e), ok: false, reason: '', legacyUnverified: 0, signed: [] });
}
