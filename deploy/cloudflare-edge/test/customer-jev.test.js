// customer-jev.js (WOW_SPEC §F1.5, §F1.10): a port of atlas_voice/jev.py replayed against Python-recorded vectors
// (test/gen_jev_parity.py), plus transport, consent and leak checks. The bids.js fallback path is in bids.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customerJev, requestBody, parseResult, sourceFreshness, shortlist, pyRound1, DIMENSIONS, LEVELS, RUBRIC_VERSION, REVIEW_THRESHOLD } from '../src/customer-jev.js';

const V = JSON.parse(readFileSync(new URL('./jev-customer.vectors.json', import.meta.url)));
const outcome = fn => { try { return { ok: fn() }; } catch (e) { return { error: e.message }; } };
const plain = v => JSON.parse(JSON.stringify(v));

test('parity: constants and request bodies match jev.py', () => {
  assert.equal(RUBRIC_VERSION, V.constants.rubric_version); assert.deepEqual(LEVELS, V.constants.levels);
  assert.deepEqual(plain(DIMENSIONS), V.constants.dimensions); assert.equal(REVIEW_THRESHOLD, 0.7);
  const customer = V.rank.three_stories.customer;
  assert.deepEqual(requestBody({ id: 's1', title: 'T' }, customer, 'jev-1.13.0', true), V.request_body.deterministic);
  assert.deepEqual(requestBody({ id: 's1', title: 'T' }, customer, 'jev-1.13.0'), V.request_body.full);
});

test('parity: Python round(x, 1), exact ties to even', () => {
  for (const [x, want] of V.round) assert.equal(pyRound1(x), want, String(x));
});

for (const [name, [data, fresh, want]] of Object.entries(V.parse_result))
  test('parity: parse_result ' + name, () => assert.deepEqual(plain(outcome(() => parseResult(data, fresh))), want));

for (const [name, [story, want]] of Object.entries(V.source_freshness))
  test('parity: source_freshness ' + name, () => assert.deepEqual(sourceFreshness(story, V.today), want));

test('parity: shortlist', () => {
  for (const [name, [stories, customer, limit, want]] of Object.entries(V.shortlist)) assert.deepEqual(outcome(() => shortlist(stories, customer, limit).map(s => s.id)), want, name);
  assert.deepEqual(outcome(() => shortlist([], ['not', 'a', 'dict'])), V.shortlist_not_dict);
});

// A fetcher that replays the recorded replies and records what JS sent, for a byte-level comparison of the bodies.
function replay(replies) {
  const calls = [], queue = [...replies];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const [status, body] = queue.shift();
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetcher };
}
for (const [name, c] of Object.entries(V.rank)) {
  test('parity: JevRanker.rank ' + name, async () => {
    const { calls, fetcher } = replay(c.replies), sleeps = [];
    const rank = customerJev({ TYPESAFE_API_KEY: 'test-key', JEV_MODEL: 'jev-1.13.0' }, fetcher, { today: V.today, sleep: async ms => { sleeps.push(ms); } });
    let got;
    try { const r = await rank(c.customer, c.stories); got = { ok: { rankings: r.rankings, method: r.method, rubric_version: r.rubricVersion, no_strong_match: r.noStrongMatch, recommended_ids: r.recommendedIds, threshold_status: r.thresholdStatus } }; }
    catch (e) { got = { error: e.message }; }
    assert.deepEqual(plain(got), c.expected);
    assert.deepEqual(calls.map(x => x.body), c.calls.map(x => x.body), 'identical request bodies');
    assert.deepEqual(sleeps, c.sleeps.map(s => s * 1000), 'the same retries, 400 ms then 800 ms');
    for (const x of calls) {
      assert.equal(x.url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(x.init.method, 'POST'); assert.equal(x.init.redirect, 'manual');
      assert.equal(x.init.headers.Authorization, 'Bearer test-key'); assert.ok(x.init.signal instanceof AbortSignal);
      assert.doesNotMatch(JSON.stringify(x.body), /owner_acl|eligible"/, 'only the scoped story keys are sent');
    }
  });
}

test('off without a key; a present key never reaches the request body', async () => {
  assert.equal(customerJev({}), null); assert.equal(customerJev({ TYPESAFE_API_KEY: '' }), null); assert.equal(customerJev(undefined), null);
  const { calls, fetcher } = replay([[200, { answers: {} }]]);
  await assert.rejects(customerJev({ TYPESAFE_API_KEY: 'sk-secret' }, fetcher, { today: V.today })(V.rank.three_stories.customer, [V.rank.three_stories.stories[0]]), /Invalid JEV score/);
  assert.doesNotMatch(calls[0].init.body, /sk-secret/);
});
