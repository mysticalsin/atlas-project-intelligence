import test from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_CODE, BUDGET_MESSAGE, EVENTS, PHASES, REASONS, budgetOutcome, exhaustedError, generatedText, httpBudget, isIllegal, optionalModel, transition } from '../src/budget-stop.js';

const LEGAL = new Set(['pending:refusal:exhausted:usd', ...REASONS.filter(r => r !== 'exhausted:usd').map(r => 'pending:refusal:' + r)]);

test('budget stop: every legal pair, and every other pair is illegal', () => {
  const seen = new Set();
  for (const phase of PHASES) {
    for (const type of [...EVENTS, 'other']) {
      for (const reason of [...REASONS, 'nope', '']) {
        const next = transition({ phase }, { type, reason });
        const key = phase + ':' + type + ':' + reason;
        if (LEGAL.has(key)) {
          seen.add(key);
          if (reason === 'exhausted:usd') assert.deepEqual(next, { phase: 'exhausted', code: BUDGET_CODE, message: BUDGET_MESSAGE });
          else assert.deepEqual(next, { phase: 'closed', reason });
          assert.equal(isIllegal(next), false);
        } else {
          assert.equal(isIllegal(next), true, key);
          assert.equal(next.phase, phase);
        }
      }
    }
  }
  assert.equal(seen.size, LEGAL.size);
  assert.equal(isIllegal(transition(null, { type: 'refusal', reason: 'exhausted:usd' })), true);
  assert.equal(isIllegal(transition({ phase: 'pending' }, null)), true);
});

test('only the month stop becomes the one message; other refusals do not', async () => {
  const stop = budgetOutcome(Object.assign(new Error('x'), { name: 'BudgetRefused', reason: 'exhausted:usd' }));
  assert.deepEqual(stop, { code: BUDGET_CODE, message: BUDGET_MESSAGE });
  assert.equal(budgetOutcome(Object.assign(new Error('x'), { name: 'BudgetRefused', reason: 'ledger_error' })), null);
  assert.equal(budgetOutcome(new Error('upstream')), null);
  assert.deepEqual(httpBudget(Object.assign(new Error('x'), { name: 'BudgetRefused', reason: 'exhausted:usd' })), { status: 429, body: { error: BUDGET_MESSAGE, code: BUDGET_CODE } });
  const err = exhaustedError();
  assert.equal(err.status, 429);
  assert.equal(err.message, BUDGET_MESSAGE);
  assert.deepEqual(await optionalModel(Promise.reject(Object.assign(new Error('x'), { name: 'BudgetRefused', reason: 'exhausted:usd' })), ''), { value: '', budget: stop });
  assert.deepEqual(await optionalModel(Promise.reject(new Error('model')), null), { value: null, budget: null });
  await assert.rejects(optionalModel(Promise.reject(Object.assign(new Error('x'), { name: 'BudgetRefused', reason: 'no_ledger' })), ''), e => e.reason === 'no_ledger');
  await assert.rejects(generatedText(Promise.reject(Object.assign(new Error('x'), { name: 'BudgetRefused', reason: 'exhausted:usd' }))), e => e.code === BUDGET_CODE && e.status === 429 && e.message === BUDGET_MESSAGE);
  assert.equal(await generatedText(Promise.reject(new Error('model'))), '');
});
