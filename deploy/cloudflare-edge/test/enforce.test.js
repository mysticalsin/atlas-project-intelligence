// Python <-> JavaScript parity for the question-fidelity check (atlas_voice/enforce.py), and what it must catch: the QA paraphrases (v2.2 Q1 items 3, 4, 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onMove, localSay, lastQuestion, stems } from '../src/enforce.js';
import { QUESTION_BANK } from '../src/policy.generated.js';
const V = JSON.parse(readFileSync(new URL('./enforce.vectors.json', import.meta.url)));
test('enforce parity with Python on every vector', () => {
  for (const [args, expected] of V.on) assert.equal(onMove(...args), expected, JSON.stringify(args));
  for (const [t, expected] of V.last) assert.equal(lastQuestion(t), expected, t);
  for (const [t, expected] of V.stems) assert.deepEqual([...stems(t)].sort(), expected, t);
  for (const [[intent, field, why, lang], expected] of V.local) assert.equal(localSay(intent, field, why, lang), expected, [intent, field, why, lang].join(' '));
  assert.ok(V.on.length >= 25 && V.local.length >= 40);
});
test('the six paraphrases of the client question QA saw: only the ones on the move are kept', () => {
  const move = QUESTION_BANK.open_exploration.en[2]; // "What was the main problem the team needed to solve?"
  assert.equal(onMove('What problem was the client facing?', move, 'open_exploration'), true);
  for (const q of ["What was the client's situation?", 'What was the client trying to achieve?', 'What was happening at the client?', "What was the client's goal?", 'What happened with the client?']) assert.equal(onMove(q, move, 'open_exploration'), false, q);
});
test('a re-angle must carry its concrete angle; a generic re-ask is off the move', () => {
  const say = QUESTION_BANK.reangle_scale.en[0];
  assert.equal(onMove('Roughly how big would you say the change was?', say, 'reangle_scale'), true);
  assert.equal(onMove('What was the client\'s situation?', say, 'reangle_scale'), false);
  assert.equal(onMove('Who on the project would know that best?', QUESTION_BANK.reangle_who.en[0], 'reangle_who'), true);
  assert.equal(onMove('What was the client\'s situation?', QUESTION_BANK.reangle_who.en[0], 'reangle_who'), false);
});
test('every re-angle and every held essential has a line in all six bank languages, one question each', () => {
  for (const intent of ['reangle_example', 'reangle_scale', 'reangle_who', 'reangle_saw']) for (const lang of ['fr', 'es', 'pt', 'de', 'it', 'nl']) assert.equal(localSay(intent, null, '', lang).split('?').length - 1, 1, intent + lang);
  for (const f of ['problem', 'contribution', 'outcome']) for (const lang of ['fr', 'es', 'pt', 'de', 'it', 'nl']) assert.equal(localSay('ladder', f, 'stop_missing:' + f, lang).split('?').length - 1, 1, f + lang);
  assert.equal(localSay('reangle_who', null, '', 'en'), null); assert.equal(localSay('reangle_who', null, '', 'pl'), null);
});
