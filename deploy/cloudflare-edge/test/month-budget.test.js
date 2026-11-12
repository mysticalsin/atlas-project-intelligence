// Production month cap (Tony, 2026-11-11, via Jarvis 17:03 BRT): $5 per UTC calendar month, fail closed.
// The live-test ledger ($1.50) is not this budget. Admission is reserved nano plus this call's ceiling
// inside that UTC month. A voice refusal does not continue into another provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from '../src/session.js';
import { BUDGET_MESSAGE } from '../src/budget-stop.js';

const M = await import('../src/meter.js');
const SM = await import('../src/month-budget.js');

const NANO = 1e9;
const FIVE = 5 * NANO;
const PROXY = Math.round((0.30 / 1e6 + 300000 * 0.02 / 1e6) * NANO);
const STT = { kind: 'stt', model: '@cf/test/voice', audioMs: 1000 };
const NOVA = { kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 };

// One second of a custom audio model whose provider price plus the proxy worst case is exactly `targetNano`.
function pricesFor(targetNano) {
  const provider = targetNano - PROXY;
  return { '@cf/test/voice': { usdPerAudioMin: provider * 60 / NANO } };
}
const req = targetNano => ({ prices: pricesFor(targetNano), limitUsd: 5 });

test('the safe default is $5 and the binding proxy is the published formula', () => {
  assert.equal(M.PRODUCTION_MONTHLY_LIMIT_USD, 5);
  assert.equal(M.PROXY_PER_CALL_NANO, PROXY);
  assert.equal(PROXY, Math.round((0.30 / 1e6 + 300000 * 0.02 / 1e6) * NANO));
});

test('exactly at the cap is admitted; one nano over is refused and reserves nothing', () => {
  const at = new M.BudgetState({ ...req(FIVE), now: () => Date.parse('2026-11-15T12:00:00Z') });
  const first = at.reserve(STT);
  assert.equal(first.ok, true);
  assert.equal(at.snapshot().reserved.nanoUsd, FIVE);
  assert.equal(at.snapshot().month, '2026-11');
  const second = at.reserve(STT);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'exhausted:usd');
  assert.equal(at.snapshot().reserved.nanoUsd, FIVE, 'the refused call adds nothing');

  const over = new M.BudgetState({ ...req(FIVE + 1), now: () => Date.parse('2026-11-15T12:00:00Z') });
  const denied = over.reserve(STT);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'exhausted:usd');
  assert.equal(over.snapshot().reserved.requests, 0);
  assert.equal(over.snapshot().reserved.nanoUsd, 0);
});

test('voice ceilings include the proxy worst case', () => {
  const ceiling = M.callCeilingNano(NOVA);
  const provider = M.priceOf(NOVA);
  assert.equal(ceiling, provider + PROXY);
  const b = new M.BudgetState({ limitUsd: ceiling / NANO, now: () => Date.parse('2026-11-15T12:00:00Z') });
  assert.equal(b.reserve(NOVA).ok, true, 'provider + proxy exactly at the configured limit');
  assert.equal(b.snapshot().reserved.nanoUsd, ceiling);
  assert.equal(b.reserve(NOVA).reason, 'exhausted:usd');
});

test('a later UTC day in the same month keeps the reservation; an open hold carries into the next month', () => {
  let t = Date.parse('2026-11-30T23:59:59Z');
  const b = new M.BudgetState({ ...req(1_000_000_000), now: () => t });
  assert.equal(b.reserve(STT).ok, true);
  const kept = b.snapshot().reserved.nanoUsd;
  assert.equal(kept, 1_000_000_000);
  t = Date.parse('2026-12-01T00:00:00Z') - 1000; // 2026-11-30T23:59:59Z is the same instant; step back inside November after a same-day check
  // Same calendar day is not the point. Move to the next UTC day while staying in November.
  t = Date.parse('2026-11-09T23:59:00Z');
  const same = new M.BudgetState({ ...req(1_000_000_000), now: () => t });
  assert.equal(same.reserve(STT).ok, true);
  const id = 'hold';
  assert.equal(same.snapshot().month, '2026-11');
  t = Date.parse('2026-11-10T00:00:01Z');
  assert.equal(same.snapshot().month, '2026-11');
  assert.equal(same.snapshot().reserved.nanoUsd, 1_000_000_000, 'a new UTC day is not a new budget');
  t = Date.parse('2026-12-01T00:00:00Z');
  assert.equal(same.snapshot().month, '2026-12');
  assert.equal(same.snapshot().reserved.nanoUsd, 1_000_000_000, 'the open hold carries');
  assert.equal(same.snapshot().reserved.requests, 1);
  assert.equal(same.reserve(STT).ok, true, 'the new month admits a call that still fits');
  assert.equal(same.settle(id, { error: 'cancelled' }), false);
  void kept;
});

test('rollover carries an open reservation and settle still finds its id', () => {
  let t = Date.parse('2026-11-30T23:50:00Z');
  const b = new M.BudgetState({ limitUsd: 5, now: () => t });
  const reserved = b.reserve({ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 1000, outputTokens: 100 });
  assert.equal(reserved.ok, true);
  const held = b.snapshot().reserved.nanoUsd;
  t = Date.parse('2026-12-01T00:00:01Z');
  const rolled = b.snapshot();
  assert.equal(rolled.month, '2026-12');
  assert.equal(rolled.reserved.nanoUsd, held, 'the open hold is not dropped');
  assert.equal(rolled.inFlight, 1);
  assert.equal(b.settle(reserved.id, { usage: { inputTokens: 10, outputTokens: 4 } }), true);
  const after = b.snapshot();
  assert.equal(after.month, '2026-12');
  assert.equal(after.inFlight, 0);
  assert.ok(after.reserved.nanoUsd > 0);
  assert.ok(after.reserved.nanoUsd < held);
});

test('an expired reservation stays charged at its ceiling and counts as unsettled', () => {
  let t = Date.parse('2026-11-12T00:00:00Z');
  const b = new M.BudgetState({ limitUsd: 5, now: () => t });
  b.reserve(NOVA);
  const held = b.snapshot().reserved.nanoUsd;
  t += 120001;
  assert.equal(b.reserve(NOVA).ok, true);
  const snap = b.snapshot();
  assert.equal(snap.reserved.nanoUsd, held + held, 'expiry does not release the hold');
  assert.equal(snap.settled.unsettled, 1);
  assert.equal(snap.inFlight, 1);
});

test('settling inside the month does not refund', () => {
  const b = new M.BudgetState({ ...req(1_000_000_000), now: () => Date.parse('2026-11-15T00:00:00Z') });
  const r = b.reserve(STT);
  assert.equal(b.settle(r.id, { error: 'cancelled' }), true);
  assert.equal(b.settle(r.id), false);
  assert.equal(b.snapshot().reserved.nanoUsd, 1_000_000_000);
});

test('the Worker variable overrides the default, and a bad variable denies', async () => {
  const store = () => { const m = new Map(); return { storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); } } }; };
  const ok = new M.ProductionSpendLedger(store(), { PRODUCTION_MONTHLY_LIMIT_USD: '5' });
  assert.equal((await ok.reserve(NOVA)).ok, true);
  assert.equal((await ok.snapshot()).limitUsd, 5);
  for (const value of ['', '0', 'nope']) {
    const bad = new M.ProductionSpendLedger(store(), { PRODUCTION_MONTHLY_LIMIT_USD: value });
    assert.equal((await bad.reserve(NOVA)).reason, 'limit_unset', value);
  }
  const unset = new M.ProductionSpendLedger(store(), {});
  assert.equal((await unset.snapshot()).limitUsd, 5);
});

test('an explicit missing, unparseable or zero limit denies; the default admits', () => {
  const now = () => Date.parse('2026-11-15T00:00:00Z');
  for (const limitUsd of [null, '', '0', 0, 'nope', -1, Number.NaN]) {
    const b = new M.BudgetState({ limitUsd, now });
    const r = b.reserve(NOVA);
    assert.equal(r.ok, false, String(limitUsd));
    assert.equal(r.reason, 'limit_unset', String(limitUsd));
    assert.equal(b.snapshot().reserved.requests, 0, String(limitUsd));
  }
  const shipped = new M.BudgetState({ now });
  assert.equal(shipped.snapshot().limitUsd, 5);
  assert.equal(shipped.reserve(NOVA).ok, true);
});

test('a legacy day record, a bad version or a bad month denies and is not healed next month', () => {
  const now = () => Date.parse('2026-11-15T00:00:00Z');
  const cases = [
    { day: '2026-11-09', reserved: { nanoUsd: 0, requests: 0 } },
    { v: 2, phase: 'open', month: '2026-11', reserved: { nanoUsd: 0, requests: 0 } },
    { v: 1, phase: 'open', month: '2026-13', reserved: { nanoUsd: 0, requests: 0 } },
    { v: 1, phase: 'open', month: 'nope', reserved: { nanoUsd: 0, requests: 0 } },
  ];
  for (const saved of cases) {
    const b = new M.BudgetState({ limitUsd: 5, now, saved });
    assert.equal(b.reserve(NOVA).reason, 'unknown_month');
    assert.equal(b.snapshot().reserved.requests, 0);
    const later = new M.BudgetState({ limitUsd: 5, now: () => Date.parse('2027-01-01T00:00:00Z'), saved: b.toJSON() });
    assert.equal(later.reserve(NOVA).reason, 'unknown_month');
    assert.equal(later.snapshot().phase, 'denied');
  }
});

test('a ledger read failure denies and the upstream is not called', async () => {
  const storage = { get: async () => { throw new Error('storage down'); }, put: async () => { throw new Error('should not write'); } };
  const ledger = new M.ProductionSpendLedger({ storage }, {}, { limitUsd: 5 });
  const calls = [];
  const env = { LEDGER_MODE: 'enforce', AI: { run: async () => { calls.push(1); return 'x'; } } };
  await assert.rejects(
    M.paid(env, { ledger, log: () => {} }).run(() => NOVA, 'm', {}),
    e => e?.name === 'BudgetRefused' && e.reason === 'ledger_error');
  assert.equal(calls.length, 0);
  await assert.rejects(
    M.paid(env, { ledger, log: () => {} }).run(() => NOVA, 'm', {}),
    e => e.reason === 'ledger_error');
  assert.equal(calls.length, 0);
});

test('concurrent reservations cannot jointly exceed $5', async () => {
  const store = new Map();
  const storage = {
    get: async k => { await new Promise(r => setTimeout(r, 5)); return store.get(k); },
    put: async (k, v) => { await new Promise(r => setTimeout(r, 5)); store.set(k, structuredClone(v)); },
  };
  const ledger = new M.ProductionSpendLedger({ storage }, {}, { limitUsd: 5, prices: pricesFor(3_000_000_000) });
  const results = await Promise.all(Array.from({ length: 8 }, () => ledger.reserve(STT)));
  const admitted = results.filter(r => r.ok);
  const reserved = admitted.reduce((n, r) => n + Math.round(r.usd * NANO), 0);
  assert.ok(reserved <= FIVE, 'admitted ' + reserved);
  assert.equal(admitted.length, 1, 'a $3 call fits once inside $5');
  const saved = store.get('budget');
  assert.ok(saved.reserved.nanoUsd <= FIVE);
  assert.equal(saved.v, 1);
  assert.equal(saved.month, new Date().toISOString().slice(0, 7));
});

test('month rollover is one pure transition: legal pairs, every illegal pair, guards, persistence', () => {
  const src = readFileSync(new URL('../src/month-budget.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('console.'), 'the reducer does not log');
  assert.ok(!src.includes('await '), 'the reducer does not do I/O');
  const meter = readFileSync(new URL('../src/meter.js', import.meta.url), 'utf8');
  assert.ok(!meter.includes('.month ='), 'month is written only by the transition');

  const open = SM.loadMonth(null);
  const rolled = SM.transition(open, { type: 'rollover', month: '2026-11' });
  assert.equal(SM.isIllegal(rolled), false);
  assert.equal(rolled.month, '2026-11');
  assert.equal(rolled.reserved.nanoUsd, 0);

  const admitted = SM.transition(rolled, { type: 'reserve', kind: 'stt', nano: FIVE, limitNano: FIVE });
  assert.equal(admitted.reserved.nanoUsd, FIVE);
  const over = SM.transition(admitted, { type: 'reserve', kind: 'stt', nano: 1, limitNano: FIVE });
  assert.equal(over.reserved.nanoUsd, FIVE);
  assert.equal(over.refusals['exhausted:usd'], 1);
  const unset = SM.transition(rolled, { type: 'reserve', kind: 'stt', nano: 1, limitNano: null });
  assert.equal(unset.reserved.nanoUsd, 0);
  assert.equal(unset.refusals.limit_unset, 1);
  assert.equal(unset.phase, 'open', 'a bad limit denies the call and does not brick the month record');

  const id = Object.keys(admitted.open)[0];
  const settled = SM.transition(admitted, { type: 'settle', id, error: true });
  assert.equal(settled.reserved.nanoUsd, FIVE, 'settle does not refund');
  assert.equal(settled.settled.errors, 1);
  const recorded = SM.transition(rolled, { type: 'record', kind: 'stt', nano: 10 });
  assert.equal(recorded.observed.nanoUsd, 10);

  const next = SM.transition(admitted, { type: 'rollover', month: '2026-12' });
  assert.equal(next.month, '2026-12');
  assert.equal(next.reserved.nanoUsd, FIVE, 'the open hold carries');
  assert.deepEqual(next.open, admitted.open);
  assert.equal(next.next, admitted.next);
  const cleared = SM.transition(settled, { type: 'rollover', month: '2026-12' });
  assert.equal(cleared.reserved.nanoUsd, 0, 'a settled month does not carry spend');
  assert.equal(Object.keys(cleared.open).length, 0);

  assert.equal(SM.isIllegal(SM.transition(rolled, { type: 'rollover', month: '2026-11' })), true, 'same month');
  assert.equal(SM.isIllegal(SM.transition(next, { type: 'rollover', month: '2026-11' })), true, 'clock backwards');
  const bad = SM.transition(rolled, { type: 'rollover', month: '2026-13' });
  assert.equal(bad.phase, 'denied');
  assert.equal(bad.denyReason, 'unknown_month');

  const legal = new Set(['open:rollover', 'open:reserve', 'open:settle', 'open:record']);
  for (const phase of SM.PHASES) for (const type of SM.EVENTS) {
    const state = phase === 'open' ? rolled : SM.loadMonth({ v: 1, phase: 'denied', denyReason: 'unknown_month', month: '' });
    const result = SM.transition(state, { type, month: '2026-12', kind: 'stt', nano: 1, limitNano: FIVE, id: 'missing' });
    if (legal.has(phase + ':' + type)) assert.equal(SM.isIllegal(result), false, phase + ':' + type);
    else assert.equal(SM.isIllegal(result), true, phase + ':' + type);
  }

  const round = SM.loadMonth(JSON.parse(JSON.stringify(admitted)));
  assert.deepEqual(round, admitted);
  assert.equal(SM.loadMonth({ day: '2026-11-09' }).phase, 'denied');
});

test('a budget refusal stops the voice session and does not call the provider again', async () => {
  const events = [];
  let calls = 0;
  const s = new Session({
    io: { send: e => events.push(e), sendBytes() {}, close() {} },
    ai: {
      async transcribe() { calls += 1; throw Object.assign(new Error('cap'), { name: 'BudgetRefused', reason: 'exhausted:usd' }); },
      async synthesize() { return new Uint8Array(480); },
      async *chatStream() { yield 'Hi'; },
      async analyst() { return []; },
    },
    csrf: 'tok', voice: 'asteria', now: () => 1000, sleep: () => Promise.resolve(),
  });
  await s.transcribe(new Uint8Array(4800));
  assert.equal(calls, 1);
  const err = events.find(e => e.type === 'error');
  assert.equal(err.code, 'budget_exhausted');
  assert.equal(err.message, BUDGET_MESSAGE);
  await s.transcribe(new Uint8Array(4800));
  assert.equal(calls, 1, 'the session does not try the provider again');
  assert.equal(s.finished, true);
});

test('a budget refusal during synthesis uses budget_exhausted and shows the shared sentence; another voice failure keeps its own copy', async () => {
  const refused = () => Object.assign(new Error('cap'), { name: 'BudgetRefused', reason: 'exhausted:usd' });
  const run = async synthesize => {
    const events = [];
    let calls = 0;
    const s = new Session({
      io: { send: e => events.push(e), sendBytes() {}, close() {} },
      ai: {
        async transcribe() { return 'hello there friend'; },
        async synthesize() { calls += 1; throw synthesize(); },
        async *chatStream() { yield 'Hello from the model.'; },
        async analyst() { return []; },
      },
      csrf: 'tok', voice: 'asteria', now: () => 1000, sleep: () => Promise.resolve(),
    });
    s.startReply('Say hello.', { prefix: 'Hello.' });
    await s.speaking;
    return { events, calls };
  };
  const stopped = await run(refused);
  assert.equal(stopped.calls, 1);
  const err = stopped.events.find(e => e.type === 'error');
  assert.equal(err.code, 'budget_exhausted');
  assert.equal(err.message, BUDGET_MESSAGE);
  assert.equal(err.budget, undefined);
  const other = await run(() => new Error('tts down'));
  const plain = other.events.find(e => e.type === 'error');
  assert.equal(plain.code, 'voice-unavailable');
  assert.equal(plain.message, 'The voice reply failed. No fallback voice was used.');
  assert.equal(plain.budget, undefined);
});
