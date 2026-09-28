// node:sqlite adapter with the Durable Object SQL API shape: exec(query, ...params) -> { toArray() }.
import { DatabaseSync } from 'node:sqlite';
export function memorySql() {
  const db = new DatabaseSync(':memory:');
  return { exec(q, ...params) { const rows = db.prepare(q).all(...params.map(p => p === undefined ? null : p)); return { toArray: () => rows.map(r => ({ ...r })) }; } };
}
