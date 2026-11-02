// v2.2 W1: ATLAS does not ask what the system already knows. The opening never asks for the opportunity ID (Opp ID) as the first question, with or without one on the
// project; when there is none it is asked once, briefly, later (TALKER_POLICY). The wording lives in Python (cascade.py) and reaches the Worker through policy.generated.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPENING, TALKER_POLICY } from '../src/policy.generated.js';

test('the opening asks about the work, never for the Opp ID first', () => {
  assert.ok(OPENING.includes('To start, could you tell me about the project and what you were brought in to do?'));
  assert.ok(!/ask for the opportunity ID \(Opp ID\) first/i.test(OPENING), 'the old "ask for the Opp ID first" instruction is gone');
  assert.match(OPENING, /never ask for the opportunity ID \(Opp ID\) in this first turn/);
  assert.match(OPENING, /already in UNTRUSTED PROJECT DATA: never ask for what is there/);
});

test('the Opp ID is asked once, later and briefly, only when the project has none', () => {
  const rule = /OPPORTUNITY ID:[^\n]*/.exec(TALKER_POLICY)?.[0] || '';
  assert.match(rule, /never ask for it when UNTRUSTED PROJECT DATA has an oppId/);
  assert.match(rule, /If absent, ask once, in one short question, after their second answer, never first/);
  assert.ok(!/skip|don.t know/i.test(rule), 'no invitation to skip');
});
