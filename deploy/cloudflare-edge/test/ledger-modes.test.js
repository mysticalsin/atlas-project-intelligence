// Ledger modes through the real call sites (docs/LEDGER_MODES.md): the scenario drives app.js workersAI, the
// Hindsight client and the JEV fetches with LEDGER_MODE observe or enforce and a fake SPEND_LEDGER binding (or none).
// Only the over-budget and unset-limit cases load the production budget (src/meter.js BudgetState).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scenario, fakeAI } from './ledger-scenario.js';

const budgetRefused = e => e?.name === 'BudgetRefused';
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
    assert.ok(logged.length >= golden.calls.length, name + ': one line per upstream call, including the analyst retry');
    for (const l of logged) {
      const j = JSON.parse(l);
      assert.equal(j.atlas_metric, 'ledger'); assert.equal(j.mode, 'observe');
      for (const t of TEXT) assert.ok(!l.includes(t), `${name}: log line carries text: ${l}`);
      assert.ok(!/fake-eleven-key|hs-key|Bearer/.test(l), name + ': no key in a log line');
    }
    if (name === 'none' || name === 'getThrows') assert.ok(JSON.parse(logged[0]).recorded === 'log_only', name);
  }
  assert.ok(records.length >= golden.calls.length, 'the working ledger records each attempt, including the analyst retry');
    assert.ok(records.every(r => Object.keys(r).every(k => ['kind', 'model', 'provider', 'lang', 'operation', 'media', 'audioMs', 'inputTokens', 'outputTokens', 'chars', 'files', 'requests'].includes(k))));
  const kinds = new Set(records.map(r => r.kind));
  for (const k of ['stt', 'turn', 'tts', 'talker', 'analyst', 'embed', 'memory', 'jev']) assert.ok(kinds.has(k), 'observed kind ' + k);
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

test('enforce fails closed with no ledger, a throwing or rejecting ledger, a broken binding or a malformed answer: nothing reaches an upstream', async () => {
  const cases = {
    no_ledger: {},
    ledger_error: { SPEND_LEDGER: nsOf({ reserve: () => { throw new Error('sync'); } }) },
    ledger_error_async: { SPEND_LEDGER: nsOf({ reserve: async () => { throw new Error('async'); } }) },
    ledger_error_binding: { SPEND_LEDGER: { idFromName: () => { throw new Error('binding broken'); }, get: () => null } },
    malformed: { SPEND_LEDGER: nsOf({ reserve: async () => ({ ok: true }) }) },
  };
  const expect = { no_ledger: 'no_ledger', ledger_error: 'ledger_error', ledger_error_async: 'ledger_error', ledger_error_binding: 'no_ledger', malformed: 'refused' };
  for (const [name, extra] of Object.entries(cases)) {
    const { calls, reasons } = await withConsole(() => enforced(extra)).then(r => r.result);
    assert.deepEqual(calls, [], name + ': no upstream call');
    assert.deepEqual([...new Set(reasons)], [expect[name]], name);
  }
});

test('enforce with the shipped production ledger uses the $5 month default and still refuses an explicit empty limit', async () => {
  const { BudgetState } = await import('../src/meter.js');
  const budget = new BudgetState();
  let reserves = 0, settles = 0;
  const counted = nsOf({
    reserve: req => { reserves += 1; return budget.reserve(req); },
    settle: (id, observed) => { settles += 1; return budget.settle(id, observed); },
  });
  const open = await withConsole(() => enforced({ SPEND_LEDGER: counted })).then(r => r.result);
  assert.deepEqual(open.reasons, Array(11).fill('admitted'));
  assert.equal(open.calls.length, reserves, 'each upstream call, including the analyst retry, has its own reservation');
  assert.equal(settles, reserves, 'each of those reservations is settled');
  const closed = await withConsole(() => enforced({ SPEND_LEDGER: nsOf(new BudgetState({ limitUsd: null })) })).then(r => r.result);
  assert.deepEqual(closed.calls, []);
  assert.deepEqual([...new Set(closed.reasons)], ['limit_unset'], 'an explicit empty limit is checked before pricing');
});

test('enforce blocks over budget: admits calls until the limit, then refuses; analyst is not retried after a refusal', async () => {
  // $0.013: 1 s of speech recognition and 1 s of the turn model, each plus the proxy worst case, fit; the next priced call does not.
  const { BudgetState } = await import('../src/meter.js');
  const budget = new BudgetState({ limitUsd: 0.013 }), reserves = [];
  const ns = nsOf({ reserve: req => { reserves.push(req.kind); return budget.reserve(req); }, settle: (id, o) => budget.settle(id, o) });
  const { calls, reasons } = await withConsole(() => enforced({ SPEND_LEDGER: ns })).then(r => r.result);
  // ElevenLabs has no Workers AI proxy, so the French line still fits after Aura's proxy ceiling does not.
  // list, stats and bank reserve the flat ceiling, which does not fit in what remains.
  assert.deepEqual(reasons, ['admitted', 'admitted', 'exhausted:usd', 'admitted', 'exhausted:usd', 'exhausted:usd', 'exhausted:usd', 'exhausted:usd', 'exhausted:usd', 'exhausted:usd', 'exhausted:usd']);
  assert.equal(calls.length, 3, 'only the admitted calls reached the upstream');
  assert.equal(reserves.filter(k => k === 'analyst').length, 3, 'complete, analyst and report each reserve once; a refusal is not retried');
  assert.equal(budget.snapshot().settled.ok, 3);
  assert.equal(budget.snapshot().refusals['exhausted:usd'], 8);
  const rich = new BudgetState({ limitUsd: 5 });
  const r2 = await withConsole(() => enforced({ SPEND_LEDGER: nsOf(rich) })).then(r => r.result);
  assert.deepEqual(r2.reasons, Array(11).fill('admitted'));
});

