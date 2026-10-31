// Contract tests for the generic connectors (v2.2 C1). A local fake HTTP server per scenario stands in for an owner's system: no real vendor, URL or
// credential exists anywhere in these tests (the field names below are invented test names, not any owner's). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CONNECTIONS_CONFIG } from '../src/policy.generated.js';
import { readiness, createHttpConnector, createInboundConnector, parseAck, allowlist, mapOutbound, findForbidden, connectionStatus, healthCheck, clearTokenCache,
  connectionById, connectionForAdapter, statusAtLeast, anyLiveEligible } from '../src/connectors.js';
import { adapterMode, adapterModeFor, registry, buildPayload, createMockAdapter } from '../src/adapters.js';
import { validate, unsupported } from '../src/schema-lite.js';
import { Library } from '../src/library.js';
import { jobs, configure, classify } from '../src/jobs.js';
import { memorySql } from './sqlite.js';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../../..'), CONFIG_DIR = resolve(ROOT, 'atlas_voice/config');
const clone = o => JSON.parse(JSON.stringify(o));

// ---- fake destination ----
async function server(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() };
      seen.push(rec);
      handler(rec, res, seen);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const reply = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };

// ---- a connection configured as an owner would configure it (invented test names) ----
const OUTBOUND_MAP = {
  entity_id: 'record.external_ref', source_revision: 'record.revision', content_hash: 'record.hash', consultant_id: 'record.person',
  'assertions[].claim_id': 'record.items[].id', 'assertions[].statement': 'record.items[].text',
};
const ACK_RULE = { kind: 'write', record_id_path: 'data.id', version_path: 'data.version', destination_revision_path: null, revision_echo_path: null, hash_echo_path: null, hash_echo_required: false };
function configured(id, patch = {}, base = CONNECTIONS_CONFIG) {
  const cfg = clone(base), c = cfg.connections.find(x => x.id === id);
  Object.assign(c, { status: 'configured_untested', owner: 'Test Owner', sandbox: false, endpoints: { send: { method: 'POST', path: '/v1/records' }, health: { method: 'GET', path: '/health' } },
    field_mapping: clone(OUTBOUND_MAP), ack_rule: { ...c.ack_rule, ...ACK_RULE }, timeout_ms: 2000 }, patch);
  return { cfg, c };
}
const envFor = (c, url, extra = {}) => {
  const a = c.auth, env = { ATLAS_ADAPTERS: 'live', [c.base_url_var]: url };
  for (const n of a.secret_names) env[n] = `secret-value-of-${n}`;
  if (a.token_url_var) env[a.token_url_var] = `${url}/oauth/token`;
  return { ...env, ...extra };
};
const envelope = (over = {}) => ({ job_id: 'job-1', idempotency_key: 'ev-1:3:hash3:DNA', source_entity_id: 'ev-1', source_revision: 3, destination: 'DNA', payload_hash: 'ph', ...over });
const PAYLOAD = { entity_id: 'ev-1', source_revision: 3, content_hash: 'hash3', approved_at: '2026-11-01T10:00:00Z', consultant_id: 'person-9', reviewer: 'rev-2', effective_date: '2026-11-01',
  assertions: [{ claim_id: 'c1', claim_type: 'technology', statement: 'Built the ingestion pipeline', attribution: 'individual', origin: 'consultant_reported' },
    { claim_id: 'c2', claim_type: 'deliverable', statement: 'Wrote the runbook', attribution: 'individual', origin: 'consultant_reported' }] };
const okAck = { data: { id: 'rec-77', version: 4 } };
const connector = (cfg, c, srv, extraEnv = {}, opts = {}) => createHttpConnector(c.id, { config: cfg, env: envFor(c, srv.url, extraEnv), ...opts });

// ======================= registry, defaults, refusal =======================
test('mock stays the default: ATLAS_ADAPTERS off/mock/live semantics, and live is blocked per connection until one is ready', () => {
  assert.deepEqual(adapterMode({}), { mode: 'off' });
  assert.deepEqual(adapterMode({ ATLAS_ADAPTERS: 'mock' }), { mode: 'mock' });
  assert.deepEqual(adapterMode({ ATLAS_ADAPTERS: 'anything' }), { mode: 'off' });
  const live = adapterMode({ ATLAS_ADAPTERS: 'live' });
  assert.deepEqual([live.mode, live.code], ['blocked', 'BLOCKED_EXTERNAL'], 'the shipped connections are all unconfigured, so live is still blocked');
  for (const name of ['DNA_SKILLS_WRITEBACK', 'MICHAT_CV', 'IMP_CAPABILITY', 'SPOTLIGHT_CMS']) {
    assert.equal(adapterModeFor({ ATLAS_ADAPTERS: 'live' }, name).mode, 'blocked');
    assert.equal(adapterModeFor({ ATLAS_ADAPTERS: 'mock' }, name).mode, 'mock');
  }
  const reg = registry(new Library(memorySql(), { now: () => '2026-11-01T00:00:00Z', newId: () => 'x' }));
  for (const name of ['DNA_SKILLS_WRITEBACK', 'MICHAT_CV', 'IMP_CAPABILITY', 'SPOTLIGHT_CMS']) assert.equal(reg[name].mock, true, `${name} registry entry is still the mock`);
  assert.equal(anyLiveEligible({ ATLAS_ADAPTERS: 'live' }), false);
});

test('the shipped config: michat_cv maps to the existing MICHAT_CV adapter; every external connection starts not_configured with no owner', () => {
  assert.equal(connectionForAdapter('MICHAT_CV')?.id, 'michat_cv');
  assert.equal(connectionById('mechat_cv'), null, 'the old spelling is not a connection id');
  assert.deepEqual(CONNECTIONS_CONFIG.connections.map(c => c.id), ['identity', 'prefill_profile', 'staffing', 'opportunity', 'dna_skills', 'michat_cv', 'imp_capability', 'maap_review', 'project_review', 'spotlight_cms']);
  for (const c of CONNECTIONS_CONFIG.connections.filter(c => c.managed_by === 'http_connector')) {
    assert.equal(c.status, 'not_configured', c.id); assert.equal(c.owner, null, c.id); assert.deepEqual(c.endpoints, {}, c.id); assert.deepEqual(c.field_mapping, {}, c.id);
  }
  assert.deepEqual(['not_configured', 'configured_untested'].map(s => statusAtLeast(s, 'configured_untested')), [false, true]);
});

test('refuses to run unless status, secrets, live flag, base URL, endpoint, mapping and ack rule are all in place; no request is made', async () => {
  const srv = await server((r, res) => reply(res, 200, okAck));
  try {
    const { cfg, c } = configured('dna_skills'), good = envFor(c, srv.url);
    assert.deepEqual(readiness(c, good).reasons, []);
    const cases = [
      ['STATUS_NOT_CONFIGURED', () => [{ ...c, status: 'not_configured' }, good]],
      ['ADAPTERS_NOT_LIVE', () => [c, { ...good, ATLAS_ADAPTERS: 'mock' }]],
      [`SECRET_MISSING:${c.auth.secret_names[0]}`, () => [c, { ...good, [c.auth.secret_names[0]]: '' }]],
      ['BASE_URL_MISSING', () => [c, { ...good, [c.base_url_var]: undefined }]],
      ['BASE_URL_INVALID', () => [c, { ...good, [c.base_url_var]: 'http://example.com' }]],
      ['ENDPOINT_NOT_CONFIGURED', () => [{ ...c, endpoints: {} }, good]],
      ['FIELD_MAPPING_EMPTY', () => [{ ...c, field_mapping: {} }, good]],
      ['ACK_RULE_MISSING', () => [{ ...c, ack_rule: { ...c.ack_rule, version_path: null } }, good]],
      ['NOT_WIRED', () => [{ ...c, wired: false }, good]],
    ];
    for (const [code, make] of cases) {
      const [conn, env] = make(), r = readiness(conn, env);
      assert.ok(r.reasons.includes(code), `${code}: ${r.reasons}`);
      const cfg2 = clone(cfg); Object.assign(cfg2.connections.find(x => x.id === 'dna_skills'), conn);
      const out = await createHttpConnector('dna_skills', { config: cfg2, env }).send(envelope(), PAYLOAD);
      assert.equal(out.ok, false); assert.equal(out.retryable, false); assert.match(out.error, /^CONNECTION_NOT_READY:/);
    }
    assert.equal(srv.seen.length, 0, 'a refused connection never touches the network');
    for (const id of ['maap_review', 'project_review']) {
      const m = configured(id, {}, CONNECTIONS_CONFIG); // even fully configured, an unwired shell cannot run (no rubric, no payload builder)
      assert.ok(readiness(m.c, envFor(m.c, srv.url)).reasons.includes('NOT_WIRED'), id);
    }
  } finally { await srv.close(); }
});

// ======================= auth types =======================
test('bearer: the secret becomes the Authorization header, the body is built only through field_mapping, and a real 2xx ack is mock:false', async () => {
  const srv = await server((r, res) => reply(res, 201, okAck));
  try {
    const { cfg, c } = configured('dna_skills'), out = await connector(cfg, c, srv).send(envelope(), PAYLOAD);
    assert.equal(out.ok, true); assert.equal(out.ack.mock, false); assert.equal(out.ack.sandbox, false);
    assert.deepEqual([out.ack.destination_record_id, out.ack.destination_version, out.ack.revision, out.ack.hash, out.ack.http_status], ['rec-77', 4, 3, 'hash3', 201]);
    const [req] = srv.seen;
    assert.deepEqual([req.method, req.url, req.headers.authorization], ['POST', '/v1/records', 'Bearer secret-value-of-DNA_SKILLS_TOKEN']);
    assert.deepEqual(req.json, { record: { external_ref: 'ev-1', revision: 3, hash: 'hash3', person: 'person-9', items: [{ id: 'c1', text: 'Built the ingestion pipeline' }, { id: 'c2', text: 'Wrote the runbook' }] } });
    assert.equal(/reviewer|approved_at|claim_type|attribution/.test(req.body), false, 'unmapped fields are never sent');
  } finally { await srv.close(); }
});

test('api key header: the header name comes from config, the key from the secret', async () => {
  const srv = await server((r, res) => reply(res, 200, okAck));
  try {
    const { cfg, c } = configured('dna_skills', { auth: { type: 'api_key_header', secret_names: ['DNA_SKILLS_KEY'], secret_roles: { key: 'DNA_SKILLS_KEY' }, header_name: 'X-Test-Key' } });
    assert.equal((await connector(cfg, c, srv).send(envelope(), PAYLOAD)).ok, true);
    assert.equal(srv.seen[0].headers['x-test-key'], 'secret-value-of-DNA_SKILLS_KEY'); assert.equal(srv.seen[0].headers.authorization, undefined);
    const noName = configured('dna_skills', { auth: { type: 'api_key_header', secret_names: ['DNA_SKILLS_KEY'], secret_roles: { key: 'DNA_SKILLS_KEY' }, header_name: null } });
    assert.ok(readiness(noName.c, envFor(noName.c, srv.url)).reasons.includes('AUTH_HEADER_NAME_MISSING'));
  } finally { await srv.close(); }
});

test('oauth2 client credentials: standard token request, cached until expiry, one fresh token on a 401, refused credentials fail without a retry', async () => {
  clearTokenCache();
  let tokens = 0, rejectFirst = false;
  const srv = await server((r, res) => {
    if (r.url === '/oauth/token') { tokens++; return reply(res, 200, { access_token: `tok-${tokens}`, token_type: 'Bearer', expires_in: 3600 }); }
    if (rejectFirst && r.headers.authorization === 'Bearer tok-1') return reply(res, 401, {});
    return reply(res, 200, okAck);
  });
  try {
    const auth = { type: 'oauth2_client_credentials', secret_names: ['T_CLIENT_ID', 'T_CLIENT_SECRET'], secret_roles: { client_id: 'T_CLIENT_ID', client_secret: 'T_CLIENT_SECRET' }, token_url_var: 'T_TOKEN_URL', scope_var: 'T_SCOPE', token_auth: 'basic' };
    const { cfg, c } = configured('dna_skills', { auth });
    let t = 1000; const conn = connector(cfg, c, srv, { T_SCOPE: 'write:test' }, { now: () => t });
    assert.equal((await conn.send(envelope(), PAYLOAD)).ok, true); assert.equal((await conn.send(envelope(), PAYLOAD)).ok, true);
    assert.equal(tokens, 1, 'the token is cached');
    const tokenReq = srv.seen[0];
    assert.equal(tokenReq.headers.authorization, `Basic ${Buffer.from('secret-value-of-T_CLIENT_ID:secret-value-of-T_CLIENT_SECRET').toString('base64')}`);
    assert.equal(tokenReq.headers['content-type'], 'application/x-www-form-urlencoded'); assert.equal(tokenReq.body, 'grant_type=client_credentials&scope=write%3Atest');
    assert.equal(srv.seen[1].headers.authorization, 'Bearer tok-1');
    t += 3600 * 1000; await conn.send(envelope(), PAYLOAD); assert.equal(tokens, 2, 'an expired token is fetched again');
    rejectFirst = true; clearTokenCache(); tokens = 0; // tok-1 is rejected by the resource once: one fresh token, then success
    assert.equal((await conn.send(envelope(), PAYLOAD)).ok, true); assert.equal(tokens, 2);
    // client_secret_post variant sends the credentials in the body
    clearTokenCache(); srv.seen.length = 0; rejectFirst = false;
    const post = configured('dna_skills', { auth: { ...auth, token_auth: 'post' } });
    await connector(post.cfg, post.c, srv).send(envelope(), PAYLOAD);
    assert.match(srv.seen[0].body, /client_id=secret-value-of-T_CLIENT_ID&client_secret=secret-value-of-T_CLIENT_SECRET/); assert.equal(srv.seen[0].headers.authorization, undefined);
  } finally { await srv.close(); }
  clearTokenCache();
  const bad = await server((r, res) => reply(res, 400, { error: 'invalid_client' }));
  try {
    const auth = { type: 'oauth2_client_credentials', secret_names: ['T_CLIENT_ID', 'T_CLIENT_SECRET'], secret_roles: { client_id: 'T_CLIENT_ID', client_secret: 'T_CLIENT_SECRET' }, token_url_var: 'T_TOKEN_URL', token_auth: 'basic' };
    const { cfg, c } = configured('dna_skills', { auth }), out = await connector(cfg, c, bad).send(envelope(), PAYLOAD);
    assert.deepEqual([out.ok, out.retryable, out.error], [false, false, 'OAUTH_TOKEN_REFUSED_400']);
    assert.equal(bad.seen.length, 1, 'no resource call without a token');
  } finally { await bad.close(); clearTokenCache(); }
});

test('mtls: the request goes through the binding the secret name points at', async () => {
  const calls = [], binding = { fetch: async (url, init) => { calls.push([url, init.method]); return new Response(JSON.stringify(okAck), { status: 200, headers: { 'Content-Type': 'application/json' } }); } };
  const { cfg, c } = configured('dna_skills', { auth: { type: 'mtls', secret_names: ['DNA_SKILLS_CERT'], secret_roles: { binding: 'DNA_SKILLS_CERT' } } });
  const env = { ATLAS_ADAPTERS: 'live', [c.base_url_var]: 'https://owner.example/', DNA_SKILLS_CERT: binding };
  const out = await createHttpConnector('dna_skills', { config: cfg, env, fetcher: () => { throw new Error('plain fetch must not be used'); } }).send(envelope(), PAYLOAD);
  assert.equal(out.ok, true); assert.deepEqual(calls, [['https://owner.example/v1/records', 'POST']]);
  assert.ok(readiness(c, { ...env, DNA_SKILLS_CERT: 'a-string' }).reasons.includes('SECRET_MISSING:DNA_SKILLS_CERT'), 'a binding must be an object with fetch');
});

// ======================= idempotency, status mapping, timeout =======================
test('idempotency: the envelope key travels in the configured header on every attempt, so a replay is deduplicated by the destination', async () => {
  const done = new Map();
  const srv = await server((r, res) => {
    const k = r.headers['x-idem']; if (done.has(k)) return reply(res, 200, { data: { ...done.get(k), duplicate: true } });
    done.set(k, okAck.data); reply(res, 201, okAck);
  });
  try {
    const { cfg, c } = configured('dna_skills', { idempotency: { header: 'X-Idem' } }), conn = connector(cfg, c, srv);
    const a = await conn.send(envelope(), PAYLOAD), b = await conn.send(envelope(), PAYLOAD);
    assert.deepEqual([srv.seen[0].headers['x-idem'], srv.seen[1].headers['x-idem']], ['ev-1:3:hash3:DNA', 'ev-1:3:hash3:DNA']);
    assert.deepEqual([a.ack.destination_record_id, b.ack.destination_record_id, done.size], ['rec-77', 'rec-77', 1]);
    await conn.send(envelope({ idempotency_key: 'ev-1:4:hash4:DNA' }), PAYLOAD); assert.equal(done.size, 2, 'another revision is another key');
  } finally { await srv.close(); }
});

test('HTTP status mapping: 409/412 reconcile, 429/5xx/408 retry, 401/403/4xx fail with a code, redirects are never followed, bodies are never copied', async () => {
  let status = 200;
  const srv = await server((r, res) => status === 302 ? (res.writeHead(302, { Location: '/elsewhere' }), res.end()) : reply(res, status, { error: 'LEAKY BODY MUST NOT APPEAR', data: okAck.data }, status === 429 ? { 'Retry-After': '7' } : {}));
  try {
    const { cfg, c } = configured('dna_skills'), conn = connector(cfg, c, srv);
    const run = async s => { status = s; return conn.send(envelope(), PAYLOAD); };
    for (const s of [409, 412]) { const r = await run(s); assert.deepEqual([r.ok, r.conflict, r.error], [false, true, `DESTINATION_CONFLICT_HTTP_${s}`]); assert.equal(classify(r, { source_revision: 3 }).outcome, 'reconcile'); }
    const r429 = await run(429); assert.deepEqual([r429.ok, r429.retryable, r429.error, r429.retry_after_ms], [false, true, 'HTTP_429', 7000]);
    for (const s of [500, 502, 503, 504, 408]) { const r = await run(s); assert.deepEqual([r.retryable, r.error], [true, `HTTP_${s}`]); assert.equal(classify(r, { source_revision: 3 }).outcome, 'retry'); }
    for (const s of [400, 401, 403, 404, 422]) { const r = await run(s); assert.deepEqual([r.ok, r.retryable, r.error], [false, false, `HTTP_${s}`]); assert.equal(classify(r, { source_revision: 3 }).outcome, 'failed'); }
    const redirected = srv.seen.length; const r302 = await run(302); assert.deepEqual([r302.retryable, r302.error], [false, 'HTTP_REDIRECT_REFUSED']); assert.equal(srv.seen.length, redirected + 1, 'the redirect target was not requested');
    for (const r of [r429, await run(500)]) assert.equal(JSON.stringify(r).includes('LEAKY'), false);
  } finally { await srv.close(); }
});

test('429 retries with backoff and then succeeds through the real job envelope; a conflict ends as needs_reconciliation', async () => {
  let n = 0, mode = 'throttle';
  const srv = await server((r, res) => mode === 'conflict' ? reply(res, 409, {}) : ++n === 1 ? reply(res, 429, {}) : reply(res, 200, okAck));
  try {
    const { cfg, c } = configured('dna_skills'), conn = connector(cfg, c, srv);
    let t = Date.UTC(2026, 10, 1, 12), id = 0;
    const lib = new Library(memorySql(), { now: () => new Date(t).toISOString(), newId: () => 'j' + ++id });
    configure(lib, { now: () => t, random: () => 0 });
    const J = jobs(lib), { job } = await J.enqueue({ entity: 'ev-1', revision: 3, hash: 'hash3', destination: 'DNA', payload: PAYLOAD, actor: 'atlas-system' });
    const first = await J.run(job.job_id, (e, p) => conn.send(e, p));
    assert.deepEqual([first.job.status, first.job.last_error], ['retrying', 'HTTP_429']);
    assert.equal((await J.run(job.job_id, (e, p) => conn.send(e, p))).ran, false, 'not due yet: backoff');
    t += 60 * 60 * 1000;
    const second = await J.run(job.job_id, (e, p) => conn.send(e, p));
    assert.equal(second.job.status, 'succeeded'); assert.equal(second.job.destination_ack.mock, false); assert.equal(second.job.destination_ack.destination_record_id, 'rec-77');
    assert.equal(srv.seen[0].headers['idempotency-key'], job.idempotency_key); assert.equal(srv.seen[1].headers['idempotency-key'], job.idempotency_key);
    mode = 'conflict';
    const other = await J.enqueue({ entity: 'ev-2', revision: 1, hash: 'h2', destination: 'DNA', payload: PAYLOAD, actor: 'atlas-system' });
    assert.equal((await J.run(other.job.job_id, (e, p) => conn.send(e, p))).job.status, 'needs_reconciliation');
  } finally { await srv.close(); }
});

test('a destination that does not answer in timeout_ms is a retryable TIMEOUT', async () => {
  const srv = await server(() => { /* never answers */ });
  try {
    const { cfg, c } = configured('dna_skills', { timeout_ms: 150 });
    const t0 = Date.now(), r = await connector(cfg, c, srv).send(envelope(), PAYLOAD);
    assert.deepEqual([r.ok, r.retryable, r.error], [false, true, 'TIMEOUT']); assert.ok(Date.now() - t0 < 2000);
  } finally { await srv.close(); }
  const closed = await server((r, res) => reply(res, 200, okAck)); const { cfg, c } = configured('dna_skills'); const env = envFor(c, closed.url); await closed.close();
  const net = await createHttpConnector('dna_skills', { config: cfg, env }).send(envelope(), PAYLOAD);
  assert.deepEqual([net.retryable, net.error], [true, 'NETWORK_ERROR']);
});

// ======================= ack rule =======================
test('ack_rule parsing: record id and version are both required, paths are configurable, echoes must match, a non-JSON 2xx is no acknowledgement', async () => {
  const { c } = configured('dna_skills', { ack_rule: { ...ACK_RULE, record_id_path: 'a.b.id', version_path: 'a.v', destination_revision_path: 'a.rev', revision_echo_path: 'a.echo_rev', hash_echo_path: 'a.echo_hash' } });
  const env = envelope(), p = { content_hash: 'hash3' };
  const good = { a: { b: { id: 'X1' }, v: 'v9', rev: 3, echo_rev: 3, echo_hash: 'hash3' } };
  const r = parseAck(c, good, env, p);
  assert.deepEqual([r.ack.destination_record_id, r.ack.destination_version, r.ack.destination_revision, r.ack.revision, r.ack.hash, r.ack.mock], ['X1', 'v9', 3, 3, 'hash3', false]);
  assert.equal(parseAck(c, { a: { v: 'v9' } }, env, p).result.error, 'ACK_RULE_UNSATISFIED');
  assert.equal(parseAck(c, { a: { b: { id: 'X1' } } }, env, p).result.error, 'ACK_RULE_UNSATISFIED');
  assert.equal(parseAck(c, { a: { b: { id: '' }, v: 1 } }, env, p).result.error, 'ACK_RULE_UNSATISFIED');
  assert.equal(parseAck(c, { a: { b: { id: { nested: 1 } }, v: 1 } }, env, p).result.error, 'ACK_RULE_UNSATISFIED');
  assert.equal(parseAck(c, { a: { ...good.a, echo_rev: 2 } }, env, p).result.conflict, true, 'an echo of another revision is a disagreement');
  assert.equal(parseAck(c, { a: { ...good.a, echo_hash: 'other' } }, env, p).result.conflict, true);
  const newer = parseAck(c, { a: { ...good.a, rev: 5 } }, env, p); assert.equal(classify({ ok: true, ack: newer.ack }, { source_revision: 3 }).outcome, 'reconcile', 'a newer destination revision is never overwritten');
  const srv = await server((rq, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK'); });
  try { const x = configured('dna_skills'); const out = await connector(x.cfg, x.c, srv).send(envelope(), PAYLOAD); assert.deepEqual([out.ok, out.error], [false, 'ACK_RULE_UNSATISFIED']); } finally { await srv.close(); }
});

test('a sandbox connection reports mock:true, sandbox:true: a sandbox record is never "synced" or "published"', async () => {
  const srv = await server((r, res) => reply(res, 200, okAck));
  try {
    const { cfg, c } = configured('dna_skills', { sandbox: true }), out = await connector(cfg, c, srv).send(envelope(), PAYLOAD);
    assert.deepEqual([out.ok, out.ack.mock, out.ack.sandbox], [true, true, true]); assert.match(out.ack.note, /Sandbox/);
  } finally { await srv.close(); }
});

test('spotlight: a 2xx is not publication. The CMS must echo the exact revision hash and report a published state, URL and time', async () => {
  const pub = { kind: 'publication', record_id_path: 'cms.id', version_path: 'cms.ver', hash_echo_path: 'cms.hash', hash_echo_required: true,
    publication: { state_path: 'cms.state', published_values: ['live'], canonical_url_path: 'cms.url', published_at_path: 'cms.at' } };
  const body = (over = {}) => ({ cms: { id: 's-1', ver: 2, hash: 'rev-hash', state: 'live', url: 'https://spotlight.example/s-1', at: '2026-11-02T09:00:00Z', ...over } });
  let current = body();
  const srv = await server((r, res) => reply(res, 200, current));
  try {
    const { cfg, c } = configured('spotlight_cms', { ack_rule: pub, field_mapping: { audience: 'audience', story_revision_id: 'story.ref', revision_hash: 'story.hash', 'story.title': 'story.title' } });
    const payload = { audience: 'public', channel: 'web', story_revision_id: 'ev-1:3', revision_hash: 'rev-hash', content_hash: 'rev-hash', story: { title: 'T' } };
    const conn = connector(cfg, c, srv), ready = readiness(c, envFor(c, srv.url)); assert.deepEqual(ready.reasons, []);
    const ok = await conn.send(envelope({ destination: 'Spotlight' }), payload);
    assert.deepEqual([ok.ok, ok.ack.mock, ok.ack.published, ok.ack.publication_state, ok.ack.canonical_url, ok.ack.revision_hash, ok.ack.hash], [true, false, true, 'live', 'https://spotlight.example/s-1', 'rev-hash', 'rev-hash']);
    for (const [over, error] of [[{ state: 'draft' }, 'CMS_ACCEPTED_NOT_PUBLISHED'], [{ url: '' }, 'CMS_ACCEPTED_NOT_PUBLISHED'], [{ at: undefined }, 'CMS_ACCEPTED_NOT_PUBLISHED'], [{ hash: undefined }, 'ACK_HASH_ECHO_MISSING']]) {
      current = body(over); const r = await conn.send(envelope({ destination: 'Spotlight' }), payload); assert.deepEqual([r.ok, r.error], [false, error], JSON.stringify(over));
    }
    current = body({ hash: 'a-different-revision' }); const r = await conn.send(envelope({ destination: 'Spotlight' }), payload); assert.deepEqual([r.ok, r.conflict], [false, true]);
    assert.ok(readiness({ ...c, ack_rule: { ...pub, hash_echo_path: null } }, envFor(c, srv.url)).reasons.includes('PUBLICATION_ACK_RULE_MISSING'));
    // the CMS never receives consultant ids
    const leaked = await conn.send(envelope(), { ...payload, consultant_id: 'person-9' }); assert.match(leaked.error, /^PAYLOAD_FORBIDDEN_FIELD:consultant_id/);
  } finally { await srv.close(); }
});

// ======================= data minimisation =======================
test('payload minimisation: a transcript, internal notes, interview/session/ledger ids or source quotes anywhere in a payload stop the send before any request', async () => {
  const srv = await server((r, res) => reply(res, 200, okAck));
  try {
    const { cfg, c } = configured('dna_skills'), conn = connector(cfg, c, srv);
    const poisoned = [['transcript', { transcript: 'raw words' }], ['internal_notes', { internal_notes: { manager: 'x' } }], ['interview_id', { interview_id: 'iv-1' }], ['session_id', { assertions: [{ ...PAYLOAD.assertions[0], session_id: 's' }] }],
      ['source_refs', { assertions: [{ ...PAYLOAD.assertions[0], source_refs: [{ quote: 'q' }] }] }], ['ledger_id', { ledger_id: 'l' }], ['item_id', { item_id: 'i' }], ['quote', { assertions: [{ quote: 'q' }] }], ['TRANSCRIPT', { TRANSCRIPT: 'x' }]];
    for (const [key, extra] of poisoned) {
      const r = await conn.send(envelope(), { ...PAYLOAD, ...extra });
      assert.equal(r.ok, false); assert.equal(r.retryable, false); assert.match(r.error, new RegExp(`^PAYLOAD_FORBIDDEN_FIELD:`), key);
    }
    assert.equal(srv.seen.length, 0);
    // a mapping cannot smuggle one in either: a static field or a mapped destination key named like a forbidden key is refused
    const sneaky = configured('dna_skills', { static_fields: { 'meta.transcript': 'x' } });
    assert.match((await connector(sneaky.cfg, sneaky.c, srv).send(envelope(), PAYLOAD)).error, /^PAYLOAD_FORBIDDEN_FIELD:transcript/);
    assert.equal(srv.seen.length, 0);
    assert.equal(findForbidden({ a: [{ b: { Source_Refs: 1 } }] }, ['source_refs']), 'Source_Refs'); assert.equal(findForbidden({ a: 1 }, ['source_refs']), null);
  } finally { await srv.close(); }
});

test('the real payload builders produce nothing a connection must never send, and each satisfies its draft request schema', () => {
  const entity = { id: 'ev-1', revision: 3, content_hash: 'h3', owner_sub: 'person-9' }, approval = { at: '2026-11-01T10:00:00Z', approver_sub: 'rev-2' };
  const claims = [
    { claim_id: 'c1', claim_type: 'technology', statement: 'Built it', attribution: 'individual', origin: 'consultant_reported', review_status: 'validated', source_refs: [{ kind: 'interview', quote: 'Built it' }] },
    { claim_id: 'c2', claim_type: 'metric', statement: 'Cut time at Acme', attribution: 'individual', origin: 'estimated', review_status: 'validated', value: 40, unit: '%', baseline: 50, after_state: '30', period: 'Q1', source_refs: [] },
    { claim_id: 'c3', claim_type: 'deliverable', statement: 'Wrote runbook', attribution: 'individual', origin: 'consultant_reported', review_status: 'validated', source_refs: [] }];
  const grants = [{ id: 'g1', purpose: 'cv', status: 'active', scope: null, expires_at: null, revision: 3 }, { id: 'g2', purpose: 'matching', status: 'active', scope: null, expires_at: null, revision: 3 }];
  const never = CONNECTIONS_CONFIG.data_minimisation.never_send_keys;
  for (const [adapter, id] of [['DNA_SKILLS_WRITEBACK', 'dna_skills'], ['MICHAT_CV', 'michat_cv'], ['IMP_CAPABILITY', 'imp_capability']]) {
    const payload = buildPayload(adapter, { entity, claims, approval, grants }), conn = connectionById(id);
    assert.equal(findForbidden(payload, never), null, `${adapter} payload`);
    const schema = JSON.parse(readFileSync(resolve(CONFIG_DIR, conn.request_schema), 'utf8')), r = validate(schema, payload);
    assert.deepEqual(r.errors, [], `${adapter} payload vs ${conn.request_schema}`);
  }
  assert.equal(JSON.stringify(buildPayload('MICHAT_CV', { entity, claims, approval, grants })).includes('Acme'), false, 'outcome and metric text is withheld');
});

test('field_mapping handles nested paths and arrays, copies nothing unmapped, and refuses prototype-polluting paths', () => {
  const c = { field_mapping: { 'a.b': 'x.y', 'list[].id': 'rows[].key', 'tags[]': 'labels[]', missing: 'm' }, static_fields: { 'k.version': 'v1' } };
  const out = mapOutbound(c, { a: { b: 1, c: 2 }, list: [{ id: 'p', other: 'z' }, { id: 'q' }], tags: ['t1', 't2'], extra: 'no' });
  assert.deepEqual(out, { x: { y: 1 }, rows: [{ key: 'p' }, { key: 'q' }], labels: ['t1', 't2'], k: { version: 'v1' } });
  assert.throws(() => mapOutbound({ field_mapping: { a: '__proto__.polluted' } }, { a: 1 }), /MAPPING_UNSAFE_PATH/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => mapOutbound({ field_mapping: { 'a[].x': 'b' } }, { a: [{ x: 1 }] }), /MAPPING_ARRAY_MISMATCH/);
});

// ======================= inbound =======================
const inboundCfg = (id, patch = {}) => configured(id, { endpoints: { read: { method: 'GET', path: '/people/{consultant_id}', query: { view: 'view' } } }, ack_rule: { kind: 'read', required_paths: [], freshness_path: 'meta.as_of' },
  field_mapping: { role: 'person.job', title: 'person.title', preferred_name: 'person.nick', manager_email: 'person.n1.mail', name: 'person.full_name', email: 'person.mail', salary: 'person.pay', nested: 'person.n1' }, ...patch });

test('inbound prefill: read-only GET; only allowlisted fields come out; names and emails are never model-visible; unknown, nested and oversized values are handled', async () => {
  const srv = await server((r, res) => reply(res, 200, { meta: { as_of: '2026-11-01T08:00:00Z' }, person: { job: 'Data engineer', title: 'Senior\u0000 consultant', nick: 'Sam', full_name: 'Samantha Realname', mail: 'samantha.real@x.test', pay: 123, n1: { mail: 'boss@x.test' } } }));
  try {
    const { cfg, c } = inboundCfg('prefill_profile', { auth: { type: 'bearer', secret_names: ['DNA_API_KEY'], secret_roles: { token: 'DNA_API_KEY' } } });
    const conn = createInboundConnector('prefill_profile', { config: cfg, env: envFor(c, srv.url) });
    const r = await conn.read({ consultant_id: 'person 9', view: 'basic' });
    assert.equal(r.ok, true); assert.equal(r.found, true);
    assert.deepEqual(r.model_fields, { role: 'Data engineer' });
    assert.deepEqual(r.display_fields, { title: 'Senior  consultant', preferred_name: 'Sam', manager_email: 'boss@x.test' }, 'control characters are replaced');
    assert.deepEqual(r.dropped.sort(), ['email', 'name', 'nested', 'salary']);
    assert.equal(JSON.stringify(r.model_fields).includes('Realname'), false); assert.equal(JSON.stringify(r).includes('samantha.real@x.test'), false);
    assert.equal(r.as_of, '2026-11-01T08:00:00Z');
    assert.deepEqual([srv.seen[0].method, srv.seen[0].url, srv.seen[0].headers.authorization, srv.seen[0].body], ['GET', '/people/person%209?view=basic', 'Bearer secret-value-of-DNA_API_KEY', '']);
    // a config that lists a name as a model field still cannot make it model-visible
    const tampered = clone(cfg); const tc = tampered.connections.find(x => x.id === 'prefill_profile'); tc.inbound.model_fields = ['role', 'name', 'email', 'manager_name'];
    const a = allowlist(tc, { role: 'R', name: 'N', email: 'e@x.test', manager_name: 'M' }, tampered);
    assert.deepEqual(a.model_fields, { role: 'R' }); assert.deepEqual(a.display_fields, { manager_name: 'M' }, 'still display-only'); assert.deepEqual(a.dropped.sort(), ['email', 'name']);
    // bounds
    const big = allowlist(c, { role: 'x'.repeat(5000) }, cfg); assert.equal(big.model_fields.role.length, 200);
    // missing placeholder value: no request
    const before = srv.seen.length; assert.match((await conn.read({})).error, /ENDPOINT_PLACEHOLDER_UNRESOLVED/); assert.equal(srv.seen.length, before);
    // refused when not ready
    const off = createInboundConnector('prefill_profile', { config: cfg, env: { ...envFor(c, srv.url), ATLAS_ADAPTERS: 'mock' } }); assert.match((await off.read({ consultant_id: 'p' })).error, /^CONNECTION_NOT_READY:/); assert.equal(srv.seen.length, before);
    // a write method is refused
    const w = inboundCfg('prefill_profile', { endpoints: { read: { method: 'POST', path: '/people/{consultant_id}' } }, auth: { type: 'bearer', secret_names: ['DNA_API_KEY'], secret_roles: { token: 'DNA_API_KEY' } } });
    assert.equal((await createInboundConnector('prefill_profile', { config: w.cfg, env: envFor(w.c, srv.url) }).read({ consultant_id: 'p' })).error, 'INBOUND_MUST_BE_GET'); assert.equal(srv.seen.length, before);
  } finally { await srv.close(); }
});

test('inbound opportunity: 404 is "not found", 5xx retryable, required paths enforced, criteria lists are bounded and display-only', async () => {
  let mode = 'ok';
  const srv = await server((r, res) => mode === '404' ? reply(res, 404, {}) : mode === '503' ? reply(res, 503, {}) : mode === 'partial' ? reply(res, 200, { opp: {} })
    : reply(res, 200, { opp: { id: 'O-1', role: 'Architect', must: Array.from({ length: 50 }, (_, i) => `m${i}`), when: '2026-12-01', client: 'Hidden Client', state: 'open' } }));
  try {
    clearTokenCache();
    const tok = await server((r, res) => reply(res, 200, { access_token: 't', token_type: 'bearer', expires_in: 60 }));
    const { cfg, c } = inboundCfg('opportunity', { endpoints: { read: { method: 'GET', path: '/opps/{opportunity_id}' } }, field_mapping: { opportunity_id: 'opp.id', role: 'opp.role', mandatory_criteria: 'opp.must', start_date: 'opp.when', customer: 'opp.client', lifecycle_state: 'opp.state' },
      ack_rule: { kind: 'read', required_paths: ['opp.id'], freshness_path: null } });
    const env = { ...envFor(c, srv.url), [c.auth.token_url_var]: `${tok.url}/t` };
    const conn = createInboundConnector('opportunity', { config: cfg, env });
    const ok = await conn.read({ opportunity_id: 'O-1' });
    assert.deepEqual(ok.model_fields, { opportunity_id: 'O-1', role: 'Architect' }); assert.equal(ok.display_fields.mandatory_criteria.length, 20); assert.deepEqual(ok.dropped, ['customer']);
    mode = '404'; assert.deepEqual([(await conn.read({ opportunity_id: 'x' })).found], [false]);
    mode = '503'; const e = await conn.read({ opportunity_id: 'x' }); assert.deepEqual([e.ok, e.retryable], [false, true]);
    mode = 'partial'; assert.equal((await conn.read({ opportunity_id: 'x' })).error, 'RESPONSE_MISSING_REQUIRED');
    await tok.close();
  } finally { await srv.close(); clearTokenCache(); }
});

test('connectionStatus and readiness expose names and booleans, never a secret or a URL', () => {
  const { cfg, c } = configured('dna_skills'), secret = 'SUPER-SECRET-VALUE-123', env = { ATLAS_ADAPTERS: 'live', [c.base_url_var]: 'https://owner.example/', DNA_SKILLS_TOKEN: secret };
  const rows = connectionStatus(env, cfg), row = rows.find(r => r.id === 'dna_skills');
  assert.deepEqual([row.eligible, row.secrets_present, row.base_url_set, row.endpoint_configured], [true, { DNA_SKILLS_TOKEN: true }, true, true]);
  const text = JSON.stringify(rows); assert.equal(text.includes(secret), false); assert.equal(text.includes('owner.example'), false);
  assert.equal(rows.find(r => r.id === 'maap_review').eligible, false);
  assert.equal(rows.length, 10);
});

test('healthCheck makes one request to the health endpoint and returns the status code only', async () => {
  const srv = await server((r, res) => reply(res, 200, { secret_detail: 'never returned' }));
  try {
    const { cfg, c } = configured('dna_skills'), env = { ...envFor(c, srv.url), ATLAS_ADAPTERS: 'off' }; // the preflight does not need the Worker's flag
    const r = await healthCheck('dna_skills', { config: cfg, env });
    assert.deepEqual([r.ok, r.status], [true, 200]); assert.equal(JSON.stringify(r).includes('never returned'), false); assert.equal(srv.seen.length, 1); assert.equal(srv.seen[0].url, '/health');
    const none = configured('dna_skills', { endpoints: { send: { method: 'POST', path: '/v1/records' } } }); assert.equal((await healthCheck('dna_skills', { config: none.cfg, env })).ok, false);
  } finally { await srv.close(); }
});

// ======================= schemas and script =======================
const schemaFiles = readdirSync(resolve(CONFIG_DIR, 'contracts'), { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => readdirSync(resolve(CONFIG_DIR, 'contracts', d.name)).map(f => `contracts/${d.name}/${f}`));

test('every contract schema parses, uses only supported keywords, and the drafts say so', () => {
  assert.ok(schemaFiles.length >= 17, `${schemaFiles.length} schema files`);
  for (const f of schemaFiles) {
    const s = JSON.parse(readFileSync(resolve(CONFIG_DIR, f), 'utf8'));
    assert.deepEqual(unsupported(s), [], f);
    assert.equal(s.additionalProperties, false, f);
    if (!f.startsWith('contracts/staffing/')) assert.match(s['x-status'], /^draft — from Atlas side; owner to confirm/, f);
  }
  for (const c of CONNECTIONS_CONFIG.connections) for (const k of ['request_schema', 'response_schema']) if (c[k]) assert.ok(schemaFiles.includes(c[k]), `${c.id} ${k}`);
});

test('schema-lite validates types, required, additional properties, enums, patterns and arrays, and refuses unsupported keywords', () => {
  const s = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer' }, b: { enum: ['x', 'y'] }, c: { type: 'array', items: { type: 'string', maxLength: 3 }, maxItems: 2 }, d: { type: ['string', 'null'], pattern: '^\\d+$' } } };
  assert.equal(validate(s, { a: 1, b: 'x', c: ['ab'], d: null }).valid, true);
  const r = validate(s, { a: 1.5, b: 'z', c: ['abcd', 'x', 'y'], d: 'no', extra: 1 });
  assert.deepEqual(r.errors.map(e => `${e.path}:${e.code}`).sort(), ['#/a:TYPE:integer', '#/b:ENUM', '#/c/0:MAX_LENGTH', '#/c:MAX_ITEMS', '#/d:PATTERN', '#/extra:ADDITIONAL_PROPERTY']);
  assert.deepEqual(validate(s, {}).errors, [{ path: '#/a', code: 'REQUIRED' }]);
  assert.throws(() => validate({ type: 'object', not: {} }, {}), /Unsupported schema keyword/);
  assert.equal(JSON.stringify(validate({ type: 'string' }, 'SECRET-PERSONAL-DATA-1')).includes('SECRET'), false, 'errors carry codes, never values');
});

const SCRIPT = resolve(ROOT, 'scripts/connection_check.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('connection_check.mjs: offline readiness report names secrets without values; --contract validates a sample; --live is refused in CI and without confirmation', () => {
  const r = run([], { DNA_SKILLS_TOKEN: 'VALUE-MUST-NOT-PRINT' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /dna_skills\s+outbound\s+step 10\s+not_configured\s+not ready/); assert.match(r.stdout, /secret DNA_SKILLS_TOKEN: present/);
  assert.equal(r.stdout.includes('VALUE-MUST-NOT-PRINT'), false); assert.match(r.stdout, /Configuration: no problems found/);
  const j = JSON.parse(run(['--json']).stdout); assert.equal(j.config_ok, true); assert.equal(j.connections.length, 10);
  assert.equal(run(['--require-ready', 'dna_skills']).status, 3); assert.equal(run(['--require-ready', 'nope']).status, 2);
  const tmp = fileURLToPath(new URL('./.connectors-sample.json', import.meta.url));
  const sample = { ...PAYLOAD, assertions: PAYLOAD.assertions.map(a => ({ ...a, skill_taxonomy_id: null, level: null, status: 'proposed', evidence_refs: [{ claim_id: a.claim_id, revision: 3 }] })) };
  execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(tmp)}, JSON.stringify(${JSON.stringify(sample)}))`]);
  const good = run(['--contract', 'dna_skills', '--sample', tmp]); assert.equal(good.status, 0, good.stdout); assert.match(good.stdout, /PASS.*draft, the owner has not confirmed it/);
  execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(tmp)}, JSON.stringify({ ...${JSON.stringify(sample)}, transcript: 'x' }))`]);
  const bad = run(['--contract', 'dna_skills', '--sample', tmp]); assert.equal(bad.status, 1); assert.match(bad.stdout, /#\/transcript ADDITIONAL_PROPERTY/);
  execFileSync(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(tmp)})`]);
  assert.equal(run(['--connection', 'dna_skills', '--live', '--confirm-live'], { CI: 'true' }).status, 2);
  const noConfirm = run(['--connection', 'dna_skills', '--live']); assert.equal(noConfirm.status, 2); assert.match(noConfirm.stderr, /--confirm-live/);
  assert.equal(run(['--connection', 'dna_skills', '--live', '--confirm-live']).status, 1, 'an unready connection makes no call and says why');
});
