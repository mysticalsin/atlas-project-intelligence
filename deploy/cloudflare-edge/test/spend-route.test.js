// The Python door. A bad token is 401. A bad settle is never 2xx. The route does not call a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spendRoute } from '../src/spend-route.js';
import { ProductionSpendLedger, priceOf } from '../src/meter.js';

const SECRET = 'ledger-secret';
const SRC = readFileSync(new URL('../src/spend-route.js', import.meta.url), 'utf8');

function store() {
  const m = new Map();
  return { storage: { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, structuredClone(v)); } } };
}
function bind(ledger) {
  return { idFromName: () => 'production', get: () => ledger };
}
function envFor(ledger, token = SECRET) {
  return { ATLAS_LEDGER_TOKEN: token, SPEND_LEDGER: bind(ledger) };
}
function request(path, body, token = SECRET) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers.Authorization = 'Bearer ' + token;
  return new Request('https://atlas.test' + path, {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function bodyOf(response) {
  return { status: response.status, body: await response.json() };
}

test('a missing secret, a missing token and a wrong token are 401 and the ledger is not called', async () => {
  const calls = [];
  const ledger = { reserve: async () => { calls.push('reserve'); return { ok: true, id: 'P1' }; }, settle: async () => { calls.push('settle'); return true; } };
  const extra = await import('../src/spend-route.js');
  assert.equal(typeof extra.bearerMatches, 'function');
  assert.equal(extra.bearerMatches('', SECRET), false);
  assert.equal(extra.bearerMatches(SECRET, ''), false);
  assert.equal(extra.bearerMatches(SECRET, 'ledger-secreT'), false);
  assert.equal(extra.bearerMatches(SECRET, 'nope'), false);
  assert.equal(extra.bearerMatches(SECRET, SECRET), true);
  assert.doesNotMatch(SRC, /given\.length !== secret\.length/);
  const missingSecret = await bodyOf(await spendRoute(request('/api/ledger/reserve', { kind: 'memory' }, SECRET), envFor(ledger, '')));
  const missingToken = await bodyOf(await spendRoute(request('/api/ledger/reserve', { kind: 'memory' }, ''), envFor(ledger)));
  const wrong = await bodyOf(await spendRoute(request('/api/ledger/reserve', { kind: 'memory' }, 'wrong-token'), envFor(ledger)));
  for (const r of [missingSecret, missingToken, wrong]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { ok: false, reason: 'no_ledger' });
  }
  assert.deepEqual(calls, []);
});

test('a malformed body is 400 and does not reserve', async () => {
  const calls = [];
  const ledger = new ProductionSpendLedger(store(), {}, { limitUsd: 5 });
  const real = ledger.reserve.bind(ledger);
  ledger.reserve = async req => { calls.push(req); return real(req); };
  for (const raw of ['not-json', '[]', 'null']) {
    const r = await bodyOf(await spendRoute(request('/api/ledger/reserve', raw), envFor(ledger)));
    assert.equal(r.status, 400, raw);
    assert.equal(r.body.ok, false);
  }
  assert.deepEqual(calls, []);
});

test('settling an unknown or already-settled id is non-2xx', async () => {
  const ledger = new ProductionSpendLedger(store(), {}, { limitUsd: 5 });
  const reserved = await bodyOf(await spendRoute(request('/api/ledger/reserve', { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 40, outputTokens: 20 }), envFor(ledger)));
  assert.equal(reserved.status, 200);
  const unknown = await bodyOf(await spendRoute(request('/api/ledger/settle', { id: 'P999', estimate: { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 40, outputTokens: 20 } }), envFor(ledger)));
  assert.ok(unknown.status < 200 || unknown.status >= 300);
  assert.equal(unknown.body.ok, false);
  const once = await bodyOf(await spendRoute(request('/api/ledger/settle', { id: reserved.body.id, estimate: { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 40, outputTokens: 20 }, usage: { inputTokens: 10, outputTokens: 4 } }), envFor(ledger)));
  assert.equal(once.status, 200);
  const again = await bodyOf(await spendRoute(request('/api/ledger/settle', { id: reserved.body.id, estimate: { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 40, outputTokens: 20 } }), envFor(ledger)));
  assert.equal(again.status, 409);
  assert.equal(again.body.ok, false);
});

test('a failed settle object is non-2xx', async () => {
  const ledger = { settle: async () => ({ ok: false, reason: 'ledger_error' }) };
  const r = await bodyOf(await spendRoute(request('/api/ledger/settle', { id: 'P1', estimate: { kind: 'memory', provider: 'hindsight', operation: 'retain', inputTokens: 8, outputTokens: 0 } }), envFor(ledger)));
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
});

test('malicious settle usage cannot charge below zero or refund past the reservation', async () => {
  const seen = [];
  const ledger = new ProductionSpendLedger(store(), {}, { limitUsd: 5 });
  const real = ledger.settle.bind(ledger);
  ledger.settle = async (id, observed) => { seen.push(observed); return real(id, observed); };
  const estimate = { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 400, outputTokens: 300 };
  const ceiling = priceOf(estimate);
  const attacks = [
    { inputTokens: -50, outputTokens: -1 },
    { inputTokens: -1e15, outputTokens: -1e15 },
    { inputTokens: 'NaN', outputTokens: '-4' },
    { inputTokens: 0, outputTokens: 0 },
  ];
  for (const usage of attacks) {
    const fresh = await bodyOf(await spendRoute(request('/api/ledger/reserve', estimate), envFor(ledger)));
    const held = (await ledger.snapshot()).reserved.nanoUsd;
    const r = await bodyOf(await spendRoute(request('/api/ledger/settle', { id: fresh.body.id, estimate, usage }), envFor(ledger)));
    assert.equal(r.status, 200, JSON.stringify(usage));
    const snap = await ledger.snapshot();
    const refund = held - snap.reserved.nanoUsd;
    assert.ok(snap.reserved.nanoUsd >= 0, JSON.stringify(usage));
    assert.ok(snap.observed.nanoUsd >= 0, JSON.stringify(usage));
    assert.ok(refund >= 0 && refund <= ceiling, JSON.stringify(usage));
  }
  const nanId = (await bodyOf(await spendRoute(request('/api/ledger/reserve', estimate), envFor(ledger)))).body.id;
  const raw = JSON.stringify({ id: nanId, estimate, usage: { inputTokens: -20, outputTokens: 1 } }).replace('"outputTokens":1', '"outputTokens":NaN');
  const refused = await bodyOf(await spendRoute(request('/api/ledger/settle', raw), envFor(ledger)));
  assert.ok(refused.status >= 400, 'a NaN usage is refused');
  for (const observed of seen) {
    if (observed.actualNano !== undefined) {
      assert.equal(Number.isInteger(observed.actualNano), true);
      assert.ok(observed.actualNano >= 0);
      assert.ok(observed.actualNano <= ceiling);
    }
  }
});

test('the route never calls a provider', async () => {
  assert.doesNotMatch(SRC, /fetch\(|api\.openai|hindsight\.vectorize|elevenlabs|typesafe|workers-ai/i);
  const fetches = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (...args) => { fetches.push(args); throw new Error('provider'); };
  try {
    const ledger = new ProductionSpendLedger(store(), {}, { limitUsd: 5 });
    await spendRoute(request('/api/ledger/reserve', { kind: 'memory', provider: 'hindsight', operation: 'retain', inputTokens: 4, outputTokens: 0 }), envFor(ledger));
  } finally {
    globalThis.fetch = previous;
  }
  assert.deepEqual(fetches, []);
});
