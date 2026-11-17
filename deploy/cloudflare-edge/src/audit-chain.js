// Tamper-evident library audit trail. Every row stores prev_hash, hash and commit.
// commit = HMAC(key, canonical(seq, id, action, at, actor, detail, prev_hash, and tenant when the row has one)).
// hash = SHA-256(prev, id, action, at, commit). The public hash can be recomputed without the key.
// The commit cannot: a relink or a reorder changes prev_hash and fails the MAC.
// A privacy rewrite may replace actor and detail only by writing an exact tombstone
// (actor matches ^erased:[0-9a-f]{12}$, detail is empty) plus
// proof = HMAC(key, JSON.stringify(['tombstone', seq, commit, actor, id, action, at, prev_hash, and tenant when the column exists])).
// It does not recompute hash or prev_hash, so a later row, including another tenant's, is never resealed.
// verify accepts a row when the HMAC of the current actor and detail equals commit, or when
// the tombstone and its proof both match. A direct edit of either field fails.
// The daily check stores n and head. A shorter chain is TRUNCATED. The stored head must still
// be the hash at that same position, so a prefix truncate padded with new rows is ANCHOR_MOVED.
// The server key signs a row only when this process writes it. A database from main has no
// hashes, no commits and no anchor row. Opening it appends one keyed chain-start row, including
// when the table is empty. The detail records how many legacy rows there were and their max seq.
// Those older rows stay legacy and unverified: counted, never signed, never a chain break.
// The first keyed row is that chain-start: action chain-start, prev_hash genesis, commit verified.
// A chain of later events relinked to genesis is not a chain. A second chain-start is refused.
// A null or empty commit is not a chain-start.
// The column adds, the chain-start index, the chain-start insert and the anchor table write
// of that first migration run in one storage.transactionSync. The callback is synchronous.
// A store with no transactionSync is not migrated. A throw rolls the schema back to the
// main-shaped table. Once an anchor row exists, or the commit column exists, the chain is
// not migrated again.
// A missing signed chain-start, keyed values that are all null, or a chain of only unsigned
// rows is TAMPERED. That state does not gain a chain-start and does not delete the anchor.
// A hash or previous-link column with no commit column is TAMPERED even when every stored
// value is null. Rows signed by an older commit formula fail COMMIT_MISMATCH. There is no
// reseal and no upgrade.
// SHA-256 and HMAC-SHA256 are synchronous because Library.log is synchronous.
// Limits, honestly: pre-chain rows cannot be proved untampered, because nothing signed them.
// Whoever can rewrite the keyed rows and recompute every hash and commit is not stopped by
// an in-table chain. The daily anchor is what notices a missing keyed prefix.
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
// seq, id, action, at and prev_hash are inside the MAC, so a copied commit fails on any other
// event and a recomputed public hash cannot relink or reorder the row.
// tenant is included only when the table has that column, and then it is always included.
export function contentCommit(key, row, withTenant = false) {
  const parts = [Number(row.seq), String(row.id ?? ''), String(row.action ?? ''), String(row.at ?? ''), String(row.actor ?? ''), String(row.detail ?? ''), String(row.prev_hash ?? '')];
  if (withTenant) parts.push(String(row.tenant ?? ''));
  return hmacHex(key, JSON.stringify(parts));
}
// One JSON array, so seq 1 cannot borrow seq 10's proof by shifting a character.
// id, action, at and the tenant (when that column exists) are inside the MAC.
// The previous actor-only proof is not accepted.
export function tombstoneProof(key, row, withTenant = false) {
  const parts = ['tombstone', Number(row.seq), String(row.commit ?? ''), String(row.actor ?? ''), String(row.id ?? ''), String(row.action ?? ''), String(row.at ?? ''), String(row.prev_hash ?? '')];
  if (withTenant) parts.push(String(row.tenant ?? ''));
  return hmacHex(key, JSON.stringify(parts));
}
function sameText(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  return timingSafe(x, y);
}

// JSON array, not a delimiter-joined string: no field value can shift a boundary. seq is excluded.
// commit is included, so actor and detail are bound without putting their text in the hash.
export const rowHash = (prev, r) => sha256Hex(JSON.stringify([prev, String(r.id ?? ''), String(r.action ?? ''), String(r.at ?? ''), String(r.commit ?? '')]));

const sealed = new WeakSet();
const CHAIN_START = 'chain-start';
const qident = name => '"' + name + '"';
const absentSchema = e => /no such (column|table)/i.test(String(e?.message || e));
// A lock is not a missing column. Treating SQLITE_BUSY as "absent" classified a live chain as tampered.
const hasColumn = (sql, name) => {
  try { sql.exec('SELECT ' + qident(name) + ' FROM audit LIMIT 0'); return true; }
  catch (e) { if (absentSchema(e)) return false; throw e; }
};
const duplicateColumn = e => /duplicate column/i.test(String(e?.message || e));
const uniqueRow = e => /unique/i.test(String(e?.message || e));
function addColumn(sql, name, ddl) {
  if (hasColumn(sql, name)) return;
  try { sql.exec(ddl); } catch (e) { if (!duplicateColumn(e) && !hasColumn(sql, name)) throw e; }
}
// A hash or previous-link column without a commit column is not a main-shaped table.
// Null values do not make it one: clearing the hashes and dropping commit must not migrate again.
function hashesWithoutCommit(sql) {
  if (hasColumn(sql, 'commit')) return false;
  return hasColumn(sql, 'hash') || hasColumn(sql, 'prev_hash');
}
function tamperedResult(sql) {
  let n = 0, seq = null;
  try {
    const rows = sql.exec('SELECT seq FROM audit ORDER BY seq').toArray();
    n = rows.length; seq = rows[0]?.seq ?? null;
  } catch { /* the table cannot be counted */ }
  return { ok: false, checked: 0, brokenSeq: seq, reason: 'TAMPERED', head: GENESIS, legacyUnverified: n };
}
function chainStartSeqs(sql) {
  if (!hasColumn(sql, 'commit')) return [];
  try { return sql.exec('SELECT seq FROM audit WHERE action = ? AND "commit" IS NOT NULL ORDER BY seq', CHAIN_START).toArray().map(r => Number(r.seq)); }
  catch (e) { if (absentSchema(e)) return []; throw e; }
}
const ANCHOR = 'CREATE TABLE IF NOT EXISTS audit_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, head TEXT NOT NULL)';
function nextSeq(sql) {
  return Number(sql.exec('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM audit').toArray()[0].n);
}
// The first migration creates the anchor table and removes an empty leftover. It is not called
// when an anchor row already exists. Do not drop the table: another caller may be reading it.
function clearAnchor(sql) {
  sql.exec(ANCHOR);
  sql.exec('DELETE FROM audit_anchor');
}
function anchorRow(sql) {
  try { return sql.exec('SELECT n, head FROM audit_anchor WHERE id = 1').toArray()[0] || null; }
  catch (e) { if (/no such table/i.test(String(e?.message || e))) return null; throw e; }
}
function keyedRows(sql) {
  return sql.exec('SELECT seq, prev_hash, hash, "commit" FROM audit ORDER BY seq').toArray();
}
// migrate: no anchor row and no commit column. One chain-start may be written.
// open: one signed chain-start whose prev is genesis, and no signed row before it.
// tampered: anything else once the commit column or an anchor row exists. No wait.
function classifyChain(sql) {
  if (hashesWithoutCommit(sql)) return 'tampered';
  const commit = hasColumn(sql, 'commit');
  const anchored = !!anchorRow(sql);
  if (!commit && !anchored) return 'migrate';
  if (!commit) return 'tampered';
  if (!hasColumn(sql, 'hash') || !hasColumn(sql, 'prev_hash')) return 'tampered';
  const starts = chainStartSeqs(sql);
  if (starts.length !== 1) return 'tampered';
  const rows = keyedRows(sql);
  const start = rows.find(r => Number(r.seq) === starts[0]);
  const signedBefore = rows.some(r => Number(r.seq) < starts[0] && r.commit);
  if (start && !signedBefore && sameText(start.prev_hash, GENESIS)) return 'open';
  return 'tampered';
}
// One keyed row naming the legacy prefix. A null commit is not this row.
// An anchor row means this database already had a chain. Do not delete it and do not seed again.
function appendChainStart(sql, key) {
  if (chainStartSeqs(sql).length || anchorRow(sql)) return;
  const stats = sql.exec('SELECT COUNT(*) AS n, MAX(seq) AS maxSeq FROM audit').toArray()[0] || {};
  const legacy = Number(stats.n) || 0;
  const detail = JSON.stringify({ legacy, maxSeq: Number(stats.maxSeq) || 0 });
  const at = new Date().toISOString();
  const seq = nextSeq(sql);
  const withTenant = hasColumn(sql, 'tenant');
  const row = { seq, id: 'audit', actor: 'atlas', action: CHAIN_START, at, detail, tenant: '', prev_hash: GENESIS };
  const commit = contentCommit(key, row, withTenant);
  const prev = GENESIS;
  const hash = rowHash(prev, { id: row.id, action: row.action, at, commit });
  clearAnchor(sql);
  try {
    if (withTenant) sql.exec('INSERT INTO audit (seq, id, actor, action, at, detail, tenant, prev_hash, hash, "commit", tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      seq, row.id, row.actor, row.action, at, detail, '', prev, hash, commit, '');
    else sql.exec('INSERT INTO audit (seq, id, actor, action, at, detail, prev_hash, hash, "commit", tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      seq, row.id, row.actor, row.action, at, detail, prev, hash, commit, '');
  } catch (e) { if (!uniqueRow(e)) throw e; }
}
function indexChainStart(sql) {
  const partial = 'CREATE UNIQUE INDEX IF NOT EXISTS audit_one_chain_start ON audit(action) WHERE action = \'chain-start\' AND "commit" IS NOT NULL';
  let current = '';
  try { current = sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'audit_one_chain_start'").toArray()[0]?.sql || ''; }
  catch { current = ''; }
  // IF NOT EXISTS would keep an older index that treats an unsigned chain-start as the one start.
  if (current && !current.includes('"commit" IS NOT NULL')) {
    try { sql.exec('DROP INDEX IF EXISTS audit_one_chain_start'); }
    catch { /* a racer is dropping it */ }
  }
  try { sql.exec(partial); }
  catch { /* a racer is creating it, or two starts already exist and verify will say so */ }
}
// Adds the chain columns only for a database that has never had a commit column or an anchor row.
// Signs nothing that was already stored. A main-shaped table gets one chain-start.
// Anything already claimed is left as stored: no new chain-start and no anchor delete.
// transactionSync is storage.transactionSync from library-store.js. It is synchronous.
// The first migration is one callback, so a crash rolls back to the main-shaped table.
export function ensureChain(sql, key = '', transactionSync = null) {
  if (sealed.has(sql)) return;
  const atomic = typeof transactionSync === 'function' ? transactionSync
    : (typeof sql?.transactionSync === 'function' ? sql.transactionSync.bind(sql) : null);
  const kind = classifyChain(sql);
  if (kind !== 'migrate') { if (kind === 'open') indexChainStart(sql); sealed.add(sql); return; }
  if (typeof atomic !== 'function') {
    const err = new Error('Audit migration cannot be made atomic on this store, so nothing was migrated.');
    err.status = 500;
    throw err;
  }
  atomic(() => {
    // The peer that held the write lock may have committed the whole migration.
    if (classifyChain(sql) !== 'migrate') return;
    addColumn(sql, 'commit', 'ALTER TABLE audit ADD COLUMN "commit" TEXT');
    addColumn(sql, 'prev_hash', 'ALTER TABLE audit ADD COLUMN prev_hash TEXT');
    addColumn(sql, 'hash', 'ALTER TABLE audit ADD COLUMN hash TEXT');
    addColumn(sql, 'tombstone', 'ALTER TABLE audit ADD COLUMN tombstone TEXT');
    indexChainStart(sql);
    if (key != null && !chainStartSeqs(sql).length) {
      const rows = sql.exec('SELECT hash, prev_hash, "commit" FROM audit').toArray();
      if (!rows.some(r => r.hash || r.prev_hash || r.commit)) appendChainStart(sql, key);
    }
  });
  sealed.add(sql);
}

// The single write path for audit rows (called from Library.log).
export function appendAudit(sql, { id, actor, action, at, detail, tenant }, key = '') {
  if (key == null) { const err = new Error('LOG_SALT is not set.'); err.status = 503; throw err; }
  if (String(action) === CHAIN_START) { const err = new Error('A second chain-start is refused.'); err.status = 409; throw err; }
  ensureChain(sql, key);
  // Refuse every non-verified result, including a chain that is only shorter than its anchor.
  const verdict = anchoredVerdict(sql, verifyChain(sql, key));
  if (!verdict.ok) { const err = new Error('The audit chain is tampered.'); err.status = 409; throw err; }
  const last = sql.exec('SELECT hash FROM audit WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1').toArray()[0];
  const prev = last?.hash || GENESIS;
  const seq = nextSeq(sql);
  const withTenant = hasColumn(sql, 'tenant');
  const commit = contentCommit(key, { seq, id, actor, action, at, detail, tenant, prev_hash: prev }, withTenant);
  const hash = rowHash(prev, { id, action, at, commit });
  if (withTenant) sql.exec('INSERT INTO audit (seq, id, actor, action, at, detail, tenant, prev_hash, hash, "commit", tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    seq, id, actor, action, at, detail, tenant ?? '', prev, hash, commit, '');
  else sql.exec('INSERT INTO audit (seq, id, actor, action, at, detail, prev_hash, hash, "commit", tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    seq, id, actor, action, at, detail, prev, hash, commit, '');
}

const ROW = 'seq, id, actor, action, at, detail, prev_hash, hash, "commit", tombstone';
function bound(key, r, withTenant) {
  const commit = String(r.commit ?? '');
  if (sameText(contentCommit(key, r, withTenant), commit)) return true;
  return TOMBSTONE_ACTOR.test(String(r.actor || '')) && String(r.detail ?? '') === '' && !!r.tombstone && sameText(r.tombstone, tombstoneProof(key, r, withTenant));
}
function finish(ok, fields, legacyUnverified) {
  return legacyUnverified ? { ...fields, ok, legacyUnverified } : { ...fields, ok };
}
// Walks the keyed rows in order (500 at a time). Legacy rows before chain-start are counted and not checked.
// { ok, checked, head } or { ok: false, brokenSeq, reason, head }. legacyUnverified is set when it is not zero.
// reasons: UNSEALED, HASH_MISMATCH, LINK_BROKEN, COMMIT_MISMATCH, TAMPERED, LOG_SALT.
export function verifyChain(sql, key = '') {
  if (hashesWithoutCommit(sql)) return tamperedResult(sql);
  ensureChain(sql, key);
  const kind = classifyChain(sql);
  if (hashesWithoutCommit(sql) || kind === 'tampered') return tamperedResult(sql);
  if (key == null) return { ok: false, checked: 0, brokenSeq: null, reason: 'LOG_SALT', head: GENESIS };
  const starts = chainStartSeqs(sql);
  if (starts.length > 1) return { ok: false, checked: 0, brokenSeq: starts[1], reason: 'TAMPERED', head: GENESIS };
  const startSeq = starts.length ? starts[0] : null;
  const legacyUnverified = startSeq == null ? 0 : Number(sql.exec('SELECT COUNT(*) AS n FROM audit WHERE seq < ?', startSeq).toArray()[0].n) || 0;
  const withTenant = hasColumn(sql, 'tenant');
  const columns = withTenant ? ROW + ', tenant' : ROW;
  // No floor of 0. A row at seq <= 0 is in this set when there is no chain-start, and
  // keyedAt reads that same set. Rows before a chain-start stay outside it.
  let after = null, prevHash = null, checked = 0, head = GENESIS;
  const verifiedSeqs = [];
  for (;;) {
    const rows = after == null
      ? (startSeq == null
        ? sql.exec(`SELECT ${columns} FROM audit ORDER BY seq LIMIT 500`).toArray()
        : sql.exec(`SELECT ${columns} FROM audit WHERE seq >= ? ORDER BY seq LIMIT 500`, startSeq).toArray())
      : sql.exec(`SELECT ${columns} FROM audit WHERE seq > ? ORDER BY seq LIMIT 500`, after).toArray();
    if (!rows.length) return finish(true, { checked, head, verifiedSeqs }, legacyUnverified);
    for (const r of rows) {
      const bad = reason => finish(false, { checked, brokenSeq: r.seq, reason, head, verifiedSeqs }, legacyUnverified);
      if (!r.hash || !r.prev_hash) return bad('UNSEALED');
      if (prevHash === null) {
        if (String(r.action) !== CHAIN_START) return bad('TAMPERED');
        if (!sameText(r.prev_hash, GENESIS)) return bad('TRUNCATED');
      } else if (!sameText(r.prev_hash, prevHash)) return bad('LINK_BROKEN');
      if (!sameText(rowHash(r.prev_hash, r), r.hash)) return bad('HASH_MISMATCH');
      if (!bound(key, r, withTenant)) return bad('COMMIT_MISMATCH');
      verifiedSeqs.push(Number(r.seq));
      prevHash = head = r.hash; after = r.seq; checked++;
    }
  }
}

// A privacy rewrite. edit(row) returns { actor, detail } or null. The only accepted write is a tombstone.
// A keyed row keeps prev_hash, hash and commit, and stores the proof, so later rows are not resealed.
// A legacy row is only overwritten with the tombstone text. It was never signed, so erasure does not sign it
// and does not refuse because of it. A broken keyed chain still refuses keyed rows.
export function rewriteRows(sql, edit, key = '') {
  if (key == null) return { refused: true, reason: 'LOG_SALT', brokenSeq: null, changed: 0, head: null, previousHead: null };
  const before = verifyChain(sql, key);
  const starts = chainStartSeqs(sql);
  const startSeq = starts.length === 1 ? starts[0] : null;
  const withTenant = hasColumn(sql, 'tenant');
  let changed = 0, keyedSkipped = false, rows = [];
  try { rows = sql.exec(`SELECT ${withTenant ? ROW + ', tenant' : ROW} FROM audit ORDER BY seq`).toArray(); } catch { rows = []; }
  for (const r of rows) {
    const patch = edit(r);
    if (!patch) continue;
    const actor = String(patch.actor ?? r.actor ?? ''), detail = String(patch.detail ?? r.detail ?? '');
    if (actor === String(r.actor ?? '') && detail === String(r.detail ?? '')) continue;
    if (!TOMBSTONE_ACTOR.test(actor) || detail !== '') continue;
    if (startSeq != null && Number(r.seq) < startSeq) {
      sql.exec('UPDATE audit SET actor = ?, detail = ? WHERE seq = ?', actor, '', r.seq);
      changed++;
      continue;
    }
    if (!before.ok) { keyedSkipped = true; continue; }
    sql.exec('UPDATE audit SET actor = ?, detail = ?, tombstone = ? WHERE seq = ?', actor, '', tombstoneProof(key, { ...r, actor }, withTenant), r.seq);
    changed++;
  }
  if (keyedSkipped || (!before.ok && changed === 0)) return { refused: true, reason: before.reason, brokenSeq: before.brokenSeq, changed: keyedSkipped ? changed : 0, head: before.head, previousHead: before.head };
  return { changed, head: before.head, previousHead: before.head };
}

// The in-table walk plus the stored anchor. Does not write the anchor.
function anchoredVerdict(sql, result) {
  if (!result.ok) return result;
  const prev = anchorRow(sql);
  if (prev && result.checked < Number(prev.n)) return { ...result, ok: false, reason: 'TRUNCATED', previousN: Number(prev.n), previousHead: prev.head };
  if (prev && Number(prev.n) > 0) {
    const at = keyedAt(sql, Number(prev.n));
    if (!at || !sameText(at.hash, prev.head)) return { ...result, ok: false, reason: 'ANCHOR_MOVED', previousN: Number(prev.n), previousHead: prev.head };
  }
  return result;
}
function keyedAt(sql, n) {
  const starts = chainStartSeqs(sql);
  if (!starts.length) return sql.exec('SELECT hash FROM audit ORDER BY seq LIMIT 1 OFFSET ?', n - 1).toArray()[0];
  return sql.exec('SELECT hash FROM audit WHERE seq >= ? ORDER BY seq LIMIT 1 OFFSET ?', starts[0], n - 1).toArray()[0];
}
// Daily check of the keyed chain. Legacy rows are a separate count and are not a break.
// Stores n and the head when the keyed chain verifies, is not shorter than the last anchor,
// and the stored head is still the hash of that keyed row. Otherwise the anchor stays.
export function verifyDaily(sql, key = '') {
  if (hashesWithoutCommit(sql)) return verifyChain(sql, key);
  ensureChain(sql, key);
  const kind = classifyChain(sql);
  if (hashesWithoutCommit(sql) || kind === 'tampered') return verifyChain(sql, key);
  sql.exec(ANCHOR);
  if (key == null) return { ok: false, reason: 'LOG_SALT', checked: 0, head: GENESIS, legacyUnverified: 0 };
  const result = anchoredVerdict(sql, verifyChain(sql, key));
  const legacyUnverified = result.legacyUnverified || 0;
  if (!result.ok) return { ...result, legacyUnverified };
  sql.exec('INSERT INTO audit_anchor (id, n, head) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n, head = excluded.head', result.checked, result.head);
  return { ok: true, checked: result.checked, head: result.head, reason: 'CHAIN_VERIFIED', legacyUnverified };
}
