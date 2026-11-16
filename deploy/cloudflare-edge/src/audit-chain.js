// Tamper-evident library audit trail (blue review G7). Every audit row carries `prev_hash` (the previous row's hash) and
// `hash = SHA-256(prev, id, action, at)`. actor and detail are outside the link: erasure may pseudonymise them without
// rewriting later rows, including another tenant's prev_hash. Editing the action, the id or the time still breaks the chain
// from that row. verifyChain finds the first broken row. The daily cron runs verifyDaily, which stores n and head and logs
// `audit_chain_ok` or `audit_chain_break`. A shorter chain than the stored anchor is `TRUNCATED`.
// SHA-256 is implemented here, synchronously, because Library.log is synchronous and WebCrypto is async-only.
// Limits, honestly: whoever can rewrite the whole table AND recompute every hash is not stopped by an in-table chain.
// Deleting the oldest prefix leaves a valid in-table chain; the stored anchor is what notices the missing rows.
export const GENESIS = '0'.repeat(64);

const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256Hex(text) {
  const msg = new TextEncoder().encode(String(text)), bits = msg.length * 8, padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg); padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32)); view.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) { const a = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), b = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + a + w[i - 7] + b) | 0; }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

// JSON array, not a delimiter-joined string: no field value can shift a boundary. `seq` is excluded (an autoincrement may skip).
// actor and detail are omitted on purpose. They are the fields a privacy rewrite is allowed to change, and including them
// forced a reseal of every later row, including other tenants. id, action and at stay, so a changed action still mismatches.
export const rowHash = (prev, r) => sha256Hex(JSON.stringify([prev, String(r.id ?? ''), String(r.action ?? ''), String(r.at ?? '')]));

const sealed = new WeakSet();
// Adds the two columns to an audit table created before the chain existed and seals every unsealed row in sequence order
// (so the existing history is protected from this point on). Idempotent; runs once per SQL handle.
export function ensureChain(sql) {
  if (sealed.has(sql)) return;
  try { sql.exec('SELECT prev_hash, hash FROM audit LIMIT 0'); }
  catch { sql.exec('ALTER TABLE audit ADD COLUMN prev_hash TEXT'); sql.exec('ALTER TABLE audit ADD COLUMN hash TEXT'); }
  if (sql.exec('SELECT 1 AS x FROM audit WHERE hash IS NULL LIMIT 1').toArray().length) {
    let prev = GENESIS;
    for (const r of sql.exec('SELECT seq, id, actor, action, at, detail, hash FROM audit ORDER BY seq').toArray()) {
      if (r.hash) { prev = r.hash; continue; }
      const h = rowHash(prev, r);
      sql.exec('UPDATE audit SET prev_hash = ?, hash = ? WHERE seq = ?', prev, h, r.seq);
      prev = h;
    }
  }
  sealed.add(sql);
}

// The single write path for audit rows (called from Library.log).
export function appendAudit(sql, { id, actor, action, at, detail }) {
  ensureChain(sql);
  const last = sql.exec('SELECT hash FROM audit WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1').toArray()[0];
  const prev = last?.hash || GENESIS, row = { id, actor, action, at, detail };
  sql.exec('INSERT INTO audit (id, actor, action, at, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)', id, actor, action, at, detail, prev, rowHash(prev, row));
}

// Walks the table in order (500 rows at a time). { ok: true, checked, head } or { ok: false, checked, brokenSeq, reason, head }.
// reasons: UNSEALED (a row without a hash), HASH_MISMATCH (row content changed), LINK_BROKEN (a row was removed or inserted before it).
export function verifyChain(sql) {
  ensureChain(sql);
  let after = 0, prevHash = null, checked = 0, head = GENESIS;
  for (;;) {
    const rows = sql.exec('SELECT seq, id, actor, action, at, detail, prev_hash, hash FROM audit WHERE seq > ? ORDER BY seq LIMIT 500', after).toArray();
    if (!rows.length) return { ok: true, checked, head };
    for (const r of rows) {
      const bad = reason => ({ ok: false, checked, brokenSeq: r.seq, reason, head });
      if (!r.hash || !r.prev_hash) return bad('UNSEALED');
      if (prevHash !== null && r.prev_hash !== prevHash) return bad('LINK_BROKEN');
      if (rowHash(r.prev_hash, r) !== r.hash) return bad('HASH_MISMATCH');
      prevHash = head = r.hash; after = r.seq; checked++;
    }
  }
}

// G2: a privacy rewrite (erasure of a person, the retention pseudonymisation). `edit(row)` returns {actor, detail} or null.
// Only those two columns are written. prev_hash and hash stay, so a later row's link does not move and another tenant's
// row is not resealed. X1 (red M8): the chain is VERIFIED FIRST. A broken chain is left exactly as it is and the call
// returns { refused: true, reason, brokenSeq, changed: 0 }.
export function rewriteRows(sql, edit) {
  const before = verifyChain(sql);
  if (!before.ok) return { refused: true, reason: before.reason, brokenSeq: before.brokenSeq, changed: 0, head: before.head, previousHead: before.head };
  let changed = 0;
  for (const r of sql.exec('SELECT seq, id, actor, action, at, detail, prev_hash, hash FROM audit ORDER BY seq').toArray()) {
    const patch = edit(r);
    if (!patch) continue;
    const actor = patch.actor ?? r.actor, detail = patch.detail ?? r.detail;
    if (actor === r.actor && detail === r.detail) continue;
    sql.exec('UPDATE audit SET actor = ?, detail = ? WHERE seq = ?', actor, detail, r.seq);
    changed++;
  }
  return { changed, head: before.head, previousHead: before.head };
}

// Daily check. Stores n and the head when the chain verifies and is not shorter than the last anchor.
// A drop in n is TRUNCATED and the anchor is left, so the next run still reports it. A mid-chain edit keeps
// verifyChain's reason and does not move the anchor.
export function verifyDaily(sql) {
  ensureChain(sql);
  sql.exec('CREATE TABLE IF NOT EXISTS audit_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, head TEXT NOT NULL)');
  const result = verifyChain(sql);
  const prev = sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0] || null;
  if (!result.ok) return result;
  if (prev && result.checked < Number(prev.n)) return { ok: false, reason: 'TRUNCATED', checked: result.checked, head: result.head, previousN: Number(prev.n), previousHead: prev.head };
  sql.exec('INSERT INTO audit_anchor (id, n, head) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n, head = excluded.head', result.checked, result.head);
  return { ok: true, checked: result.checked, head: result.head, reason: 'CHAIN_VERIFIED' };
}
