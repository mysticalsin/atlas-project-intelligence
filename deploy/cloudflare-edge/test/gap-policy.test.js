// Python ↔ JavaScript parity for the gap-interview policy (WOW_SPEC §F2.3). atlas_voice/gaps.py is the source of
// truth; test/gen_gap_parity.py records it into gap.vectors.json (tests/test_edge.py fails when that file is stale).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as policy from '../src/gap-policy.js';
import { GAP_LIMIT_S, GAP_SPEAKING_S, GAP_WRAP_S, GAP_MAX, GAP_ATTEMPTS, GAP_ANSWER_WORDS, TIME_PLAN, GAP_NOTE, GAP_LIST_LABEL, WIN_HINTS, TIME_UP_MESSAGE } from '../src/policy.generated.js';

const V = JSON.parse(readFileSync(new URL('./gap.vectors.json', import.meta.url)));

for (const name of ['gapSystemBlock', 'gapNotes', 'gapStatus', 'gapGuidance', 'timePlan']) {
  test(`gap policy parity: ${name}`, () => {
    assert.ok(V[name].length > 0, 'vectors recorded');
    for (const [args, expected] of V[name]) assert.deepEqual(policy[name](...args), expected, JSON.stringify(args).slice(0, 160));
  });
}

test('the vectors cover what the spec names: analyst filed elsewhere, UNKNOWN, short answers, 2 attempts, admin note, every pace threshold', () => {
  const statuses = V.gapStatus.flatMap(([, out]) => out.map(s => s.status));
  for (const s of ['answered_unverified', 'unknown', 'deferred', 'open']) assert.ok(statuses.includes(s), s);
  const [[, , , elsewhere], first] = V.gapStatus[0];
  assert.equal(elsewhere[0].field, 'measurement'); assert.equal(first[0].status, 'answered_unverified'); assert.deepEqual(first[0].details, []);
  const paces = V.gapNotes.map(([, out]) => out[2]);
  for (const t of ['Time is up: close now', 'Under ninety seconds left', 'Open items: ', 'Every item has an answer']) assert.ok(paces.some(p => p.includes(t)), t);
  assert.ok(V.gapNotes.some(([args, out]) => args[3] && out[0] === args[3] && out[1] === GAP_NOTE), 'admin note first, then GAP_NOTE');
  assert.ok(V.timePlan.some(([args, out]) => args[0] === 10 && out.depthAt === 4), 'Python rounds half to even: round(4.5) == 4');
});

test('generated gap constants (Python source of truth)', () => {
  assert.deepEqual([GAP_LIMIT_S, GAP_SPEAKING_S, GAP_WRAP_S, GAP_MAX, GAP_ATTEMPTS, GAP_ANSWER_WORDS], [300, 150, 40, 3, 2, 6]);
  assert.deepEqual(TIME_PLAN, { depth_fraction: 0.45, closing_left_s: 210, gap_closing_left_s: 90 });
  assert.match(GAP_NOTE, /bracketed words such as \[company\] are masked names, never guess or ask for them/);
  assert.ok(GAP_LIST_LABEL.startsWith('UNTRUSTED GAP LIST'));
  assert.deepEqual(Object.keys(WIN_HINTS).sort(), ['confirmed', 'quantified']);
  assert.equal(TIME_UP_MESSAGE.replace('{minutes}', 5), 'The 5 minutes are up. Finishing your interview.');
});
