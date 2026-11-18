// Durable Object SQL allows 100 bound parameters on one statement. This is the only
// place that builds a '?' list. `fixed` is every other bound parameter, including a
// tenant filter. `copies` is how many times the chunk itself is bound.
export const BOUND_MAX = 100;

export function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function roomFor(fixed, copies) {
  const room = Math.floor((BOUND_MAX - fixed) / copies);
  if (!Number.isInteger(fixed) || !Number.isInteger(copies) || copies < 1 || room < 1) {
    throw new Error('Durable Object SQL allows at most 100 bound parameters.');
  }
  return room;
}

function boundParams(chunk, fixed, copies, params) {
  const bound = params(chunk);
  if (bound.length !== fixed + copies * chunk.length || bound.length > BOUND_MAX) {
    throw new Error('Durable Object SQL allows at most 100 bound parameters.');
  }
  return bound;
}

export function readChunks(lib, values, spec) {
  const rows = [];
  if (!values?.length) return rows;
  const fixed = spec.fixed || 0;
  const copies = spec.copies || 1;
  const room = roomFor(fixed, copies);
  for (let at = 0; at < values.length; at += room) {
    const chunk = values.slice(at, at + room);
    rows.push(...lib.rows(spec.sql(chunk), ...boundParams(chunk, fixed, copies, spec.params)));
  }
  return rows;
}

// One transaction per caller. A chunked write joins it instead of opening another.
const openTransaction = new WeakMap();

export function withTransaction(lib, fn) {
  if (typeof lib.transactionSync !== 'function') throw new Error('Chunked writes require transactionSync.');
  if (openTransaction.get(lib)) return fn();
  return lib.transactionSync(() => {
    openTransaction.set(lib, true);
    try { return fn(); }
    finally { openTransaction.delete(lib); }
  });
}

// Every chunk of every group commits in one transactionSync. A throw rolls them all back.
// A caller already inside withTransaction keeps these chunks in that transaction.
export function writeChunks(lib, groups) {
  const pending = (groups || []).filter(group => group.values?.length);
  if (!pending.length) return;
  withTransaction(lib, () => {
    for (const group of pending) {
      const fixed = group.fixed || 0;
      const copies = group.copies || 1;
      const room = roomFor(fixed, copies);
      for (let at = 0; at < group.values.length; at += room) {
        const chunk = group.values.slice(at, at + room);
        lib.sql.exec(group.sql(chunk), ...boundParams(chunk, fixed, copies, group.params));
      }
    }
  });
}
