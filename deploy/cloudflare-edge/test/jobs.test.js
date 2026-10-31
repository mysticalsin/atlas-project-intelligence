// Reliable job envelope (T15, Integration Contracts §7-§8): idempotent enqueue, bounded retry with exponential backoff and jitter on an
// injected clock and random source, dead-letter, reconciliation instead of overwrite, human recovery, audit. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { jobs, configure, backoffMs, classify, idempotencyKey, JOB_STATUSES, DEFAULTS } from '../src/jobs.js';
import { memorySql } from './sqlite.js';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
function setup(patch = {}) {
  let n = 0;
  const clock = { t: T0 }, l = new Library(memorySql(), { now: () => new Date(clock.t).toISOString(), newId: () => 'job' + String(++n).padStart(4, '0') });
  configure(l, { now: () => clock.t, random: () => 0, ...patch });
  return { l, J: jobs(l), clock };
}
const SECRET = 'Zebracorp routing pilot cut triage from 40 to 12 minutes';
const spec = (over = {}) => ({ entity: 'ev-1', revision: 3, hash: 'h'.repeat(64), destination: 'DNA', payload: { entity_id: 'ev-1', claims: [{ statement: SECRET }] }, actor: 'atlas-system', ...over });
const ack = (over = {}) => ({ mock: true, destination_record_id: 'mock-1', destination_revision: 3, ...over });
const ok = async () => ({ ok: true, ack: ack() });

test('the envelope is the pack\'s: key, entity, revision, destination, payload hash, status, attempt, ack, created_at', async () => {
  const { J } = setup(), { job, duplicate } = await J.enqueue(spec());
  assert.equal(duplicate, false);
  assert.deepEqual(Object.keys(job).slice(0, 10), ['job_id', 'idempotency_key', 'source_entity_id', 'source_revision', 'destination', 'payload_hash', 'status', 'attempt', 'max_attempts', 'destination_ack']);
  assert.equal(job.idempotency_key, `ev-1:3:${'h'.repeat(64)}:DNA`); assert.equal(job.idempotency_key, idempotencyKey('h'.repeat(64), 'DNA', 'ev-1', 3));
  assert.deepEqual([job.source_entity_id, job.source_revision, job.destination, job.status, job.attempt, job.destination_ack], ['ev-1', 3, 'DNA', 'queued', 0, null]);
  assert.match(job.payload_hash, /^[0-9a-f]{64}$/); assert.match(job.created_at, /^2026-11-01T12:00:00/);
  assert.ok(JOB_STATUSES.includes(job.status)); assert.deepEqual(JOB_STATUSES, ['queued', 'running', 'succeeded', 'retrying', 'failed', 'needs_reconciliation']);
  assert.equal('payload' in job || 'payload_json' in job, false, 'the envelope never carries the payload');
});

test('idempotency_key is UNIQUE in the table, and a duplicate enqueue is a no-op that returns the existing job in any state', async () => {
  const { l, J } = setup(), a = await J.enqueue(spec()), b = await J.enqueue(spec({ payload: { different: true } }));
  assert.equal(b.duplicate, true); assert.equal(b.job.job_id, a.job.job_id); assert.equal(b.job.payload_hash, a.job.payload_hash, 'the first payload stands');
  assert.equal(l.rows('SELECT COUNT(*) AS n FROM jobs')[0].n, 1);
  assert.throws(() => l.sql.exec(`INSERT INTO jobs (job_id, idempotency_key) VALUES ('x', ?)`, a.job.idempotency_key), /UNIQUE/);
  assert.equal((await J.enqueue(spec({ destination: 'MeChat' }))).duplicate, false, 'another destination is another job');
  assert.equal((await J.enqueue(spec({ hash: 'g'.repeat(64) }))).duplicate, false, 'another revision hash is another job');
  const [x, y] = await Promise.all([J.enqueue(spec({ entity: 'ev-2', hash: 'k'.repeat(64) })), J.enqueue(spec({ entity: 'ev-2', hash: 'k'.repeat(64) }))]); // a race resolves to one job
  assert.equal(x.job.job_id, y.job.job_id); assert.deepEqual([x.duplicate, y.duplicate].sort(), [false, true]);
  await J.run(a.job.job_id, async () => ({ ok: false, retryable: false, error: 'GONE' }));
  const c = await J.enqueue(spec()); assert.deepEqual([c.duplicate, c.job.status], [true, 'failed'], 'a failed job is recovered by a person, never re-created');
  for (const bad of [{ entity: '' }, { revision: 1.5 }, { hash: '' }, { destination: '' }, { payload: 'x' }]) await assert.rejects(J.enqueue(spec(bad)));
});

test('success needs the destination\'s acknowledgement; the ack is stored and the job is not re-run', async () => {
  const { J } = setup(), { job } = await J.enqueue(spec());
  const calls = [], r = await J.run(job.job_id, async (env, payload) => { calls.push([env.job_id, env.attempt, env.status, payload.entity_id]); return { ok: true, ack: ack() }; });
  assert.deepEqual(calls, [[job.job_id, 1, 'running', 'ev-1']]); assert.deepEqual([r.ran, r.job.status, r.job.attempt, r.job.destination_ack.destination_record_id], [true, 'succeeded', 1, 'mock-1']);
  assert.equal((await J.run(job.job_id, async () => { throw new Error('must not run again'); })).ran, false);
  assert.equal((await J.run('missing', ok)).job, null);
  const { job: j2 } = await J.enqueue(spec({ hash: 'n'.repeat(64) }));
  const noAck = await J.run(j2.job_id, async () => ({ ok: true })); // ok without an ack is not success
  assert.deepEqual([noAck.job.status, noAck.job.last_error, noAck.job.destination_ack], ['retrying', 'NO_ACK', null]);
});

test('backoff is exponential with equal jitter, capped, and deterministic for an injected random', () => {
  const rnd = v => () => v, o = { baseMs: 1000, capMs: 8000 };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(a => backoffMs(a, rnd(0), o)), [500, 1000, 2000, 4000, 4000, 4000]);
  assert.deepEqual([1, 2, 3, 4, 5].map(a => backoffMs(a, rnd(0.999999), o)), [1000, 2000, 4000, 8000, 8000]);
  assert.deepEqual([1, 2, 3].map(a => backoffMs(a, rnd(0.5), o)), [750, 1500, 3000]);
  for (let a = 1; a < 12; a++) for (const r of [0, 0.25, 0.5, 0.75, 1, -3, NaN]) { const d = backoffMs(a, rnd(r), o), ceiling = Math.min(8000, 1000 * 2 ** (a - 1)); assert.ok(d >= ceiling / 2 && d <= ceiling, `${a} ${r} ${d}`); }
  assert.equal(backoffMs(2, rnd(0)), 1000); assert.equal(DEFAULTS.maxAttempts, 5);
});

test('a failing destination retries on the schedule, is not run early, and becomes failed (dead-letter) after max attempts', async () => {
  const { J, clock } = setup({ maxAttempts: 3, baseMs: 1000, capMs: 60000, random: () => 0 }), { job } = await J.enqueue(spec());
  let calls = 0; const down = async () => { calls++; return { ok: false, error: 'MOCK_DOWN' }; };
  let r = await J.run(job.job_id, down);
  assert.deepEqual([r.job.status, r.job.attempt, r.job.last_error, r.job.next_attempt_at], ['retrying', 1, 'MOCK_DOWN', new Date(T0 + 500).toISOString()]);
  assert.equal((await J.run(job.job_id, down)).ran, false, 'not due yet'); assert.equal(calls, 1);
  clock.t = T0 + 499; assert.equal(J.due().length, 0); assert.equal((await J.run(job.job_id, down)).ran, false);
  clock.t = T0 + 500; assert.equal(J.due().length, 1);
  r = await J.run(job.job_id, down);
  assert.deepEqual([r.job.status, r.job.attempt, r.job.next_attempt_at], ['retrying', 2, new Date(T0 + 500 + 1000).toISOString()]);
  clock.t = T0 + 1500; r = await J.run(job.job_id, down);
  assert.deepEqual([r.job.status, r.job.attempt, r.job.next_attempt_at], ['failed', 3, null]); assert.equal(calls, 3);
  assert.equal(J.due().length, 0, 'a dead-lettered job is not picked up again');
  assert.deepEqual(J.events(job.job_id).map(e => e.event), ['enqueued', 'attempt_started', 'retry_scheduled', 'attempt_started', 'retry_scheduled', 'attempt_started', 'dead_letter']);
});

test('an injected exception retries; a non-retryable refusal fails at once; a success after retries stands', async () => {
  const { J, clock } = setup({ maxAttempts: 5 }), a = (await J.enqueue(spec())).job, b = (await J.enqueue(spec({ hash: 'b'.repeat(64) }))).job;
  assert.deepEqual([(await J.run(a.job_id, async () => { throw new Error('boom ' + SECRET); })).job.last_error], ['ADAPTER_EXCEPTION']); // the message is never stored
  const rb = await J.run(b.job_id, async () => ({ ok: false, retryable: false, error: 'CMS_REJECTED' })); assert.deepEqual([rb.job.status, rb.job.attempt, rb.job.last_error], ['failed', 1, 'CMS_REJECTED']);
  clock.t = T0 + 10_000; const ra = await J.run(a.job_id, ok); assert.deepEqual([ra.job.status, ra.job.attempt, ra.job.last_error], ['succeeded', 2, null]);
});

test('a destination holding a newer revision is never overwritten: needs_reconciliation, not retried, not failed', async () => {
  const { J } = setup(), a = (await J.enqueue(spec())).job, b = (await J.enqueue(spec({ hash: 'b'.repeat(64) }))).job, c = (await J.enqueue(spec({ hash: 'c'.repeat(64) }))).job;
  const ra = await J.run(a.job_id, async () => ({ ok: false, conflict: true, error: 'DESTINATION_NEWER_REVISION', destination_revision: 9 }));
  assert.deepEqual([ra.job.status, ra.job.last_error, ra.job.attempt], ['needs_reconciliation', 'DESTINATION_NEWER_REVISION', 1]);
  const rb = await J.run(b.job_id, async () => ({ ok: true, ack: ack({ destination_revision: 4 }) })); // an ack that names a newer revision is not success either
  assert.deepEqual([rb.job.status, rb.job.last_error], ['needs_reconciliation', 'DESTINATION_NEWER_REVISION']);
  const rc = await J.run(c.job_id, async () => ({ ok: true, ack: ack({ destination_revision: 3 }) })); assert.equal(rc.job.status, 'succeeded', 'the same revision is fine');
  assert.equal(J.due().length, 0); assert.equal((await J.run(a.job_id, ok)).ran, false);
  assert.equal(J.recover(a.job_id, 'rev@mantu.com'), null, 'reconciliation ends by a new revision, not by recovery');
});

test('classify: only an acknowledgement is success; everything else is retry, failure or reconciliation', () => {
  const job = { source_revision: 3 };
  assert.deepEqual(classify({ ok: true, ack: { destination_revision: 3 } }, job), { outcome: 'succeeded', ack: { destination_revision: 3 } });
  assert.equal(classify({ ok: true }, job).outcome, 'retry'); assert.equal(classify(null, job).outcome, 'retry'); assert.equal(classify('ok', job).outcome, 'retry');
  assert.equal(classify({ ok: false, error: 'x' }, job).outcome, 'retry'); assert.equal(classify({ ok: false, retryable: false }, job).outcome, 'failed');
  assert.equal(classify({ ok: false, conflict: true }, job).outcome, 'reconcile'); assert.equal(classify({ ok: true, ack: { destination_revision: 4 } }, job).outcome, 'reconcile');
  assert.equal(classify({ ok: false, error: 'e'.repeat(500) }, job).error.length, 80);
});

test('human recovery puts a dead-lettered job back with a fresh budget; halt stops open jobs without dropping them', async () => {
  const { J, clock } = setup({ maxAttempts: 1 }), { job } = await J.enqueue(spec());
  assert.equal((await J.run(job.job_id, async () => ({ ok: false, error: 'DOWN' }))).job.status, 'failed');
  assert.equal(J.recover('nope', 'x'), null);
  const back = J.recover(job.job_id, 'rev@mantu.com'); assert.deepEqual([back.status, back.attempt, back.last_error], ['queued', 0, null]);
  assert.deepEqual(J.events(job.job_id).at(-1).actor, 'rev@mantu.com'); assert.equal(J.recover(job.job_id, 'x'), null, 'only a failed job is recovered');
  assert.equal((await J.run(job.job_id, ok)).job.status, 'succeeded');
  const o1 = (await J.enqueue(spec({ entity: 'ev-9', revision: 1, hash: '1'.repeat(64) }))).job, o2 = (await J.enqueue(spec({ entity: 'ev-9', revision: 2, hash: '2'.repeat(64), destination: 'IMP' }))).job;
  const stopped = J.halt('ev-9', { reason: 'SOURCE_SUPERSEDED', keepRevision: 2 });
  assert.deepEqual(stopped.map(j => [j.job_id, j.status, j.last_error]), [[o1.job_id, 'needs_reconciliation', 'SOURCE_SUPERSEDED']]); assert.equal(J.get(o2.job_id).status, 'queued');
  assert.equal(J.halt('ev-9', { reason: 'X', destinations: ['DNA'] }).length, 0); assert.equal(J.halt('ev-9', { reason: 'PERMISSION_REVOKED', destinations: ['IMP'] })[0].job_id, o2.job_id);
  clock.t += 1;
});

test('an attempt that never reported back (a restart) is picked up after its lease and counted', async () => {
  const { l, J, clock } = setup({ leaseMs: 60_000, maxAttempts: 2 }), { job } = await J.enqueue(spec());
  l.sql.exec("UPDATE jobs SET status = 'running', attempt = 1, updated_at = ? WHERE job_id = ?", new Date(clock.t).toISOString(), job.job_id);
  assert.equal(J.due().length, 0); assert.equal((await J.run(job.job_id, ok)).ran, false);
  clock.t += 60_000; assert.equal(J.due().length, 1);
  const r = await J.run(job.job_id, async () => ({ ok: false, error: 'DOWN' })); assert.deepEqual([r.job.status, r.job.attempt], ['failed', 2]); // bounded: the lost attempt counted
});

test('the audit trail has actor, payload hash, timestamps, attempts, ack and errors, and never payload content', async () => {
  const { l, J } = setup({ maxAttempts: 2 }), { job } = await J.enqueue(spec());
  await J.run(job.job_id, async () => ({ ok: false, error: 'MOCK_DOWN' }));
  const ev = J.events(job.job_id); assert.equal(ev[0].actor, 'atlas-system'); assert.equal(ev[0].detail, job.payload_hash);
  assert.ok(ev.every(e => /^2026-11-01T/.test(e.at))); assert.deepEqual(ev.map(e => e.attempt), [0, 1, 1]);
  const dump = JSON.stringify([l.rows('SELECT * FROM job_events'), J.get(job.job_id), J.list('ev-1')]);
  assert.ok(!dump.includes('Zebracorp') && !dump.includes('triage'), 'payload text stays in the job\'s own payload column only');
});

test('the tables are additive and a second store over the same database is harmless', async () => {
  const { l } = setup(), names = l.rows("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name);
  for (const t of ['jobs', 'job_events']) assert.ok(names.includes(t), t);
  assert.equal(jobs(l), jobs(l));
  const l2 = new Library(l.sql, {}); assert.ok(jobs(l2));
});

// G1 (review: idempotency key reuse across revisions, in-flight delivery vs halt, halt covers dead letters)
test('the same content hash at a later revision is its own job (the key includes entity and revision)', async () => {
  const { J } = setup(), a = await J.enqueue(spec({ revision: 1 })), b = await J.enqueue(spec({ revision: 3 })), c = await J.enqueue(spec({ revision: 3 }));
  assert.equal(b.duplicate, false); assert.notEqual(a.job.job_id, b.job.job_id); assert.equal(c.duplicate, true);
  assert.equal((await J.enqueue(spec({ revision: 3, entity: 'ev-2' }))).duplicate, false, 'another record with the same hash is another job');
});

test('halt stops a dead-lettered (failed) job too, so recovery cannot put it back in the queue', async () => {
  const { J } = setup(), { job } = await J.enqueue(spec());
  await J.run(job.job_id, async () => ({ ok: false, retryable: false, error: 'DOWN' }));
  assert.equal(J.get(job.job_id).status, 'failed');
  assert.equal(J.halt('ev-1', { reason: 'PERMISSION_REVOKED' }).length, 1);
  assert.equal(J.get(job.job_id).status, 'needs_reconciliation'); assert.equal(J.recover(job.job_id, 'rev'), null);
});

test('a delivery attempt in flight when halt() stops the job never overwrites the halt, and the job is not due again', async () => {
  const { J, clock } = setup(), { job } = await J.enqueue(spec());
  let answer; const inflight = J.run(job.job_id, () => new Promise(r => { answer = r; }));
  await new Promise(r => setImmediate(r));
  J.halt('ev-1', { reason: 'SOURCE_SUPERSEDED', keepRevision: 4 });
  answer({ ok: false, retryable: true, error: 'TIMEOUT' });
  const r = await inflight;
  assert.equal(r.halted, true); assert.equal(J.get(job.job_id).status, 'needs_reconciliation'); assert.equal(J.get(job.job_id).last_error, 'SOURCE_SUPERSEDED');
  clock.t += 3600e3; assert.deepEqual(J.due(), []);
  assert.ok(J.events(job.job_id).some(e => e.event === 'result_after_halt' && e.detail === 'retry'));
  // a delivery that did get through is not recorded as success either
  const { job: j2 } = await J.enqueue(spec({ revision: 5, hash: 'z'.repeat(64) }));
  let ans2; const p2 = J.run(j2.job_id, () => new Promise(r => { ans2 = r; })); await new Promise(r => setImmediate(r));
  J.halt('ev-1', { reason: 'EVIDENCE_WITHDRAWN' }); ans2({ ok: true, ack: ack() }); await p2;
  assert.equal(J.get(j2.job_id).status, 'needs_reconciliation'); assert.equal(J.get(j2.job_id).destination_ack, null);
});
