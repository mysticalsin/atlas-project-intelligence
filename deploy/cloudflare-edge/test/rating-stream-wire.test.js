// The interactive rater is the only writer of the attempt stream. A throwing observer cannot leave rate() unsettled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storyRater } from '../src/rating.js';

test('interactive rate() steps through ratingStreamTransition', () => {
  const src = readFileSync(new URL('../src/rating.js', import.meta.url), 'utf8');
  assert.match(src, /ratingStreamTransition\(/);
  assert.doesNotMatch(src, /let settled = false, attempts = 0, hedged = 0/);
});

test('a throwing onEnd still settles the interactive rating, and the log has no message and no key', async () => {
  const logs = [];
  const rater = storyRater({ TYPESAFE_API_KEY: 'synthetic-key' }, async () => new Response('no', { status: 400 }), {
    now: () => 1_000_000,
    log: line => logs.push(line),
    onEnd() { throw new Error('observer failed'); },
  });
  const outcome = await Promise.race([
    rater.rate('{}', '{}', { asked: [] }).then(() => 'resolved', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 500)),
  ]);
  assert.equal(outcome, 'rejected');
  const line = logs.find(item => item && item.event === 'onend_throw');
  assert.ok(line, 'the observer throw is on the rating log');
  assert.equal(line.name, 'Error');
  assert.equal(Object.hasOwn(line, 'message'), false);
  assert.equal(JSON.stringify(logs).includes('observer failed'), false);
  assert.equal(JSON.stringify(logs).includes('synthetic-key'), false);
});
