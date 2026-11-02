// MiChat CV, ready to connect (X2, Tony 2026-11-02). Contract tests against a mock MiChat on 127.0.0.1: the ASSUMED contract (MICHAT_CV_CONTRACT=assumed),
// the outbox when nothing is configured, retries with backoff and the idempotency key, the health check, translation into the CV's language and
// client names kept out of the CV. No real MiChat URL, token or data anywhere: synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { effectiveConfig, michatConnection, michatReadiness, createMichatAdapter, michatHealth, cvOptions, cvTextMask, translateClaims, assumedContractOn } from '../src/michat.js';
import { adapterMode, adapterModeFor, liveAdapter, buildPayload } from '../src/adapters.js';
import { CONNECTIONS_CONFIG } from '../src/policy.generated.js';
import { jobs, configure } from '../src/jobs.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

async function server(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { const rec = { method: req.method, url: req.url, headers: req.headers, json: (() => { try { return JSON.parse(body); } catch { return null; } })() }; seen.push(rec); handler(rec, res, seen); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const ack = rec => ({ cv_document_id: 'cv-synthetic-42', version: 3, external_revision: rec.json?.external_revision, content_hash: rec.json?.content_hash, status: 'generated' });
const live = (url, extra = {}) => ({ ATLAS_ADAPTERS: 'live', MICHAT_CV_CONTRACT: 'assumed', MICHAT_CV_BASE_URL: url, MICHAT_CV_TOKEN: 'synthetic-token-value', ...extra });
const envelope = (over = {}) => ({ job_id: 'job-1', idempotency_key: 'ev-7:2:hash-7:MiChat', source_entity_id: 'ev-7', source_revision: 2, destination: 'MiChat', payload_hash: 'ph', ...over });
const ENTITY = { id: 'ev-7', revision: 2, content_hash: 'hash-7', owner_sub: 'person-synthetic-1' };
const CLAIMS = [
  { claim_id: 'c1', claim_type: 'deliverable', statement: 'Built the claims triage service for Globex Corporation with Jane Synthetic', attribution: 'individual', origin: 'consultant_reported', review_status: 'validated', source_refs: [] },
  { claim_id: 'c2', claim_type: 'metric', statement: 'Globex cut handling time by 30 percent', value: 30, unit: 'percent', baseline: '10 days', after_state: '7 days', period: 'Q3', attribution: 'individual', origin: 'consultant_reported', review_status: 'validated', source_refs: [] },
  { claim_id: 'c3', claim_type: 'technology', statement: 'Python and Kafka', attribution: 'individual', origin: 'consultant_reported', review_status: 'validated', source_refs: [{ kind: 'interview', quote: 'Python and Kafka' }] },
];
// A library with one synthetic client and contact (the refs table is what scrub.js reads).
const fakeLib = () => ({ rows: q => /COUNT/.test(q) ? [{ n: 1, u: 'u', r: 1 }] : [{ owner: 'o1', data: JSON.stringify({ client: { name: 'Globex Corporation', contact: 'Jane Synthetic' } }) }] });
const payload = (cv = {}) => buildPayload('MICHAT_CV', { entity: ENTITY, claims: CLAIMS, approval: { at: '2026-11-02T12:00:00Z' }, grants: [{ id: 'g1', purpose: 'cv', status: 'active', revision: 1 }], cv, mask: cvTextMask(fakeLib()) });

test('unconfigured is the outbox: without MICHAT_CV_CONTRACT the registry is untouched, the branch stays mock (or blocked under live) and nothing is fetched', async () => {
  assert.equal(effectiveConfig({}), CONNECTIONS_CONFIG); assert.equal(assumedContractOn({}), false);
  assert.equal(michatConnection({}).status, 'not_configured');
  assert.deepEqual(adapterModeFor({}, 'MICHAT_CV'), { mode: 'off' }); assert.deepEqual(adapterModeFor({ ATLAS_ADAPTERS: 'mock' }, 'MICHAT_CV'), { mode: 'mock' });
  assert.equal(adapterModeFor({ ATLAS_ADAPTERS: 'live' }, 'MICHAT_CV').mode, 'blocked');
  // The contract alone, or the contract and the live flag without the URL and token, is still not enough: refused before any request.
  let fetched = 0; const fetcher = () => { fetched++; throw new Error('no request may be made'); };
  for (const env of [{ MICHAT_CV_CONTRACT: 'assumed' }, { MICHAT_CV_CONTRACT: 'assumed', ATLAS_ADAPTERS: 'live' }, { MICHAT_CV_CONTRACT: 'assumed', ATLAS_ADAPTERS: 'live', MICHAT_CV_BASE_URL: 'https://michat.invalid' }]) {
    assert.equal(michatReadiness(env).eligible, false, JSON.stringify(env));
    const out = await createMichatAdapter(env, { fetcher }).send(envelope(), payload());
    assert.equal(out.ok, false); assert.match(out.error, /^CONNECTION_NOT_READY/);
    assert.equal((await michatHealth(env, { fetcher })).error, 'CONNECTION_NOT_READY');
  }
  assert.equal(fetched, 0);
  assert.equal(adapterModeFor({ MICHAT_CV_CONTRACT: 'assumed', ATLAS_ADAPTERS: 'live' }, 'MICHAT_CV').mode, 'blocked');
});

test('assumed contract: Bearer token, Idempotency-Key, the documented body (no client names, withheld text stays withheld) and a sandbox acknowledgement', async () => {
  const srv = await server((rec, res) => reply(res, 201, ack(rec)));
  try {
    const env = live(srv.url);
    assert.equal(michatReadiness(env).eligible, true); assert.deepEqual(adapterModeFor(env, 'MICHAT_CV'), { mode: 'live' }); assert.equal(adapterMode(env).mode, 'live');
    const out = await liveAdapter(env, 'MICHAT_CV').send(envelope(), payload());
    assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.ack.destination_record_id, 'cv-synthetic-42'); assert.equal(out.ack.mock, true, 'sandbox by default: never "synced"');
    const [rec] = srv.seen;
    assert.equal(rec.method, 'POST'); assert.equal(rec.url, '/v1/cv-entries');
    assert.equal(rec.headers.authorization, 'Bearer synthetic-token-value'); assert.equal(rec.headers['idempotency-key'], 'ev-7:2:hash-7:MiChat');
    const b = rec.json;
    assert.deepEqual([b.external_id, b.external_revision, b.content_hash, b.source_system, b.consultant.id, b.cv.language], ['ev-7', 2, 'hash-7', 'atlas', 'person-synthetic-1', null]);
    assert.equal(b.entries.length, 3); assert.equal(b.consents[0].id, 'g1');
    assert.equal(b.entries[0].text, 'Built the claims triage service for a client with a contact');
    assert.deepEqual([b.entries[1].text, b.entries[1].text_withheld_reason, b.entries[1].metric.value], [null, 'CLIENT_PERMISSION_UNKNOWN', 30]);
    assert.deepEqual([b.entries[2].text, b.entries[2].text_withheld_reason], [null, 'VERBATIM_ASR_NOT_REVIEWED']);
    assert.doesNotMatch(JSON.stringify(b), /Globex|Jane Synthetic/);
    const prod = await createMichatAdapter(live(srv.url, { MICHAT_CV_SANDBOX: 'false' })).send(envelope(), payload());
    assert.equal(prod.ack.mock, false, 'MICHAT_CV_SANDBOX=false: a real record');
  } finally { await srv.close(); }
});

test('retry with backoff then success through the real job pump, the same key on every attempt; 409 reconciles; 401 fails without a retry', async () => {
  let status = 503;
  const srv = await server((rec, res) => status === 200 ? reply(res, 201, ack(rec)) : reply(res, status, { error: 'synthetic' }));
  try {
    let t = Date.UTC(2026, 10, 2, 12), id = 0;
    const lib = new Library(memorySql(), { now: () => new Date(t).toISOString(), newId: () => 'j' + ++id });
    configure(lib, { now: () => t, random: () => 0 });
    const J = jobs(lib), conn = createMichatAdapter(live(srv.url), { now: () => t });
    const { job } = await J.enqueue({ entity: 'ev-7', revision: 2, hash: 'hash-7', destination: 'MiChat', payload: payload(), actor: 'atlas-system' });
    const first = await J.run(job.job_id, (e, p) => conn.send(e, p));
    assert.deepEqual([first.job.status, first.job.last_error], ['retrying', 'HTTP_503']);
    assert.equal((await J.run(job.job_id, (e, p) => conn.send(e, p))).ran, false, 'backoff: not due yet');
    t += 60 * 60 * 1000; status = 200;
    const second = await J.run(job.job_id, (e, p) => conn.send(e, p));
    assert.equal(second.job.status, 'succeeded'); assert.equal(srv.seen.length, 2);
    assert.equal(srv.seen[0].headers['idempotency-key'], job.idempotency_key); assert.equal(srv.seen[1].headers['idempotency-key'], job.idempotency_key);
    status = 409; const c = await conn.send(envelope(), payload()); assert.deepEqual([c.ok, c.conflict], [false, true]);
    status = 401; const u = await conn.send(envelope(), payload()); assert.deepEqual([u.ok, u.retryable], [false, false]);
  } finally { await srv.close(); }
});

test('health check: one GET to the assumed health path, status and time only', async () => {
  let code = 200;
  const srv = await server((rec, res) => reply(res, code, { ok: true, secret_detail: 'never echoed' }));
  try {
    const ok = await michatHealth(live(srv.url));
    assert.equal(ok.ok, true); assert.equal(ok.status, 200); assert.equal(srv.seen[0].url, '/v1/health'); assert.equal(srv.seen[0].headers.authorization, 'Bearer synthetic-token-value');
    assert.ok(!('secret_detail' in ok));
    code = 503; assert.deepEqual([(await michatHealth(live(srv.url))).ok, (await michatHealth(live(srv.url))).status], [false, 503]);
    assert.equal((await michatHealth({ ...live(srv.url), ATLAS_ADAPTERS: 'mock' })).ok, false, 'health runs without the live flag but still needs a configured connection'); // ignoreAdaptersFlag: the call is made
  } finally { await srv.close(); }
});

test('translation into the CV language: any language tag, each entry carries its language and a confidence, never a gate', async () => {
  assert.deepEqual(cvOptions({ MICHAT_CV_LANGUAGE: 'pt-BR', MICHAT_CV_TEMPLATE: ' Mantu standard \u0007' }), { language: 'pt-BR', template: 'Mantu standard' });
  assert.deepEqual(cvOptions({ MICHAT_CV_LANGUAGE: 'not a tag!' }), { language: null, template: null }); assert.equal(cvOptions({ MICHAT_CV_LANGUAGE: 'ja' }).language, 'ja');
  const p = payload(cvOptions({ MICHAT_CV_LANGUAGE: 'ja' }));
  const calls = [];
  const fake = async (env, text, { target }) => { calls.push([text, target]); return { text: `[${target}] ${text}`, source: 'en', target, translated: true, engine: 'fake', confidence: 'medium', flags: ['LENGTH_UNUSUAL'] }; };
  const out = await translateClaims({}, p, { translate: fake });
  assert.deepEqual(calls, [['Built the claims triage service for a client with a contact', 'ja']], 'only text that is sent is translated, after masking');
  assert.deepEqual([out.claims[0].statement, out.claims[0].statement_language, out.claims[0].translation_confidence], ['[ja] Built the claims triage service for a client with a contact', 'ja', 'medium']);
  assert.equal(out.claims[1].statement, null);
  assert.equal(await translateClaims({}, payload(), { translate: fake }).then(x => x.claims[0].statement), 'Built the claims triage service for a client with a contact', 'no CV language: unchanged');
  // End to end through the adapter with the real translate.js and a fake Workers AI: the translated text and its confidence reach MiChat.
  const srv = await server((rec, res) => reply(res, 201, ack(rec)));
  try {
    const AI = { run: async () => ({ response: 'クレーム振り分けサービスをクライアントのために構築しました' }) };
    const r = await createMichatAdapter({ ...live(srv.url, { MICHAT_CV_LANGUAGE: 'ja' }), AI, TALKER_MODEL: 'fake-model' }).send(envelope(), payload({ language: 'ja' }));
    assert.equal(r.ok, true);
    const e = srv.seen[0].json.entries[0];
    assert.equal(srv.seen[0].json.cv.language, 'ja'); assert.match(e.text, /クレーム/); assert.equal(e.text_language, 'ja'); assert.ok(['high', 'medium', 'low'].includes(e.translation_confidence));
  } finally { await srv.close(); }
});
