// Adaptive interview length (Tony, 2026-10-31): 20 minutes planned, 30 at most, one polite offer to continue. Parity with atlas_voice/extension.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hardLimit, offerPoint, offerText, shouldOffer, extensionReply } from '../src/extension.js';
import { INTERVIEW_LIMIT_S, INTERVIEW_HARD_S, TIME_PLAN, WRAP_S } from '../src/policy.generated.js';

const V = JSON.parse(readFileSync(new URL('./extension.vectors.json', import.meta.url)));

test('extension parity with Python: hard limits, offer wording, when to offer, how the reply is read', () => {
  for (const [s, e] of V.hard) assert.equal(hardLimit(s), e, 'hard ' + s);
  for (const [f, i, e] of V.offer) assert.equal(offerText(f, i), e, `offer ${f} ${i}`);
  for (const [k, r, ext, t, e] of V.should) assert.equal(shouldOffer(k, r, ext, t), e, `should ${k} ${r} ${ext} ${t}`);
  for (const [i, w, e] of V.reply) assert.equal(extensionReply(i, w), e, `reply ${i} ${w}`);
});

test('the plan: 20 minutes soft, 30 hard, the offer comes with 4.5 minutes of the planned end left, a 90-second wrap, the polite question names the point', () => {
  assert.equal(INTERVIEW_LIMIT_S, 1200); assert.equal(INTERVIEW_HARD_S, 1800); assert.equal(hardLimit(INTERVIEW_LIMIT_S), 1800);
  assert.equal(TIME_PLAN.closing_left_s, 270); assert.equal(WRAP_S, 90);
  assert.equal(offerText('contribution', 'ask'), "We've covered most of it. Could we take a few more minutes on what you personally did?");
  assert.equal(offerPoint(null, 'confirm_asr'), 'a few words I want to check I heard right');
});
