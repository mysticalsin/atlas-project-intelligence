// Reliable job envelope (plan §4, Integration Contracts §7-§8): one job per source revision and destination, delivered at least
// once and recorded exactly once. Runs inside the LibraryStore Durable Object on the Library's SQL adapter (additive
// CREATE TABLE IF NOT EXISTS). The store is generic: it knows envelopes and outcomes, never what a destination is.
//
// - idempotency_key = `${source_revision_hash}:${destination}` is UNIQUE: enqueueing it again is a no-op that returns the
//   existing job, whatever state it is in (a failed job is recovered by a person, never re-created).
// - A destination answers { ok:true, ack } | { ok:false, retryable?, error } | { ok:false, conflict:true, destination_revision }.
//   Only an acknowledgement is success. Anything else retries with exponential backoff and jitter, bounded: after max_attempts
//   the job is `failed` (dead-letter) and waits for a person. A destination holding a NEWER revision than the source is never
//   overwritten: the job becomes `needs_reconciliation` (also when an ack names a newer destination revision).
// - Time and randomness are injected (configure: now() in ms, random() in [0,1)), so the schedule is deterministic in tests.
// - job_events is the audit trail (codes, ids and counts, never payload content): actor, payload hash, timestamps, attempts,
//   acknowledgement and errors.
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'retrying', 'failed', 'needs_reconciliation'];
const OPEN = ['queued', 'running', 'retrying'];
export const DEFAULTS = { maxAttempts: 5, baseMs: 1000, capMs: 15 * 60 * 1000, leaseMs: 2 * 60 * 1000 };

const DDL = [
  `CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, source_entity_id TEXT, source_revision INTEGER, destination TEXT,
    payload_hash TEXT, payload_json TEXT, status TEXT, attempt INTEGER, max_attempts INTEGER, next_attempt_at TEXT, destination_ack TEXT, last_error TEXT,
    actor TEXT, created_at TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS jobs_entity ON jobs(source_entity_id)',
  'CREATE INDEX IF NOT EXISTS jobs_open ON jobs(status)',
  `CREATE TABLE IF NOT EXISTS job_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, at TEXT, event TEXT, attempt INTEGER, status TEXT, actor TEXT, detail TEXT)`,
  'CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id)',
];

const settings = new WeakMap();
export function configure(lib, patch = {}) { settings.set(lib, { ...(settings.get(lib) || {}), ...patch }); }
const config = lib => ({ ...DEFAULTS, now: () => Date.parse(lib.now()), random: Math.random, ...(settings.get(lib) || {}) });
export const clock = lib => new Date(config(lib).now()).toISOString(); // the job clock as a timestamp (mock acknowledgements use it)

const ensured = new WeakSet();
const stores = new WeakMap();
export function jobs(lib) {
  if (!stores.has(lib)) {
    if (!ensured.has(lib)) { for (const q of DDL) lib.sql.exec(q); ensured.add(lib); }
    stores.set(lib, new Jobs(lib));
  }
  return stores.get(lib);
}

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v ?? null);
export async function sha256(s) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const payloadHash = payload => sha256(stable(payload));
export const idempotencyKey = (sourceRevisionHash, destination) => `${sourceRevisionHash}:${destination}`;

// Equal jitter: the delay for the attempt that just failed is between half and all of min(cap, base * 2^(attempt-1)).
export function backoffMs(attempt, random = Math.random, { baseMs = DEFAULTS.baseMs, capMs = DEFAULTS.capMs } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1)), r = Math.min(Math.max(Number(random()) || 0, 0), 0.999999);
  return Math.round(ceiling / 2 + r * (ceiling / 2));
}

// What a destination's answer means for the job. Pure. `job` supplies the source revision the destination must not be ahead of.
export function classify(res, job) {
  const r = obj(res) ? res : {};
  const ack = obj(r.ack) ? r.ack : null;
  const newer = rev => Number.isInteger(rev) && rev > job.source_revision;
  if (r.conflict === true || (ack && newer(ack.destination_revision))) return { outcome: 'reconcile', ack, error: 'DESTINATION_NEWER_REVISION' };
  if (r.ok === true && ack) return { outcome: 'succeeded', ack };
  if (r.ok === true) return { outcome: 'retry', error: 'NO_ACK' }; // no success without the destination's acknowledgement
  const error = typeof r.error === 'string' && r.error ? r.error.slice(0, 80) : 'DESTINATION_ERROR';
  return { outcome: r.retryable === false ? 'failed' : 'retry', error };
}

class Jobs {
  constructor(lib) { this.lib = lib; }
  rows(q, ...p) { return this.lib.rows(q, ...p); }
  cfg() { return config(this.lib); }
  iso(ms) { return new Date(ms).toISOString(); }
  row(id) { return this.rows('SELECT * FROM jobs WHERE job_id = ?', String(id || ''))[0] || null; }
  view(r) {
    return r && { job_id: r.job_id, idempotency_key: r.idempotency_key, source_entity_id: r.source_entity_id, source_revision: r.source_revision, destination: r.destination,
      payload_hash: r.payload_hash, status: r.status, attempt: r.attempt, max_attempts: r.max_attempts, destination_ack: parse(r.destination_ack, null),
      created_at: r.created_at, updated_at: r.updated_at, next_attempt_at: r.next_attempt_at, last_error: r.last_error };
  }
  get(id) { return this.view(this.row(id)); }
  byKey(key) { return this.view(this.rows('SELECT * FROM jobs WHERE idempotency_key = ?', String(key))[0] || null); }
  list(entity) { return this.rows('SELECT * FROM jobs WHERE source_entity_id = ? ORDER BY created_at, rowid', String(entity)).map(r => this.view(r)); }
  events(id) { return this.rows('SELECT at, event, attempt, status, actor, detail FROM job_events WHERE job_id = ? ORDER BY seq', String(id)); }
  log(r, event, { actor = null, detail = null } = {}) {
    const row = this.row(r.job_id) || r;
    this.lib.sql.exec('INSERT INTO job_events (job_id, at, event, attempt, status, actor, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      row.job_id, this.iso(this.cfg().now()), event, row.attempt, row.status, actor, detail);
  }
  set(id, fields) {
    const keys = Object.keys(fields);
    this.lib.sql.exec(`UPDATE jobs SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE job_id = ?`, ...keys.map(k => fields[k]), this.iso(this.cfg().now()), id);
  }

  // Create the job, or return the one that already has this key. `duplicate` says which.
  async enqueue({ entity, revision, hash, destination, payload, actor = null }) {
    if (!entity || !Number.isInteger(revision) || !hash || !destination || !obj(payload)) throw new Error('A job needs an entity, a revision, its hash, a destination and a payload.');
    const key = idempotencyKey(hash, destination), existing = this.byKey(key);
    if (existing) return { job: existing, duplicate: true };
    const c = this.cfg(), id = this.lib.newId(), at = this.iso(c.now()), ph = await payloadHash(payload);
    const again = this.byKey(key); // another enqueue finished while the payload was hashed
    if (again) return { job: again, duplicate: true };
    try {
      this.lib.sql.exec(`INSERT INTO jobs (job_id, idempotency_key, source_entity_id, source_revision, destination, payload_hash, payload_json, status, attempt, max_attempts, next_attempt_at,
        destination_ack, last_error, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, ?, ?, ?)`,
      id, key, entity, revision, destination, ph, JSON.stringify(payload), c.maxAttempts, actor, at, at);
    } catch (e) { const raced = this.byKey(key); if (raced) return { job: raced, duplicate: true }; throw e; } // the UNIQUE index decides a race
    this.log({ job_id: id }, 'enqueued', { actor, detail: ph });
    return { job: this.get(id), duplicate: false };
  }

  // Make one delivery attempt if the job is due. `send(envelope, payload)` talks to the destination. Returns { job, ran }.
  async run(id, send, { force = false } = {}) {
    const r = this.row(id);
    if (!r) return { job: null, ran: false };
    const c = this.cfg(), nowMs = c.now();
    const due = r.status === 'queued'
      || (r.status === 'retrying' && (force || !r.next_attempt_at || Date.parse(r.next_attempt_at) <= nowMs))
      || (r.status === 'running' && Date.parse(r.updated_at) <= nowMs - c.leaseMs); // an attempt that never reported back (Durable Object restart)
    if (!due) return { job: this.view(r), ran: false };
    const attempt = r.attempt + 1;
    this.set(id, { status: 'running', attempt, next_attempt_at: null });
    this.log(r, 'attempt_started', {});
    const envelope = this.view(this.row(id)); // the pack's envelope; the payload travels beside it, never inside it
    let res;
    try { res = await send(envelope, parse(r.payload_json, {})); } catch { res = { ok: false, retryable: true, error: 'ADAPTER_EXCEPTION' }; }
    const out = classify(res, r);
    const ack = out.ack ? JSON.stringify(out.ack) : null;
    if (out.outcome === 'succeeded') { this.set(id, { status: 'succeeded', destination_ack: ack, last_error: null, next_attempt_at: null }); this.log(r, 'acknowledged', { detail: String(out.ack.mock === false ? 'live' : 'mock') }); }
    else if (out.outcome === 'reconcile') { this.set(id, { status: 'needs_reconciliation', destination_ack: ack, last_error: out.error, next_attempt_at: null }); this.log(r, 'needs_reconciliation', { detail: out.error }); }
    else if (out.outcome === 'failed' || attempt >= r.max_attempts) {
      this.set(id, { status: 'failed', last_error: out.error, next_attempt_at: null });
      this.log(r, 'dead_letter', { detail: out.error }); // a person recovers it (recover)
    } else {
      this.set(id, { status: 'retrying', last_error: out.error, next_attempt_at: this.iso(nowMs + backoffMs(attempt, c.random, c)) });
      this.log(r, 'retry_scheduled', { detail: out.error });
    }
    return { job: this.get(id), ran: true };
  }

  // Jobs that may run now: queued, retrying whose time has come, and running attempts past their lease.
  due() {
    const c = this.cfg(), now = c.now();
    return this.rows(`SELECT job_id FROM jobs WHERE status IN ('queued', 'retrying', 'running') ORDER BY created_at, rowid`).map(r => this.row(r.job_id))
      .filter(r => r.status === 'queued' || (r.status === 'retrying' && (!r.next_attempt_at || Date.parse(r.next_attempt_at) <= now)) || (r.status === 'running' && Date.parse(r.updated_at) <= now - c.leaseMs))
      .map(r => this.view(r));
  }

  // Human recovery of a dead-lettered job: back to the queue with a fresh attempt budget. Reconciliation is a different matter:
  // the source and the destination disagree, so it ends by a new revision (a new key), never by a retry.
  recover(id, actor) {
    const r = this.row(id);
    if (!r || r.status !== 'failed') return null;
    this.set(id, { status: 'queued', attempt: 0, last_error: null, next_attempt_at: null });
    this.log(r, 'human_recovery', { actor });
    return this.get(id);
  }

  // Stop open jobs that must no longer deliver (the source moved on, a permission was withdrawn): needs_reconciliation, never silently dropped.
  halt(entity, { reason, keepRevision = null, destinations = null }) {
    const stopped = [];
    for (const r of this.rows('SELECT * FROM jobs WHERE source_entity_id = ?', String(entity))) {
      if (!OPEN.includes(r.status) || (keepRevision !== null && r.source_revision === keepRevision) || (destinations && !destinations.includes(r.destination))) continue;
      this.set(r.job_id, { status: 'needs_reconciliation', last_error: reason, next_attempt_at: null });
      this.log(r, 'halted', { detail: reason });
      stopped.push(this.get(r.job_id));
    }
    return stopped;
  }
}
