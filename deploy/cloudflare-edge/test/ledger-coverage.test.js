// Ledger coverage (docs/LEDGER_MODES.md): every paid Workers AI or provider call in the edge app goes through the
// one wrapper factory, src/meter.js paid(). Static check, then observe and enforce behaviour against fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { paid, ledgerMode, BudgetState, ProductionSpendLedger, PRODUCTION_DAILY_LIMIT_USD, DEFAULT_LEDGER_MODE, priceOf, sanitize, budgetRefused } from '../src/meter.js';
import { scenario, fakeAI } from './ledger-scenario.js';

const ROOT = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, ROOT), 'utf8');
const sources = () => [
  ...readdirSync(new URL('src/', ROOT)).filter(f => f.endsWith('.js')).map(f => 'src/' + f),
  ...readdirSync(new URL('live-test/', ROOT)).filter(f => /\.(m?js)$/.test(f)).map(f => 'live-test/' + f),
];
// Line comments are removed so prose about env.AI does not count; '//' inside a URL (https://) is kept.
const code = p => read(p).split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

// The only files allowed to touch a paid upstream: the wrapper, and the live-test REST stand-in for the AI binding
// (restBinding, reachable only through meteredRestAI and then through workersAI, i.e. through paid() as well).
const WRAPPER = 'src/meter.js', REST_STANDIN = 'src/spend-ledger.js';
const PAID_HOSTS = /api\.typesafe\.ai|api\.elevenlabs\.io|api\.cloudflare\.com|\/ai\/run\/|gateway\.ai\.cloudflare\.com|api\.openai\.com|api\.anthropic\.com/;
// Direct fetch calls that reach no paid provider, by file and count. A new direct fetch anywhere fails this test.
const UNPAID_FETCHES = {
  'src/app.js': 1,          // Cloudflare Access signing keys (cdn-cgi/access/certs)
  'src/profile.js': 1,      // Mantu DNA directory (production data mode only)
  'src/teams.js': 6,        // Microsoft identity / Bot Framework (default arguments and calls)
  'src/teams-routes.js': 1, // default fetcher argument
  'src/worker.js': 2,       // the Durable Objects' own fetch handlers
  'src/confirm-page.js': 3, // same-origin browser requests in the served page
  'live-test/entry.js': 1,  // the test Worker's own fetch handler
  'live-test/run.mjs': 2,   // the local harness calling wrangler dev on 127.0.0.1
};

test('static: no file but the wrapper calls env.AI.run, the AI binding or a paid provider endpoint', () => {
  const offenders = [];
  for (const p of sources()) {
    if (p === WRAPPER) continue;
    const c = code(p);
    if (/\.AI\b/.test(c) || /\[\s*['"]AI['"]\s*\]/.test(c) || /\{[^}]*\bAI\b[^}]*\}\s*=\s*(this\.)?env\b/.test(c)) offenders.push(p + ': reads the AI binding');
    if (PAID_HOSTS.test(c) && p !== REST_STANDIN) offenders.push(p + ': names a paid endpoint');
    const direct = (c.match(/(^|[^\w.$])(fetch|fetcher|fetchImpl)\s*\(/g) || []).length;
    if (p !== REST_STANDIN && direct !== (UNPAID_FETCHES[p] || 0)) offenders.push(`${p}: ${direct} direct fetch calls, ${UNPAID_FETCHES[p] || 0} allowed (all unpaid)`);
  }
  assert.deepEqual(offenders, []);
  // The REST stand-in has exactly one fetch, inside restBinding, and restBinding is built only by meteredRestAI.
  const rest = code(REST_STANDIN);
  assert.equal((rest.match(/(^|[^\w.$])fetchImpl\s*\(/g) || []).length, 1);
  assert.equal((rest.match(/restBinding\(/g) || []).length, 2);
  // Each module that owns a paid call site uses the wrapper.
  for (const p of ['src/app.js', 'src/memory.js', 'src/memory-routes.js', 'src/jev.js', 'src/classify.js', 'src/rating.js', 'src/customer-jev.js'])
    assert.match(read(p), /from '\.\/meter\.js'/, p);
  assert.ok((read('src/app.js').match(/paid\(env\)/g) || []).length >= 4, 'app.js: workersAI, runReasoning, ElevenLabs, toMarkdown');
});

test('LEDGER_MODE: off by default; unknown values are not silently off', () => {
  assert.equal(DEFAULT_LEDGER_MODE, 'off');
  assert.equal(PRODUCTION_DAILY_LIMIT_USD, null, 'the production limit is a placeholder, not set');
  for (const v of [undefined, null, '', 'off']) assert.equal(ledgerMode({ LEDGER_MODE: v }), 'off');
  assert.equal(ledgerMode({}), 'off'); assert.equal(ledgerMode(undefined), 'off');
  assert.equal(ledgerMode({ LEDGER_MODE: 'observe' }), 'observe');
  assert.equal(ledgerMode({ LEDGER_MODE: 'enforce' }), 'enforce');
  assert.equal(ledgerMode({ LEDGER_MODE: 'Observe' }), 'invalid');
  // Neither the production nor the live-test configuration sets it.
  for (const f of ['wrangler.jsonc', 'live-test/wrangler.jsonc', 'live-test/wrangler.mock.jsonc', 'live-test/wrangler.rest.jsonc']) assert.doesNotMatch(read(f), /LEDGER_MODE/, f);
});

test('off: toMarkdown and provider fetches pass the exact arguments through, with no estimate evaluated', async () => {
  const seen = [], env = { AI: { toMarkdown: (...a) => { seen.push(a); return 'md'; }, run: (...a) => { seen.push(a); return 'r'; } } };
  Object.defineProperty(env, 'SPEND_LEDGER', { get() { throw new Error('looked up'); } });
  const never = () => { throw new Error('estimate evaluated in off mode'); };
  const m = paid(env), files = [{ name: 'a.pdf' }], opts = { conversionOptions: { pdf: { metadata: false } } };
  assert.equal(await m.toMarkdown(never, files, opts), 'md');
  assert.equal(m.run(never, 'model', { x: 1 }, undefined), 'r', 'off returns the upstream value itself, not a wrapper promise');
  assert.equal(seen[0].length, 2); assert.equal(seen[0][0], files); assert.equal(seen[0][1], opts);
  assert.equal(seen[1].length, 3, 'a trailing undefined argument is kept');
  const f = (...a) => a; assert.deepEqual(m.fetch(never, f, 'https://x.example/', { method: 'POST' }), ['https://x.example/', { method: 'POST' }]);
});

const lines = () => { const out = []; return { out, log: l => out.push(l) }; };
const nsOf = obj => ({ idFromName: n => n, get: () => obj });
const TEXT = ['synthetic words', 'Hello there', 'Hola', 'Bonjour', 'summarise', 'analyse', 'report', 'some words', 'remembered', 'Tickets bounced', 'Claims'];
async function withConsole(fn) {
  const logged = [], real = console.log; console.log = (...a) => logged.push(a.join(' '));
  try { return { result: await fn(), logged }; } finally { console.log = real; }
}

test('observe never blocks: with no ledger, a throwing, rejecting or hanging ledger, every call reaches its upstream unchanged; logs carry numbers only', async () => {
  const golden = JSON.parse(readFileSync(new URL('./ledger-off.golden.json', import.meta.url), 'utf8'));
  const records = [];
  const ledgers = {
    none: {},
    getThrows: { SPEND_LEDGER: { idFromName: () => { throw new Error('binding broken'); }, get: () => null } },
    recordThrows: { SPEND_LEDGER: nsOf({ record: () => { throw new Error('sync'); } }) },
    recordRejects: { SPEND_LEDGER: nsOf({ record: async () => { throw new Error('async'); } }) },
    recordHangs: { SPEND_LEDGER: nsOf({ record: () => new Promise(() => {}) }) },
    working: { SPEND_LEDGER: nsOf({ record: async req => { records.push(req); return { ok: true }; } }) },
  };
  for (const [name, extra] of Object.entries(ledgers)) {
    const { result, logged } = await withConsole(() => scenario('observe', extra));
    assert.deepEqual(result, golden, name + ': same upstream arguments and outputs as off');
    await new Promise(r => setTimeout(r, 10));
    assert.ok(logged.length >= golden.calls.length, name + ': one line per paid call');
    for (const l of logged) {
      const j = JSON.parse(l);
      assert.equal(j.atlas_metric, 'ledger'); assert.equal(j.mode, 'observe');
      for (const t of TEXT) assert.ok(!l.includes(t), `${name}: log line carries text: ${l}`);
      assert.ok(!/fake-eleven-key|hs-key|Bearer/.test(l), name + ': no key in a log line');
    }
    if (name === 'none' || name === 'getThrows') assert.ok(JSON.parse(logged[0]).recorded === 'log_only', name);
  }
  assert.ok(records.length >= golden.calls.length, 'the working ledger received a record per call');
  assert.ok(records.every(r => Object.keys(r).every(k => ['kind', 'model', 'provider', 'lang', 'audioMs', 'inputTokens', 'outputTokens', 'chars', 'files', 'requests'].includes(k))));
  const kinds = new Set(records.map(r => r.kind));
  for (const k of ['stt', 'turn', 'tts', 'talker', 'analyst', 'embed', 'memory', 'jev']) assert.ok(kinds.has(k), 'observed kind ' + k);
});

test('observe: the estimate failing does not block the call either', async () => {
  const { out, log } = lines(), env = { LEDGER_MODE: 'observe', AI: { run: async m => 'ran ' + m } };
  assert.equal(await paid(env, { log }).run(() => { throw new Error('bad estimate'); }, 'm'), 'ran m');
  assert.equal(out[0].kind, 'unknown');
});

// Every paid method of the scenario, called once, under enforce; returns what reached the upstream and the refusals.
async function enforced(extra) {
  const calls = [];
  const env = { ...(await import('./ledger-scenario.js')).ENV, LEDGER_MODE: 'enforce', ...extra, AI: fakeAI(calls) };
  const { workersAI } = await import('../src/app.js'), { hindsight, jevRelevant } = await import('../src/memory.js');
  const realFetch = globalThis.fetch;
  const record = (...a) => { calls.push({ to: 'fetch', url: a[0] }); return new Response('{}'); };
  globalThis.fetch = record;
  const ai = workersAI(env), pcm = new Uint8Array(4800), reasons = [];
  const attempts = [
    () => ai.transcribe(pcm), () => ai.turnComplete(pcm), () => ai.synthesize('Hello.', 'atlas', 'en'), () => ai.synthesize('Bonjour.', 'atlas', 'fr'),
    async () => { for await (const d of ai.chatStream([{ role: 'user', content: 'hi' }])) void d; }, () => ai.complete([{ role: 'user', content: 'x' }]),
    () => ai.analyst([{ role: 'user', content: 'x' }]), () => ai.report([{ role: 'user', content: 'x' }]), () => ai.embed('x'),
    () => hindsight(env, record).stats('b'), () => jevRelevant(env, [{ text: 'o', tags: [] }], { id: 'p' }, record),
  ];
  try {
    for (const a of attempts) { try { await a(); reasons.push('admitted'); } catch (e) { reasons.push(budgetRefused(e) ? e.reason : 'error:' + e.message); } }
  } finally { globalThis.fetch = realFetch; }
  return { calls, reasons };
}

test('enforce fails closed with no ledger, a throwing or rejecting ledger, a hanging ledger, and an unset limit: nothing reaches an upstream', async () => {
  const cases = {
    no_ledger: {},
    ledger_error: { SPEND_LEDGER: nsOf({ reserve: () => { throw new Error('sync'); } }) },
    ledger_error_async: { SPEND_LEDGER: nsOf({ reserve: async () => { throw new Error('async'); } }) },
    ledger_error_binding: { SPEND_LEDGER: { idFromName: () => { throw new Error('binding broken'); }, get: () => null } },
    limit_unset: { SPEND_LEDGER: nsOf(new BudgetState()) },
    malformed: { SPEND_LEDGER: nsOf({ reserve: async () => ({ ok: true }) }) },
  };
  const expect = { no_ledger: 'no_ledger', ledger_error: 'ledger_error', ledger_error_async: 'ledger_error', ledger_error_binding: 'no_ledger', limit_unset: 'limit_unset', malformed: 'refused' };
  for (const [name, extra] of Object.entries(cases)) {
    const { calls, reasons } = await withConsole(() => enforced(extra)).then(r => r.result);
    assert.deepEqual(calls, [], name + ': no upstream call');
    assert.deepEqual([...new Set(reasons)], [expect[name]], name);
  }
});

test('enforce: a hanging ledger times out and refuses', async () => {
  const calls = [], env = { LEDGER_MODE: 'enforce', AI: { run: async () => { calls.push(1); return 'x'; } } };
  const ledger = { reserve: () => new Promise(() => {}) };
  await assert.rejects(paid(env, { ledger, timeoutMs: 20, log: () => {} }).run(() => ({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 }), 'm', {}), e => e.reason === 'ledger_timeout');
  assert.equal(calls.length, 0);
});

test('enforce blocks over budget: admits priced calls until the limit, then refuses; unpriced calls never pass; analyst is not retried after a refusal', async () => {
  // 0.0001 USD: 1 s of speech recognition ($0.0000867) and 1 s of the turn model ($0.0000057) fit; the next priced call does not.
  const budget = new BudgetState({ limitUsd: 0.0001 }), reserves = [];
  const ns = nsOf({ reserve: req => { reserves.push(req.kind); return budget.reserve(req); }, settle: (id, o) => budget.settle(id, o) });
  const { calls, reasons } = await withConsole(() => enforced({ SPEND_LEDGER: ns })).then(r => r.result);
  assert.deepEqual(reasons, ['admitted', 'admitted', 'exhausted:usd', 'unpriced', 'exhausted:usd', 'unpriced', 'unpriced', 'unpriced', 'unpriced', 'unpriced', 'unpriced']);
  assert.equal(calls.length, 2, 'only the admitted calls reached the upstream');
  assert.equal(reserves.filter(k => k === 'analyst').length, 3, 'complete, analyst, report: one reservation each, no retry');
  assert.equal(budget.snapshot().settled.ok, 2);
  assert.equal(budget.snapshot().refusals['exhausted:usd'], 2);
  // A generous limit admits every priced kind (nova-3, smart-turn, aura, llama) and still refuses the unpriced ones.
  const rich = new BudgetState({ limitUsd: 5 });
  const r2 = await withConsole(() => enforced({ SPEND_LEDGER: nsOf(rich) })).then(r => r.result);
  assert.deepEqual(r2.reasons, ['admitted', 'admitted', 'admitted', 'unpriced', 'admitted', 'unpriced', 'unpriced', 'unpriced', 'unpriced', 'unpriced', 'unpriced']);
});

test('enforce: an invalid LEDGER_MODE refuses every paid call', async () => {
  const calls = [], env = { LEDGER_MODE: 'enfroce', AI: { run: async () => { calls.push(1); } } };
  await assert.rejects(paid(env, { ledger: { reserve: async () => ({ ok: true, id: 'x' }) }, log: () => {} }).run(() => ({ kind: 'stt' }), 'm'), e => e.reason === 'invalid_mode');
  assert.equal(calls.length, 0);
});

test('enforce settles after success and after an upstream failure, and the upstream error is unchanged', async () => {
  const settled = [], ledger = { reserve: async () => ({ ok: true, id: 'P1' }), settle: async (id, o) => settled.push([id, o]) };
  const ok = paid({ LEDGER_MODE: 'enforce', AI: { run: async () => 'out' } }, { ledger, log: () => {} });
  assert.equal(await ok.run(() => ({ kind: 'stt' }), 'm'), 'out');
  const boom = Object.assign(new Error('upstream'), { name: 'AiError' });
  const bad = paid({ LEDGER_MODE: 'enforce', AI: { run: async () => { throw boom; } } }, { ledger, log: () => {} });
  await assert.rejects(bad.run(() => ({ kind: 'stt' }), 'm'), e => e === boom);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(settled, [['P1', {}], ['P1', { error: 'AiError' }]]);
});

test('BudgetState: priced ceilings, never refunded, one UTC day; ProductionSpendLedger persists', async () => {
  let t = Date.parse('2026-11-09T23:59:00Z');
  const b = new BudgetState({ limitUsd: 0.01, now: () => t });
  assert.equal(priceOf({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1 }), Math.ceil(1000 / 60000 * 0.0052 * 1e9), 'audio rounds up to a whole second');
  assert.equal(priceOf({ kind: 'turn', model: '@cf/pipecat-ai/smart-turn-v2', audioMs: 20000 }), Math.ceil(8000 / 60000 * 0.00033795 * 1e9), 'turn model at most 8 s');
  assert.equal(priceOf({ kind: 'analyst', model: '@cf/openai/gpt-oss-120b', inputTokens: 10, outputTokens: 10 }), null, 'no sourced price: unpriced');
  assert.equal(priceOf({ kind: 'jev', provider: 'typesafe', requests: 1 }), null);
  const r = b.reserve({ kind: 'tts', model: '@cf/deepgram/aura-2-en', chars: 100 });
  assert.ok(r.ok); assert.equal(b.settle(r.id, { error: 'x' }), true); assert.equal(b.settle(r.id), false);
  assert.equal(b.snapshot().reserved.requests, 1, 'a failed call keeps its reservation');
  t += 120000; // next UTC day
  assert.equal(b.snapshot().reserved.requests, 0);
  assert.deepEqual(sanitize({ kind: 'stt', text: 'secret', audioMs: 12.2, model: 'm' }), { kind: 'stt', model: 'm', audioMs: 13 });
  const store = new Map(), state = { storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, structuredClone(v)); } } };
  const a = new ProductionSpendLedger(state, {}, { limitUsd: 1 });
  assert.ok((await a.reserve({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 })).ok);
  assert.equal((await new ProductionSpendLedger(state, {}, { limitUsd: 1 }).snapshot()).reserved.requests, 1, 'state survives a restart');
  assert.equal((await new ProductionSpendLedger(state, {}).reserve({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 })).reason, 'limit_unset', 'the shipped placeholder refuses');
});
