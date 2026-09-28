import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, requestBody, parse, choose, jevRanker } from '../src/jev.js';
import { InterviewLedger, guidance } from '../src/ledger.js';

function planAfter(quotes) {
  const l = new InterviewLedger('Delivery'); let n = 0;
  for (const [field, text] of quotes) { n++; l.addTranscript('u' + n, text); l.call('c' + n, 'record_details', { details: [{ field, item_id: 'u' + n, quote: text }] }); }
  return l.planProbe();
}
const ans = (score, confidence = .9) => { const p = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }; const lo = Math.floor(score), hi = Math.min(4, lo + 1), w = score - lo; p[lo] += 1 - w; if (w) p[hi] += w; return { type: 'score', score, confidence, probabilities: p }; };

test('JEV only ranks when the ledger leaves a free choice', () => {
  assert.deepEqual(candidates(planAfter([['outcome', 'We cut triage time by 40% overall']])), []); // numeric claim: measurement is forced
  assert.deepEqual(candidates(planAfter([['problem', 'Tickets bounced between three teams']])), []);  // contribution is forced
  const free = planAfter([['problem', 'Tickets bounced between three teams'], ['contribution', 'I personally rebuilt the routing rules']]);
  const c = candidates(free);
  assert.equal(c[0], free.next_field); assert.ok(c.length >= 2 && c.length <= 4 && !c.includes('measurement'));
});

test('request carries interview shape only, never transcript content', () => {
  const plan = planAfter([['problem', 'Tickets bounced between three teams at Contoso'], ['contribution', 'I personally rebuilt the routing rules']]);
  const body = JSON.stringify(requestBody('jev-1.13.0', plan, candidates(plan)));
  assert.ok(!body.includes('Contoso') && !body.includes('routing rules') && !body.includes('bounced'));
  assert.ok(body.includes('"recorded"') && body.includes('"questions"'));
});

test('override needs a clear, confident win; bad answers are rejected', () => {
  const plan = planAfter([['problem', 'Tickets bounced between three teams'], ['contribution', 'I personally rebuilt the routing rules']]);
  const g = guidance(plan), [cur, other] = candidates(plan);
  assert.equal(choose(plan, g, { [cur]: { score: 2, confidence: .9 }, [other]: { score: 2.3, confidence: .9 } }), null); // not clearly better
  assert.equal(choose(plan, g, { [cur]: { score: 1, confidence: .9 }, [other]: { score: 3.5, confidence: .4 } }), null); // not confident
  const better = choose(plan, g, { [cur]: { score: 1, confidence: .9 }, [other]: { score: 3.5, confidence: .8 } });
  assert.equal(better.field, other); assert.equal(better.ranked_by, 'jev');
  assert.throws(() => parse({ answers: { [cur]: { type: 'score', score: 3, confidence: .9, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 } } } }, [cur]));
  assert.throws(() => parse({ answers: {} }, [cur]));
  assert.deepEqual(parse({ answers: { [cur]: ans(3.5) } }, [cur]), { [cur]: { score: 3.5, confidence: .9 } });
});

test('ranker is off without a key and uses the TypeSafe endpoint with it', async () => {
  assert.equal(jevRanker({}), null);
  const plan = planAfter([['problem', 'Tickets bounced between three teams'], ['contribution', 'I personally rebuilt the routing rules']]);
  const fields = candidates(plan);
  const rank = jevRanker({ TYPESAFE_API_KEY: 'k' }, async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(init.headers.Authorization, 'Bearer k');
    return new Response(JSON.stringify({ answers: Object.fromEntries(fields.map((f, i) => [f, ans(i === 1 ? 3.6 : 1.2)])) }));
  });
  assert.equal((await rank(plan, guidance(plan))).field, fields[1]);
});
