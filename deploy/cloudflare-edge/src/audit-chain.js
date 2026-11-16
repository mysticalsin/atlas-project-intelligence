// Tamper-evident library audit trail. Every row stores prev_hash, hash and commit.
// commit = HMAC(key, canonical(actor, detail)). hash = SHA-256(prev, id, action, at, commit).
// A privacy rewrite may replace actor and detail only by writing an exact tombstone
// (actor matches ^erased:[0-9a-f]{12}$, detail is empty) plus
// proof = HMAC(key, JSON.stringify(['tombstone', seq, commit, actor])).
// It does not recompute hash or prev_hash, so a later row, including another tenant's, is never resealed.
// verify accepts a row when the HMAC of the current actor and detail equals commit, or when
// the tombstone and its proof both match. A direct edit of either field fails.
// The daily check stores n and head. A shorter chain is TRUNCATED. The stored head must still
// be the hash at that same position, so a prefix truncate padded with new rows is ANCHOR_MOVED.
// ensureChain fills only rows whose hash is NULL. A row whose hash matches only an earlier
// formula fails verify. There is no reseal and no upgrade.
// SHA-256 and HMAC-SHA256 are synchronous because Library.log is synchronous.
// Limits, honestly: whoever can rewrite the whole table and recompute every hash and commit
// is not stopped by an in-table chain. The daily anchor is what notices a missing prefix.
import { timingSafe } from './timing-safe.js';
export const GENESIS = '0'.repeat(64);
const TOMBSTONE_ACTOR = /^erased:[0-9a-f]{12}$/;

const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
function sha256Bytes(msg) {
  const bits = msg.length * 8, padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
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
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
export function sha256Hex(text) {
  return hex(sha256Bytes(new TextEncoder().encode(String(text))));
}
// HMAC-SHA256. A key longer than the 64-byte block is hashed first, the same rule as RFC 2104.
export function hmacHex(key, message) {
  const enc = new TextEncoder();
  let k = enc.encode(String(key ?? ''));
  if (k.length > 64) k = sha256Bytes(k);
  const block = new Uint8Array(64);
  block.set(k);
  const ipad = new Uint8Array(64), opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { ipad[i] = block[i] ^ 0x36; opad[i] = block[i] ^ 0x5c; }
  const inner = sha256Bytes(concat(ipad, enc.encode(String(message ?? ''))));
  return hex(sha256Bytes(concat(opad, inner)));
}

// Same key material as the subject pseudonym. Production without LOG_SALT fails closed (null).
// A missing env is the unit-test key, the empty string, shared by append and verify.
export function auditKey(env) {
  if (!env) return '';
  if (env.LOG_SALT) return String(env.LOG_SALT);
  if (String(env.DATA_MODE || '').toLowerCase() === 'production') return null;
  if (env.CSRF_SECRET) return 'subject-v1:' + env.CSRF_SECRET;
  return '';
}
const canonical = (actor, detail) => JSON.stringify([String(actor ?? ''), String(detail ?? '')]);
export const contentCommit = (key, actor, detail) => hmacHex(key, canonical(actor, detail));
// One JSON array, so seq 1 cannot borrow seq 10's proof by shifting a character, and the actor token is inside the MAC.
export const tombstoneProof = (key, seq, commit, actor) => hmacHex(key, JSON.stringify(['tombstone', Number(seq), String(commit ?? ''), String(actor ?? '')]));
function sameText(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  return timingSafe(x, y);
}

// JSON array, not a delimiter-joined string: no field value can shift a boundary. seq is excluded.
// commit is included, so actor and detail are bound without putting their text in the hash.
export const rowHash = (prev, r) => sha256Hex(JSON.stringify([prev, String(r.id ?? ''), String(r.action ?? ''), String(r.at ?? ''), String(r.commit ?? '')]));

const sealed = new WeakSet();
const qident = name => '"' + name + '"';
const hasColumn = (sql, name) => { try { sql.exec('SELECT ' + qident(name) + ' FROM audit LIMIT 0'); return true; } catch { return false; } };
// Adds the chain columns and seals rows that have never been hashed. Rows that already have a hash
// are left alone. A hash from an earlier formula stays a mismatch.
export function ensureChain(sql, key = '') {
  if (sealed.has(sql)) return;
  if (!hasColumn(sql, 'prev_hash')) sql.exec('ALTER TABLE audit ADD COLUMN prev_hash TEXT');
  if (!hasColumn(sql, 'hash')) sql.exec('ALTER TABLE audit ADD COLUMN hash TEXT');
  if (!hasColumn(sql, 'commit')) sql.exec('ALTER TABLE audit ADD COLUMN "commit" TEXT');
  if (!hasColumn(sql, 'tombstone')) sql.exec('ALTER TABLE audit ADD COLUMN tombstone TEXT');
  if (key != null && sql.exec('SELECT 1 AS x FROM audit WHERE hash IS NULL LIMIT 1').toArray().length) {
    let prev = GENESIS;
    for (const r of sql.exec('SELECT seq, id, actor, action, at, detail, hash, "commit" FROM audit ORDER BY seq').toArray()) {
      if (r.hash) { prev = r.hash; continue; }
      const commit = r.commit || contentCommit(key, r.actor, r.detail);
      const proof = TOMBSTONE_ACTOR.test(String(r.actor || '')) && String(r.detail ?? '') === '' ? tombstoneProof(key, r.seq, commit, r.actor) : '';
      const h = rowHash(prev, { ...r, commit });
      sql.exec('UPDATE audit SET prev_hash = ?, hash = ?, "commit" = ?, tombstone = ? WHERE seq = ?', prev, h, commit, proof, r.seq);
      prev = h;
    }
  }
  sealed.add(sql);
}

// The single write path for audit rows (called from Library.log).
export function appendAudit(sql, { id, actor, action, at, detail }, key = '') {
  if (key == null) { const err = new Error('LOG_SALT is not set.'); err.status = 503; throw err; }
  ensureChain(sql, key);
  const last = sql.exec('SELECT hash FROM audit WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1').toArray()[0];
  const prev = last?.hash || GENESIS, commit = contentCommit(key, actor, detail);
  sql.exec('INSERT INTO audit (id, actor, action, at, detail, prev_hash, hash, "commit", tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, actor, action, at, detail, prev, rowHash(prev, { id, action, at, commit }), commit, '');
}

const ROW = 'seq, id, actor, action, at, detail, prev_hash, hash, "commit", tombstone';
function bound(key, r) {
  const commit = String(r.commit ?? '');
  if (sameText(contentCommit(key, r.actor, r.detail), commit)) return true;
  return TOMBSTONE_ACTOR.test(String(r.actor || '')) && String(r.detail ?? '') === '' && !!r.tombstone && sameText(r.tombstone, tombstoneProof(key, r.seq, commit, r.actor));
}
// Walks the table in order (500 rows at a time). { ok, checked, head } or { ok: false, brokenSeq, reason, head }.
// reasons: UNSEALED, HASH_MISMATCH, LINK_BROKEN, COMMIT_MISMATCH, LOG_SALT.
export function verifyChain(sql, key = '') {
  ensureChain(sql, key);
  if (key == null) return { ok: false, checked: 0, brokenSeq: null, reason: 'LOG_SALT', head: GENESIS };
  let after = 0, prevHash = null, checked = 0, head = GENESIS;
  for (;;) {
    const rows = sql.exec(`SELECT ${ROW} FROM audit WHERE seq > ? ORDER BY seq LIMIT 500`, after).toArray();
    if (!rows.length) return { ok: true, checked, head };
    for (const r of rows) {
      const bad = reason => ({ ok: false, checked, brokenSeq: r.seq, reason, head });
      if (!r.hash || !r.prev_hash) return bad('UNSEALED');
      if (prevHash !== null && r.prev_hash !== prevHash) return bad('LINK_BROKEN');
      if (!sameText(rowHash(r.prev_hash, r), r.hash)) return bad('HASH_MISMATCH');
      if (!bound(key, r)) return bad('COMMIT_MISMATCH');
      prevHash = head = r.hash; after = r.seq; checked++;
    }
  }
}

// A privacy rewrite. edit(row) returns { actor, detail } or null. The only accepted write is a tombstone:
// actor and detail are replaced and the proof is stored. prev_hash, hash and commit stay, so later rows
// are not resealed. The chain is verified first. A broken chain is left exactly as it is.
export function rewriteRows(sql, edit, key = '') {
  if (key == null) return { refused: true, reason: 'LOG_SALT', brokenSeq: null, changed: 0, head: null, previousHead: null };
  const before = verifyChain(sql, key);
  if (!before.ok) return { refused: true, reason: before.reason, brokenSeq: before.brokenSeq, changed: 0, head: before.head, previousHead: before.head };
  let changed = 0;
  for (const r of sql.exec(`SELECT ${ROW} FROM audit ORDER BY seq`).toArray()) {
    const patch = edit(r);
    if (!patch) continue;
    const actor = String(patch.actor ?? r.actor ?? ''), detail = String(patch.detail ?? r.detail ?? '');
    if (actor === String(r.actor ?? '') && detail === String(r.detail ?? '')) continue;
    if (!TOMBSTONE_ACTOR.test(actor) || detail !== '') continue;
    sql.exec('UPDATE audit SET actor = ?, detail = ?, tombstone = ? WHERE seq = ?', actor, '', tombstoneProof(key, r.seq, String(r.commit ?? ''), actor), r.seq);
    changed++;
  }
  return { changed, head: before.head, previousHead: before.head };
}

const ANCHOR = 'CREATE TABLE IF NOT EXISTS audit_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, head TEXT NOT NULL)';
// Daily check. Stores n and the head when the chain verifies, is not shorter than the last anchor,
// and the stored head is still the hash at that position. Otherwise the anchor is left where it is.
export function verifyDaily(sql, key = '') {
  ensureChain(sql, key);
  sql.exec(ANCHOR);
  if (key == null) return { ok: false, reason: 'LOG_SALT', checked: 0, head: GENESIS };
  const result = verifyChain(sql, key);
  const prev = sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0] || null;
  if (!result.ok) return result;
  if (prev && result.checked < Number(prev.n)) return { ok: false, reason: 'TRUNCATED', checked: result.checked, head: result.head, previousN: Number(prev.n), previousHead: prev.head };
  if (prev && Number(prev.n) > 0) {
    const at = sql.exec('SELECT hash FROM audit ORDER BY seq LIMIT 1 OFFSET ?', Number(prev.n) - 1).toArray()[0];
    if (!at || !sameText(at.hash, prev.head)) return { ok: false, reason: 'ANCHOR_MOVED', checked: result.checked, head: result.head, previousN: Number(prev.n), previousHead: prev.head };
  }
  sql.exec('INSERT INTO audit_anchor (id, n, head) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n, head = excluded.head', result.checked, result.head);
  return { ok: true, checked: result.checked, head: result.head, reason: 'CHAIN_VERIFIED' };
}
