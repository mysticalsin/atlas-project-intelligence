// The connector wired into the branch fan-out (v2.2 C1): under ATLAS_ADAPTERS=live a destination whose connection is configured is delivered over HTTP and
// reaches sync_complete only on a real acknowledgement bound to the exact revision; every other destination stays blocked_external. This file mutates the
// imported CONNECTIONS_CONFIG in place (one process per test file), so it is kept apart from connectors.test.js. Synthetic data, a local fake server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Library } from '../src/library.js';
import { evidence } from '../src/evidence.js';
import * as B from '../src/branches.js';
import { jobs } from '../src/jobs.js';
import { registry } from '../src/adapters.js';
import { CONNECTIONS_CONFIG } from '../src/policy.generated.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' };
const NOTES = { session_id: 'sess-001', project_ref: 'PRJ-1', details: [
  { id: 'D-001', field: 'problem', item_id: 'item-1', quote: 'Zebracorp claims were bouncing between three teams.', status: 'reported' },
  { id: 'D-002', field: 'contribution', item_id: 'item-2', quote: 'I designed and built the routing model.', status: 'reported' },
  { id: 'D-003', field: 'intervention', item_id: 'item-3', quote: 'We shipped a triage queue with a routing model in front of it.', status: 'reported' }] };

let handler = (r, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: { id: 'dna-rec-1', version: 1 } })); };
const seen = [];
const srv = http.createServer((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body }); handler(req, res); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${srv.address().port}`;
test.after(() => { srv.closeAllConnections?.(); srv.close(); });

const dna = CONNECTIONS_CONFIG.connections.find(c => c.id === 'dna_skills');
function configureDna(patch = {}) {
  Object.assign(dna, { status: 'configured_untested', owner: 'Test Owner', sandbox: false, endpoints: { send: { method: 'POST', path: '/skills' } }, timeout_ms: 2000,
    field_mapping: { entity_id: 'ref', source_revision: 'rev', content_hash: 'hash', consultant_id: 'person', 'assertions[].claim_id': 'skills[].id', 'assertions[].statement': 'skills[].text' },
    ack_rule: { ...dna.ack_rule, record_id_path: 'data.id', version_path: 'data.version', hash_echo_path: null }, ...patch });
}
const ENV = { ATLAS_ADAPTERS: 'live', DNA_SKILLS_BASE_URL: URL_, DNA_SKILLS_TOKEN: 'tok-test' };

async function approvedWith(env) {
  let t = 0, n = 0, clock = Date.UTC(2026, 10, 1, 12);
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString(), newId: () => 'id' + String(++n).padStart(4, '0') });
  B.configure(l, { env, now: () => clock, random: () => 0, maxAttempts: 3, adapters: {} });
  const ev = evidence(l), d = await ev.createDraftFromNotes(OWNER.email, NOTES);
  for (const purpose of ['skills_profile', 'cv', 'matching']) ev.grantPermission(OWNER, d.id, { expected_revision: d.revision, purpose });
  const q = ev.submit(OWNER.email, d.id, d.revision);
  const ok = await ev.review(REV, q.id, 'approve', { expected_revision: q.revision, content_hash: q.content_hash });
  return { l, ev, id: ok.id };
}
const status = (l, id) => Object.fromEntries(l.rows('SELECT branch, status FROM branch_status WHERE entity = ?', id).map(r => [r.branch, r.status]));

test('live is per connection: a ready DNA connection is delivered over HTTP and reaches sync_complete; the others stay blocked_external; nothing else is touched', async () => {
  configureDna(); seen.length = 0;
  const { l, ev, id } = await approvedWith(ENV);
  assert.deepEqual(status(l, id), { evidence: 'evidence_approved', maap: 'maap_pending', project_review: 'project_review_pending', dna: 'sync_complete', mechat: 'blocked_external', imp: 'blocked_external', spotlight: 'spotlight_draft' });
  assert.equal(seen.length, 1, 'one HTTP request, for DNA only');
  assert.equal(seen[0].headers.authorization, 'Bearer tok-test'); assert.match(seen[0].headers['idempotency-key'], /:DNA$/);
  const sent = JSON.parse(seen[0].body); assert.deepEqual(Object.keys(sent).sort(), ['hash', 'person', 'ref', 'rev', 'skills']);
  assert.equal(/transcript|source_refs|quote|session|item_id|Zebracorp/.test(seen[0].body), false, 'no interview content left');
  const [job] = jobs(l).list(id); assert.deepEqual([job.status, job.destination_ack.mock, job.destination_ack.destination_record_id], ['succeeded', false, 'dna-rec-1']);
  assert.equal(l.rows("SELECT mock FROM branch_status WHERE entity = ? AND branch = 'dna'", id)[0].mock, 0);
  assert.equal(B.statusView(ev, OWNER, id).cards.find(c => c.branch === 'dna').mock, false);
  assert.equal(registry(l).DNA_SKILLS_WRITEBACK.calls.length, 0, 'the mock was not used');
  assert.deepEqual(l.rows("SELECT reason FROM branch_status WHERE entity = ? AND branch IN ('mechat','imp')", id).map(r => r.reason), ['BLOCKED_EXTERNAL', 'BLOCKED_EXTERNAL']);
});

test('a sandbox connection is delivered but shown as a mock acknowledgement, never as synced', async () => {
  configureDna({ sandbox: true }); seen.length = 0;
  const { l, id } = await approvedWith(ENV);
  assert.equal(status(l, id).dna, 'mock_acknowledged'); assert.equal(seen.length, 1);
  const [job] = jobs(l).list(id); assert.deepEqual([job.destination_ack.mock, job.destination_ack.sandbox], [true, true]);
});

test('a destination that answers 409 leaves the card needs_reconciliation; one that answers 503 retries; nothing is reported synced', async () => {
  configureDna(); seen.length = 0;
  handler = (r, res) => { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end('{}'); };
  const a = await approvedWith(ENV); assert.equal(status(a.l, a.id).dna, 'needs_reconciliation');
  handler = (r, res) => { res.writeHead(503); res.end(); };
  const b = await approvedWith(ENV); assert.equal(status(b.l, b.id).dna, 'retrying');
  assert.equal(b.l.rows("SELECT COUNT(*) AS n FROM branch_status WHERE status IN ('sync_complete','published')")[0].n, 0);
});

test('without the live flag or with a missing secret the same configured connection is blocked, not mocked, and no request is made', async () => {
  configureDna(); seen.length = 0;
  handler = (r, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":{"id":"x","version":1}}'); };
  const noSecret = await approvedWith({ ...ENV, DNA_SKILLS_TOKEN: undefined });
  assert.equal(status(noSecret.l, noSecret.id).dna, 'blocked_external');
  const mock = await approvedWith({ ...ENV, ATLAS_ADAPTERS: 'mock' });
  assert.equal(status(mock.l, mock.id).dna, 'mock_acknowledged', 'mock stays the default behaviour');
  const off = await approvedWith({ ...ENV, ATLAS_ADAPTERS: 'off' });
  assert.equal(status(off.l, off.id).dna, 'projection_pending');
  assert.equal(seen.length, 0);
});
