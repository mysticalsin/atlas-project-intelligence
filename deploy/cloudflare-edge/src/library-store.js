// The LibraryStore constructor wires Durable Object storage into Library.
// Queries use storage.sql. Atomic work uses storage.transactionSync.
// This module does not run a Cloudflare isolate.
import { Library } from './library.js';

export function libraryFromStorage(storage, options = {}) {
  if (typeof storage?.sql?.exec !== 'function' || typeof storage?.transactionSync !== 'function') {
    throw new Error('LibraryStore requires storage.sql and storage.transactionSync.');
  }
  return new Library(storage.sql, { ...options, transactionSync: fn => storage.transactionSync(fn) });
}
