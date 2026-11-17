// The LibraryStore constructor wires Durable Object storage into Library.
// Queries use storage.sql. Atomic work uses storage.transactionSync.
// Library passes that same function into ensureChain, so the first audit migration
// is one synchronous transaction. This module does not run a Cloudflare isolate.
import { Library } from './library.js';

const DO_ID = /^[0-9a-f]{64}$/;

export function libraryFromStorage(storage, options = {}) {
  if (typeof storage?.sql?.exec !== 'function' || typeof storage?.transactionSync !== 'function') {
    throw new Error('LibraryStore requires storage.sql and storage.transactionSync.');
  }
  return new Library(storage.sql, { ...options, transactionSync: fn => storage.transactionSync(fn) });
}

// The Durable Object path only. Tests and dev/local-edge.mjs construct Library directly and keep dbId ''.
export function openDurableLibrary(ctx, env, options = {}) {
  void env;
  const id = String(ctx?.id);
  if (!DO_ID.test(id)) {
    const err = new Error('LibraryStore requires a 64-character Durable Object id.');
    err.status = 500;
    throw err;
  }
  return libraryFromStorage(ctx.storage, { ...options, dbId: id });
}
